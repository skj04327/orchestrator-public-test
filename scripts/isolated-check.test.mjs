import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,chmod,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runIsolatedCheck} from './isolated-check.mjs';
const payload=Buffer.from(JSON.stringify({baseline:[{path:'package.json',content:'e30='},{path:'package-lock.json',content:'e30='}],candidate:[{path:'src/a.ts',content:'YQ=='}]}));
test('isolated-check ambiguous creation, stopped nonzero and failed cleanup never count as passed',async()=>{
  for(const mode of ['create-fails','check-fails','cleanup-fails']){
    const root=await mkdtemp(join(tmpdir(),'isolated-lifecycle-')),originalPath=process.env.PATH,log=join(root,'calls');
    try{
      await writeFile(log,'');
      const shim=`#!/usr/bin/env node
import {appendFileSync} from 'node:fs';const a=process.argv.slice(2);
appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
const mode=${JSON.stringify(mode)};
if(mode==='create-fails'&&a[0]==='create')process.exit(1);
if(mode==='cleanup-fails'&&a[0]==='volume'&&a[1]==='rm')process.exit(1);
if(a[0]==='inspect')console.log(JSON.stringify({Running:false,Paused:false,Restarting:false,ExitCode:mode==='check-fails'?1:0}));
`;
      await writeFile(join(root,'docker'),shim);await chmod(join(root,'docker'),0o755);process.env.PATH=root+':'+originalPath;
      const operation=()=>runIsolatedCheck({imageId:'sha256:'+'a'.repeat(64),payload,variant:'candidate',stage:'build'});
      if(mode==='cleanup-fails')await assert.rejects(operation());
      else{const result=await operation();assert.equal(result.status,'failed');assert.equal(result.removed,true);}
      const calls=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(calls.filter(a=>a[0]==='volume'&&a[1]==='rm').length,1);
      assert.ok(calls.some(a=>a[0]==='rm'&&a.at(-1).endsWith('-seed')));
    }finally{process.env.PATH=originalPath;await rm(root,{recursive:true,force:true});}
  }
});
