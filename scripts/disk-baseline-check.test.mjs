import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectDiskBaseline} from './disk-baseline.mjs';
import {runDiskBaselineStage} from './disk-baseline-check.mjs';
import {gitBaselineFixture} from './test-fixtures/git-baseline.mjs';
const actions=process.env.GITHUB_ACTIONS;
before(()=>{delete process.env.GITHUB_ACTIONS;});after(()=>{if(actions===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=actions;});
test('disk stage ambiguous create, corrupt source and cleanup failure never report pass; denial creates no resources',async()=>{
  for(const mode of ['create-fails','tamper','cleanup-fails','data-only','forged','actions','never-started','malformed-state','extended-unit-test']){
    const root=await mkdtemp(join(tmpdir(),'disk-stage-lifecycle-')),oldPath=process.env.PATH,log=join(root,'calls');
    try{
      const f=await gitBaselineFixture({files:[{path:'package.json',content:'e30='},{path:'package-lock.json',content:'e30='}]});
      const r=await collectDiskBaseline({root:join(root,'cache'),get:f.get,purpose:mode==='data-only'?'data-only':'checks',streamBlob:async({sha,destination})=>writeFile(destination,Buffer.from(f.values.get('/git/blobs/'+sha).content,'base64'),{flag:'wx',mode:0o600})});
      if(mode==='tamper'){
        const index=JSON.parse(await readFile(join(root,'cache',r.baseSha+'.json')));await writeFile(join(root,'cache',index.bundleDirectory,'blobs',index.files[0].sha),'xx');
      }
      await writeFile(log,'');await writeFile(join(root,'docker'),`#!/usr/bin/env node
const {appendFileSync}=require('node:fs'),a=process.argv.slice(2),mode=${JSON.stringify(mode)};
appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
if(mode==='create-fails'&&a[0]==='create')process.exit(1);
if(mode==='cleanup-fails'&&a[0]==='volume'&&a[1]==='rm')process.exit(1);
if(a[0]==='cp'){process.stdin.resume();process.stdin.on('end',()=>process.exit(0));}else if(a[0]==='inspect')console.log(JSON.stringify({Status:mode==='malformed-state'?undefined:mode==='never-started'?'created':'exited',Running:false,Paused:false,Restarting:false,ExitCode:0,OOMKilled:false,Dead:false,Pid:0,Error:'',StartedAt:'2026-11-18T00:00:00.123Z',FinishedAt:'2026-11-18T00:00:01.123Z'}));
`);await chmod(join(root,'docker'),0o755);process.env.PATH=root+':'+oldPath;
      if(mode==='actions')process.env.GITHUB_ACTIONS='true';
      const operation=()=>runDiskBaselineStage({diskSnapshot:mode==='forged'?structuredClone(r.snapshot):r.snapshot,imageId:'sha256:'+'a'.repeat(64),stage:'build'});
      if(mode==='extended-unit-test'){
        const opts={diskSnapshot:r.snapshot,imageId:'sha256:'+'a'.repeat(64),stage:'unit-test',timeoutMs:900000};
        await assert.rejects(runDiskBaselineStage({...opts,timeoutMs:900001}),{failureKind:'invalid_configuration'});
        await assert.rejects(runDiskBaselineStage({...opts,stage:'build'}),{failureKind:'invalid_configuration'});
        assert.equal((await runDiskBaselineStage(opts)).status,'passed');
      }
      else if(['cleanup-fails','data-only','forged','actions'].includes(mode))await assert.rejects(operation());
      else{const result=await operation();assert.equal(result.status,'failed');assert.equal(result.publishAuthorized,false);if(mode==='tamper')assert.equal(result.failureKind,'blob_integrity');}
      const calls=(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
      if(['data-only','forged','actions'].includes(mode))assert.equal(calls.length,0);
      else{assert.equal(calls.filter(a=>a[0]==='volume'&&a[1]==='rm').length,1);if(mode==='tamper')assert.equal(calls.filter(a=>a[0]==='start').length,0);}
    }finally{delete process.env.GITHUB_ACTIONS;process.env.PATH=oldPath;await rm(root,{recursive:true,force:true});}
  }
});
