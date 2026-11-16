import test from 'node:test';
import assert from 'node:assert/strict';
import { recipientKey, seal, open, handoffContext } from './private-handoff.mjs';

const context={repository:'skj04327/orchestrator-public-test',taskId:'20261116T090000Z-123-456',runId:'42',runAttempt:'1',workflowSha:'a'.repeat(40)};
const key=recipientKey('synthetic-secret-only',context);
test('only recipient can read transport; ciphertext contains no source or task plaintext',()=>{
  const payload={source:'PRIVATE_SOURCE_SENTINEL',task:'PRIVATE_TASK_SENTINEL'};
  const bytes=seal(payload,key.publicKey,context);
  assert.ok(Buffer.isBuffer(bytes));
  assert.ok(!bytes.includes(Buffer.from('PRIVATE_SOURCE_SENTINEL')));
  assert.ok(!bytes.includes(Buffer.from('PRIVATE_TASK_SENTINEL')));
  assert.deepEqual(open(bytes,key.privateKey,context),payload);
  assert.throws(()=>open(bytes,recipientKey('other-secret',context).privateKey,context));
});
test('transport rejects corruption, truncation, trailing bytes and replay in another context',()=>{
  const bytes=seal({ok:true},key.publicKey,context);
  for(const index of [0,10,50,bytes.length-1]){
    const changed=Buffer.from(bytes);changed[index]^=1;
    assert.throws(()=>open(changed,key.privateKey,context));
  }
  assert.throws(()=>open(bytes.subarray(0,-1),key.privateKey,context));
  assert.throws(()=>open(Buffer.concat([bytes,Buffer.from('extra')]),key.privateKey,context));
  for(const field of ['taskId','runId','runAttempt','workflowSha']){
    const other={...context,[field]:field==='taskId'?'20261116T090001Z-123-456':field==='workflowSha'?'b'.repeat(40):'2'};
    assert.throws(()=>open(bytes,key.privateKey,other));
  }
  assert.notDeepEqual(seal({ok:true},key.publicKey,context),bytes);
});
test('transport is bounded and requires exact validated run context and secret',()=>{
  assert.throws(()=>seal({x:'x'.repeat(900000)},key.publicKey,context));
  assert.throws(()=>open(Buffer.alloc(900000),key.privateKey,context));
  assert.throws(()=>recipientKey('',context));
  assert.throws(()=>handoffContext({...context,taskId:'../unsafe'}));
  assert.throws(()=>handoffContext({...context,runId:'1\nINJECT=1'}));
  assert.throws(()=>handoffContext({...context,repository:'other/repo'}));
  assert.throws(()=>handoffContext({...context,extra:'untrusted'}));
});
