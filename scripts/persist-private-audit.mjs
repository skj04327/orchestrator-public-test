// Publishes whitelisted execution metadata exclusively to the private task queue.
// This script is only invoked in a distinct post-execution step with a write token.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAuditLedger } from './audit-ledger.mjs';

const REPO='skj04327/the-twilight-of-korea';
const QUEUE_BRANCH='orchestrator/task-queue';
const TASK_ID=/^[0-9]{8}T[0-9]{6}Z-[0-9]+-[0-9]+$/;
const PR_URL=/^https:\/\/github\.com\/skj04327\/the-twilight-of-korea\/pull\/\d+$/;

export function finalizePrivateReport(id, existing, outcome='skipped', prUrl=null){
  if(!TASK_ID.test(id)||!['success','failure','skipped','cancelled'].includes(outcome))
    throw Error('Invalid report context');
  if(prUrl!==null&&!PR_URL.test(prUrl))throw Error('Invalid private PR URL');
  const startedAt=existing?.taskId===id&&Number.isFinite(Date.parse(existing.startedAt))?existing.startedAt:new Date().toISOString();
  const ledger=createAuditLedger(id,{startedAt});
  if(existing?.taskId===id&&Array.isArray(existing.events)){
    // Normalize every event; never copy arbitrary fields from the workspace or CLI output.
    for(const event of existing.events.slice(0,90))ledger.record(event,event.timestamp);
  }else{
    ledger.record({stage:'intake',actor:'system',status:'failed',failureKind:'operation_failed'});
  }
  ledger.record({stage:'publish',actor:'system',
    status:outcome==='success'?'passed':outcome==='skipped'||outcome==='cancelled'?'skipped':'failed',
    failureKind:outcome==='failure'?'operation_failed':null
  });
  return ledger.snapshot({
    status:outcome==='success'&&existing?.status==='passed'?'passed':'failed',
    prUrl:outcome==='success'?prUrl:null
  });
}

async function getJsonOrNull(path){
  try{return JSON.parse(await readFile(path,'utf8'));}catch{return null;}
}

export async function persistPrivateAudit(){
  const id=process.env.TASK_ID,token=process.env.PRIVATE_GAME_WRITE_TOKEN;
  if(!TASK_ID.test(id||'')||!token)throw Error('Missing report context');
  const directory=process.env.ORCHESTRATOR_AUDIT_DIR;
  if(!directory)throw Error('Missing private report directory');
  const existing=await getJsonOrNull(join(directory,id+'.json'));
  const published=await getJsonOrNull('.private-task-pr.json');
  const report=finalizePrivateReport(id,existing,
    process.env.PUBLISH_OUTCOME||'skipped',published?.prUrl??null);
  const path='docs/orchestrator/reports/'+id+'.json';
  const url='https://api.github.com/repos/'+REPO+'/contents/'+path;
  const headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
    'X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'};
  const old=await fetch(url+'?ref='+encodeURIComponent(QUEUE_BRANCH),{headers});
  if(old.status!==200&&old.status!==404)throw Error('Cannot inspect private report location HTTP '+old.status);
  const sha=old.status===200?(await old.json()).sha:null;
  const payload={message:'audit: metadata for task '+id,branch:QUEUE_BRANCH,
    content:Buffer.from(JSON.stringify(report,null,2)+'\n','utf8').toString('base64')};
  if(sha)payload.sha=sha;
  const put=await fetch(url,{method:'PUT',headers,body:JSON.stringify(payload)});
  if(!put.ok)throw Error('Cannot save private report HTTP '+put.status);
  // Never print private details, source, raw task or report content.
  console.log('STATUS: PRIVATE_AUDIT_SAVED');
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  persistPrivateAudit().catch(()=>{
    console.error('RESULT: PRIVATE_AUDIT_SAVE_FAILED');
    process.exitCode=1;
  });
}
