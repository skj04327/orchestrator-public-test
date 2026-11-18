import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {makeLocalReceipt} from './test-fixtures/local-receipt.mjs';
import {independentProject} from './test-fixtures/independent-project.mjs';
import {prepareLocalJob,runPreparedLocalJob,readLocalJob} from './local-jobs.mjs';
import {recipientKey,seal} from './private-handoff.mjs';
import * as checks from './local-independent-checks.mjs';
const actions=process.env.GITHUB_ACTIONS;
before(()=>{delete process.env.GITHUB_ACTIONS;});after(()=>{if(actions===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=actions;});
async function job(root){const f=await makeLocalReceipt(root),prepared=await prepareLocalJob(f),p=independentProject(prepared.context),key=recipientKey('SYNTHETIC',prepared.context);
  await runPreparedLocalJob({...f,publicKey:key.publicKey,worker:async()=>({removed:true,executionOutcome:'success',encrypted:seal(p.bundle,key.publicKey,prepared.context)})});return {...f,context:prepared.context,p,key};}
test('strict disk-v1 report uses a distinct manifest fingerprint and preserves six-stage/review/publication gates',async()=>{
  const root=await mkdtemp(join(tmpdir(),'disk-report-'));
  try{
    const f=await job(root),state=await readLocalJob(f),dir=join(f.stateRoot,f.id);
    const claim={schemaVersion:2,inputProfile:'disk-v1',context:state.context,artifactSha256:state.artifactSha256,baseSha:'d'.repeat(40),baselineManifestSha256:'b'.repeat(64),candidateContentSha256:'c'.repeat(64),imageId:'sha256:'+'a'.repeat(64),baselineProvenance:{schemaVersion:2,repository:'skj04327/the-twilight-of-korea',ref:'refs/heads/main',baseSha:'d'.repeat(40),treeSha:'e'.repeat(40),manifestSha256:'b'.repeat(64),fileCount:3,totalBytes:40000000,observedAt:'2026-11-18T00:00:00.000Z'}};
    await writeFile(join(dir,'independent-claim.json'),JSON.stringify(claim),{mode:0o600});
    assert.equal((await checks.readIndependentCheckStatus(f)).phase,'running-or-needs-recovery');
    const observations=['baseline:typecheck','baseline:unit-test','baseline:build','candidate:typecheck','candidate:unit-test','candidate:build'].map(k=>{const [variant,stage]=k.split(':');return {variant,stage,status:'passed',failureKind:null,exitCode:0,removed:true,durationMs:1};});
    const report={...claim,phase:'checks-passed-awaiting-review',checks:observations,baselineBinding:'github-main-pinned',review:'not-run',publishAuthorized:false,failureKind:null};
    const path=join(dir,'independent-report.json');await writeFile(path,JSON.stringify(report),{mode:0o600});
    assert.equal((await checks.readIndependentCheckStatus(f)).baselineManifestSha256,claim.baselineManifestSha256);
    for(const patch of [{publishAuthorized:true},{review:'passed'},{inputProfile:'memory'},{baselineContentSha256:'b'.repeat(64)},{baselineManifestSha256:'f'.repeat(64)},{checks:observations.slice(1)},{phase:'needs-recovery'},{imageId:[claim.imageId]},{checks:observations.map((r,i)=>i? r:{...r,variant:[r.variant]})},{checks:observations.map((r,i)=>i? r:{...r,stage:[r.stage]})}]){await writeFile(path,JSON.stringify({...report,...patch}));await assert.rejects(checks.readIndependentCheckStatus(f));}
    const infra={...observations[0],status:'failed',failureKind:'timeout',exitCode:null};
    await writeFile(path,JSON.stringify({...report,phase:'needs-recovery',failureKind:'timeout',checks:[infra]}));
    assert.equal((await checks.readIndependentCheckStatus(f)).phase,'needs-recovery');
    for(const patch of [{checks:[infra,...observations.slice(1)]},{checks:[infra],failureKind:'operation_failed'}]){
      await writeFile(path,JSON.stringify({...report,phase:'needs-recovery',failureKind:'timeout',...patch}));await assert.rejects(checks.readIndependentCheckStatus(f));
    }
    const wrong=structuredClone(claim);wrong.baselineProvenance.manifestSha256='f'.repeat(64);await writeFile(join(dir,'independent-claim.json'),JSON.stringify(wrong));await assert.rejects(checks.readIndependentCheckStatus(f));
  }finally{await rm(root,{recursive:true,force:true});}
});
test('large runner refuses copied/data-only inputs and invalid runtime before creating the shared claim',async()=>{
  assert.equal(typeof checks.runLargeDiskIndependentChecks,'function');
  const {diskCheckFixture}=await import('./test-fixtures/disk-check.mjs');const root=await mkdtemp(join(tmpdir(),'disk-run-gate-'));
  try{const f=await job(root),source=await diskCheckFixture(join(root,'source'),{context:f.context,purpose:'data-only'});
    for(const patch of [{diskSnapshot:source.snapshot},{diskSnapshot:structuredClone(source.snapshot)},{diskSnapshot:source.snapshot,imageId:'latest'}]){
      await assert.rejects(checks.runLargeDiskIndependentChecks({...f,privateKey:f.key.privateKey,imageId:'sha256:'+'a'.repeat(64),...patch}));
      const {stat}=await import('node:fs/promises');await assert.rejects(stat(join(f.stateRoot,f.id,'independent-claim.json')),{code:'ENOENT'});
    }
  }finally{await rm(root,{recursive:true,force:true});}
});
test('final real artifact read cancellation cannot commit a passed disk-profile report',async()=>{
  const fs=(await import('node:fs')).default,{syncBuiltinESMExports}=await import('node:module'),{diskCheckFixture}=await import('./test-fixtures/disk-check.mjs');
  const root=await mkdtemp(join(tmpdir(),'disk-final-cancel-')),oldPath=process.env.PATH,originalOpen=fs.promises.open;
  try{
    const f=await makeLocalReceipt(root),prepared=await prepareLocalJob(f),source=await diskCheckFixture(root,{context:prepared.context}),key=recipientKey('SYNTHETIC',prepared.context);
    await runPreparedLocalJob({...f,publicKey:key.publicKey,worker:async()=>({removed:true,executionOutcome:'success',encrypted:seal(source.bundle,key.publicKey,prepared.context)})});
    const marker=join(root,'observed'),artifact=join(f.stateRoot,f.id,'result.enc'),controller=new AbortController();
    await writeFile(join(root,'docker'),`#!/usr/bin/env node
const {writeFileSync}=require('node:fs'),a=process.argv.slice(2);
if(a[0]==='cp'){process.stdin.resume();}else if(a[0]==='inspect'){
writeFileSync(${JSON.stringify(marker)},'done');console.log(JSON.stringify({Status:'exited',Running:false,Paused:false,Restarting:false,OOMKilled:false,Dead:false,Pid:0,Error:'',ExitCode:0,StartedAt:'2026-11-18T00:00:00.123Z',FinishedAt:'2026-11-18T00:00:01.123Z'}));}
`);const {chmod}=await import('node:fs/promises');await chmod(join(root,'docker'),0o755);process.env.PATH=root+':'+oldPath;
    fs.promises.open=async(...args)=>{const handle=await originalOpen(...args);if(String(args[0])===artifact&&fs.existsSync(marker))controller.abort();return handle;};syncBuiltinESMExports();
    const report=await checks.runLargeDiskIndependentChecks({...f,diskSnapshot:source.snapshot,privateKey:key.privateKey,imageId:'sha256:'+'a'.repeat(64),signal:controller.signal});
    assert.equal(controller.signal.aborted,true);assert.equal(report.phase,'needs-recovery');assert.equal(report.failureKind,'cancelled');assert.equal(report.publishAuthorized,false);
  }finally{fs.promises.open=originalOpen;syncBuiltinESMExports();process.env.PATH=oldPath;await rm(root,{recursive:true,force:true});}
});

test('array-valued runtime IDs are refused before claims for both checker profiles',async()=>{
  const {captureCheckConfiguration}=await import('./isolated-check.mjs');
  assert.throws(()=>captureCheckConfiguration({imageId:['sha256:'+'a'.repeat(64)]}));
});
test('post-capture disk blob corruption yields a readable terminal recovery report with normalized transport failure',async()=>{
  const {diskCheckFixture}=await import('./test-fixtures/disk-check.mjs'),root=await mkdtemp(join(tmpdir(),'disk-transfer-fail-')),oldPath=process.env.PATH;
  try{
    const f=await makeLocalReceipt(root),prepared=await prepareLocalJob(f),source=await diskCheckFixture(root,{context:prepared.context}),key=recipientKey('SYNTHETIC',prepared.context);
    await runPreparedLocalJob({...f,publicKey:key.publicKey,worker:async()=>({removed:true,executionOutcome:'success',encrypted:seal(source.bundle,key.publicKey,prepared.context)})});
    const index=JSON.parse(await readFile(join(root,'cache',source.snapshot.baseSha+'.json'))),entry=index.files.find(f=>f.path==='src/status.ts');
    await writeFile(join(root,'cache',index.bundleDirectory,'blobs',entry.sha),Buffer.alloc(entry.size,7));
    const calls=join(root,'calls');await writeFile(calls,'');await writeFile(join(root,'docker'),`#!/usr/bin/env node
const {appendFileSync}=require('node:fs'),a=process.argv.slice(2);appendFileSync(${JSON.stringify(calls)},a[0]+'\\n');if(a[0]==='cp')process.stdin.resume();
`);const {chmod}=await import('node:fs/promises');await chmod(join(root,'docker'),0o755);process.env.PATH=root+':'+oldPath;
    const report=await checks.runLargeDiskIndependentChecks({...f,diskSnapshot:source.snapshot,privateKey:key.privateKey,imageId:'sha256:'+'a'.repeat(64)});
    assert.equal(report.phase,'needs-recovery');assert.equal(report.failureKind,'invalid_output');assert.equal(report.checks.length,1);assert.equal(report.checks[0].failureKind,'invalid_output');assert.equal(report.publishAuthorized,false);
    assert.equal((await checks.readIndependentCheckStatus(f)).phase,'needs-recovery');assert.ok(!(await readFile(calls,'utf8')).split('\n').includes('start'));
  }finally{process.env.PATH=oldPath;await rm(root,{recursive:true,force:true});}
});
