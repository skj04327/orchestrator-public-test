import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as disk from './disk-baseline.mjs';
import {gitBaselineFixture} from './test-fixtures/git-baseline.mjs';
const actions=process.env.GITHUB_ACTIONS;
before(()=>{delete process.env.GITHUB_ACTIONS;});after(()=>{if(actions===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=actions;});
const file=(path,b)=>({path,content:Buffer.from(b).toString('base64')});
async function fixture(root,extra=[],purpose='checks'){
  const source=await gitBaselineFixture({files:[file('package.json','{}'),file('package-lock.json','{}'),file('public/고려 지도.txt','SYNTHETIC'),...extra]},{executablePaths:['tool.sh']});
  return disk.collectDiskBaseline({root,get:source.get,purpose,streamBlob:async({sha,destination})=>writeFile(destination,Buffer.from(source.values.get('/git/blobs/'+sha).content,'base64'),{flag:'wx',mode:0o600})});
}
test('archive exports verified regular SHA files and Unicode/executable manifest once without source serialization',async()=>{
  assert.equal(typeof disk.createDiskBaselineArchive,'function');
  const root=await mkdtemp(join(tmpdir(),'disk-archive-'));
  try{
    const r=await fixture(root,[file('tool.sh','#!/bin/sh\nexit 0\n')]),a=disk.createDiskBaselineArchive(r.snapshot),parts=[];
    for await(const b of a.inputStream){assert.ok(b.length<=65536);parts.push(b);}
    const bytes=Buffer.concat(parts),files=new Map();let at=0;
    while(bytes[at]){const h=bytes.subarray(at,at+512),name=h.subarray(0,100).toString().replace(/\0.*$/s,''),size=parseInt(h.subarray(124,136).toString(),8);
      assert.equal(h[156],48);assert.equal(parseInt(h.subarray(100,108).toString(),8),0o444);files.set(name,bytes.subarray(at+512,at+512+size));at+=512+Math.ceil(size/512)*512;}
    assert.ok(bytes.subarray(at).every(b=>b===0));const m=JSON.parse(files.get('manifest.json'));
    assert.equal(m.files.length,4);assert.equal(m.files.find(f=>f.path==='tool.sh').mode,'100755');
    assert.equal(files.get(m.files.find(f=>f.path==='public/고려 지도.txt').sha).toString(),'SYNTHETIC');
    assert.equal(a.provenance.baseSha,r.snapshot.baseSha);assert.equal(a.provenance.publishAuthorized,false);
    await assert.rejects(async()=>{for await(const b of a.inputStream){void b;}});
  }finally{await rm(root,{recursive:true,force:true});}
});
test('archive rejects data-only and copied handles before yielding any bytes',async()=>{
  assert.equal(typeof disk.createDiskBaselineArchive,'function');const root=await mkdtemp(join(tmpdir(),'disk-archive-policy-'));
  try{const r=await fixture(root,[],'data-only');assert.throws(()=>disk.createDiskBaselineArchive(r.snapshot));assert.throws(()=>disk.createDiskBaselineArchive(structuredClone(r.snapshot)));}
  finally{await rm(root,{recursive:true,force:true});}
});
test('archive tamper, abort and early consumer return cannot produce a complete reusable transfer',async()=>{
  assert.equal(typeof disk.createDiskBaselineArchive,'function');
  for(const mode of ['tamper','abort','return']){
    const root=await mkdtemp(join(tmpdir(),'disk-archive-stop-'));
    try{
      const r=await fixture(root,[file('big.bin',Buffer.alloc(2*1024*1024,1))]),controller=new AbortController();
      const archive=disk.createDiskBaselineArchive(r.snapshot,{signal:controller.signal});
      if(mode==='tamper'){
        const index=JSON.parse(await readFile(join(root,r.snapshot.baseSha+'.json'))),f=index.files.find(f=>f.path==='big.bin');
        await writeFile(join(root,index.bundleDirectory,'blobs',f.sha),Buffer.alloc(f.size,2));
      }
      if(mode==='return'){for await(const b of archive.inputStream){assert.ok(b.length);break;}await assert.rejects(async()=>{for await(const b of archive.inputStream){void b;}});}
      else await assert.rejects(async()=>{for await(const b of archive.inputStream){if(mode==='abort')controller.abort();void b;}});
    }finally{await rm(root,{recursive:true,force:true});}
  }
});
test('mid-blob unread-byte mutation, truncation, abort and early return close the actual open reader',async()=>{
  const {open,truncate,readdir,readlink}=await import('node:fs/promises');
  async function readers(path){const names=await readdir('/proc/self/fd');const targets=await Promise.all(names.map(n=>readlink('/proc/self/fd/'+n).catch(()=>'')));return targets.filter(v=>v===path).length;}
  for(const mode of ['mutate','truncate','abort','return']){
    const root=await mkdtemp(join(tmpdir(),'disk-mid-blob-'));
    try{
      const r=await fixture(root,[file('big.bin',Buffer.alloc(2*1024*1024,1))]),index=JSON.parse(await readFile(join(root,r.baseSha+'.json'))),entry=index.files.find(f=>f.path==='big.bin');
      const blob=join(root,index.bundleDirectory,'blobs',entry.sha),controller=new AbortController(),archive=disk.createDiskBaselineArchive(r.snapshot,{signal:controller.signal}),iterator=archive.inputStream[Symbol.asyncIterator]();
      while(true){const next=await iterator.next();assert.equal(next.done,false);if(next.value.length===65536&&next.value[0]===1&&next.value[65535]===1)break;}
      assert.equal(await readers(blob),1);
      if(mode==='mutate'){const f=await open(blob,'r+');try{await f.write(Buffer.alloc(65536,2),0,65536,65536);}finally{await f.close();}}
      if(mode==='truncate')await truncate(blob,65536);
      if(mode==='abort')controller.abort();
      if(mode==='return')await iterator.return();
      else await assert.rejects(async()=>{while(!(await iterator.next()).done){}});
      assert.equal(await readers(blob),0);
    }finally{await rm(root,{recursive:true,force:true});}
  }
});
