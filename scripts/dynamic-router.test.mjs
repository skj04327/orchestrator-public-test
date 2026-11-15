import test from 'node:test';
import assert from 'node:assert/strict';
import {routeTask,classifyTask,createRouteMetadata,ROUTER_VERSION} from './dynamic-router.mjs';

test('keeps current Claude-Codex-Gemini allocation for architecture',()=>{
  const route=routeTask('마을 걷기 엔진 리팩터링과 경로 최적화');
  assert.equal(route.controller,'claude');
  assert.equal(route.developer,'codex');
  assert.equal(route.reviewer,'gemini');
  assert.equal(route.autoMerge,false);
  assert.equal(route.paidApiAllowed,false);
});
test('chooses independent Gemini control tower for UI tasks',()=>{
  const route=routeTask('현재 탭 UI 버튼 위치를 수정해줘');
  assert.equal(route.controller,'gemini');
  assert.equal(route.developer,'codex');
  assert.equal(route.reviewer,'claude');
});
test('sensitive code retains strict independent reviewer',()=>{
  const route=routeTask('OAuth 로그인 권한 오류를 수정해줘');
  assert.equal(route.risk,'high');
  assert.equal(route.controller,'claude');
  assert.equal(route.reviewer,'gemini');
  assert.equal(route.explanationCode,'HIGH_RISK_STRICT_GATE');
});
test('stable mode always preserves current routing',()=>{
  const route=routeTask('화면 스타일 변경',{mode:'stable'});
  assert.equal(route.controller,'claude');
  assert.equal(route.reviewer,'gemini');
});
test('manual controller override with automatic independent reviewer',()=>{
  const a=routeTask('엔진 오류',{mode:'manual',controller:'gemini'});
  assert.equal(a.controller,'gemini');
  assert.equal(a.reviewer,'claude');
  const b=routeTask('엔진 오류',{mode:'manual',controller:'codex'});
  assert.equal(b.controller,'codex');
  assert.equal(b.reviewer,'gemini');
});
test('rejects unsupported provider, duplicate reviewer, unimplemented backend',()=>{
  assert.throws(()=>routeTask('test',{mode:'manual',controller:'openrouter'}));
  assert.throws(()=>routeTask('test',{mode:'manual',controller:'claude',developer:'gemini'}));
  assert.throws(()=>routeTask('test',{mode:'manual',controller:'gemini',reviewer:'gemini'}));
  assert.throws(()=>routeTask('test',{mode:'manual',controller:'codex',reviewer:'codex'}));
  assert.throws(()=>routeTask('test',{mode:'magic'}));
});
test('router does not expose task or invent model identity/effort',()=>{
  const task='민감한 게임 줄거리 코드 작업';
  const meta=createRouteMetadata(routeTask(task));
  assert.ok(!JSON.stringify(meta).includes('줄거리'));
  assert.deepEqual(meta.modelIds,{claude:null,codex:null,gemini:null});
  assert.deepEqual(meta.reasoningEfforts,{claude:null,codex:null,gemini:null});
  assert.equal(meta.policyVersion,ROUTER_VERSION);
});
test('rejects empty, too-long and nonstring task',()=>{
  assert.throws(()=>classifyTask(''));
  assert.throws(()=>classifyTask('x'.repeat(2501)));
  assert.throws(()=>routeTask({title:'work'}));
});
