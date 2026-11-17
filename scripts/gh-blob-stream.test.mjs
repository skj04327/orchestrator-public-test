import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,readFile,rm,stat,symlink} from 'node:fs/promises';
import {watch} from 'node:fs';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fetchGitBlobToFile} from './gh-blob-stream.mjs';
const actions=process.env.GITHUB_ACTIONS;
before(()=>{delete process.env.GITHUB_ACTIONS;});after(()=>{if(actions===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=actions;});
function expected(size){const sha1=createHash('sha1').update('blob '+size+'\0'),sha256=createHash('sha256'),chunk=Buffer.alloc(65536,97);
  for(let n=0;n<size;n+=chunk.length){const b=chunk.subarray(0,Math.min(chunk.length,size-n));sha1.update(b);sha256.update(b);}return {sha:sha1.digest('hex'),sha256:sha256.digest('hex')};}
async function fixture(mode,size){
  const root=await mkdtemp(join(tmpdir(),'raw-blob-')),modePath=join(root,'mode'),pidPath=join(root,'pid');
  await writeFile(modePath,JSON.stringify({mode,size}));
  await writeFile(join(root,'gh'),`#!/usr/bin/env node
import {readFileSync,writeFileSync,renameSync} from 'node:fs';import {once} from 'node:events';
const a=process.argv.slice(2);if(a[0]!=='api'||a[1]!=='--hostname'||a[2]!=='github.com'||a[3]!=='-X'||a[4]!=='GET'||a[5]!=='-H'||a[6]!=='Accept: application/vnd.github.raw+json'||!/^repos\\/skj04327\\/the-twilight-of-korea\\/git\\/blobs\\/[a-f0-9]{40}$/.test(a[7]))process.exit(90);
const {mode,size}=JSON.parse(readFileSync(${JSON.stringify(modePath)},'utf8'));
writeFileSync(${JSON.stringify(pidPath+'.tmp')},String(process.pid));renameSync(${JSON.stringify(pidPath+'.tmp')},${JSON.stringify(pidPath)});
if(mode==='hang'){setInterval(()=>{},1000);}else if(mode==='stderr'){process.stderr.write('SYNTHETIC_PRIVATE_ERROR'.repeat(2000));setInterval(()=>{},1000);}else{
const count=mode==='overflow'?size+65536:mode==='short'?size-1:size,chunk=Buffer.alloc(65536,mode==='corrupt'?98:97);
(async()=>{for(let n=0;n<count;n+=chunk.length)if(!process.stdout.write(chunk.subarray(0,Math.min(chunk.length,count-n))))await once(process.stdout,'drain');})();}
`);await chmod(join(root,'gh'),0o755);return {root,pidPath,destination:join(root,'blob')};
}
test('raw Git blob bigger than old memory cap streams to private disk with exact hash and bounded chunks',async()=>{
  const size=40*1024*1024,f=await fixture('good',size),oldPath=process.env.PATH;process.env.PATH=f.root+':'+oldPath;
  try{
    const e=expected(size),r=await fetchGitBlobToFile({...f,sha:e.sha,size,timeoutMs:10000});
    assert.equal(r.sha256,e.sha256);assert.equal(r.size,size);assert.ok(r.maxChunkBytes<=262144);
    assert.equal((await stat(f.destination)).size,size);assert.equal((await stat(f.destination)).mode&0o777,0o600);
    await assert.rejects(fetchGitBlobToFile({...f,sha:e.sha,size}));assert.equal((await stat(f.destination)).size,size);
  }finally{process.env.PATH=oldPath;await rm(f.root,{recursive:true,force:true});}
});
test('corrupt, short, oversized, noisy, timeout and aborted transfers stop child and remove only their partial file',async()=>{
  for(const [mode,kind]of [['corrupt','blob_integrity'],['short','size_mismatch'],['overflow','size_mismatch'],['stderr','output_limit'],['hang','timeout'],['abort','cancelled']]){
    const f=await fixture(mode==='abort'?'hang':mode,65536),oldPath=process.env.PATH;process.env.PATH=f.root+':'+oldPath;
    const controller=new AbortController();let watcher;
    try{
      if(mode==='abort')watcher=watch(f.root,(_,name)=>{if(String(name)==='pid')controller.abort();});
      await assert.rejects(fetchGitBlobToFile({...f,sha:expected(65536).sha,size:65536,timeoutMs:mode==='hang'?300:5000,signal:controller.signal}),e=>e.failureKind===kind&&!e.message.includes('SYNTHETIC_PRIVATE_ERROR'));
      await assert.rejects(stat(f.destination));const pid=Number(await readFile(f.pidPath,'utf8'));assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');
    }finally{watcher?.close();process.env.PATH=oldPath;await rm(f.root,{recursive:true,force:true});}
  }
});
test('symlink and pre-aborted destination cannot launch a raw transfer or overwrite existing state',async()=>{
  const f=await fixture('good',1),oldPath=process.env.PATH;process.env.PATH=f.root+':'+oldPath;
  try{
    const keep=join(f.root,'keep');await writeFile(keep,'KEEP');await symlink(keep,f.destination);
    await assert.rejects(fetchGitBlobToFile({...f,sha:expected(1).sha,size:1}));assert.equal(await readFile(keep,'utf8'),'KEEP');
    await assert.rejects(fetchGitBlobToFile({...f,destination:join(f.root,'other'),sha:expected(1).sha,size:1,signal:AbortSignal.abort()}));
    await assert.rejects(stat(f.pidPath));
  }finally{process.env.PATH=oldPath;await rm(f.root,{recursive:true,force:true});}
});
test('cancellation during file sync cannot return a completed raw transfer',async()=>{
  const f=await fixture('good',65536),oldPath=process.env.PATH,originalOpen=fs.promises.open,controller=new AbortController();
  process.env.PATH=f.root+':'+oldPath;
  try{
    fs.promises.open=async(...args)=>{const handle=await originalOpen(...args);if(args[0]===f.destination){const sync=handle.sync.bind(handle);handle.sync=async()=>{await sync();controller.abort();};}return handle;};
    syncBuiltinESMExports();
    await assert.rejects(fetchGitBlobToFile({...f,sha:expected(65536).sha,size:65536,signal:controller.signal}),e=>e.failureKind==='cancelled');
    await assert.rejects(stat(f.destination));
  }finally{fs.promises.open=originalOpen;syncBuiltinESMExports();process.env.PATH=oldPath;await rm(f.root,{recursive:true,force:true});}
});
