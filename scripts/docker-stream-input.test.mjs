import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {docker} from './docker-command.mjs';
test('Docker stdin consumes bounded async bytes and joins the producer before resolving or rejecting',async()=>{
  const root=await mkdtemp(join(tmpdir(),'docker-stream-')),old=process.env.PATH;
  try{
    await writeFile(join(root,'docker'),`#!/usr/bin/env node
const {createHash}=require('node:crypto');let n=0,h=createHash('sha256');
if(process.argv[2]==='early')process.exit(0);
process.stdin.on('data',b=>{n+=b.length;h.update(b);});process.stdin.on('end',()=>console.log(JSON.stringify({n,hash:h.digest('hex')})));
`);await chmod(join(root,'docker'),0o755);process.env.PATH=root+':'+old;
    let closed=false;const chunk=Buffer.alloc(65536,7);
    async function* bytes(){try{for(let i=0;i<640;i++)yield chunk;}finally{await new Promise(r=>setTimeout(r,10));closed=true;}}
    const result=JSON.parse(await docker(['consume'],{inputStream:bytes(),timeout:10000}));
    assert.equal(result.n,41943040);assert.equal(result.hash,createHash('sha256').update(Buffer.alloc(41943040,7)).digest('hex'));assert.equal(closed,true);
    closed=false;
    await assert.rejects(docker(['early'],{inputStream:bytes()}));assert.equal(closed,true);
    closed=false;async function* failed(){try{yield chunk;throw Object.assign(Error('PRIVATE_MARKER'),{failureKind:'blob_integrity'});}finally{closed=true;}}
    await assert.rejects(docker(['consume'],{inputStream:failed()}),e=>e.failureKind==='blob_integrity'&&!e.message.includes('PRIVATE_MARKER'));assert.equal(closed,true);
  }finally{process.env.PATH=old;await rm(root,{recursive:true,force:true});}
});
test('an iterator that throws during setup cannot spawn a Docker child before validation finishes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'docker-iterator-')),old=process.env.PATH,log=join(root,'spawned');
  try{
    await writeFile(join(root,'docker'),`#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(log)},'spawned');\n`);await chmod(join(root,'docker'),0o755);process.env.PATH=root+':'+old;
    const inputStream={[Symbol.asyncIterator](){throw Error('SYNTHETIC_ITERATOR_FAILURE');}};
    await assert.rejects(docker(['cp'],{inputStream,timeout:100}));await new Promise(r=>setTimeout(r,150));
    const {stat}=await import('node:fs/promises');await assert.rejects(stat(log),{code:'ENOENT'});
  }finally{process.env.PATH=old;await rm(root,{recursive:true,force:true});}
});
