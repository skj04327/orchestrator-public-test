import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  CLAUDE_REVIEW_SCHEMA,assertSubscriptionLogin,claudeReviewArgs,claudeReviewEnvironment,createClaudeCliRunner,
  inspectClaudeReviewScope,inspectLocalClaudeReviewScope,parseClaudeReviewResponse,prepareClaudeReviewInput,runLocalClaudeReview
} from './local-claude-review.mjs';
import {prepareLocalIndependentReview,readLocalIndependentReview,reviewVerdictMessage} from './local-independent-review.mjs';
import {prepareLocalJob} from './local-jobs.mjs';
import {makeLocalReceipt} from './test-fixtures/local-receipt.mjs';
import {diskCheckFixture} from './test-fixtures/disk-check.mjs';
import {captureDiskCheckInput,getDiskCheckProvenance} from './disk-check-input.mjs';
import {recipientKey} from './private-handoff.mjs';
import {submitLocalCandidate} from './local-candidate-intake.mjs';

const actions=process.env.GITHUB_ACTIONS;
before(()=>{delete process.env.GITHUB_ACTIONS;});
after(()=>{if(actions===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=actions;});
const json=value=>Buffer.from(JSON.stringify(value));
const live={schemaVersion:1,provider:'claude',subscriptionLoginOnly:true,extraUsageDisabled:true};
const cleanEnv=extra=>({PATH:process.env.PATH,HOME:tmpdir(),...extra});
const codeOf=code=>error=>error?.name==='ClaudeReviewError'&&error.code===code;

// Same synthetic review fixture as the existing review boundary test: a checked candidate awaiting review.
async function fixture(root){
  const f=await makeLocalReceipt(root),job=await prepareLocalJob(f);
  const {diskSnapshot,bundle}=await diskCheckFixture(root,{context:job.context});
  const key=recipientKey('SYNTHETIC_CLAUDE_REVIEW_RECIPIENT',job.context),reviewer=generateKeyPairSync('ed25519');
  const response=json({schemaVersion:1,runId:job.context.runId,baselineManifestSha256:diskSnapshot.manifestSha256,
    files:bundle.files.map(({path,content})=>({path,content:Buffer.from(content,'base64').toString('utf8')}))});
  const state=await submitLocalCandidate({...f,diskSnapshot,publicKey:key.publicKey,response});
  const proof=getDiskCheckProvenance(captureDiskCheckInput({diskSnapshot,bundle,context:job.context}));
  const claim={schemaVersion:2,inputProfile:'disk-v1',context:job.context,artifactSha256:state.artifactSha256,...proof,imageId:'sha256:'+'a'.repeat(64)};
  const checks=['baseline','candidate'].flatMap(variant=>['typecheck','unit-test','build'].map(stage=>({variant,stage,status:'passed',failureKind:null,exitCode:0,removed:true,durationMs:1})));
  const report={...claim,phase:'checks-passed-awaiting-review',checks,baselineBinding:'github-main-pinned',review:'not-run',publishAuthorized:false,failureKind:null};
  const dir=join(f.stateRoot,f.id);
  await writeFile(join(dir,'independent-claim.json'),json(claim),{mode:0o600});
  const reportPath=join(dir,'independent-report.json');
  await writeFile(reportPath,json(report),{mode:0o600});
  const options={...f,diskSnapshot,privateKey:key.privateKey,reviewerPublicKey:reviewer.publicKey};
  const prepared=await prepareLocalIndependentReview(options);
  return {options,reviewer,report,reportPath,dir,prepared,scope:inspectClaudeReviewScope(prepared),
    reviewPath:join(dir,'independent-review.json'),claimPath:join(dir,'claude-review-claim.json'),
    signer:async({message})=>sign(null,message,reviewer.privateKey)};
}
const envelope=(structured_output,extra={})=>JSON.stringify({type:'result',is_error:false,structured_output,...extra});
const answer=(prepared,patch={})=>({schemaVersion:1,runId:prepared.request.runId,candidateContentSha256:prepared.request.candidateContentSha256,
  verdict:'pass',findings:[],...patch});

// Stand-in for the claude binary. A behaviour file picks the answer; a log file records what the child could observe.
const MOCK=`
import {appendFileSync,readFileSync,readdirSync} from 'node:fs';
const [logPath,behaviourPath,...argv]=process.argv.slice(2);
const behaviour=JSON.parse(readFileSync(behaviourPath,'utf8'));
let stdin='';for await(const chunk of process.stdin)stdin+=chunk;
const auth=argv[0]==='auth';
appendFileSync(logPath,JSON.stringify({pid:process.pid,auth,argv,envKeys:Object.keys(process.env).sort(),cwdEntries:readdirSync(process.cwd()),stdin})+'\\n');
if(auth){console.log(JSON.stringify(behaviour.auth??{loggedIn:true,authMethod:'oauth_token',apiProvider:'firstParty'}));process.exit(0);}
if(behaviour.run==='hang')setInterval(()=>{},1000);
else if(behaviour.run==='exit1')process.exit(1);
else if(behaviour.run==='huge')console.log('x'.repeat(400000));
else if(behaviour.run==='text')console.log(JSON.stringify({type:'result',is_error:false,result:'PASS\\nlooks fine'}));
else{
  const target=JSON.parse(stdin.slice(stdin.indexOf('CANDIDATE_JSON\\n')+15));
  const out={schemaVersion:1,runId:behaviour.runId??target.runId,candidateContentSha256:target.candidateContentSha256,
    verdict:behaviour.verdict??'pass',findings:behaviour.findings??[]};
  console.log(JSON.stringify({type:'result',is_error:false,structured_output:out}));
}
`;
async function mockRunner(root,behaviour={},options={}){
  const script=join(root,'mock-claude.mjs'),logPath=join(root,'mock.log'),behaviourPath=join(root,'behaviour.json');
  await writeFile(script,MOCK);await writeFile(behaviourPath,JSON.stringify(behaviour));await writeFile(logPath,'');
  const runner=createClaudeCliRunner({liveApproval:live,command:process.execPath,commandArgs:[script,logPath,behaviourPath],
    env:cleanEnv({GITHUB_TOKEN:'ghp_SYNTHETIC',ORCHESTRATOR_REVIEW_KEY:'SYNTHETIC_PRIVATE_KEY',...options.env}),...options});
  const calls=async()=>(await readFile(logPath,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
  return {runner,calls,setBehaviour:value=>writeFile(behaviourPath,JSON.stringify(value))};
}

test('the approved scope binds the run, candidate fingerprint and every file digest, and nothing private goes to the prompt',async()=>{
  const root=await mkdtemp(join(tmpdir(),'claude-review-input-'));
  try{
    const {prepared,scope,options}=await fixture(root);
    assert.equal(scope.provider,'claude');
    assert.equal(scope.taskId,options.id);
    assert.equal(scope.runId,prepared.request.runId);
    assert.deepEqual((await inspectLocalClaudeReviewScope(options)),scope);
    const input=prepareClaudeReviewInput({...prepared,approvedScope:scope});
    assert.equal(input.expected.runId,prepared.request.runId);
    assert.equal(input.expected.candidateContentSha256,prepared.request.candidateContentSha256);
    const sent=JSON.parse(input.prompt.slice(input.prompt.indexOf('CANDIDATE_JSON\n')+15));
    assert.deepEqual(Object.keys(sent).sort(),['candidateContentSha256','files','provider','runId','schemaVersion']);
    assert.deepEqual(sent.files.map(file=>file.path),prepared.files.map(file=>file.path).sort());
    for(const secret of [options.id,prepared.request.baseSha,prepared.request.artifactSha256,prepared.request.reviewerKeySha256,'SYNTHETIC_CLAUDE_REVIEW_RECIPIENT','PRIVATE KEY'])
      assert.equal(input.prompt.includes(secret),false,secret);
    const other=generateKeyPairSync('ed25519');
    assert.notEqual(options.reviewerPublicKey,other.publicKey);
    const mutations=[
      {...scope,runId:'3dfdb025-3a63-4fcf-94e0-d433d19f8d1c'},
      {...scope,provider:'codex'},
      {...scope,candidateContentSha256:'a'.repeat(64)},
      {...scope,baselineManifestSha256:'b'.repeat(64)},
      {...scope,files:scope.files.map((file,index)=>index?file:{...file,sha256:'c'.repeat(64)})},
      {...scope,files:scope.files.slice(1)},
      {...scope,files:[...scope.files,{path:'src/extra.ts',sha256:'d'.repeat(64)}]},
      {...scope,extra:true},
      null
    ];
    for(const approvedScope of mutations)assert.throws(()=>prepareClaudeReviewInput({...prepared,approvedScope}),codeOf('NOT_APPROVED'));
    assert.throws(()=>prepareClaudeReviewInput({...prepared,approvedScope:scope,signal:AbortSignal.abort()}),codeOf('CANCELLED'));
    // Candidate bytes that no longer match the verified request fingerprint are never offered for approval.
    const tampered=prepared.files.map((file,index)=>index?file:{...file,content:Buffer.from(file.content.toString()+'\n// tampered')});
    assert.throws(()=>inspectClaudeReviewScope({request:prepared.request,files:tampered}),codeOf('TARGET_MISMATCH'));
    assert.throws(()=>inspectClaudeReviewScope({request:{...prepared.request,runId:'not-a-run'},files:prepared.files}));
    assert.throws(()=>inspectClaudeReviewScope({request:prepared.request,files:[]}),codeOf('TARGET_MISMATCH'));
    const binary=prepared.files.map(file=>({...file,content:Buffer.concat([file.content,Buffer.from([0])])}));
    assert.throws(()=>inspectClaudeReviewScope({request:prepared.request,files:binary}),codeOf('TARGET_MISMATCH'));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('only a well-formed structured answer for the exact target becomes a verdict',async()=>{
  const root=await mkdtemp(join(tmpdir(),'claude-review-parse-'));
  try{
    const {prepared,scope}=await fixture(root);
    const input=prepareClaudeReviewInput({...prepared,approvedScope:scope}),path=input.paths[0];
    const parse=raw=>parseClaudeReviewResponse(raw,input);
    assert.deepEqual(parse(envelope(answer(prepared))),{verdict:'pass',findings:[]});
    const advisory={path,severity:'advisory',summary:'Consider a clearer name.'};
    assert.deepEqual(parse(envelope(answer(prepared,{findings:[advisory]}))),{verdict:'pass',findings:[advisory]});
    const blocking={path,severity:'blocking',summary:'Reads a secret from the environment.'};
    assert.deepEqual(parse(envelope(answer(prepared,{verdict:'fail',findings:[blocking]}))),{verdict:'fail',findings:[blocking]});
    const formatCases=[
      'not json',envelope(null),'[]','null',
      JSON.stringify({type:'result',is_error:false,result:'PASS'}),
      JSON.stringify({type:'result',is_error:false,result:JSON.stringify(answer(prepared))}),
      JSON.stringify({type:'result',structured_output:answer(prepared)}),
      JSON.stringify({type:'result',is_error:true,structured_output:answer(prepared)}),
      envelope({...answer(prepared),extra:1}),
      envelope({...answer(prepared),schemaVersion:2}),
      envelope({...answer(prepared),verdict:'PASS'}),
      envelope({...answer(prepared),verdict:'maybe'}),
      envelope({...answer(prepared),findings:'none'}),
      envelope({...answer(prepared),findings:Array(9).fill(advisory)}),
      envelope(answer(prepared,{findings:[{...advisory,path:'src/not-sent.ts'}]})),
      envelope(answer(prepared,{findings:[{...advisory,severity:'critical'}]})),
      envelope(answer(prepared,{findings:[{...advisory,summary:''}]})),
      envelope(answer(prepared,{findings:[{...advisory,summary:'x'.repeat(301)}]})),
      envelope(answer(prepared,{findings:[{...advisory,summary:'line\u001b[31m'}]})),
      envelope(answer(prepared,{findings:[{...advisory,extra:true}]})),
      envelope(answer(prepared,{verdict:'pass',findings:[blocking]})),
      envelope(Object.fromEntries(Object.entries(answer(prepared)).filter(([key])=>key!=='findings'))),
      'x'.repeat(262145),42,undefined
    ];
    for(const raw of formatCases)assert.throws(()=>parse(raw),codeOf('FORMAT'),String(raw).slice(0,80));
    for(const patch of [{runId:'3dfdb025-3a63-4fcf-94e0-d433d19f8d1c'},{candidateContentSha256:'a'.repeat(64)}])
      assert.throws(()=>parse(envelope(answer(prepared,patch))),codeOf('TARGET_MISMATCH'));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('the child environment drops credentials and metered-billing switches, and the options are a fixed tool-less set',()=>{
  const env=claudeReviewEnvironment({PATH:'/bin',HOME:'/home/u',LANG:'C.UTF-8',CLAUDE_CODE_OAUTH_TOKEN:'sub-token',GITHUB_TOKEN:'x',GH_TOKEN:'x',
    GITHUB_ACTIONS:'false',ORCHESTRATOR_PRIVATE_KEY:'x',ORCHESTRATOR_REVIEW_PRIVATE_KEY:'x',SSH_AUTH_SOCK:'/s',AWS_SECRET_ACCESS_KEY:'x',OPENAI_API_KEY:'x'});
  assert.deepEqual(Object.keys(env).sort(),['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC','CLAUDE_CODE_OAUTH_TOKEN','DISABLE_AUTOUPDATER','HOME','LANG','PATH']);
  for(const name of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','ANTHROPIC_PROFILE','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY'])
    assert.throws(()=>claudeReviewEnvironment({PATH:'/bin',[name]:'1'}),codeOf('UNAVAILABLE'),name);
  const args=claudeReviewArgs({model:'sonnet'});
  assert.deepEqual(args.slice(0,2),['-p','Review the candidate described on stdin.']);
  assert.equal(args[args.indexOf('--tools')+1],'');
  assert.equal(args[args.indexOf('--json-schema')+1],JSON.stringify(CLAUDE_REVIEW_SCHEMA));
  for(const flag of ['--safe-mode','--strict-mcp-config','--disable-slash-commands','--no-session-persistence'])assert.ok(args.includes(flag),flag);
  assert.equal(args[args.indexOf('--permission-prompts')+1],'none');
  assert.equal(args[args.indexOf('--model')+1],'sonnet');
  // --bare would disable the subscription login; the rest could widen tools or add metered spend.
  for(const flag of ['--bare','--allowedTools','--allowed-tools','--dangerously-skip-permissions','--max-budget-usd','--mcp-config','--add-dir','--settings','--resume','--continue'])
    assert.equal(args.includes(flag),false,flag);
  assert.equal(claudeReviewArgs().includes('--model'),false);
  for(const model of ['','--bare','a b','x'.repeat(65),'bad;rm'])assert.throws(()=>claudeReviewArgs({model}),codeOf('UNAVAILABLE'));
});

test('only a subscription login passes the local authentication check',()=>{
  const ok={loggedIn:true,authMethod:'oauth_token',apiProvider:'firstParty'};
  assertSubscriptionLogin(JSON.stringify(ok));
  assertSubscriptionLogin(JSON.stringify({...ok,authMethod:'claude.ai'}));
  for(const bad of ['',' not json','null','[]',{...ok,loggedIn:false},{...ok,authMethod:'api_key'},{...ok,authMethod:'apiKeyHelper'},
    {...ok,apiProvider:'bedrock'},{...ok,apiProvider:undefined},{loggedIn:true}])
    assert.throws(()=>assertSubscriptionLogin(typeof bad==='string'?bad:JSON.stringify(bad)),codeOf('UNAVAILABLE'));
});

test('the real child sees only the review arguments, a clean directory and the scrubbed environment',async()=>{
  const root=await mkdtemp(join(tmpdir(),'claude-review-child-'));
  try{
    const {prepared,scope}=await fixture(root),input=prepareClaudeReviewInput({...prepared,approvedScope:scope});
    const {runner,calls}=await mockRunner(root,{});
    await runner.preflight();
    const raw=await runner.run({prompt:input.prompt});
    assert.deepEqual(parseClaudeReviewResponse(raw,input),{verdict:'pass',findings:[]});
    const [auth,review]=await calls();
    assert.deepEqual(auth.argv,['auth','status','--json']);
    assert.equal(auth.stdin,'');
    assert.deepEqual(review.argv,claudeReviewArgs());
    assert.equal(review.stdin,input.prompt);
    for(const child of [auth,review]){
      assert.deepEqual(child.cwdEntries,[]);
      assert.equal(child.envKeys.some(name=>/GITHUB|ORCHESTRATOR|TOKEN|KEY|ANTHROPIC/.test(name)),false,child.envKeys.join());
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

test('the runner needs an operator decision and local metered-billing and authentication evidence before any call',async()=>{
  const root=await mkdtemp(join(tmpdir(),'claude-review-gate-'));
  try{
    for(const liveApproval of [undefined,{...live,extraUsageDisabled:false},{...live,subscriptionLoginOnly:false},{...live,provider:'codex'},{...live,extra:1},{...live,schemaVersion:2}])
      assert.throws(()=>createClaudeCliRunner({liveApproval}),codeOf('NOT_APPROVED'));
    const spawned=[];
    const spy=(...args)=>{spawned.push(args);throw Error('must not start');};
    const metered=createClaudeCliRunner({liveApproval:live,spawnImpl:spy,env:cleanEnv({ANTHROPIC_API_KEY:'sk-ant-SYNTHETIC'})});
    await assert.rejects(metered.preflight(),codeOf('UNAVAILABLE'));
    await assert.rejects(metered.run({prompt:'x'}),codeOf('UNAVAILABLE'));
    process.env.GITHUB_ACTIONS='true';
    try{
      const inActions=createClaudeCliRunner({liveApproval:live,spawnImpl:spy,env:cleanEnv()});
      await assert.rejects(inActions.preflight(),codeOf('UNAVAILABLE'));
      await assert.rejects(inActions.run({prompt:'x'}),codeOf('UNAVAILABLE'));
    }finally{delete process.env.GITHUB_ACTIONS;}
    const cancelled=createClaudeCliRunner({liveApproval:live,spawnImpl:spy,env:cleanEnv()});
    await assert.rejects(cancelled.run({prompt:'x',signal:AbortSignal.abort()}),codeOf('CANCELLED'));
    assert.deepEqual(spawned,[]);
    const {runner}=await mockRunner(root,{auth:{loggedIn:true,authMethod:'api_key',apiProvider:'firstParty'}});
    await assert.rejects(runner.preflight(),codeOf('UNAVAILABLE'));
    const missing=createClaudeCliRunner({liveApproval:live,command:join(root,'no-such-claude'),env:cleanEnv()});
    await assert.rejects(missing.preflight(),codeOf('UNAVAILABLE'));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('timeout, cancellation, failure exit and oversized output end the child and never yield a verdict',async()=>{
  const root=await mkdtemp(join(tmpdir(),'claude-review-child-failures-'));
  const gone=async pid=>{
    for(let attempt=0;attempt<50;attempt++){
      try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')return true;}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    return false;
  };
  try{
    const timed=await mockRunner(root,{run:'hang'},{timeoutMs:1000});
    await assert.rejects(timed.runner.run({prompt:'x'}),codeOf('TIMEOUT'));
    const controller=new AbortController();
    const slow=await mockRunner(root,{run:'hang'},{timeoutMs:60000});
    const pending=slow.runner.run({prompt:'x',signal:controller.signal});
    setTimeout(()=>controller.abort(),500);
    await assert.rejects(pending,codeOf('CANCELLED'));
    const failing=await mockRunner(root,{run:'exit1'});
    await assert.rejects(failing.runner.run({prompt:'x'}),codeOf('UNAVAILABLE'));
    const huge=await mockRunner(root,{run:'huge'});
    await assert.rejects(huge.runner.run({prompt:'x'}),codeOf('FORMAT'));
    // A timed out or cancelled child must not keep running (and spending) after its call failed.
    for(const hung of [timed,slow]){
      const [call]=await hung.calls();
      assert.equal(await gone(call.pid),true,'child '+call.pid+' still running');
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a fake child that cannot be spawned or errors never produces output',async()=>{
  const failing=createClaudeCliRunner({liveApproval:live,env:cleanEnv(),spawnImpl:()=>{throw Error('EACCES');}});
  await assert.rejects(failing.run({prompt:'x'}),codeOf('UNAVAILABLE'));
  const child=new EventEmitter();Object.assign(child,{stdout:new PassThrough(),stdin:new PassThrough(),kill(){this.killed=true;}});
  const errored=createClaudeCliRunner({liveApproval:live,env:cleanEnv(),spawnImpl:()=>{setImmediate(()=>child.emit('error',Error('boom')));return child;}});
  await assert.rejects(errored.run({prompt:'x'}),codeOf('UNAVAILABLE'));
  assert.equal(child.killed,true);
});

test('a passing review is approved, claimed once, signed by the separate signer and verified by the existing boundary',async()=>{
  const root=await mkdtemp(join(tmpdir(),'claude-review-pass-'));
  try{
    const {options,scope,signer,reviewPath,claimPath,prepared}=await fixture(root);
    const {runner,calls}=await mockRunner(root,{});
    let signed;
    const result=await runLocalClaudeReview({...options,approvedScope:scope,runner,signer:async value=>{signed=value;return signer(value);}});
    assert.equal(result.verdict,'pass');
    assert.equal(result.status.phase,'review-passed');
    assert.equal(result.status.publishAuthorized,false);
    assert.equal((await readLocalIndependentReview(options)).phase,'review-passed');
    assert.equal((await stat(reviewPath)).mode&0o777,0o600);
    assert.equal((await stat(claimPath)).mode&0o777,0o600);
    // The signer gets request, verdict, digests and the message bytes. It never gets file contents or any key.
    assert.deepEqual(Object.keys(signed).sort(),['files','message','request','verdict']);
    assert.deepEqual(signed.message,reviewVerdictMessage(prepared.request,'pass'));
    assert.deepEqual(signed.files,scope.files);
    const stored=await readFile(reviewPath,'utf8'),claim=await readFile(claimPath,'utf8');
    for(const text of [stored,claim])assert.doesNotMatch(text,/export const|SYNTHETIC|PRIVATE KEY/);
    assert.deepEqual(Object.keys(JSON.parse(claim)).sort(),['inputSha256','schemaVersion','scopeSha256']);
    assert.equal((await calls()).filter(call=>!call.auth).length,1);
    // A second call for the same job fails before the model is called again.
    await assert.rejects(runLocalClaudeReview({...options,approvedScope:scope,runner,signer}));
    assert.equal((await calls()).filter(call=>!call.auth).length,1);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a rejection is signed and terminal, and the findings stay in memory',async()=>{
  const root=await mkdtemp(join(tmpdir(),'claude-review-reject-'));
  try{
    const {options,scope,signer,reviewPath,prepared}=await fixture(root);
    const path=prepared.files[0].path;
    const {runner}=await mockRunner(root,{verdict:'fail',findings:[{path,severity:'blocking',summary:'Synthetic blocking defect.'}]});
    const result=await runLocalClaudeReview({...options,approvedScope:scope,runner,signer});
    assert.equal(result.status.phase,'review-failed');
    assert.deepEqual(result.findings,[{path,severity:'blocking',summary:'Synthetic blocking defect.'}]);
    assert.doesNotMatch(await readFile(reviewPath,'utf8'),/Synthetic blocking defect/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('format errors, wrong targets, timeouts and cancellation record nothing and keep the claim',async()=>{
  const root=await mkdtemp(join(tmpdir(),'claude-review-no-record-'));
  try{
    const cases=[
      ['FORMAT',{run:'text'},{}],
      ['FORMAT',{run:'huge'},{}],
      ['TARGET_MISMATCH',{runId:'3dfdb025-3a63-4fcf-94e0-d433d19f8d1c'},{}],
      ['UNAVAILABLE',{run:'exit1'},{}],
      ['TIMEOUT',{run:'hang'},{timeoutMs:1000}]
    ];
    for(const [code,behaviour,runnerOptions] of cases){
      const sub=await mkdtemp(join(root,'case-'));
      const {options,scope,signer,reviewPath,claimPath}=await fixture(sub);
      const {runner,calls,setBehaviour}=await mockRunner(sub,behaviour,runnerOptions);
      await assert.rejects(runLocalClaudeReview({...options,approvedScope:scope,runner,signer}),codeOf(code),code);
      await assert.rejects(stat(reviewPath),{code:'ENOENT'});
      assert.equal((await stat(claimPath)).isFile(),true);
      assert.equal((await readLocalIndependentReview(options)).phase,'awaiting-review');
      // The consumed claim blocks an automatic retry even with a now-valid answer; the model is not called again.
      const before=(await calls()).filter(call=>!call.auth).length;
      await setBehaviour({});
      await assert.rejects(runLocalClaudeReview({...options,approvedScope:scope,runner,signer}),codeOf('ALREADY_CLAIMED'),code);
      assert.equal((await calls()).filter(call=>!call.auth).length,before);
    }
    const sub=await mkdtemp(join(root,'case-'));
    const {options,scope,signer,reviewPath}=await fixture(sub);
    const controller=new AbortController();
    const {runner}=await mockRunner(sub,{run:'hang'},{timeoutMs:60000});
    setTimeout(()=>controller.abort(),500);
    await assert.rejects(runLocalClaudeReview({...options,approvedScope:scope,runner,signer,signal:controller.signal}),codeOf('CANCELLED'));
    await assert.rejects(stat(reviewPath),{code:'ENOENT'});
  }finally{await rm(root,{recursive:true,force:true});}
});

test('an unapproved scope, a failed preflight or a missing signer stops before the claim and the model call',async()=>{
  const root=await mkdtemp(join(tmpdir(),'claude-review-before-claim-'));
  try{
    const {options,scope,signer,claimPath}=await fixture(root);
    const {runner,calls,setBehaviour}=await mockRunner(root,{});
    await assert.rejects(runLocalClaudeReview({...options,approvedScope:{...scope,runId:'3dfdb025-3a63-4fcf-94e0-d433d19f8d1c'},runner,signer}),codeOf('NOT_APPROVED'));
    await assert.rejects(runLocalClaudeReview({...options,approvedScope:scope,runner,signer:undefined}),codeOf('NOT_APPROVED'));
    await assert.rejects(runLocalClaudeReview({...options,approvedScope:scope,runner:{},signer}),codeOf('NOT_APPROVED'));
    await setBehaviour({auth:{loggedIn:false}});
    await assert.rejects(runLocalClaudeReview({...options,approvedScope:scope,runner,signer}),codeOf('UNAVAILABLE'));
    await assert.rejects(stat(claimPath),{code:'ENOENT'});
    assert.equal((await calls()).filter(call=>!call.auth).length,0);
    await setBehaviour({});
    const result=await runLocalClaudeReview({...options,approvedScope:scope,runner,signer});
    assert.equal(result.status.phase,'review-passed');
  }finally{await rm(root,{recursive:true,force:true});}
});

async function submitFirst({options,prepared,signer}){
  const {submitLocalIndependentReview}=await import('./local-independent-review.mjs');
  const verdict='pass',message=reviewVerdictMessage(prepared.request,verdict);
  await submitLocalIndependentReview({...options,verdict,signature:await signer({message})});
}
test('a bad signature, a changed check report or a competing verdict cannot be recorded',async()=>{
  const root=await mkdtemp(join(tmpdir(),'claude-review-boundary-'));
  try{
    const a=await mkdtemp(join(root,'a-')),b=await mkdtemp(join(root,'b-'));
    const first=await fixture(a),other=generateKeyPairSync('ed25519');
    const {runner}=await mockRunner(a,{});
    await assert.rejects(runLocalClaudeReview({...first.options,approvedScope:first.scope,runner,
      signer:async({message})=>sign(null,message,other.privateKey)}));
    await assert.rejects(runLocalClaudeReview({...first.options,approvedScope:first.scope,runner,
      signer:async()=>Buffer.alloc(64)}));
    await assert.rejects(stat(first.reviewPath),{code:'ENOENT'});
    // A verdict recorded by anyone else first wins; this call must not reach the model.
    const claimedRoot=await mkdtemp(join(root,'c-')),claimed=await fixture(claimedRoot),probe=await mockRunner(claimedRoot,{});
    await submitFirst(claimed);
    await assert.rejects(runLocalClaudeReview({...claimed.options,approvedScope:claimed.scope,runner:probe.runner,signer:claimed.signer}));
    assert.equal((await probe.calls()).length,0);
    const second=await fixture(b);
    const real=(await mockRunner(b,{})).runner;
    const changed=structuredClone(second.report);changed.checks[0].durationMs++;
    const racing={preflight:real.preflight,async run(args){await writeFile(second.reportPath,json(changed));return real.run(args);}};
    await assert.rejects(runLocalClaudeReview({...second.options,approvedScope:second.scope,runner:racing,signer:second.signer}));
    await assert.rejects(stat(second.reviewPath),{code:'ENOENT'});
    await writeFile(second.reportPath,json(second.report));
    assert.equal((await readLocalIndependentReview(second.options)).phase,'awaiting-review');
    // The submit boundary rechecks only the report, so the adapter must itself notice an encrypted candidate replaced during the run.
    const thirdRoot=await mkdtemp(join(root,'d-')),third=await fixture(thirdRoot),thirdRunner=(await mockRunner(thirdRoot,{})).runner;
    const artifact=join(third.dir,'result.enc'),original=await readFile(artifact);
    const swapping={preflight:thirdRunner.preflight,async run(){
      await writeFile(artifact,Buffer.concat([original,Buffer.from('x')]));return envelope(answer(third.prepared));
    }};
    await assert.rejects(runLocalClaudeReview({...third.options,approvedScope:third.scope,runner:swapping,signer:third.signer}));
    await assert.rejects(stat(third.reviewPath),{code:'ENOENT'});
  }finally{await rm(root,{recursive:true,force:true});}
});

test('local review is unavailable in GitHub Actions',async()=>{
  const root=await mkdtemp(join(tmpdir(),'claude-review-actions-'));
  try{
    const {options,scope,signer,prepared}=await fixture(root);
    const {runner}=await mockRunner(root,{});
    process.env.GITHUB_ACTIONS='true';
    try{
      await assert.rejects(runLocalClaudeReview({...options,approvedScope:scope,runner,signer}),codeOf('UNAVAILABLE'));
      assert.throws(()=>prepareClaudeReviewInput({...prepared,approvedScope:scope}),codeOf('UNAVAILABLE'));
    }finally{delete process.env.GITHUB_ACTIONS;}
  }finally{await rm(root,{recursive:true,force:true});}
});
