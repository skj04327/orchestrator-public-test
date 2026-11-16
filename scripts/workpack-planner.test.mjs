import test from 'node:test';
import assert from 'node:assert/strict';
import {parseWorkplan,assertExecutableWorkplan,requiresImageGeneration,makeCodePrompt,MAX_CODE_WORKPACKS} from './workpack-planner.mjs';
const task='인물 50명 추가해줘';
const plan={
  schemaVersion:1,
  workpacks:[
    {id:'P1',kind:'code',title:'캐릭터 자료형 정의',instructions:'Define safe typed data definitions for characters.',dependsOn:[],files:['src/data/characters.ts']},
    {id:'P2',kind:'code',title:'50명 인물 배치',instructions:'Populate all requested characters and verify exported references.',dependsOn:['P1'],files:['src/data/npc-characters.ts']}
  ]
};
test('validates deterministic delegation and dependencies',()=>{
  const p=parseWorkplan(JSON.stringify(plan),task);
  assert.equal(p.codeCount,2);
  assert.equal(p.imageCount,0);
  assert.deepEqual(p.workpacks.map(x=>x.worker),['codex','codex']);
  assert.equal(assertExecutableWorkplan(p),true);
  const prompt=makeCodePrompt({task,workpack:p.workpacks[0],index:1,total:2,sourceRules:'Only edit src files.'});
  assert.match(prompt,/50명/);
  assert.match(prompt,/P1/);
  assert.equal(MAX_CODE_WORKPACKS,3);
});
test('accepts JSON fence but rejects non-JSON planner chatter',()=>{
  assert.equal(parseWorkplan('```json\n'+JSON.stringify(plan)+'\n```',task).codeCount,2);
  assert.throws(()=>parseWorkplan('Sure, here is the plan: '+JSON.stringify(plan),task));
});
test('image generation request must include a blocked image workpack',()=>{
  const imageTask='인물 초상화 이미지 50장 만들어서 게임에 추가';
  assert.equal(requiresImageGeneration(imageTask),true);
  assert.throws(()=>parseWorkplan(JSON.stringify(plan),imageTask),/omitted/);
  const withImage={schemaVersion:1,workpacks:[plan.workpacks[0],{
    id:'P2',kind:'image',title:'일러스트 제작',instructions:'Create original portraits for the new game characters.',dependsOn:['P1'],files:[]}
  ]};
  const p=parseWorkplan(JSON.stringify(withImage),imageTask);
  assert.equal(p.imageCount,1);
  assert.throws(()=>assertExecutableWorkplan(p),e=>e.failureKind==='blocked_capability');
});
test('rejects invalid DAG and unsafe output paths',()=>{
  const broken=structuredClone(plan);broken.workpacks[0].dependsOn=['P2'];
  assert.throws(()=>parseWorkplan(JSON.stringify(broken),task));
  const unsafe=structuredClone(plan);unsafe.workpacks[0].files=['.github/workflows/deploy.yml'];
  assert.throws(()=>parseWorkplan(JSON.stringify(unsafe),task));
  const duplicate=structuredClone(plan);duplicate.workpacks[1].id='P1';
  assert.throws(()=>parseWorkplan(JSON.stringify(duplicate),task));
});
test('rejects unbounded, ambiguous and unsupported workpack types',()=>{
  const long=structuredClone(plan);long.workpacks[0].instructions='x'.repeat(2200);
  assert.throws(()=>parseWorkplan(JSON.stringify(long),task));
  const unsupported=structuredClone(plan);unsupported.workpacks[0].kind='deploy';
  assert.throws(()=>parseWorkplan(JSON.stringify(unsupported),task));
  const oversized=structuredClone(plan);oversized.workpacks=[...plan.workpacks,...plan.workpacks,...plan.workpacks];
  assert.throws(()=>parseWorkplan(JSON.stringify(oversized),task));
  const extra=structuredClone(plan);extra.workpacks[0].apiKey='SHOULD_NOT_ENTER_SCHEMA';
  assert.throws(()=>parseWorkplan(JSON.stringify(extra),task));
});
test('does not infer images from a plain character data request',()=>{
  assert.equal(requiresImageGeneration(task),false);
});


test('image analysis and reference screenshots do not trigger image generation',()=>{
  for(const prompt of [
    '첨부한 이미지를 읽고 한옥마을 위치를 분석해줘',
    '이 위성사진을 참고해서 길 배치 코드를 수정해줘',
    '지도 화면 이미지를 보고 더 자연스럽게 만들어줘'
  ])assert.equal(requiresImageGeneration(prompt),false);
  for(const prompt of [
    '인물 초상화 이미지 50장 만들어서 게임에 추가',
    '마을 스프라이트를 생성해줘',
    'Generate original portraits'
  ])assert.equal(requiresImageGeneration(prompt),true);
});
