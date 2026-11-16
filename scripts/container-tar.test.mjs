import test from 'node:test';
import assert from 'node:assert/strict';
import {readDockerFile,makeTarFile} from './container-tar.mjs';
test('Docker copy is read as one bounded regular file without archive extraction',()=>{
  const archive=makeTarFile('result.json',Buffer.from('safe'));
  assert.equal(readDockerFile(archive,'result.json',20).toString(),'safe');
  assert.throws(()=>readDockerFile(archive,'other.json',20));
  assert.throws(()=>readDockerFile(archive,'result.json',3));
  assert.throws(()=>readDockerFile(Buffer.concat([archive,Buffer.from('extra')]),'result.json',20));
});
test('host exporter rejects link/directory/PAX/traversal/extra-file archives and corruption',()=>{
  const base=makeTarFile('result.json',Buffer.from('safe'));
  const checksum=bytes=>{bytes.fill(32,148,156);const sum=bytes.subarray(0,512).reduce((a,b)=>a+b,0);bytes.write(sum.toString(8).padStart(6,'0')+'\0 ',148);return bytes;};
  for(const type of ['1','2','5','x','g']){
    const a=Buffer.from(base);a.write(type,156);assert.throws(()=>readDockerFile(checksum(a),'result.json',20));
  }
  for(const path of ['../result.json','/result.json','dir/result.json']){
    const a=Buffer.from(base);a.fill(0,0,100);a.write(path,0);assert.throws(()=>readDockerFile(checksum(a),'result.json',20));
  }
  const corrupt=Buffer.from(base);corrupt[0]^=1;
  assert.throws(()=>readDockerFile(corrupt,'result.json',20));
  assert.throws(()=>readDockerFile(Buffer.concat([base.subarray(0,-1024),base]),'result.json',20));
  assert.throws(()=>readDockerFile(base.subarray(0,520),'result.json',20));
});
