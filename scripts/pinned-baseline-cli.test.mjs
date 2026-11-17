import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {watch} from 'node:fs';
import {gitBaselineFixture} from './test-fixtures/git-baseline.mjs';
import {ghBaselineGet} from './pinned-baseline-cli.mjs';
const exec=promisify(execFile),file=(path,content)=>({path,content:Buffer.from(content).toString('base64')});
test('actual CLI uses fixed GET routes, returns metadata only, and refuses Actions or arbitrary endpoints',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pinned-cli-'));
  try{
    const fixture=await gitBaselineFixture({files:[file('package.json','{}'),file('package-lock.json','{}'),file('src/a.ts','SYNTHETIC_PRIVATE_BASELINE')]}),store=join(root,'store.json'),log=join(root,'calls');
    await writeFile(store,JSON.stringify(Object.fromEntries(fixture.values)));await writeFile(log,'');
    await writeFile(join(root,'gh'),`#!/usr/bin/env node
import {readFileSync,appendFileSync} from 'node:fs';const a=process.argv.slice(2);
if(JSON.stringify(a.slice(0,6))!==JSON.stringify(['api','--hostname','github.com','-X','GET','repos/skj04327/the-twilight-of-korea'+(a[5]||'').slice('repos/skj04327/the-twilight-of-korea'.length)]))process.exit(4);
const path=a[5].slice('repos/skj04327/the-twilight-of-korea'.length);appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
const v=JSON.parse(readFileSync(${JSON.stringify(store)}))[path];if(!v)process.exit(5);console.log(JSON.stringify(v));`);
    await chmod(join(root,'gh'),0o755);const env={...process.env,PATH:root+':'+process.env.PATH,GITHUB_ACTIONS:''},cli=resolve('scripts/pinned-baseline-cli.mjs');
    const r=await exec(process.execPath,[cli,'inspect'],{env}),result=JSON.parse(r.stdout);
    assert.equal(result.phase,'captured');assert.equal(result.fileCount,3);assert.equal(result.publishAuthorized,false);
    assert.ok(!r.stdout.includes('SYNTHETIC_PRIVATE_BASELINE'));assert.ok(!r.stdout.includes('src/a.ts'));
    const before=await readFile(log,'utf8');
    await assert.rejects(exec(process.execPath,[cli,'inspect'],{env:{...env,GITHUB_ACTIONS:'true'}}));
    await assert.rejects(exec(process.execPath,[cli,'inspect','https://evil.invalid'],{env}));assert.equal(await readFile(log,'utf8'),before);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('actual gh child is killed on response overflow and abort without emitting raw output',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pinned-cli-bounds-')),oldPath=process.env.PATH;let watcher,timer;
  try{
    const modePath=join(root,'mode'),pidPath=join(root,'pid');
    await writeFile(join(root,'gh'),`#!/usr/bin/env node
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
writeFileSync(${JSON.stringify(pidPath+'.tmp')},String(process.pid));renameSync(${JSON.stringify(pidPath+'.tmp')},${JSON.stringify(pidPath)});
if(readFileSync(${JSON.stringify(modePath)},'utf8')==='flood')process.stdout.write('x'.repeat(4000001));setInterval(()=>{},1000);`);
    await chmod(join(root,'gh'),0o755);process.env.PATH=root+':'+oldPath;
    for(const mode of ['flood','abort']){
      await rm(pidPath,{force:true});await writeFile(modePath,mode);
      const controller=new AbortController();let started=false,fallback=false;
      watcher=watch(root,(_,name)=>{if(mode==='abort'&&String(name)==='pid'){started=true;controller.abort();}});
      timer=setTimeout(async()=>{fallback=true;controller.abort();try{process.kill(Number(await readFile(pidPath,'utf8')),'SIGKILL');}catch{}},5000);
      try{
        await assert.rejects(ghBaselineGet('',{signal:controller.signal}),e=>e.message==='Private baseline read failed');
        assert.equal(fallback,false);if(mode==='abort')assert.equal(started,true);else assert.equal(controller.signal.aborted,false);
        const pid=Number(await readFile(pidPath,'utf8'));assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');
      }finally{clearTimeout(timer);watcher.close();}
    }
    for(const path of ['/git/ref/heads/other','https://evil.invalid',['/git/commits/'+'a'.repeat(40)]])await assert.rejects(ghBaselineGet(path));
  }finally{clearTimeout(timer);watcher?.close();process.env.PATH=oldPath;await rm(root,{recursive:true,force:true});}
});
