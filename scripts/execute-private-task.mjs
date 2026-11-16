import { spawn } from 'node:child_process';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { digestChangedFiles } from './verified-manifest.mjs';
import { routeTask, createRouteMetadata } from './dynamic-router.mjs';
import { runPlanner, runReviewer, parseReviewVerdict } from './agent-backends.mjs';
import { createAuditLedger, writePrivateAuditReport } from './audit-ledger.mjs';
import { shouldAttemptRepair } from './retry-policy.mjs';
import { plannerContract, parseWorkplan, assertExecutableWorkplan, makeCodePrompt } from './workpack-planner.mjs';
import { loadPublicReferences, findTaskImage, describeTaskImage, buildReferenceContext } from './reference-gateway.mjs';
const cwd=join(process.cwd(),'private-game');
const id=process.env.TASK_ID;
if (!/^[0-9]{8}T[0-9]{6}Z-[0-9]+-[0-9]+$/.test(id||'')) throw Error('Invalid task ID');
const task=await readFile(join(process.cwd(),'task-private/docs/orchestrator/tasks',id+'.txt'),'utf8');
if (!task.trim()||task.length>2500) throw Error('Task size out of bounds');
const route=routeTask(task,{
  mode:process.env.ORCHESTRATOR_ROUTING_MODE||'auto',
  controller:process.env.ORCHESTRATOR_CONTROLLER&&process.env.ORCHESTRATOR_CONTROLLER!=='auto'?process.env.ORCHESTRATOR_CONTROLLER:undefined
});
console.log('STATUS: ROUTE '+JSON.stringify(createRouteMetadata(route)));
const ledger=createAuditLedger(id);
const auditDir=process.env.ORCHESTRATOR_AUDIT_DIR;
let finalStatus='failed';
function run(bin,args,opts={}) {
  return new Promise((resolve,reject)=>{
    let out='',err='',outputBytes=0,limitReason=null,settled=false;
    const proc=spawn(bin,args,{cwd:opts.cwd||cwd,stdio:['ignore','pipe','pipe'],
      detached:process.platform!=='win32',
      env:{...process.env,ANTHROPIC_API_KEY:'',OPENAI_API_KEY:'',GOOGLE_API_KEY:'',GEMINI_API_KEY:''}});
    const stopGroup=()=>{
      try{
        if(process.platform!=='win32'&&proc.pid)process.kill(-proc.pid,'SIGKILL');
        else proc.kill('SIGKILL');
      }catch{proc.kill('SIGKILL');}
    };
    const fail=e=>{if(settled)return;settled=true;clearTimeout(timer);reject(e);};
    const timer=setTimeout(()=>{
      if(!limitReason){limitReason='timeout';stopGroup();}
    },opts.timeout||240000);
    const collect=(stream,chunk)=>{
      const value=chunk.toString('utf8');
      outputBytes+=chunk.length;
      if(stream==='out')out+=value;else err+=value;
      if(outputBytes>240000&&!limitReason){
        limitReason='output_limit';
        stopGroup();
      }
    };
    proc.stdout.on('data',d=>collect('out',d));
    proc.stderr.on('data',d=>collect('err',d));
    proc.on('error',e=>{
      const failure=Error('Command unavailable: '+bin);
      failure.failureKind='spawn_error';
      fail(failure);
    });
    proc.on('close',code=>{
      if(settled)return;
      clearTimeout(timer);settled=true;
      if(code!==0||limitReason){
        const kind=limitReason||(code===null?'signal':'nonzero_exit');
        const e=Error(bin+' command failed ('+kind+')');
        e.failureKind=kind;
        e.exitCode=Number.isInteger(code)?code:null;
        e.privateDiagnostic=(out+'\\n'+err).slice(-8500);
        reject(e);
      }else resolve(out);
    });
  });
}
async function observed(stage,actor,operation,metadata={}){
  const began=Date.now();
  ledger.record({stage,actor,status:'started',workpackId:metadata.workpackId??null});
  try{
    const result=await operation();
    ledger.record({stage,actor,status:'passed',workpackId:metadata.workpackId??null,durationMs:Date.now()-began,
      verdict:stage==='review'?'PASS':null});
    return result;
  }catch(e){
    ledger.record({stage,actor,status:'failed',workpackId:metadata.workpackId??null,durationMs:Date.now()-began,
      failureKind:e.failureKind||'operation_failed',verdict:stage==='review'?'FAIL':null});
    throw e;
  }
}
async function changed() {
  const statuses=await run('git',['status','--porcelain','--untracked-files=all']);
  const paths=[];
  for(const line of statuses.split('\n').filter(Boolean)){
    const flag=line.slice(0,2),file=line.slice(3);
    if(!/^( M|M |\?\?)$/.test(flag))throw Error('Only added or modified files are supported');
    if(!/^(src\/(?!assets\/)[a-zA-Z0-9_./-]+\.(ts|tsx)|tests\/[a-zA-Z0-9_./-]+\.test\.ts)$/.test(file) || file.includes('..') || file.includes('//'))throw Error('Disallowed path: change outside src code or tests');
    const stat=await lstat(join(cwd,file));
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65000)throw Error('Unsafe file type/size');
    if(file.startsWith('tests/')&&flag!=='??')throw Error('Existing tests cannot be modified');
    paths.push(file);
  }
  if(!paths.length||paths.length>8)throw Error('Expected 1-8 safe source/test changes');
  return paths;
}
async function gitDiff(paths){
  const chunks=[];
  for(const path of paths){
    const out=await run('git',['diff','--no-ext-diff','--',path]);
    // git diff omits untracked files: include the full new content in independent reviews.
    const extra=await readFile(join(cwd,path),'utf8');
    chunks.push(path+'\n'+out+'\n'+extra);
  }
  const combined=chunks.join('\n');
  if(combined.length>55000)throw Error('Patch exceeds review size limit');
  return combined;
}
const safeLog=s=>console.log('STATUS: '+s);
let stage='initial';
try{
  const start=(await run('git',['status','--porcelain','--untracked-files=all'])).trim();
  if(start)throw Error('Source checkout is not clean');
  safeLog('Install existing project dependencies');
  await observed('intake','system',()=>run('npm',['ci','--no-audit','--no-fund'],{timeout:360000}));
  // Only the user explicitly supplies public HTTPS URLs or a private screenshot.
  // Model-generated links never trigger network calls. Sources are untrusted data.
  stage='references';
  const referenceRoot=join(process.cwd(),'task-private');
  const publicReferences=await loadPublicReferences(referenceRoot,id);
  const referenceImage=await findTaskImage(referenceRoot,id);
  let imageDescription='';
  if(referenceImage){
    imageDescription=await observed('plan','codex',()=>describeTaskImage(referenceImage,run));
  }
  const referenceContext=buildReferenceContext(publicReferences,imageDescription);
  safeLog('REFERENCE_INPUTS public='+publicReferences.length+' image='+(referenceImage?'yes':'no'));
  const sourceRules='Read-only initial repo baseline. Respect current branch, existing feature owners, and project directions. Never edit existing tests, workflow, package files, docs, lock files, git config, or assets. Only modify src/**/*.ts or src/**/*.tsx and ADD new tests/**/*.test.ts. Do not run git commands that commit or push. Do not install dependencies. No file deletion. No deployment or API spending. Keep changes small and relevant.';
  stage='planning';
  safeLog('Control tower '+route.controller+' decomposing private task');
  const planText=await observed('plan',route.controller,()=>runPlanner({
    provider:route.controller,run,cwd,
    prompt:plannerContract(task)+'\\nPlanning is read-only; inspect actual code. Task:\\n'+task+'\\n\\n'+referenceContext
  }));
  if((await run('git',['status','--porcelain','--untracked-files=all'])).trim())
    throw Error('Planning unexpectedly modified repository');
  // The model cannot authorize a new CLI or asset generator: use deterministic validation.
  const workplan=parseWorkplan(planText,task);
  safeLog('WORKPACKS CODE='+workplan.codeCount+' IMAGE='+workplan.imageCount);
  if(workplan.imageCount) {
    ledger.record({stage:'implementation',actor:'system',status:'failed',failureKind:'blocked_capability'});
    safeLog('BLOCKED: IMAGE_BACKEND_NOT_CONFIGURED');
  }
  assertExecutableWorkplan(workplan);
  stage='coding';
  const codePacks=workplan.workpacks.filter(p=>p.kind==='code');
  for(let i=0;i<codePacks.length;i++) {
    const pack=codePacks[i];
    safeLog('Codex workpack '+pack.id+' of '+codePacks.length);
    await observed('implementation','codex',()=>run('codex',[
      'exec','--sandbox','workspace-write',
      makeCodePrompt({task,workpack:pack,index:i+1,total:codePacks.length,sourceRules})+'\\n\\n'+referenceContext
    ],{timeout:240000}),{workpackId:pack.id});
    // Detect disallowed changes as soon as a workpack returns; do not allow
    // later workers to repair or bury unsafe changes.
    const currentPaths=await changed();
    safeLog('Workpack '+pack.id+' saved; safe changed files='+currentPaths.length);
  }
  let paths=await changed();
  safeLog('Modified paths validated ('+paths.length+' total files)');
  stage='validation';
  const stageByName={'TypeScript':'typecheck','Unit tests':'unit-test','Production build':'build'};
  const checks=[['TypeScript','npm',['run','typecheck']],['Unit tests','npm',['test','--','--reporter=dot']],['Production build','npm',['run','build']]];
  async function runChecks(prefix){
    for(const [name,bin,args] of checks){
      safeLog(prefix+' '+name);
      try{
        await observed(stageByName[name],'system',()=>run(bin,args,{timeout:420000}));
        safeLog(name+' passed');
      }catch(e){
        // Never echo the captured private diagnostic into public Actions logs.
        safeLog(name+' failed: '+(e.failureKind||'operation_failed'));
        return e;
      }
    }
    return null;
  }
  let failure=await runChecks('Checking');
  let repairs=0;
  while(failure&&shouldAttemptRepair(failure.failureKind,repairs)){
    safeLog('Codex repairing code validation failure (bounded)');
    const diagnostic=(failure.privateDiagnostic||failure.message).slice(-4500);
    await observed('repair','codex',()=>run('codex',[
      'exec','--sandbox','workspace-write',
      'Fix validation failure without modifying existing tests or files outside src/**/*.ts, src/**/*.tsx, or NEW tests/**/*.test.ts. Do not change package files, tools or CI. Preserve requirements. Private diagnostic:\\n'+diagnostic
    ],{timeout:180000}));
    paths=await changed();
    repairs++;
    failure=await runChecks('Rechecking');
  }
  // Timeouts, output exhaustion and CLI infrastructure problems are not code defects.
  // Fail closed and retain a private metadata report; never publish unverified code.
  if(failure)throw failure;
  paths=await changed();
  const diff=await gitDiff(paths);
  stage='review';
  const fingerprint=items=>digestChangedFiles(cwd,items);
  const beforeReview=await fingerprint(paths);
  safeLog(route.reviewer+' independently reviewing code changes');
  await observed('review',route.reviewer,async()=>{
    const review=await runReviewer({
    provider:route.reviewer,run,cwd,
    prompt:'You are a strict independent code reviewer. Evaluate adherence to the task, regression risk, obvious security problems, and whether tests appear meaningful. First line EXACTLY PASS or FAIL. Then brief reason. Do not edit any files. TASK:\\n'+task+'\\nCONTROL TOWER WORKPACKS:\\n'+JSON.stringify(workplan.workpacks)+'\\nREFERENCE DATA:\\n'+referenceContext+'\\nPATCH:\\n'+diff
    });
    if(parseReviewVerdict(review)!=='PASS')throw Error('Independent review rejected task');
  });
  paths=await changed();
  if((await fingerprint(paths))!==beforeReview)throw Error('Reviewer modified source after validation');
  safeLog(route.reviewer+' independent review PASSED');
  const verifiedContentSha256=await fingerprint(paths);
  await writeFile(join(process.cwd(),'.private-task-result.json'),JSON.stringify({id,paths,verifiedContentSha256,route:createRouteMetadata(route)}),{mode:0o600});
  safeLog('Validated private change ready for PR publishing');
  finalStatus='passed';
}catch(e){
  console.error('RESULT: FAILED during '+stage+' ('+String(e.message).replace(/[^a-zA-Z0-9 _.()/-]/g,'').slice(0,160)+')');
  process.exitCode=1;
}finally{
  if(auditDir){
    try{
      await writePrivateAuditReport(auditDir,ledger.snapshot({status:finalStatus}));
      safeLog('Private execution audit prepared');
    }catch{
      console.error('RESULT: PRIVATE_AUDIT_PREPARE_FAILED');
      process.exitCode=1;
    }
  }
}
