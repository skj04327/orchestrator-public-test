import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {submitLocalCandidate} from './local-candidate-intake.mjs';
import {prepareLocalJob,readLocalJob} from './local-jobs.mjs';
import {captureDiskCheckInput} from './disk-check-input.mjs';
import {captureCheckSnapshot} from './independent-check-input.mjs';
import {open,recipientKey,MAX_HANDOFF_BYTES} from './private-handoff.mjs';
import {diskCheckFixture} from './test-fixtures/disk-check.mjs';
import {independentProject} from './test-fixtures/independent-project.mjs';
import {makeLocalReceipt} from './test-fixtures/local-receipt.mjs';

const actions=process.env.GITHUB_ACTIONS;
before(()=>{delete process.env.GITHUB_ACTIONS;});
after(()=>{if(actions===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=actions;});
const encode=value=>Buffer.from(JSON.stringify(value));

test('a prepared job accepts one reply bound to its run and exact disk manifest',async()=>{
  const root=await mkdtemp(join(tmpdir(),'candidate-intake-'));
  try{
    const f=await makeLocalReceipt(root),job=await prepareLocalJob(f);
    const {diskSnapshot}=await diskCheckFixture(root,{context:job.context});
    const key=recipientKey('SYNTHETIC_INTAKE',job.context);
    const value={schemaVersion:1,runId:job.context.runId,baselineManifestSha256:diskSnapshot.manifestSha256,
      files:[{path:'src/status.ts',content:'export const n=3; // 합성 데이터\n'}]};
    const opts={...f,diskSnapshot,publicKey:key.publicKey};
    for(const invalid of [
      {...value,runId:'3dfdb025-3a63-4fcf-94e0-d433d19f8d1c'},
      {...value,baselineManifestSha256:'a'.repeat(64)},
      {...value,publishAuthorized:true},
      {...value,files:[{path:'tests/status.test.ts',content:'SYNTHETIC_REPLACEMENT'}]},
      {...value,files:[{path:'src/.env/config.ts',content:'SYNTHETIC_DISALLOWED'}]},
      {...value,files:[{path:'src/status.ts',content:'\ud800'}]}
    ])await assert.rejects(submitLocalCandidate({...opts,response:encode(invalid)}));
    for(const response of [Buffer.alloc(MAX_HANDOFF_BYTES+1),Buffer.from([0xff]),Buffer.from('```json\n{}\n```')]){
      await assert.rejects(submitLocalCandidate({...opts,response}));
    }
    await assert.rejects(submitLocalCandidate({...opts,response:encode(value),diskSnapshot:structuredClone(diskSnapshot)}));
    const archive=await diskCheckFixture(join(root,'archive'),{context:job.context,purpose:'data-only'});
    await assert.rejects(submitLocalCandidate({...opts,diskSnapshot:archive.diskSnapshot,
      response:encode({...value,baselineManifestSha256:archive.diskSnapshot.manifestSha256})}),{failureKind:'disk_execution_denied'});
    await assert.rejects(submitLocalCandidate({...opts,response:encode(value),signal:AbortSignal.abort()}));
    assert.equal((await readLocalJob(f)).phase,'prepared');
    const competing=await Promise.allSettled([submitLocalCandidate({...opts,response:encode(value)}),submitLocalCandidate({...opts,response:encode(value)})]);
    const completed=competing.filter(r=>r.status==='fulfilled');
    assert.equal(completed.length,1);
    assert.equal(completed[0].value.phase,'awaiting-independent-validation');
    assert.doesNotMatch(JSON.stringify(completed[0].value),/합성 데이터/);
    const encrypted=await readFile(join(f.stateRoot,f.id,'result.enc'));
    const bundle=open(encrypted,key.privateKey,job.context);
    assert.equal(bundle.baselineManifestSha256,value.baselineManifestSha256);
    assert.equal(Buffer.from(bundle.files[0].content,'base64').toString('utf8'),value.files[0].content);
    assert.equal(captureDiskCheckInput({diskSnapshot,bundle,context:job.context}).baselineManifestSha256,value.baselineManifestSha256);
    assert.throws(()=>captureDiskCheckInput({diskSnapshot,context:job.context,bundle:{...bundle,baselineManifestSha256:'a'.repeat(64)}}),/Wrong disk baseline/);
    const baseline={...independentProject(job.context).baseline,baseSha:diskSnapshot.baseSha};
    assert.throws(()=>captureCheckSnapshot({baseline,bundle,context:job.context}),/Disk-bound candidate requires direct disk checks/);
  }finally{await rm(root,{recursive:true,force:true});}
});
