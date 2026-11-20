// Local data only. The caller must obtain approval for the exact scope before any provider transfer.
import {createHash} from 'node:crypto';
import {selectDiskDeveloperSources,readDiskDeveloperSources} from './disk-baseline.mjs';
import {readPreparedDeveloperTask} from './local-jobs.mjs';
import {handoffContext} from './private-handoff.mjs';
import {validateQueueTaskId} from './private-queue.mjs';
import {isVerifiedDigest} from './verified-manifest.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const unavailable=()=>Error('Local developer input unavailable');
const provider='codex';

function metadata(task,diskSnapshot,entries){
  return {schemaVersion:1,provider,taskId:task.context.taskId,runId:task.context.runId,baselineManifestSha256:diskSnapshot.manifestSha256,
    taskSha256:task.taskSha256,files:entries.map(({path,sha256})=>({path,sha256}))};
}
function readApproval(scope){
  if(!exact(scope,['schemaVersion','provider','taskId','runId','baselineManifestSha256','taskSha256','files'])||
    scope.schemaVersion!==1||scope.provider!==provider||typeof scope.runId!=='string'||!isVerifiedDigest(scope.baselineManifestSha256)||
    !isVerifiedDigest(scope.taskSha256)||!Array.isArray(scope.files)||scope.files.length>8)throw unavailable();
  const taskId=validateQueueTaskId(scope.taskId);
  const files=Array.from(scope.files,entry=>{
    if(!exact(entry,['path','sha256'])||typeof entry.path!=='string'||!isVerifiedDigest(entry.sha256))throw unavailable();
    return {path:entry.path,sha256:entry.sha256};
  }).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  return {schemaVersion:1,provider,taskId,runId:scope.runId,baselineManifestSha256:scope.baselineManifestSha256,taskSha256:scope.taskSha256,files};
}
function text(bytes){
  const value=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
  if(value.includes('\0'))throw unavailable();
  return value;
}

export async function inspectLocalDeveloperScope({id,stateRoot,diskSnapshot,paths,signal}){
  if(process.env.GITHUB_ACTIONS==='true'||signal?.aborted)throw unavailable();
  const entries=selectDiskDeveloperSources(diskSnapshot,paths);
  const task=await readPreparedDeveloperTask({id,stateRoot,signal});
  return metadata(task,diskSnapshot,entries);
}

export async function prepareLocalDeveloperInput({id,stateRoot,diskSnapshot,approvedScope,signal}){
  if(process.env.GITHUB_ACTIONS==='true'||signal?.aborted)throw unavailable();
  const scope=readApproval(approvedScope),paths=scope.files.map(file=>file.path);
  const entries=selectDiskDeveloperSources(diskSnapshot,paths);
  const task=await readPreparedDeveloperTask({id,stateRoot,signal});
  if(JSON.stringify(scope)!==JSON.stringify(metadata(task,diskSnapshot,entries)))throw unavailable();
  const sources=await readDiskDeveloperSources(diskSnapshot,paths,{signal});
  const input=JSON.stringify({schemaVersion:1,provider,runId:scope.runId,baselineManifestSha256:scope.baselineManifestSha256,
    task:text(task.bytes),files:sources.map(({path,bytes})=>({path,content:text(bytes)}))});
  if(Buffer.byteLength(input)>512000)throw unavailable();
  const current=await readPreparedDeveloperTask({id,stateRoot,signal});
  if(signal?.aborted||current.manifestSha256!==task.manifestSha256||current.taskSha256!==task.taskSha256||
    !handoffContext(current.context).equals(handoffContext(task.context)))throw unavailable();
  return {input,scopeSha256:hash(JSON.stringify(scope)),inputSha256:hash(input)};
}
