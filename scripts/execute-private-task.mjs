import { spawn } from 'node:child_process';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { routeTask, createRouteMetadata } from './dynamic-router.mjs';
import { runPlanner, runReviewer, parseReviewVerdict } from './agent-backends.mjs';
const cwd=join(process.cwd(),'private-game');
const id=process.env.TASK_ID;
if (!/^[0-9]{8}T[0-9]{6}Z-[0-9]+-[0-9]+$/.test(id||'')) throw Error('Invalid task ID');
const task=await readFile(join(process.cwd(),'task-private/docs/orchestrator/tasks',id+'.txt'),'utf8');
if (!task.trim()||task.length>2500) throw Error('Task size out of bounds');
const route=routeTask(task,{
  mode:process.env.ORCHESTRATOR_ROUTING_MODE||'auto',
  controller:process.env.ORCHESTRATOR_CONTROLLER||undefined
});
console.log('STATUS: ROUTE '+JSON.stringify(createRouteMetadata(route)));
function run(bin,args,opts={}) {
  return new Promise((resolve,reject)=>{
    let out='',err='',over=false;
    const proc=spawn(bin,args,{cwd:opts.cwd||cwd,stdio:['ignore','pipe','pipe'],
      env:{...process.env,ANTHROPIC_API_KEY:'',OPENAI_API_KEY:'',GOOGLE_API_KEY:'',GEMINI_API_KEY:''}});
    const timer=setTimeout(()=>{over=true;proc.kill('SIGKILL');},opts.timeout||240000);
    proc.stdout.on('data',d=>{out+=d;if(out.length>240000){over=true;proc.kill('SIGKILL');}});
    proc.stderr.on('data',d=>{err+=d;if(err.length>240000){over=true;proc.kill('SIGKILL');}});
    proc.on('error',e=>{clearTimeout(timer);reject(Error('Command unavailable: '+bin+' ('+e.code+')'));});
    proc.on('close',code=>{
      clearTimeout(timer);
      if(code!==0||over){const e=Error(bin+' command failed ('+(over?'limit':'exit '+code)+')');e.privateDiagnostic=(out+'\n'+err).slice(-8500);reject(e);}
      else resolve(out);
    });
  });
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
    const extra=path.startsWith('tests/')?await readFile(join(cwd,path),'utf8'):'';
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
  await run('npm',['ci','--no-audit','--no-fund'],{timeout:360000});
  const sourceRules='Read-only initial repo baseline. Respect current branch, existing feature owners, and project directions. Never edit existing tests, workflow, package files, docs, lock files, git config, or assets. Only modify src/**/*.ts or src/**/*.tsx and ADD new tests/**/*.test.ts. Do not run git commands that commit or push. Do not install dependencies. No file deletion. No deployment or API spending. Keep changes small and relevant.';
  safeLog('Control tower '+route.controller+' planning private task');
  const planResult={result:await runPlanner({
    provider:route.controller,run,cwd,
    prompt:'Plan this task on the actual repository. '+sourceRules+' Output a concise 4-10 step implementation plan including relevant files; do not modify files. TASK:\\n'+task
  })};
  if(planResult.result.length>10000)throw Error('Control tower plan too long');
  if((await run('git',['status','--porcelain','--untracked-files=all'])).trim())throw Error('Planning unexpectedly modified repository');
  stage='coding';
  safeLog('Codex implementing private task on isolated checkout');
  const codingPrompt=['You are implementing a requested feature for a private game repository.',
    sourceRules,'Write actual code and add appropriate new tests where feasible.',
    'Do not output credentials, private source text, or user task to terminal logs.',
    'Task: '+task,'Claude implementation guidance: '+planResult.result,
    'Finish only when changes are saved to files, not merely described.'].join('\n');
  await run('codex',['exec','--sandbox','workspace-write',codingPrompt],{timeout:660000});
  let paths=await changed();
  safeLog('Modified paths validated ('+paths.length+' files)');
  stage='validation';
  let diagnostic='';
  // Dot reporting avoids huge Vitest output exhausting the protected output buffer.
  const checks=[['TypeScript','npm',['run','typecheck']],['Unit tests','npm',['test','--','--reporter=dot']],['Production build','npm',['run','build']]];
  let ok=true;
  for(const [name,bin,args] of checks) {
    try{safeLog('Checking '+name);await run(bin,args,{timeout:420000});safeLog(name+' passed');}
    catch(e){ok=false;diagnostic+='\n'+name+': '+(e.privateDiagnostic||e.message).slice(-4500);safeLog(name+' failed');break;}
  }
  if(!ok) {
    // One repair pass; tests are not weakened and all changes are checked again.
    safeLog('Codex repairing validation failure');
    await run('codex',['exec','--sandbox','workspace-write','Fix the reported validation problem without changing existing tests or any files outside src/**/*.ts, src/**/*.tsx or new tests/**/*.test.ts. No package changes. Keep requested behavior. Diagnostic:\n'+diagnostic.slice(-6000)],{timeout:240000});
    paths=await changed();
    for(const [name,bin,args] of checks){safeLog('Rechecking '+name);await run(bin,args,{timeout:420000});}
  }
  paths=await changed();
  const diff=await gitDiff(paths);
  stage='review';
  safeLog(route.reviewer+' independently reviewing code changes');
  const review=await runReviewer({
    provider:route.reviewer,run,cwd,
    prompt:'You are a strict independent code reviewer. Evaluate adherence to the task, regression risk, obvious security problems, and whether tests appear meaningful. First line EXACTLY PASS or FAIL. Then brief reason. Do not edit any files. TASK:\\n'+task+'\\nCONTROL TOWER PLAN:\\n'+planResult.result+'\\nPATCH:\\n'+diff
  });
  const verdict=parseReviewVerdict(review);
  if(verdict!=='PASS')throw Error('Independent review rejected task');
  paths=await changed();
  safeLog(route.reviewer+' independent review PASSED');
  await writeFile(join(process.cwd(),'.private-task-result.json'),JSON.stringify({id,paths,route:createRouteMetadata(route)}));
  safeLog('Validated private change ready for PR publishing');
}catch(e){
  console.error('RESULT: FAILED during '+stage+' ('+String(e.message).replace(/[^a-zA-Z0-9 _.()/-]/g,'').slice(0,160)+')');
  process.exitCode=1;
}
