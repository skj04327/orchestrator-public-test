// Ready proof and local receipt only. No provider, process execution or PR writes.
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,lstat,realpath,link,rm,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve,basename,dirname} from 'node:path';
import {findTaskImage,readTaskReferences} from './reference-gateway.mjs';
export const PRIVATE_QUEUE_REPO='skj04327/the-twilight-of-korea';
const BLOCKED='20261115T121256Z-10360-7098';
const ID=/^[0-9]{8}T[0-9]{6}Z-[0-9]+-[0-9]+$/;
const SHA=/^[a-f0-9]{40}$/,DIGEST=/^[a-f0-9]{64}$/;
const limits={task:10000,references:2500,image:700000};
const hash=b=>createHash('sha256').update(b).digest('hex');
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
export function validateQueueTaskId(id){
  if(typeof id!=='string'||id.length>80||!ID.test(id)||id===BLOCKED)throw Error('Task is unavailable for receipt');return id;
}
function routing(value){
  if(!exact(value,['mode','controller'])||!['auto','stable','manual'].includes(value.mode)||
    (value.mode==='manual'?!['claude','codex','gemini'].includes(value.controller):value.controller!=='auto'))throw Error('Invalid queue routing');
  return {mode:value.mode,controller:value.controller};
}
export function validateReadyManifest(value,id){
  validateQueueTaskId(id);
  if(!exact(value,['schemaVersion','taskId','routing','inputs'])||value.schemaVersion!==1||value.taskId!==id||
    !Array.isArray(value.inputs)||value.inputs.length<1||value.inputs.length>3)throw Error('Invalid readiness proof');
  const seen=new Set();
  const inputs=value.inputs.map(input=>{
    if(!exact(input,['kind','path','size','sha256'])||typeof input.kind!=='string'||!Object.hasOwn(limits,input.kind)||seen.has(input.kind)||
      !Number.isSafeInteger(input.size)||input.size<1||input.size>limits[input.kind]||!DIGEST.test(input.sha256))throw Error('Invalid queue input');
    seen.add(input.kind);
    const expected=input.kind==='task'?'docs/orchestrator/tasks/'+id+'.txt':input.kind==='references'?'docs/orchestrator/references/'+id+'.json':null;
    if(expected?input.path!==expected:typeof input.path!=='string'||
      !new RegExp('^docs/orchestrator/media/'+id+'\\.(png|jpg|jpeg)$').test(input.path))throw Error('Unsafe queue input path');
    return {...input};
  });
  if(!seen.has('task'))throw Error('Task text is missing');
  return {schemaVersion:1,taskId:id,routing:routing(value.routing),inputs};
}
export function createReadyManifest(id,route,inputs){
  if(!Array.isArray(inputs)||inputs.some(i=>!Buffer.isBuffer(i.content)))throw Error('Invalid queue buffers');
  return validateReadyManifest({schemaVersion:1,taskId:id,routing:route,inputs:inputs.map(i=>({
    kind:i.kind,path:i.path,size:i.content.length,sha256:hash(i.content)
  }))},id);
}
async function privateRoot(root){
  if(typeof root!=='string'||!root||!process.getuid)throw Error('Missing trusted Unix receipt root');
  const absolute=resolve(root);await mkdir(absolute,{recursive:true,mode:0o700});
  for(let parent=absolute;;parent=dirname(parent)){
    const directory=await lstat(parent);
    // An untrusted ancestor owner, or a nonsticky shared writable directory,
    // can replace the validated root even when its own mode is 0700.
    if(!directory.isDirectory()||directory.isSymbolicLink()||
      ![0,process.getuid()].includes(directory.uid)||
      ((directory.mode&0o022)&&!(directory.mode&0o1000)))throw Error('Unsafe receipt ancestor');
    try{
      const marker=await lstat(join(parent,'.git'));
      // Some managed sandboxes expose empty .git marker directories. A normal
      // Git directory has HEAD; a gitdir file/symlink is conservatively rejected.
      if(!marker.isDirectory())throw Error('Receipt root must be outside Git checkouts');
      try{await lstat(join(parent,'.git','HEAD'));throw Error('Receipt root must be outside Git checkouts');}
      catch(error){if(error.code!=='ENOENT')throw error;}
    }catch(error){if(error.code!=='ENOENT')throw error;}
    if(dirname(parent)===parent)break;
  }
  const stat=await lstat(absolute);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)||
    (process.getuid&&stat.uid!==process.getuid())||await realpath(absolute)!==absolute)throw Error('Unsafe receipt root');
  return absolute;
}
async function privateWrite(path,bytes){
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const f=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}
}
// Trusted host state helpers, never grant these roots to a worker.
export const ensurePrivateStateRoot=privateRoot;
export const writePrivateStateFile=privateWrite;
export async function readPrivateStateFile(path,limit){
  if(!Number.isSafeInteger(limit)||limit<1||limit>800000)throw Error('Invalid state read limit');
  await privateRoot(dirname(path));
  // Nonblocking open lets fstat reject FIFO/device substitution before a read can hang.
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const stat=await file.stat();
    if(!stat.isFile()||stat.size>limit||(stat.mode&0o077)||stat.uid!==process.getuid())throw Error('Unsafe state file');
    const bytes=Buffer.alloc(limit+1);let total=0;
    while(total<bytes.length){const {bytesRead}=await file.read(bytes,total,bytes.length-total,total);if(!bytesRead)break;total+=bytesRead;}
    if(total>limit)throw Error('Oversized state file');return bytes.subarray(0,total);
  }finally{await file.close();}
}
function contentFile(response,limit){
  if(response?.type!=='file'||response.encoding!=='base64'||typeof response.content!=='string'||
    !Number.isSafeInteger(response.size)||response.size<1||response.size>limit||response.content.length>Math.ceil(limit/3)*4+20000)throw Error('Invalid private API file');
  const encoded=response.content.replace(/\s/g,'');
  const bytes=Buffer.from(encoded,'base64');
  if(bytes.toString('base64')!==encoded||bytes.length!==response.size||bytes.length>limit)throw Error('Invalid private API encoding');
  return bytes;
}
export async function receivePrivateTask({id,root,get}){
  validateQueueTaskId(id);if(typeof get!=='function')throw Error('Missing private reader');
  const directory=await privateRoot(root);
  const metadata=await get('');
  if(metadata?.private!==true||metadata.full_name!==PRIVATE_QUEUE_REPO)throw Error('Queue repository must be private');
  const ref=await get('/git/ref/heads/orchestrator/task-queue');
  if(ref?.object?.type!=='commit'||!SHA.test(ref.object.sha))throw Error('Missing queue commit');
  const commit=ref.object.sha;
  const raw=contentFile(await get('/contents/docs/orchestrator/requests/'+id+'.json?ref='+commit),8192);
  const manifest=validateReadyManifest(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)),id);
  const captures=[];
  for(const input of manifest.inputs){
    const bytes=contentFile(await get('/contents/'+input.path+'?ref='+commit),limits[input.kind]);
    if(bytes.length!==input.size||hash(bytes)!==input.sha256)throw Error('Queue input integrity mismatch');
    if(input.kind==='task'){
      const task=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      if(!task.trim()||task.length>2500)throw Error('Task text out of bounds');
    }
    captures.push({input,bytes});
  }
  const stage=await mkdtemp(join(directory,'.receive-'));
  let committed=false;
  try{
    for(const {input,bytes} of captures)await privateWrite(join(stage,'task-private',input.path),bytes);
    // Reuse existing input parsers. No URL fetch or AI/image analysis is invoked.
    await readTaskReferences(join(stage,'task-private'),id);
    await findTaskImage(join(stage,'task-private'),id);
    const receipt={schemaVersion:1,taskId:id,phase:'received',queueCommitSha:commit,
      inputManifestSha256:hash(raw),routing:manifest.routing,bundleDirectory:basename(stage),receivedAt:new Date().toISOString()};
    await privateWrite(join(stage,'ready-manifest.json'),raw);
    await privateWrite(join(stage,'receipt.json'),Buffer.from(JSON.stringify(receipt)+'\n'));
    // Atomic exclusive index. Existing files/symlinks/competing receipts never get overwritten.
    await link(join(stage,'receipt.json'),join(directory,id+'.json'));committed=true;
    return receipt;
  }finally{if(!committed)await rm(stage,{recursive:true,force:true});}
}
export async function readLocalReceipt({id,root}){
  validateQueueTaskId(id);const directory=await privateRoot(root);
  return parseReceipt(await readPrivateStateFile(join(directory,id+'.json'),4096),id);
}
function parseReceipt(bytes,id){
  const value=JSON.parse(bytes.toString('utf8'));
  if(!exact(value,['schemaVersion','taskId','phase','queueCommitSha','inputManifestSha256','routing','bundleDirectory','receivedAt'])||
    value.schemaVersion!==1||value.taskId!==id||value.phase!=='received'||!SHA.test(value.queueCommitSha)||!DIGEST.test(value.inputManifestSha256)||
    !/^\.receive-[a-zA-Z0-9]{6,20}$/.test(value.bundleDirectory)||!Number.isFinite(Date.parse(value.receivedAt)))throw Error('Invalid receipt');
  return {...value,routing:routing(value.routing)};
}
export async function captureReceivedTask({id,root}){
  validateQueueTaskId(id);const directory=await privateRoot(root);
  const rawReceipt=await readPrivateStateFile(join(directory,id+'.json'),4096),receipt=parseReceipt(rawReceipt,id);
  const bundle=await privateRoot(join(directory,receipt.bundleDirectory));
  const rawManifest=await readPrivateStateFile(join(bundle,'ready-manifest.json'),8192);
  if(hash(rawManifest)!==receipt.inputManifestSha256)throw Error('Received manifest changed');
  const manifest=validateReadyManifest(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(rawManifest)),id);
  if(JSON.stringify(manifest.routing)!==JSON.stringify(receipt.routing))throw Error('Routing changed after receipt');
  const inputs=[];
  for(const input of manifest.inputs){
    const content=await readPrivateStateFile(join(bundle,'task-private',input.path),limits[input.kind]);
    if(content.length!==input.size||hash(content)!==input.sha256)throw Error('Received input changed');
    inputs.push({kind:input.kind,path:input.path,content});
  }
  return {receipt,receiptSha256:hash(rawReceipt),rawManifest,manifest,inputs};
}
