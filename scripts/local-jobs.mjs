// Trusted local host coordinator. No provider login, arbitrary command, API or PR.
import {createHash,randomUUID,createPublicKey} from 'node:crypto';
import {mkdir,lstat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {captureReceivedTask,validateQueueTaskId,validateReadyManifest,
  ensurePrivateStateRoot,readPrivateStateFile,writePrivateStateFile} from './private-queue.mjs';
import {handoffContext,MAX_HANDOFF_BYTES} from './private-handoff.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const json=b=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));
const limits={task:10000,references:2500,image:700000};
async function location({id,stateRoot}){
  validateQueueTaskId(id);const root=await ensurePrivateStateRoot(stateRoot),dir=join(root,id);
  await lstat(dir);await ensurePrivateStateRoot(dir);return dir;
}
async function descriptor(dir,id){
  const value=json(await readPrivateStateFile(join(dir,'job.json'),8192));
  if(!exact(value,['schemaVersion','context','manifestSha256','routing'])||value.schemaVersion!==1||
    value.context?.kind!=='local'||value.context.taskId!==id||! /^[a-f0-9]{64}$/.test(value.manifestSha256))throw Error('Invalid local descriptor');
  handoffContext(value.context);return value;
}
async function snapshot(dir,job){
  const raw=await readPrivateStateFile(join(dir,'input','ready-manifest.json'),8192);
  if(hash(raw)!==job.manifestSha256)throw Error('Prepared manifest changed');
  const manifest=validateReadyManifest(json(raw),job.context.taskId);
  if(JSON.stringify(job.routing)!==JSON.stringify(manifest.routing))throw Error('Prepared routing changed');
  for(const input of manifest.inputs){
    const bytes=await readPrivateStateFile(join(dir,'input','task-private',input.path),limits[input.kind]);
    if(bytes.length!==input.size||hash(bytes)!==input.sha256)throw Error('Prepared input changed');
  }
}
async function event(dir,job,sequence,phase,artifactSha256=null){
  const value={schemaVersion:1,taskId:job.context.taskId,runId:job.context.runId,sequence,phase,
    timestamp:new Date().toISOString(),artifactSha256};
  await writePrivateStateFile(join(dir,'events',String(sequence).padStart(4,'0')+'.json'),Buffer.from(JSON.stringify(value)+'\n'));
}
export async function prepareLocalJob({id,receiptRoot,stateRoot}){
  if(process.env.GITHUB_ACTIONS==='true')throw Error('Local host required');
  const packet=await captureReceivedTask({id,root:receiptRoot}),root=await ensurePrivateStateRoot(stateRoot);
  const dir=join(root,id);await mkdir(dir,{mode:0o700}); // Exclusive; never auto-resume a partial/old job.
  const context={kind:'local',schemaVersion:2,taskId:id,runId:randomUUID(),
    queueCommitSha:packet.receipt.queueCommitSha,receiptSha256:packet.receiptSha256};
  handoffContext(context);
  const job={schemaVersion:1,context,manifestSha256:hash(packet.rawManifest),routing:packet.manifest.routing};
  for(const input of packet.inputs)await writePrivateStateFile(join(dir,'input','task-private',input.path),input.content);
  await writePrivateStateFile(join(dir,'input','ready-manifest.json'),packet.rawManifest);
  await writePrivateStateFile(join(dir,'job.json'),Buffer.from(JSON.stringify(job)+'\n'));
  await event(dir,job,0,'prepared');return readLocalJob({id,stateRoot});
}
export async function readLocalJob({id,stateRoot}){
  const dir=await location({id,stateRoot}),job=await descriptor(dir,id);
  const names=(await readdir(join(dir,'events'))).sort();
  if(names.length<1||names.length>3||names.some((p,i)=>p!==String(i).padStart(4,'0')+'.json'))throw Error('Incomplete local journal');
  const phases=[['prepared'],['running'],['awaiting-independent-validation','failed','needs-recovery']];
  let latest;
  for(let i=0;i<names.length;i++){
    const value=json(await readPrivateStateFile(join(dir,'events',names[i]),4096));
    if(!exact(value,['schemaVersion','taskId','runId','sequence','phase','timestamp','artifactSha256'])||
      value.schemaVersion!==1||value.taskId!==id||value.runId!==job.context.runId||value.sequence!==i||
      !phases[i].includes(value.phase)||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.timestamp)||
      !Number.isFinite(Date.parse(value.timestamp))||
      (value.artifactSha256!==null&&! /^[a-f0-9]{64}$/.test(value.artifactSha256)))throw Error('Invalid local journal');
    latest=value;
  }
  let phase=latest.phase;
  if(phase==='prepared'){
    try{await lstat(join(dir,'worker-claim.json'));phase='needs-recovery';}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  if(['awaiting-independent-validation','failed'].includes(phase)){
    if(!latest.artifactSha256||hash(await readPrivateStateFile(join(dir,'result.enc'),MAX_HANDOFF_BYTES))!==latest.artifactSha256)
      throw Error('Local artifact integrity mismatch');
  }else if(latest.artifactSha256!==null)throw Error('Unexpected local artifact');
  return {taskId:id,phase,context:job.context,routing:job.routing,artifactSha256:latest.artifactSha256};
}
export async function runPreparedLocalJob({id,stateRoot,worker,publicKey,signal}){
  if(process.env.GITHUB_ACTIONS==='true'||typeof worker!=='function'||signal?.aborted)throw Error('Local backend unavailable');
  const key=createPublicKey({key:Buffer.from(publicKey||'','base64'),format:'der',type:'spki'});
  if(key.asymmetricKeyType!=='x25519')throw Error('Invalid local recipient');
  const dir=await location({id,stateRoot}),job=await descriptor(dir,id),state=await readLocalJob({id,stateRoot});
  if(state.phase!=='prepared')throw Error('Local job already claimed');
  await snapshot(dir,job);
  // Permanent one-shot claim. Cleanup/failure never silently makes a job runnable again.
  await writePrivateStateFile(join(dir,'worker-claim.json'),Buffer.from(JSON.stringify({runId:job.context.runId})+'\n'));
  await event(dir,job,1,'running');
  try{
    const result=await worker({context:Object.freeze({...job.context}),routing:Object.freeze({...job.routing}),
      queueDir:join(dir,'input','task-private'),publicKey,signal});
    if(signal?.aborted||result?.removed!==true||!['success','failure'].includes(result.executionOutcome)||
      !Buffer.isBuffer(result.encrypted)||result.encrypted.length<70||result.encrypted.length>MAX_HANDOFF_BYTES||
      result.encrypted.subarray(0,8).toString()!=='ORCHENC1')throw Error('Unconfirmed worker result');
    const captured=Buffer.from(result.encrypted),outcome=result.executionOutcome;
    await writePrivateStateFile(join(dir,'result.enc'),captured);
    if(signal?.aborted)throw Error('Cancelled before terminal commit');
    // Terminal-event append is the completion commit point. Later abort is too late.
    await event(dir,job,2,outcome==='success'?'awaiting-independent-validation':'failed',hash(captured));
  }catch{
    await event(dir,job,2,'needs-recovery');throw Error('Local worker did not complete safely');
  }
  return readLocalJob({id,stateRoot});
}
