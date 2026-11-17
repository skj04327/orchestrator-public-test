import test from 'node:test';
import assert from 'node:assert/strict';
import {captureCheckSnapshot} from './independent-check-input.mjs';
import {createAuditLedger} from './audit-ledger.mjs';
import {digestFileBuffers} from './verified-manifest.mjs';
const context={kind:'local',schemaVersion:2,taskId:'20261117T100000Z-123-456',runId:'12345678-1234-4234-8234-123456789abc',queueCommitSha:'e'.repeat(40),receiptSha256:'f'.repeat(64)};
const file=(path,content)=>({path,content:Buffer.from(content).toString('base64')});
function fixture(){
  const files=[file('src/status.ts','export const n=2;')],ledger=createAuditLedger(context.taskId);
  for(const stage of ['typecheck','unit-test','build','review'])ledger.record({stage,status:'passed',actor:stage==='review'?'gemini':'system',verdict:stage==='review'?'PASS':null});
  const baseline={baseSha:'d'.repeat(40),files:[file('package.json','{}'),file('package-lock.json','{}'),file('src/status.ts','export const n=1;'),file('tests/existing.test.ts','BASE_TEST')]};
  const bundle={version:1,context,executionOutcome:'success',baseSha:baseline.baseSha,files,audit:ledger.snapshot({status:'passed'}),result:{id:context.taskId,paths:['src/status.ts'],verifiedContentSha256:digestFileBuffers([{path:'src/status.ts',content:Buffer.from('export const n=2;')}]),route:{controller:'claude',developer:'codex',reviewer:'gemini'}}};
  return {context,baseline,bundle};
}
test('captured snapshots bind all baseline bytes and candidate bytes before caller mutation',()=>{
  const f=fixture(),snapshot=captureCheckSnapshot(f),payload=Buffer.from(snapshot.payload);
  f.baseline.files[0].content=Buffer.from('CHANGED').toString('base64');f.bundle.files[0].content='CHANGED';
  assert.deepEqual(snapshot.payload,payload);
  const parsed=JSON.parse(payload);assert.equal(Buffer.from(parsed.baseline[0].content,'base64').toString(),'{}');
  assert.equal(snapshot.baseSha,'d'.repeat(40));assert.match(snapshot.baselineContentSha256,/^[a-f0-9]{64}$/);
  const other=fixture();other.baseline.files[0]=file('package.json','{"scripts":{}}');
  assert.notEqual(captureCheckSnapshot(other).baselineContentSha256,snapshot.baselineContentSha256);
});
test('snapshot rejects stale base, existing-test overwrite, unsafe baseline paths and credential/cache files',()=>{
  for(const mutate of [
    f=>f.baseline.baseSha='a'.repeat(40),
    f=>{f.bundle.files=[file('tests/existing.test.ts','REPLACED')];f.bundle.result.paths=['tests/existing.test.ts'];f.bundle.result.verifiedContentSha256=digestFileBuffers([{path:'tests/existing.test.ts',content:Buffer.from('REPLACED')}]);},
    ...['../outside','/absolute','a//b','.git/config','node_modules/a.js','.env','.npmrc','a/../b','.codex/auth.json','src/status.ts/child',
      '.config/gcloud/application_default_credentials.json','.docker/config.json','.azure/accessTokens.json','.cache/npm/data','.npm/cache'].map(path=>f=>f.baseline.files.push(file(path,'BAD'))),
    f=>f.baseline.files.push(f.baseline.files[0]),f=>f.baseline.files.pop()&&f.baseline.files.shift(),
    f=>f.baseline.files[0].content='%%%bad',f=>f.baseline.files[0]=file('package.json','x'.repeat(1048577))
  ]){const f=fixture();mutate(f);assert.throws(()=>captureCheckSnapshot(f));}
});
test('existing colocated test/spec and test directories cannot be overwritten as source files',()=>{
  for(const path of ['src/status.test.ts','src/status.spec.tsx','src/__tests__/status.ts','src/test/status.ts']){
    const f=fixture();f.baseline.files.push(file(path,'EXISTING_TEST'));
    f.bundle.files=[file(path,'REPLACED')];f.bundle.result.paths=[path];
    f.bundle.result.verifiedContentSha256=digestFileBuffers([{path,content:Buffer.from('REPLACED')}]);
    assert.throws(()=>captureCheckSnapshot(f));
  }
});
test('ordinary sibling names that share a prefix are not directory collisions',()=>{
  const f=fixture();f.baseline.files.push(file('LICENSE','a'),file('LICENSE2','b'));
  assert.doesNotThrow(()=>captureCheckSnapshot(f));
});
