import test from 'node:test';
import assert from 'node:assert/strict';
import {open,recipientKey} from './private-handoff.mjs';
import {sealLocalCandidate,validateLocalCheckBundle} from './local-candidate-bundle.mjs';
import {validateBundle} from './private-task-bundle.mjs';
import {captureCheckSnapshot,parseCheckPayload} from './independent-check-input.mjs';
import {independentProject} from './test-fixtures/independent-project.mjs';

const context={kind:'local',schemaVersion:2,taskId:'20261119T021500Z-123-456',
  runId:'3dfdb025-3a63-4fcf-94e0-d433d19f8d1c',queueCommitSha:'a'.repeat(40),receiptSha256:'b'.repeat(64)};
const key=recipientKey('SYNTHETIC_LOCAL_RECIPIENT',context);
const {baseline}=independentProject(context);
const files=[{path:'src/status.ts',content:Buffer.from('export const n=3;\n')}];

test('a candidate without a worker check or review claim reaches the local checker only',()=>{
  const encrypted=sealLocalCandidate({context,publicKey:key.publicKey,baseSha:baseline.baseSha,files});
  const candidate=open(encrypted,key.privateKey,context);
  assert.deepEqual(Object.keys(candidate).sort(),['baseSha','candidateContentSha256','context','files','kind']);
  const result=captureCheckSnapshot({context,bundle:candidate,baseline});
  assert.equal(result.candidateContentSha256,candidate.candidateContentSha256);
  assert.deepEqual(parseCheckPayload(result.payload).candidate,[{path:'src/status.ts',content:files[0].content.toString('base64')}]);
  assert.throws(()=>validateBundle(candidate,context),/Invalid bundle context/);
  const github={repository:'skj04327/orchestrator-public-test',taskId:context.taskId,runId:'12',runAttempt:'1',workflowSha:'e'.repeat(40)};
  assert.throws(()=>open(encrypted,recipientKey('SYNTHETIC_LOCAL_RECIPIENT',github).privateKey,github));
  assert.throws(()=>sealLocalCandidate({context:github,publicKey:key.publicKey,baseSha:baseline.baseSha,files}));
});

test('candidate verification rejects altered context, bytes, scope and authorization claims',()=>{
  const candidate=open(sealLocalCandidate({context,publicKey:key.publicKey,baseSha:baseline.baseSha,files}),key.privateKey,context);
  const patches=[
    {context:{...context,queueCommitSha:'c'.repeat(40)}},
    {baseSha:[baseline.baseSha]},
    {files:[{path:'src/status.ts',content:Buffer.from('DIFFERENT').toString('base64')}]},
    {files:[{path:'src/status.ts',content:'////='}]},
    {files:Array(9).fill(candidate.files[0])},
    {files:[{path:'package.json',content:'e30='}]},
    {files:[{path:'src/./status.ts',content:candidate.files[0].content}]},
    {publishAuthorized:true},
    {audit:{status:'passed'}}
  ];
  for(const patch of patches)assert.throws(()=>validateLocalCheckBundle({...candidate,...patch},context));
  assert.throws(()=>sealLocalCandidate({context,publicKey:key.publicKey,baseSha:baseline.baseSha,
    files:[{path:'src/./status.ts',content:files[0].content}]}));
  assert.throws(()=>captureCheckSnapshot({context,bundle:{...candidate,baseSha:'f'.repeat(40)},baseline}),/Wrong baseline commit/);
});
