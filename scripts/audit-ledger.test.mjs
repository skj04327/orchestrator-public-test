import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeAuditEvent,createAuditLedger,writePrivateAuditReport,readPrivateAuditReport
} from './audit-ledger.mjs';
const id='20261115T121256Z-10360-7098';
const fixed='2026-11-15T12:12:56.000Z';

test('records a minimal event without assuming model or reasoning level',()=>{
  const a=normalizeAuditEvent({stage:'plan',actor:'claude',status:'passed'},fixed);
  assert.equal(a.modelId,null);
  assert.equal(a.reasoningEffort,null);
  assert.equal(a.tokenUsage,null);
  assert.equal(a.timestamp,fixed);
});
test('removes unrecognized fields including raw prompt and secrets',()=>{
  const a=normalizeAuditEvent({
    stage:'implementation',actor:'codex',status:'started',
    prompt:'secret',rawOutput:'PRIVATE SOURCE',apiKey:'not to serialize',
    modelId:'verified/cli-version',reasoningEffort:'medium'
  },fixed);
  assert.ok(!('prompt' in a));
  assert.ok(!('rawOutput' in a));
  assert.ok(!('apiKey' in a));
  assert.equal(a.modelId,'verified/cli-version');
  assert.equal(a.reasoningEffort,'medium');
});
test('rejects unexpected stage, actor, verdict and oversized identifiers',()=>{
  for(const event of [
    {stage:'steal',actor:'system',status:'passed'},
    {stage:'plan',actor:'unknown',status:'passed'},
    {stage:'plan',actor:'claude',status:'passed',verdict:'APPROVED'},
    {stage:'plan',actor:'claude',status:'passed',modelId:'x'.repeat(1000)},
    {stage:'plan',actor:'claude',status:'passed',durationMs:-5}
  ]) assert.throws(()=>normalizeAuditEvent(event,fixed));
});
test('creates stable summary and protects snapshot from future mutations',()=>{
  const ledger=createAuditLedger(id,{startedAt:fixed});
  ledger.record({stage:'plan',actor:'claude',status:'passed',durationMs:3000},fixed);
  ledger.record({stage:'review',actor:'gemini',status:'failed',verdict:'FAIL'},fixed);
  const snapshot=ledger.snapshot({status:'failed'});
  assert.equal(snapshot.totalEvents,2);
  assert.deepEqual(snapshot.checks,{passed:1,failed:1,skipped:0});
  snapshot.events[0].stage='steal';
  assert.equal(ledger.snapshot().events[0].stage,'plan');
  assert.throws(()=>ledger.snapshot({prUrl:'https://attacker.example.com/steal'}));
});
test('writes secure JSON and reads it back',async()=>{
  const root=await mkdtemp(join(tmpdir(),'audit-test-'));
  try{
    const ledger=createAuditLedger(id,{startedAt:fixed});
    ledger.record({stage:'publish',actor:'system',status:'passed',verdict:'PASS'},fixed);
    const report=ledger.snapshot({status:'passed',prUrl:'https://github.com/skj04327/the-twilight-of-korea/pull/123'});
    const path=await writePrivateAuditReport(join(root,'private'),report);
    assert.equal((await readPrivateAuditReport(path)).status,'passed');
    const raw=await readFile(path,'utf8');
    assert.ok(!raw.includes('PRIVATE SOURCE'));
  } finally{await rm(root,{recursive:true,force:true});}
});
