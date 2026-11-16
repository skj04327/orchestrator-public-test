// Contract test of the REAL runner, publisher and audit with only a public fake checkout.
// No subscription CLI, real game files, GitHub token, or external network is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,chmod,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {recipientKey} from './private-handoff.mjs';
import {spawn} from 'node:child_process';

const ID='20261116T090000Z-123-456';
const SEAL=resolve('scripts/seal-private-task.mjs');
const RUNNER=resolve('scripts/execute-private-task.mjs');
const PUBLISH=resolve('scripts/publish-private-task.mjs');
const PERSIST=resolve('scripts/persist-private-audit.mjs');
const MOCK_CLI=resolve('scripts/test-fixtures/mock-cli.mjs');
const MOCK_FETCH=resolve('scripts/test-fixtures/mock-fetch.mjs');
const plan={schemaVersion:1,workpacks:[
  {id:'P1',kind:'code',title:'Fixture data',instructions:'Create a standalone character data module.',dependsOn:[],files:['src/generated-one.ts']},
  {id:'P2',kind:'code',title:'Fixture integration',instructions:'Create a second module building on the previous work.',dependsOn:['P1'],files:['src/generated-two.ts']}
]};
const imagePlan={schemaVersion:1,workpacks:[
  {id:'P1',kind:'image',title:'Fixture portraits',instructions:'Generate original portraits for the user request.',dependsOn:[],files:[]}
]};
function cmd(bin,args,opts={}){
  return new Promise((resolvePromise,reject)=>{
    const ps=spawn(bin,args,{cwd:opts.cwd,env:opts.env,stdio:['ignore','pipe','pipe']});
    let out='',err='',done=false;
    const timer=setTimeout(()=>{
      if(!done){done=true;ps.kill('SIGKILL');reject(Error('Fixture process timed out'));}
    },25000);
    ps.stdout.on('data',x=>out+=x.toString('utf8'));
    ps.stderr.on('data',x=>err+=x.toString('utf8'));
    ps.on('error',e=>{if(!done){done=true;clearTimeout(timer);reject(e);}});
    ps.on('close',code=>{if(!done){done=true;clearTimeout(timer);resolvePromise({code,out,err});}});
  });
}
async function fixture(task,workplan,{failTests=false}={}){
  const root=await mkdtemp(join(tmpdir(),'orchestrator-offline-'));
  const privateGame=join(root,'private-game'),binDir=join(root,'fake-bin');
  const taskDir=join(root,'task-private','docs','orchestrator','tasks');
  await mkdir(join(privateGame,'src'),{recursive:true});
  await mkdir(binDir,{recursive:true});
  await mkdir(taskDir,{recursive:true});
  await writeFile(join(privateGame,'src','baseline.ts'),'export const baseline = true;\n');
  await writeFile(join(privateGame,'package.json'),JSON.stringify({name:'public-fixture-only',private:true,type:'module'})+'\n');
  await writeFile(join(taskDir,ID+'.txt'),task);
  const planFile=join(root,'plan.json');
  await writeFile(planFile,JSON.stringify(workplan));
  const callLog=join(root,'mock-calls.jsonl'),fetchLog=join(root,'fake-fetch-calls.jsonl');
  await writeFile(callLog,'');await writeFile(fetchLog,'');
  const content=await readFile(MOCK_CLI,'utf8');
  for(const name of ['npm','claude','agy','codex']){
    const file=join(binDir,name);
    await writeFile(file,content);await chmod(file,0o755);
  }
  const env={...process.env,PATH:binDir+':'+process.env.PATH,TASK_ID:ID,
    MOCK_PLAN_FILE:planFile,MOCK_CALL_LOG:callLog,
    MOCK_FETCH_LOG:fetchLog,MOCK_GAME_ROOT:privateGame,
    MOCK_FAIL_TESTS:failTests?'1':'0',
    ORCHESTRATOR_AUDIT_DIR:join(root,'private-audit'),
    ORCHESTRATOR_ROUTING_MODE:'stable',ORCHESTRATOR_CONTROLLER:'auto',
    GITHUB_REPOSITORY:'skj04327/orchestrator-public-test',GITHUB_RUN_ID:'42',GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:'a'.repeat(40),
    ANTHROPIC_API_KEY:'',OPENAI_API_KEY:'',GEMINI_API_KEY:'',GOOGLE_API_KEY:''
  };
  for(const args of [
    ['init','-q','-b','main'],['config','user.name','Offline Fixture'],
    ['config','user.email','fixture@example.invalid'],['add','.'],['commit','-qm','initial synthetic fixture']
  ]){
    const result=await cmd('git',args,{cwd:privateGame,env});
    assert.equal(result.code,0,'Fixture git setup failed: '+result.err);
  }
  const head=(await cmd('git',['rev-parse','HEAD'],{cwd:privateGame,env})).out.trim();
  const context={repository:env.GITHUB_REPOSITORY,taskId:ID,runId:'42',runAttempt:'1',workflowSha:env.GITHUB_SHA};
  const publicKey=recipientKey('FIXTURE_TOKEN',context).publicKey;
  return {root,env:{...env,HANDOFF_PUBLIC_KEY:publicKey,MOCK_GIT_HEAD:head},callLog,fetchLog};
}
async function publish(f,{outcome='success',corrupt=false,trustedOutcome=outcome}={}){
  const sealed=await cmd(process.execPath,[SEAL],{cwd:f.root,env:{...f.env,EXECUTION_OUTCOME:outcome}});
  if(sealed.code!==0)return sealed;
  const fresh=await mkdtemp(join(tmpdir(),'orchestrator-publisher-'));
  try{
    let bytes=await readFile(join(f.root,'.private-handoff.enc'));
    if(corrupt){bytes=Buffer.from(bytes);bytes[bytes.length-1]^=1;}
    await writeFile(join(fresh,'.private-handoff.enc'),bytes);
    const pub=await cmd(process.execPath,['--import',MOCK_FETCH,PUBLISH],{cwd:fresh,
      env:{...f.env,EXECUTION_OUTCOME:trustedOutcome,PRIVATE_GAME_WRITE_TOKEN:'FIXTURE_TOKEN',ORCHESTRATOR_AUDIT_DIR:join(fresh,'audit')}});
    // Publisher must work with NO game checkout, git config, model CLI or task input.
    assert.equal(await exists(join(fresh,'private-game')),false);
    for(const name of ['.private-task-pr.json']){
      if(await exists(join(fresh,name)))await writeFile(join(f.root,name),await readFile(join(fresh,name)));
    }
    return pub;
  }finally{await rm(fresh,{recursive:true,force:true});}
}
const readLines=async path=>(await readFile(path,'utf8')).split('\n').filter(Boolean).map(x=>JSON.parse(x));
const report=async f=>JSON.parse(await readFile(join(f.root,'private-audit',ID+'.json'),'utf8'));
const exists=async path=>access(path).then(()=>true,()=>false);

