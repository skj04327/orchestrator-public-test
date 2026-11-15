// Private structured audit ledger, independent from the live task workflow.
// Collects *metadata*, not raw prompts, private source, model responses or credentials.
import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const TASK_ID=/^[0-9]{8}T[0-9]{6}Z-[0-9]+-[0-9]+$/;
const STAGES=new Set(['intake','plan','implementation','typecheck','unit-test','build','review','repair','publish']);
const STATUS=new Set(['started','passed','failed','skipped']);
const ROLES=new Set(['claude','codex','gemini','system']);
const VERDICTS=new Set(['PASS','FAIL','UNKNOWN']);
const MAX_EVENTS=100;
const FAILURE_KINDS=new Set(['nonzero_exit','timeout','output_limit','spawn_error','signal','operation_failed','blocked_capability']);
const str=(value,max=100)=>typeof value==='string'&&value.length>0&&value.length<=max;
const unsigned=(n)=>Number.isSafeInteger(n)&&n>=0;

/**
 * event requires stage, status, actor.
 * modelId and reasoningEffort are OPTIONAL and must be null if CLI has not verified them.
 * Do not infer a model, effort, duration or token usage from subscriptions.
 * For security, unknown event keys are ignored, rather than serialized.
 */
export function normalizeAuditEvent(event, now=new Date().toISOString()){
  if(!event||typeof event!=='object'||!STAGES.has(event.stage)||!STATUS.has(event.status)||!ROLES.has(event.actor))
    throw Error('Unsupported audit event');
  if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(now)||!Number.isFinite(Date.parse(now)))
    throw Error('Invalid audit time');
  if(event.modelId!=null&&!str(event.modelId,90))throw Error('Invalid model identifier');
  if(event.reasoningEffort!=null&&!str(event.reasoningEffort,30))throw Error('Invalid reasoning value');
  if(event.durationMs!=null&&!unsigned(event.durationMs))throw Error('Invalid duration');
  if(event.tokenUsage!=null&&(
    !event.tokenUsage||!unsigned(event.tokenUsage.input)||!unsigned(event.tokenUsage.output)
  ))throw Error('Invalid token usage');
  if(event.verdict!=null&&!VERDICTS.has(event.verdict))throw Error('Invalid verdict');
  if(event.failureKind!=null&&!FAILURE_KINDS.has(event.failureKind))throw Error('Invalid failure classification');
  if(event.workpackId!=null&&!/^P[1-4]$/.test(event.workpackId))throw Error('Invalid workpack ID');
  return {
    timestamp:now,
    stage:event.stage,
    status:event.status,
    actor:event.actor,
    modelId:event.modelId??null,
    reasoningEffort:event.reasoningEffort??null,
    durationMs:event.durationMs??null,
    tokenUsage:event.tokenUsage==null?null:{
      input:event.tokenUsage.input,
      output:event.tokenUsage.output
    },
    verdict:event.verdict??null,
    failureKind:event.failureKind??null,
    workpackId:event.workpackId??null
  };
}
export function createAuditLedger(taskId,{startedAt=new Date().toISOString()}={}){
  if(!TASK_ID.test(taskId))throw Error('Invalid task identifier');
  if(!Number.isFinite(Date.parse(startedAt)))throw Error('Invalid startedAt');
  const events=[];
  return {
    record(event,at){
      if(events.length>=MAX_EVENTS)throw Error('Audit event capacity exceeded');
      const next=normalizeAuditEvent(event,at);
      events.push(next);
      return next;
    },
    snapshot({status='in_progress',prUrl=null}={}){
      if(!['in_progress','passed','failed'].includes(status))throw Error('Unsupported final status');
      if(prUrl!==null&&(!str(prUrl,300)||!/^https:\/\/github\.com\/skj04327\/the-twilight-of-korea\/pull\/\d+$/.test(prUrl)))
        throw Error('Invalid PR URL');
      const counts={passed:0,failed:0,skipped:0};
      for(const e of events)if(e.status in counts)counts[e.status]++;
      return {
        schemaVersion:1,taskId,startedAt,status,prUrl,
        totalEvents:events.length,checks:counts,
        events:events.map(e=>({...e,tokenUsage:e.tokenUsage?{...e.tokenUsage}:null}))
      };
    }
  };
}
/** Writes only JSON metadata. Caller must persist to a PRIVATE repo, never public artifacts. */
export async function writePrivateAuditReport(directory,report){
  if(!TASK_ID.test(report?.taskId))throw Error('Invalid report task identifier');
  if(!report||report.schemaVersion!==1||!Array.isArray(report.events)||report.events.length>MAX_EVENTS)
    throw Error('Unsupported report');
  await mkdir(directory,{recursive:true,mode:0o700});
  const path=join(directory,report.taskId+'.json');
  const tmp=join(directory,'.'+report.taskId+'.'+randomUUID()+'.tmp');
  await writeFile(tmp,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
  await rename(tmp,path);
  return path;
}
export async function readPrivateAuditReport(path){
  const report=JSON.parse(await readFile(path,'utf8'));
  if(report.schemaVersion!==1||!TASK_ID.test(report.taskId))throw Error('Unsupported report');
  return report;
}
