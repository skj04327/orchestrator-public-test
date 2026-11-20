// Trusted local host. The review signer runs separately and only its public key is needed to verify a verdict.
import {createHash,KeyObject,verify} from 'node:crypto';
import {link,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {readIndependentCheckStatus} from './local-independent-checks.mjs';
import {captureDiskCheckInput} from './disk-check-input.mjs';
import {validateLocalCheckBundle} from './local-candidate-bundle.mjs';
import {MAX_HANDOFF_BYTES,open} from './private-handoff.mjs';
import {readPrivateStateFile,validateQueueTaskId,writePrivateStateFile} from './private-queue.mjs';
import {isVerifiedDigest} from './verified-manifest.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const exact=(value,fields)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===fields.length&&fields.every(field=>Object.hasOwn(value,field));
const digestFields=['artifactSha256','baselineManifestSha256','candidateContentSha256','checksSha256','reviewerKeySha256'];
const requestFields=['schemaVersion','taskId','runId','baseSha',...digestFields];
const recordFields=['schemaVersion','requestSha256','verdict','signature'];
const validVerdict=value=>value==='pass'||value==='fail';

function checkLocal(signal){
  if(process.env.GITHUB_ACTIONS==='true'||signal?.aborted)throw Error('Local review unavailable');
}
function fingerprint(key){
  if(!(key instanceof KeyObject)||key.type!=='public'||key.asymmetricKeyType!=='ed25519')throw Error('Invalid review public key');
  return hash(key.export({type:'spki',format:'der'}));
}
function requestValues(request){
  if(!exact(request,requestFields)||request.schemaVersion!==1||typeof request.runId!=='string'||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(request.runId)||
    typeof request.baseSha!=='string'||! /^[a-f0-9]{40}$/.test(request.baseSha)||
    digestFields.some(field=>!isVerifiedDigest(request[field])))throw Error('Invalid local review request');
  validateQueueTaskId(request.taskId);
  return requestFields.map(field=>request[field]);
}
export function reviewVerdictMessage(request,verdict){
  if(!validVerdict(verdict))throw Error('Invalid review verdict');
  return Buffer.from(JSON.stringify(['orchestrator-local-independent-review-v1',...requestValues(request),verdict]));
}
function requestFromReport(report,reviewerKeySha256){
  if(report.schemaVersion!==2||report.inputProfile!=='disk-v1'||report.phase!=='checks-passed-awaiting-review')return null;
  const {context,baseSha,artifactSha256,baselineManifestSha256,candidateContentSha256}=report;
  return Object.freeze({schemaVersion:1,taskId:context.taskId,runId:context.runId,baseSha,artifactSha256,
    baselineManifestSha256,candidateContentSha256,checksSha256:hash(JSON.stringify(report)),reviewerKeySha256});
}
const requestDigest=request=>hash(JSON.stringify(requestValues(request)));

async function readRecord(path){
  let bytes;
  try{bytes=await readPrivateStateFile(path,4096);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  let record;
  try{record=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw Error('Invalid local review record');}
  if(!exact(record,recordFields)||record.schemaVersion!==1||!isVerifiedDigest(record.requestSha256)||!validVerdict(record.verdict)||
    typeof record.signature!=='string'||record.signature.length!==88)throw Error('Invalid local review record');
  return record;
}
function verifiedStatus(request,record,reviewerPublicKey){
  const signature=Buffer.from(record.signature,'base64');
  if(signature.length!==64||signature.toString('base64')!==record.signature||record.requestSha256!==requestDigest(request)||
    !verify(null,reviewVerdictMessage(request,record.verdict),reviewerPublicKey,signature))throw Error('Invalid local review signature');
  return {taskId:request.taskId,phase:record.verdict==='pass'?'review-passed':'review-failed',review:record.verdict,
    requestSha256:record.requestSha256,reviewerKeySha256:request.reviewerKeySha256,publishAuthorized:false};
}

export async function readLocalIndependentReview({id,stateRoot,reviewerPublicKey}){
  checkLocal();
  const reviewerKeySha256=fingerprint(reviewerPublicKey);
  const options={id,stateRoot},report=await readIndependentCheckStatus(options);
  let request=requestFromReport(report,reviewerKeySha256);
  const record=await readRecord(join(stateRoot,id,'independent-review.json'));
  if(!record)return {taskId:id,phase:request?'awaiting-review':'not-ready',review:'not-run',publishAuthorized:false};
  // The checks and verdict may have completed after the initial report read.
  if(!request)request=requestFromReport(await readIndependentCheckStatus(options),reviewerKeySha256);
  if(!request)throw Error('Review without completed disk checks');
  return verifiedStatus(request,record,reviewerPublicKey);
}

export async function prepareLocalIndependentReview({id,stateRoot,privateKey,diskSnapshot,reviewerPublicKey,signal}){
  checkLocal(signal);
  const reviewerKeySha256=fingerprint(reviewerPublicKey);
  const report=await readIndependentCheckStatus({id,stateRoot});
  const request=requestFromReport(report,reviewerKeySha256),directory=join(stateRoot,id);
  if(!request||await readRecord(join(directory,'independent-review.json')))throw Error('Local review cannot be prepared');
  const encrypted=await readPrivateStateFile(join(directory,'result.enc'),MAX_HANDOFF_BYTES);
  if(hash(encrypted)!==request.artifactSha256)throw Error('Candidate artifact changed');
  const bundle=open(encrypted,privateKey,report.context);
  const input=captureDiskCheckInput({diskSnapshot,context:report.context,bundle});
  if(input.baseSha!==request.baseSha||input.baselineManifestSha256!==request.baselineManifestSha256||
    input.candidateContentSha256!==request.candidateContentSha256)throw Error('Candidate differs from checked input');
  checkLocal(signal);
  return {request,files:validateLocalCheckBundle(bundle,report.context).files};
}

export async function submitLocalIndependentReview({id,stateRoot,reviewerPublicKey,verdict,signature,signal}){
  checkLocal(signal);
  const reviewerKeySha256=fingerprint(reviewerPublicKey);
  if(!validVerdict(verdict)||!Buffer.isBuffer(signature)||signature.length!==64)throw Error('Invalid review response');
  const encoded=signature.toString('base64');
  const report=await readIndependentCheckStatus({id,stateRoot});
  const request=requestFromReport(report,reviewerKeySha256);
  if(!request)throw Error('Review requires completed disk checks');
  const record={schemaVersion:1,requestSha256:requestDigest(request),verdict,signature:encoded};
  const status=verifiedStatus(request,record,reviewerPublicKey);
  const directory=join(stateRoot,id);
  checkLocal(signal);
  const staging=await mkdtemp(join(directory,'.independent-review-'));
  let committed=false;
  try{
    const staged=join(staging,'record.json');
    await writePrivateStateFile(staged,Buffer.from(JSON.stringify(record)+'\n'));
    const current=requestFromReport(await readIndependentCheckStatus({id,stateRoot}),reviewerKeySha256);
    if(!current||requestDigest(current)!==record.requestSha256)throw Error('Review evidence changed before commit');
    checkLocal(signal);
    await link(staged,join(directory,'independent-review.json'));
    committed=true;
  }finally{
    try{await rm(staging,{recursive:true,force:true});}
    catch(error){
      // An already linked verdict remains terminal even if staging cleanup fails.
      if(!committed)throw error;
    }
  }
  return status;
}
