import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizePrivateReport } from './persist-private-audit.mjs';
const id='20261115T121256Z-10360-7098';
const now='2026-11-15T12:12:56.000Z';

test('failed checks remain failed and never include workspace data',()=>{
  const existing={taskId:id,startedAt:now,status:'failed',events:[
    {stage:'unit-test',actor:'system',status:'failed',failureKind:'output_limit',
      timestamp:now,privateDiagnostic:'SECRET SOURCE',modelId:null,reasoningEffort:null}
  ]};
  const result=finalizePrivateReport(id,existing,'skipped');
  assert.equal(result.status,'failed');
  assert.equal(result.events[0].failureKind,'output_limit');
  assert.equal(result.events[1].stage,'publish');
  assert.ok(!JSON.stringify(result).includes('SECRET SOURCE'));
});
test('publish success requires clean execution and records only verified private URL',()=>{
  const existing={taskId:id,startedAt:now,status:'passed',events:[
    {stage:'review',actor:'gemini',status:'passed',timestamp:now,verdict:'PASS'}
  ]};
  const url='https://github.com/skj04327/the-twilight-of-korea/pull/321';
  const report=finalizePrivateReport(id,existing,'success',url);
  assert.equal(report.status,'passed');
  assert.equal(report.prUrl,url);
  assert.equal(report.events[1].status,'passed');
  assert.throws(()=>finalizePrivateReport(id,existing,'success','https://malicious.invalid/pull/1'));
});
test('missing report fails closed',()=>{
  const report=finalizePrivateReport(id,null,'skipped');
  assert.equal(report.status,'failed');
  assert.equal(report.events[0].stage,'intake');
  assert.throws(()=>finalizePrivateReport('bad-id',null,'skipped'));
});
