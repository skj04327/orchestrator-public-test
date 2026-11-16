import test from 'node:test';
import assert from 'node:assert/strict';
import {validateBundle} from './private-task-bundle.mjs';
import {digestFileBuffers} from './verified-manifest.mjs';
import {createAuditLedger} from './audit-ledger.mjs';
const context={repository:'skj04327/orchestrator-public-test',taskId:'20261116T090000Z-123-456',runId:'42',runAttempt:'1',workflowSha:'a'.repeat(40)};
function fixture(){
  const ledger=createAuditLedger(context.taskId);
  for(const stage of ['typecheck','unit-test','build','review'])ledger.record({stage,status:'passed',actor:stage==='review'?'gemini':'system',verdict:stage==='review'?'PASS':null});
  const files=[{path:'src/one.ts',content:Buffer.from('export const one=1;\n')}];
  return {version:1,context,executionOutcome:'success',baseSha:'b'.repeat(40),
    audit:ledger.snapshot({status:'passed'}),files:files.map(f=>({...f,content:f.content.toString('base64')})),
    result:{id:context.taskId,paths:files.map(f=>f.path),verifiedContentSha256:digestFileBuffers(files),
      route:{controller:'claude',developer:'codex',reviewer:'gemini'}}};
}
test('bundle accepts captured bytes and rejects unsafe, duplicate, oversized and changed content',()=>{
  assert.equal(validateBundle(fixture(),context).files[0].content.toString(),'export const one=1;\n');
  for(const mutate of [
    b=>b.files[0].path='../secret',b=>b.files.push(b.files[0]),
    b=>b.files[0].content=Buffer.alloc(65001).toString('base64'),
    b=>b.files[0].content=Buffer.from('changed').toString('base64'),
    b=>b.result.paths=['src/other.ts'],b=>b.baseSha='not-a-sha',
    b=>b.files[0].content+='\n',b=>b.result.route.reviewer='claude'
  ]){const b=fixture();mutate(b);assert.throws(()=>validateBundle(b,context));}
});
test('failed, missing or superseded checks can never authorize source publication',()=>{
  for(const stage of ['typecheck','unit-test','build','review']){
    const b=fixture();b.audit.events=b.audit.events.filter(e=>e.stage!==stage);
    assert.throws(()=>validateBundle(b,context));
    const failed=fixture();failed.audit.events.push({...failed.audit.events.find(e=>e.stage===stage),status:'failed'});
    assert.throws(()=>validateBundle(failed,context));
  }
  const failed=fixture();failed.executionOutcome='failure';
  assert.throws(()=>validateBundle(failed,context));
  failed.result=null;failed.files=[];
  assert.equal(validateBundle(failed,context).result,null);
});
test('oversized audit cannot hide a late failed check through normalization truncation',()=>{
  const b=fixture();
  while(b.audit.events.length<90)b.audit.events.push({...b.audit.events[0]});
  b.audit.events.push({...b.audit.events[0],status:'failed'});
  assert.throws(()=>validateBundle(b,context));
});
