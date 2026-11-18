import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as disk from './disk-check-input.mjs';
import {diskCheckFixture,encoded,replaceCandidate} from './test-fixtures/disk-check.mjs';
const actions=process.env.GITHUB_ACTIONS;
before(()=>{delete process.env.GITHUB_ACTIONS;});after(()=>{if(actions===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=actions;});
test('opaque candidate captures bytes/digest before mutation, adds safe tests and never promotes data-only or copied handles',async()=>{
  assert.equal(typeof disk.captureDiskCheckInput,'function');const root=await mkdtemp(join(tmpdir(),'disk-candidate-'));
  try{
    const f=await diskCheckFixture(root),input=disk.captureDiskCheckInput(f),proof=disk.getDiskCheckProvenance(input);
    assert.equal(proof.baseSha,f.source.baseSha);assert.equal(proof.baselineProvenance.manifestSha256,f.snapshot.manifestSha256);
    const before=disk.createDiskCheckArchive(input,{variant:'candidate'}).overlayArchive;
    f.bundle.files[0].content=Buffer.from('MUTATED').toString('base64');
    assert.deepEqual(disk.createDiskCheckArchive(input,{variant:'candidate'}).overlayArchive,before);
    assert.equal(disk.createDiskCheckArchive(input,{variant:'baseline'}).overlayArchive,null);
    assert.throws(()=>disk.getDiskCheckProvenance(structuredClone(input)));
    assert.throws(()=>disk.createDiskCheckArchive(input,{variant:'forged'}));
    const fresh=await diskCheckFixture(join(root,'new'));replaceCandidate(fresh.bundle,[encoded('tests/new.test.ts','// new')]);assert.ok(disk.captureDiskCheckInput(fresh));
    const data=await diskCheckFixture(join(root,'data'),{purpose:'data-only'});assert.throws(()=>disk.captureDiskCheckInput(data));
    assert.throws(()=>disk.captureDiskCheckInput({...fresh,diskSnapshot:structuredClone(fresh.snapshot)}));
  }finally{await rm(root,{recursive:true,force:true});}
});
test('candidate cannot replace existing tests, collide with baseline files/directories, exceed counts or change configuration',async()=>{
  assert.equal(typeof disk.captureDiskCheckInput,'function');
  for(const mode of ['test','src-test','parent','child','config','wrong-base','capacity']){
    const root=await mkdtemp(join(tmpdir(),'disk-candidate-policy-'));
    try{
      const extra=mode==='src-test'?[encoded('src/old.spec.ts','// existing')]:mode==='parent'?[encoded('src/status.ts/nested.bin','child')]:mode==='child'?[encoded('src/block.ts','file')]:[];
      // The parent case uses a different candidate so the Git fixture itself stays valid.
      if(mode==='parent')extra[0].path='src/blocked.ts/child.bin';
      const f=await diskCheckFixture(root,{extra});
      const path=mode==='test'?'tests/status.test.ts':mode==='src-test'?'src/old.spec.ts':mode==='parent'?'src/blocked.ts':mode==='child'?'src/block.ts/child.ts':mode==='config'?'package.json':'src/status.ts';
      if(mode==='config'){f.bundle.files=[encoded(path,'{}')];f.bundle.result.paths=[path];}
      else if(mode==='capacity'){f.bundle.files=Array.from({length:9},(_,i)=>encoded('src/n'+i+'.ts','x'));f.bundle.result.paths=f.bundle.files.map(f=>f.path);}
      else replaceCandidate(f.bundle,[encoded(path,'x')]);
      if(mode==='wrong-base')f.bundle.baseSha='a'.repeat(40);
      assert.throws(()=>disk.captureDiskCheckInput(f));
    }finally{await rm(root,{recursive:true,force:true});}
  }
});
test('a complete 10000-file baseline permits replacement but refuses even one additional candidate file',async()=>{
  const root=await mkdtemp(join(tmpdir(),'disk-full-count-'));
  try{
    const extra=Array.from({length:9993},(_,i)=>encoded('public/a'+i+'.bin',''));
    const f=await diskCheckFixture(root,{extra});assert.equal(f.snapshot.fileCount,10000);
    assert.ok(disk.captureDiskCheckInput(f));replaceCandidate(f.bundle,[encoded('src/extra.ts','x')]);assert.throws(()=>disk.captureDiskCheckInput(f),/capacity/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('candidate paths must be canonical, exclude restricted directories and retain exact disk length/depth bounds',async()=>{
  const root=await mkdtemp(join(tmpdir(),'disk-canonical-'));
  try{
    const f=await diskCheckFixture(root,{extra:[encoded('src/existing.spec.ts','// original test')]});
    for(const path of ['src/./existing.spec.ts','src/.aws/leak.ts','src/'+('x'.repeat(241))+'.ts','src/'+('a/'.repeat(32))+'x.ts']){
      replaceCandidate(f.bundle,[encoded(path,'// replacement')]);assert.throws(()=>disk.captureDiskCheckInput(f));
    }
  }finally{await rm(root,{recursive:true,force:true});}
});
