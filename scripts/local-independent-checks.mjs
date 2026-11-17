// Local host only: decrypt on host, execute code without keys, never grant publish authority.
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {readLocalJob} from './local-jobs.mjs';
import {readPrivateStateFile,writePrivateStateFile} from './private-queue.mjs';
import {open,handoffContext,MAX_HANDOFF_BYTES} from './private-handoff.mjs';
import {captureCheckSnapshot,captureBaselineInput} from './independent-check-input.mjs';
import {runIsolatedCheck,captureCheckConfiguration} from './isolated-check.mjs';
import {getPinnedBaselineProof,validatePinnedBaselineProof,collectPrivateBaseline} from './pinned-private-baseline.mjs';
import {ghBaselineGet} from './pinned-baseline-cli.mjs';
import {validateBundle} from './private-task-bundle.mjs';
import {materializeDiskBaseline} from './disk-baseline.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const kinds=['resource_limit','check_failed','docker_error','timeout','output_limit','cancelled','invalid_output','invalid_state','cleanup_failed','operation_failed'];
const order=['baseline:typecheck','baseline:unit-test','baseline:build','candidate:typecheck','candidate:unit-test','candidate:build'];
const claimKeys=['schemaVersion','context','artifactSha256','baseSha','baselineContentSha256','candidateContentSha256','imageId'];
const fields=c=>Object.hasOwn(c,'baselineProvenance')?[...claimKeys,'baselineProvenance']:claimKeys;
async function optional(path){try{
  const value=JSON.parse((await readPrivateStateFile(path,16384)).toString('utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid independent state');return value;
}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function checkClaim(claim,state){
  if(!exact(claim,fields(claim))||claim.schemaVersion!==1||!handoffContext(claim.context).equals(handoffContext(state.context))||
    claim.artifactSha256!==state.artifactSha256||!digest(claim.artifactSha256)||!digest(claim.baselineContentSha256)||
    !digest(claim.candidateContentSha256)||! /^[a-f0-9]{40}$/.test(claim.baseSha)||! /^sha256:[a-f0-9]{64}$/.test(claim.imageId))throw Error('Invalid independent claim');
  if(Object.hasOwn(claim,'baselineProvenance'))validatePinnedBaselineProof(claim.baselineProvenance,claim);
}
export async function readIndependentCheckStatus({id,stateRoot}){
  const state=await readLocalJob({id,stateRoot}),dir=join(stateRoot,id),claim=await optional(join(dir,'independent-claim.json'));
  if(!claim){
    if(await optional(join(dir,'independent-report.json')))throw Error('Unclaimed independent report');
    return {taskId:id,phase:'not-started',publishAuthorized:false};
  }
  checkClaim(claim,state);
  const report=await optional(join(dir,'independent-report.json'));
  if(!report)return {taskId:id,phase:'running-or-needs-recovery',publishAuthorized:false};
  const keys=fields(claim),binding=Object.hasOwn(claim,'baselineProvenance')?'github-main-pinned':'caller-supplied';
  if(!exact(report,[...keys,'phase','checks','baselineBinding','review','publishAuthorized','failureKind'])||
    keys.some(k=>JSON.stringify(report[k])!==JSON.stringify(claim[k]))||report.publishAuthorized!==false||
    report.baselineBinding!==binding||report.review!=='not-run'||
    !['checks-passed-awaiting-review','checks-failed','needs-recovery'].includes(report.phase)||
    !Array.isArray(report.checks)||report.checks.length>6||
    (report.failureKind!==null&&!kinds.includes(report.failureKind)))throw Error('Invalid independent report');
  report.checks.forEach((r,i)=>{
    if(!exact(r,['variant','stage','status','failureKind','exitCode','removed','durationMs'])||r.variant+':'+r.stage!==order[i]||
      !['passed','failed'].includes(r.status)||r.removed!==true||!Number.isSafeInteger(r.durationMs)||r.durationMs<0||
      (r.exitCode!==null&&(!Number.isInteger(r.exitCode)||r.exitCode<0||r.exitCode>255))||
      (r.status==='passed'?(r.exitCode!==0||r.failureKind!==null):!kinds.includes(r.failureKind))||
      (r.failureKind==='check_failed'&&(!Number.isInteger(r.exitCode)||r.exitCode===0)))throw Error('Invalid independent observation');
  });
  const allPassed=report.checks.length===6&&report.checks.every(r=>r.status==='passed');
  if(report.phase==='checks-passed-awaiting-review'&&(!allPassed||report.failureKind!==null)||
    report.phase==='checks-failed'&&(report.checks.length!==6||allPassed||report.failureKind!==null||
      report.checks.some(r=>r.status==='failed'&&r.failureKind!=='check_failed'))||
    report.phase==='needs-recovery'&&report.failureKind===null)throw Error('Invalid independent completion');
  return report;
}
export async function runLocalIndependentChecks({id,stateRoot,privateKey,baseline,imageId,timeoutMs,outputLimit,signal}){
  if(process.env.GITHUB_ACTIONS==='true'||signal?.aborted)throw Error('Local host required');
  const provenance=getPinnedBaselineProof(baseline),capturedBaseline=captureBaselineInput(baseline),config=captureCheckConfiguration({imageId,timeoutMs,outputLimit});
  const state=await readLocalJob({id,stateRoot});
  if(state.phase!=='awaiting-independent-validation')throw Error('Local result unavailable');
  const dir=join(stateRoot,id),encrypted=await readPrivateStateFile(join(dir,'result.enc'),MAX_HANDOFF_BYTES);
  if(hash(encrypted)!==state.artifactSha256)throw Error('Local artifact changed');
  const snapshot=captureCheckSnapshot({context:state.context,bundle:open(encrypted,privateKey,state.context),baseline:capturedBaseline});
  const claim={schemaVersion:1,context:state.context,artifactSha256:state.artifactSha256,baseSha:snapshot.baseSha,
    baselineContentSha256:snapshot.baselineContentSha256,candidateContentSha256:snapshot.candidateContentSha256,imageId:config.imageId};
  if(provenance){validatePinnedBaselineProof(provenance,claim);claim.baselineProvenance=provenance;}
  if(signal?.aborted)throw Error('Cancelled before claim');
  await writePrivateStateFile(join(dir,'independent-claim.json'),Buffer.from(JSON.stringify(claim)+'\n'));
  const checks=[];let phase='needs-recovery',failureKind=null;
  try{
    for(const key of order){
      const [variant,stage]=key.split(':');
      const observed=await runIsolatedCheck({...config,payload:snapshot.payload,variant,stage,signal});checks.push(observed);
      if(observed.status==='failed'&&observed.failureKind!=='check_failed'){
        const error=Error('Independent infrastructure failed');error.failureKind=observed.failureKind;throw error;
      }
    }
    const finalState=await readLocalJob({id,stateRoot});
    if(signal?.aborted||finalState.artifactSha256!==state.artifactSha256)throw Error('Independent completion interrupted');
    phase=checks.every(r=>r.status==='passed')?'checks-passed-awaiting-review':'checks-failed';
  }catch(error){failureKind=kinds.includes(error.failureKind)?error.failureKind:signal?.aborted?'cancelled':'operation_failed';}
  // Terminal report append is the commit point; no automatic retry after any claim.
  const report={...claim,phase,checks,baselineBinding:provenance?'github-main-pinned':'caller-supplied',review:'not-run',publishAuthorized:false,failureKind};
  await writePrivateStateFile(join(dir,'independent-report.json'),Buffer.from(JSON.stringify(report)+'\n'));
  return readIndependentCheckStatus({id,stateRoot});
}
export async function runPinnedIndependentChecks({id,stateRoot,privateKey,imageId,timeoutMs,outputLimit,signal,get=ghBaselineGet,snapshotTimeoutMs=180000}){
  if(process.env.GITHUB_ACTIONS==='true'||signal?.aborted)throw Error('Local host required');
  const config=captureCheckConfiguration({imageId,timeoutMs,outputLimit}),state=await readLocalJob({id,stateRoot});
  if(state.phase!=='awaiting-independent-validation')throw Error('Local result unavailable');
  const encrypted=await readPrivateStateFile(join(stateRoot,id,'result.enc'),MAX_HANDOFF_BYTES);
  if(hash(encrypted)!==state.artifactSha256)throw Error('Local artifact changed');
  const bundle=validateBundle(open(encrypted,privateKey,state.context),state.context);
  if(!bundle.result)throw Error('Local source unavailable');
  const collected=await collectPrivateBaseline({get,expectedBaseSha:bundle.baseSha,signal,timeoutMs:snapshotTimeoutMs});
  if(collected.phase!=='captured')return {taskId:id,phase:collected.phase,fileCount:collected.fileCount,totalBytes:collected.totalBytes,publishAuthorized:false};
  return runLocalIndependentChecks({id,stateRoot,privateKey,...config,signal,baseline:collected.baseline});
}
export async function runDiskIndependentChecks({id,stateRoot,privateKey,diskSnapshot,imageId,timeoutMs,outputLimit,signal}){
  if(process.env.GITHUB_ACTIONS==='true'||signal?.aborted)throw Error('Local host required');
  const config=captureCheckConfiguration({imageId,timeoutMs,outputLimit}),state=await readLocalJob({id,stateRoot});
  if(state.phase!=='awaiting-independent-validation')throw Error('Local result unavailable');
  const encrypted=await readPrivateStateFile(join(stateRoot,id,'result.enc'),MAX_HANDOFF_BYTES);
  if(hash(encrypted)!==state.artifactSha256)throw Error('Local artifact changed');
  const bundle=validateBundle(open(encrypted,privateKey,state.context),state.context);
  if(!bundle.result||diskSnapshot?.baseSha!==bundle.baseSha)throw Error('Wrong disk baseline');
  const ready=await materializeDiskBaseline(diskSnapshot,{signal});
  if(ready.phase!=='materialized')return {taskId:id,...ready,publishAuthorized:false};
  return runLocalIndependentChecks({id,stateRoot,privateKey,...config,signal,baseline:ready.baseline});
}
