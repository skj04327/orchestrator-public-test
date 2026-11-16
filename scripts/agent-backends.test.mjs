import test from 'node:test';
import assert from 'node:assert/strict';
import { runPlanner, runReviewer, parseReviewVerdict } from './agent-backends.mjs';
test('Claude planning extracts JSON output and passes read-only tools',async()=>{
  let called;
  const result=await runPlanner({provider:'claude',prompt:'plan',cwd:'/tmp',
    run:async(bin,args)=>{called={bin,args};return JSON.stringify({is_error:false,result:'Plan three steps'})}});
  assert.equal(result,'Plan three steps');
  assert.equal(called.bin,'claude');
  assert.ok(called.args.includes('Read,Glob,Grep'));
});
test('Gemini planning uses subscriber CLI and does not allow edits',async()=>{
  let called;
  const result=await runPlanner({provider:'gemini',prompt:'map task',run:async(bin,args)=>{called={bin,args};return 'Answer.'}});
  assert.equal(result,'Answer.');
  assert.equal(called.bin,'agy');
  assert.match(called.args.join(' '),/Do not modify any files/);
});
test('Gemini reviewing returns PASS or FAIL and unknown verdict fails closed',async()=>{
  const out=await runReviewer({provider:'gemini',prompt:'Review',run:async()=> 'FAIL\nBad source.'});
  assert.equal(parseReviewVerdict(out),'FAIL');
  assert.equal(parseReviewVerdict('PASS\nFine'),'PASS');
  assert.throws(()=>parseReviewVerdict('Sure, looks good.'));
});
test('Claude reviewing is supported and Codex reviewing blocked',async()=>{
  const out=await runReviewer({provider:'claude',prompt:'Review',run:async()=>JSON.stringify({result:'PASS\nChecks out'})});
  assert.equal(parseReviewVerdict(out),'PASS');
  await assert.rejects(runReviewer({provider:'codex',prompt:'x',run:async()=>''}));
});
test('empty or oversized model result is rejected',async()=>{
  await assert.rejects(runPlanner({provider:'gemini',prompt:'x',run:async()=>''}));
  await assert.rejects(runPlanner({provider:'claude',prompt:'x',run:async()=>JSON.stringify({is_error:true,result:'oops'})}));
});


test('Claude receives only a strict vetted local MCP config when explicitly staged',async()=>{
  let args;
  const text=await runPlanner({provider:'claude',prompt:'plan',mcpConfig:'/tmp/mock-refs.json',
    run:async(bin,argv)=>{args=argv;return JSON.stringify({result:'Valid plan',is_error:false})}});
  assert.equal(text,'Valid plan');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--mcp-config'));
  assert.ok(args.includes('/tmp/mock-refs.json'));
  assert.match(args[args.indexOf('--allowedTools')+1],/mcp__goryeo_refs__read_reference/);
  assert.ok(!args.includes('--dangerously-skip-permissions'));
});
