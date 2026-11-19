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
import {materializeDiskBaseline,diskExecutionMetadata} from './disk-baseline.mjs';
import {captureDiskCheckInput,getDiskCheckProvenance,validateDiskCheckProvenance} from './disk-check-input.mjs';
import {runDiskCheckStage,DISK_UNIT_TEST_TIMEOUT_MAX} from './disk-baseline-check.mjs';
import {failure} from './docker-command.mjs';
import {offlineNpmProvenance,validateOfflineNpmProvenance} from './offline-npm-runtime.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const kinds=['resource_limit','check_failed','docker_error','timeout','output_limit','cancelled','invalid_output','invalid_state','cleanup_failed','operation_failed'];
const order=['baseline:typecheck','baseline:unit-test','baseline:build','candidate:typecheck','candidate:unit-test','candidate:build'];
const claimKeys=['schemaVersion','context','artifactSha256','baseSha','baselineContentSha256','candidateContentSha256','imageId'];
const diskClaimKeys=['schemaVersion','inputProfile','context','artifactSha256','baseSha','baselineManifestSha256','candidateContentSha256','imageId','baselineProvenance'];
const fields=c=>c.schemaVersion===2?[...diskClaimKeys,...['offlineDependencies','unitTestTimeoutMs'].filter(key=>Object.hasOwn(c,key))]:Object.hasOwn(c,'baselineProvenance')?[...claimKeys,'baselineProvenance']:claimKeys;
const validUnitTestTimeout=value=>Number.isSafeInteger(value)&&value>=100&&value<=DISK_UNIT_TEST_TIMEOUT_MAX;
function baselineBinding(claim){
  if(claim.baselineProvenance?.projection)return 'github-main-projected';
  return Object.hasOwn(claim,'baselineProvenance')?'github-main-pinned':'caller-supplied';
}
async function optional(path){try{
  const value=JSON.parse((await readPrivateStateFile(path,16384)).toString('utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid independent state');return value;
}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function checkClaim(claim,state){
  const disk=claim.schemaVersion===2;
  if(!exact(claim,fields(claim))||!(disk?claim.inputProfile==='disk-v1':claim.schemaVersion===1)||
    !handoffContext(claim.context).equals(handoffContext(state.context))||claim.artifactSha256!==state.artifactSha256||!digest(claim.artifactSha256)||
    !digest(disk?claim.baselineManifestSha256:claim.baselineContentSha256)||!digest(claim.candidateContentSha256)||
    typeof claim.baseSha!=='string'||! /^[a-f0-9]{40}$/.test(claim.baseSha)||typeof claim.imageId!=='string'||! /^sha256:[a-f0-9]{64}$/.test(claim.imageId))throw Error('Invalid independent claim');
  if(disk){
    validateDiskCheckProvenance(claim.baselineProvenance,claim);
    if(Object.hasOwn(claim,'offlineDependencies'))validateOfflineNpmProvenance(claim.offlineDependencies,claim.baselineManifestSha256);
    if(Object.hasOwn(claim,'unitTestTimeoutMs')&&!validUnitTestTimeout(claim.unitTestTimeoutMs))throw Error('Invalid unit test deadline');
  }
  else if(Object.hasOwn(claim,'baselineProvenance'))validatePinnedBaselineProof(claim.baselineProvenance,claim);
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
  const keys=fields(claim),binding=baselineBinding(claim);
  if(!exact(report,[...keys,'phase','checks','baselineBinding','review','publishAuthorized','failureKind'])||
    keys.some(k=>JSON.stringify(report[k])!==JSON.stringify(claim[k]))||report.publishAuthorized!==false||
    report.baselineBinding!==binding||report.review!=='not-run'||
    !['checks-passed-awaiting-review','checks-failed','needs-recovery'].includes(report.phase)||
    !Array.isArray(report.checks)||report.checks.length>6||
    (report.failureKind!==null&&!kinds.includes(report.failureKind)))throw Error('Invalid independent report');
  report.checks.forEach((r,i)=>{
    const [variant,stage]=order[i].split(':');
    if(!exact(r,['variant','stage','status','failureKind','exitCode','removed','durationMs'])||(r.variant!==variant||r.stage!==stage)||
      !['passed','failed'].includes(r.status)||r.removed!==true||!Number.isSafeInteger(r.durationMs)||r.durationMs<0||
      (r.exitCode!==null&&(!Number.isInteger(r.exitCode)||r.exitCode<0||r.exitCode>255))||
      (r.status==='passed'?(r.exitCode!==0||r.failureKind!==null):!kinds.includes(r.failureKind))||
      (r.failureKind==='check_failed'&&(!Number.isInteger(r.exitCode)||r.exitCode===0)))throw Error('Invalid independent observation');
  });
  if(claim.schemaVersion===2){
    const infrastructure=report.checks.findIndex(r=>r.status==='failed'&&r.failureKind!=='check_failed');
    if(infrastructure>=0&&(infrastructure!==report.checks.length-1||report.phase!=='needs-recovery'||report.failureKind!==report.checks[infrastructure].failureKind))throw Error('Invalid disk recovery history');
  }
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
  return completeIndependentChecks({id,stateRoot,state,claim,config,input:snapshot,profile:'memory',signal});
}
async function completeIndependentChecks({id,stateRoot,state,claim,config,input,profile,offlineDependencies,signal}){
  const dir=join(stateRoot,id);
  if(signal?.aborted)throw Error('Cancelled before claim');
  await writePrivateStateFile(join(dir,'independent-claim.json'),Buffer.from(JSON.stringify(claim)+'\n'));
  const checks=[];let phase='needs-recovery',failureKind=null;
  try{
    for(const key of order){
      const [variant,stage]=key.split(':');
      const raw=profile==='disk'?await runDiskCheckStage({...config,
        timeoutMs:stage==='unit-test'?(claim.unitTestTimeoutMs??config.timeoutMs):config.timeoutMs,
        checkInput:input,variant,stage,offlineDependencies,signal}):
        await runIsolatedCheck({...config,payload:input.payload,variant,stage,signal});
      if(profile==='disk'&&(raw.baseSha!==claim.baseSha||raw.manifestSha256!==claim.baselineManifestSha256||raw.candidateContentSha256!==claim.candidateContentSha256||
        raw.baselineBinding!==baselineBinding(claim)||raw.projection?.sha256!==claim.baselineProvenance.projection?.sha256||raw.publishAuthorized!==false)){
        const error=Error('Disk observation binding failed');error.failureKind='invalid_output';throw error;
      }
      const observed={variant:raw.variant,stage:raw.stage,status:raw.status,failureKind:raw.failureKind!==null&&!kinds.includes(raw.failureKind)?'invalid_output':raw.failureKind,exitCode:raw.exitCode,removed:raw.removed,durationMs:raw.durationMs};checks.push(observed);
      if(observed.status==='failed'&&observed.failureKind!=='check_failed'){
        const error=Error('Independent infrastructure failed');error.failureKind=observed.failureKind;throw error;
      }
    }
    const finalState=await readLocalJob({id,stateRoot});
    if(signal?.aborted||finalState.artifactSha256!==state.artifactSha256)throw Error('Independent completion interrupted');
    phase=checks.every(r=>r.status==='passed')?'checks-passed-awaiting-review':'checks-failed';
  }catch(error){failureKind=kinds.includes(error.failureKind)?error.failureKind:signal?.aborted?'cancelled':'operation_failed';}
  // Terminal report append is the commit point; no automatic retry after any claim.
  const report={...claim,phase,checks,baselineBinding:baselineBinding(claim),review:'not-run',publishAuthorized:false,failureKind};
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

export async function runLargeDiskIndependentChecks({id,stateRoot,privateKey,diskSnapshot,offlineDependencies,imageId,timeoutMs,unitTestTimeoutMs,outputLimit,signal}){
  if(process.env.GITHUB_ACTIONS==='true'||signal?.aborted)throw Error('Local host required');
  const config=captureCheckConfiguration({imageId,timeoutMs,outputLimit});
  if(unitTestTimeoutMs!==undefined&&!validUnitTestTimeout(unitTestTimeoutMs))throw failure('invalid_configuration');
  diskExecutionMetadata(diskSnapshot); // deny data-only/forged handles before the first await
  const dependencyProof=offlineNpmProvenance(offlineDependencies,diskSnapshot);
  const state=await readLocalJob({id,stateRoot});if(state.phase!=='awaiting-independent-validation')throw Error('Local result unavailable');
  const encrypted=await readPrivateStateFile(join(stateRoot,id,'result.enc'),MAX_HANDOFF_BYTES);
  if(hash(encrypted)!==state.artifactSha256)throw Error('Local artifact changed');
  const input=captureDiskCheckInput({diskSnapshot,context:state.context,bundle:open(encrypted,privateKey,state.context)}),proof=getDiskCheckProvenance(input);
  const claim={schemaVersion:2,inputProfile:'disk-v1',context:state.context,artifactSha256:state.artifactSha256,...proof,imageId:config.imageId,
    ...(unitTestTimeoutMs===undefined?{}:{unitTestTimeoutMs}),
    ...(dependencyProof?{offlineDependencies:dependencyProof}:{})};
  checkClaim(claim,state);
  return completeIndependentChecks({id,stateRoot,state,claim,config,input,profile:'disk',offlineDependencies,signal});
}