test('isolated publisher blocks corrupt transport and failed worker before any GitHub call',async()=>{
  for(const outcome of ['success','failure']){
    const f=await fixture('Synthetic harmless code task',plan);
    try{
      const run=await cmd(process.execPath,[RUNNER],{cwd:f.root,env:f.env});
      assert.equal(run.code,0,run.out+'\n'+run.err);
      const pub=await publish(f,{outcome,corrupt:outcome==='success'});
      assert.equal(pub.code,1);
      assert.equal((await readLines(f.fetchLog)).length,0);
      assert.match(pub.err,/PUBLISH_FAILED/);
    }finally{await rm(f.root,{recursive:true,force:true});}
  }
});
test('trusted workflow outcome overrides a success claim inside encrypted payload',async()=>{
  const f=await fixture('Synthetic harmless code task',plan);
  try{
    const run=await cmd(process.execPath,[RUNNER],{cwd:f.root,env:f.env});
    assert.equal(run.code,0);
    const pub=await publish(f,{trustedOutcome:'failure'});
    assert.equal(pub.code,1);
    assert.equal((await readLines(f.fetchLog)).length,0);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('publisher refuses stale base and existing-test overwrite before branch creation',async()=>{
  for(const reason of ['stale','existing-test']){
    const f=await fixture('Synthetic harmless code task',plan);
    try{
      if(reason==='existing-test')f.env.MOCK_ADD_TEST='1';
      const run=await cmd(process.execPath,[RUNNER],{cwd:f.root,env:f.env});
      assert.equal(run.code,0,run.out+'\n'+run.err);
      if(reason==='stale')f.env.MOCK_GIT_HEAD='f'.repeat(40);
      else f.env.MOCK_EXISTING_TEST='1';
      const pub=await publish(f);
      assert.equal(pub.code,1,pub.out+'\n'+pub.err);
      const calls=await readLines(f.fetchLog);
      assert.ok(calls.length>0);
      assert.ok(calls.every(c=>c.method==='GET'));
    }finally{await rm(f.root,{recursive:true,force:true});}
  }
});

test('offline full flow: 2 Codex workpacks, checks, independent review, mocked private Draft PR and audit',async()=>{
  const f=await fixture('인물 50명 추가해줘',plan);
  try{
    const run=await cmd(process.execPath,[RUNNER],{cwd:f.root,env:f.env});
    assert.equal(run.code,0,run.out+'\n'+run.err);
    assert.ok(!run.out.includes('인물 50명'));
    assert.equal((await report(f)).status,'passed');
    const events=(await report(f)).events;
    assert.deepEqual(events.filter(e=>e.stage==='implementation'&&e.status==='passed').map(e=>e.workpackId),['P1','P2']);
    assert.ok(events.some(e=>e.stage==='review'&&e.status==='passed'));
    assert.ok(await exists(join(f.root,'.private-task-result.json')));
    const pub=await publish(f);
    assert.equal(pub.code,0,pub.out+'\n'+pub.err);
    const save=await cmd(process.execPath,['--import',MOCK_FETCH,PERSIST],{
      cwd:f.root,env:{...f.env,PRIVATE_GAME_WRITE_TOKEN:'FIXTURE_TOKEN',PUBLISH_OUTCOME:'success'}
    });
    assert.equal(save.code,0,save.out+'\n'+save.err);
    const calls=await readLines(f.fetchLog);
    assert.equal(calls.filter(c=>c.method==='POST'&&c.path.endsWith('/pulls')&&c.draft===true).length,1);
    assert.equal(calls.filter(c=>c.method==='PUT'&&c.branch==='orchestrator/task-queue').length,1);
    assert.deepEqual((await readLines(f.callLog)).filter(x=>x.tool==='codex').map(x=>x.kind),['P1','P2']);
    assert.ok(!run.out.includes('FIXTURE_TOKEN'));
    assert.ok(!save.out.includes('인물'));
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('offline failure: three failing unit-test validations, maximum two repairs and no PR manifest',async()=>{
  const f=await fixture('인물 50명 추가해줘',plan,{failTests:true});
  try{
    const run=await cmd(process.execPath,[RUNNER],{cwd:f.root,env:f.env});
    assert.equal(run.code,1,run.out+'\n'+run.err);
    const audit=await report(f);
    assert.equal(audit.status,'failed');
    assert.equal(audit.events.filter(e=>e.stage==='repair'&&e.status==='passed').length,2);
    assert.equal(audit.events.filter(e=>e.stage==='unit-test'&&e.status==='failed').length,3);
    assert.ok(audit.events.some(e=>e.failureKind==='nonzero_exit'));
    assert.equal(await exists(join(f.root,'.private-task-result.json')),false);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('offline image request is blocked before Codex and before publishing any manifest',async()=>{
  const f=await fixture('인물 50명 초상화 이미지 생성해줘',imagePlan);
  try{
    const run=await cmd(process.execPath,[RUNNER],{cwd:f.root,env:f.env});
    assert.equal(run.code,1,run.out+'\n'+run.err);
    assert.match(run.out,/BLOCKED: IMAGE_BACKEND_NOT_CONFIGURED/);
    assert.equal((await readLines(f.callLog)).filter(e=>e.tool==='codex').length,0);
    assert.equal(await exists(join(f.root,'.private-task-result.json')),false);
    assert.ok((await report(f)).events.some(e=>e.failureKind==='blocked_capability'));
    assert.ok(!run.out.includes('초상화'));
  }finally{await rm(f.root,{recursive:true,force:true});}
});


test('offline tampering: code changed after review cannot reach GitHub publisher',async()=>{
  const f=await fixture('인물 50명 추가해줘',plan);
  try{
    const run=await cmd(process.execPath,[RUNNER],{cwd:f.root,env:f.env});
    assert.equal(run.code,0,run.out+'\n'+run.err);
    const manifest=JSON.parse(await readFile(join(f.root,'.private-task-result.json'),'utf8'));
    assert.match(manifest.verifiedContentSha256,/^[a-f0-9]{64}$/);
    // Malicious or stale work changes the SAME safe path after review.
    // The git status path list is unchanged, but its bytes are no longer approved.
    await writeFile(join(f.root,'private-game','src','generated-one.ts'),
      'export const one = "changed AFTER review";\n');
    const pub=await publish(f);
    assert.equal(pub.code,1,pub.out+'\n'+pub.err);
    assert.match(pub.err,/HANDOFF_FAILED|PUBLISH_FAILED/);
    assert.equal((await readLines(f.fetchLog)).length,0);
    assert.equal(await exists(join(f.root,'.private-task-pr.json')),false);
  }finally{await rm(f.root,{recursive:true,force:true});}
});


test('offline opt-in references: fetch only allowlisted public page and analyze private PNG without publishing media',async()=>{
  const f=await fixture('위성사진을 참고해서 게임 마을 도로 배치 코드를 개선해줘',plan);
  try{
    const privateRoot=join(f.root,'task-private','docs','orchestrator');
    await mkdir(join(privateRoot,'references'),{recursive:true});
    await mkdir(join(privateRoot,'media'),{recursive:true});
    await writeFile(join(privateRoot,'references',ID+'.json'),
      JSON.stringify({version:1,urls:['https://en.wikipedia.org/wiki/Goryeo']}));
    // Synthetic PNG header for the mock CLI only; gateway checks dimensions and magic bytes.
    const png=Buffer.alloc(33);
    Buffer.from('89504e470d0a1a0a','hex').copy(png);
    png.writeUInt32BE(13,8);png.write('IHDR',12);
    png.writeUInt32BE(400,16);png.writeUInt32BE(200,20);
    await writeFile(join(privateRoot,'media',ID+'.png'),png);
    const run=await cmd(process.execPath,['--import',MOCK_FETCH,RUNNER],{cwd:f.root,env:f.env});
    assert.equal(run.code,0,run.out+'\n'+run.err);
    assert.match(run.out,/REFERENCE_INPUTS public=1 image=yes/);
    assert.ok(!run.out.includes('Public reference history'));
    const calls=await readLines(f.callLog);
    assert.equal(calls.filter(c=>c.tool==='codex'&&c.kind==='generic').length,1);
    assert.deepEqual(calls.filter(c=>c.tool==='codex'&&c.kind!=='generic').map(c=>c.kind),['P1','P2']);
    const audit=await report(f);
    assert.equal(audit.status,'passed');
    assert.ok(audit.events.some(x=>x.stage==='plan'&&x.actor==='codex'&&x.status==='passed'));
  }finally{await rm(f.root,{recursive:true,force:true});}
});
