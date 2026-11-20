// Trusted host content-addressed cache. No source execution, provider login or publishing.
import {mkdir,mkdtemp,open,rm,link,statfs} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {makeTarHeader} from './container-tar.mjs';
import {ensurePrivateStateRoot,writePrivateStateFile} from './private-queue.mjs';
import {readMainInventory,readPrivateMainHead,checkTree,BASELINE_REPOSITORY,fail} from './main-inventory.mjs';
import {privateReadSession} from './private-read-session.mjs';
import {fetchGitBlobToFile,MAX_DISK_BLOB} from './gh-blob-stream.mjs';
import {isSafeBaselinePath,captureBaselineInput,baselineContentDigest} from './independent-check-input.mjs';
import {isSafeManifestPath} from './verified-manifest.mjs';
const MAX_TOTAL=1073741824,MAX_INDEX=8388608,handles=new WeakMap(),materialized=new WeakMap();
const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v),digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
function diskPath(path,allowSensitive=false){
  return typeof path==='string'&&path.length<=240&&path.split('/').length<=32&&/^[\p{L}\p{M}\p{N}_.@ /()-]+$/u.test(path)&&
    path.split('/').every(p=>p&&p!=='.'&&p!=='..'&&(allowSensitive||!/^(?:\.git|node_modules|\.env.*|\.npmrc|\.codex|\.claude|\.gemini|\.aws|\.ssh|\.config|\.docker|\.azure|\.kube|\.gnupg|\.npm|\.cache|\.local)$/.test(p)));
}
const PROJECTED='checks-projected';
const CONFIG_PROJECTION='omit-root-agent-config-v1';
const indexFields=['schemaVersion','purpose','repository','ref','baseSha','treeSha','observedAt','fileCount','totalBytes','manifestSha256','bundleDirectory','treeEntries','files'];
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const manifestDigest=index=>hash(['disk-baseline-v1',index.schemaVersion,index.purpose,index.repository,index.ref,
  index.baseSha,index.treeSha,index.observedAt,index.bundleDirectory,index.files,...(index.projection?[index.projection]:[])]);
const countBytes=entries=>entries.reduce((sum,entry)=>sum+entry.size,0);
const withinCapacity=(entries,totalBytes)=>entries.length<=10000&&totalBytes<=MAX_TOTAL&&entries.every(entry=>entry.size<=MAX_DISK_BLOB);
const hasProject=entries=>entries.some(e=>e.path==='package.json')&&entries.some(e=>e.path==='package-lock.json');
const capturePhase=purpose=>purpose===PROJECTED?'captured-projected':purpose==='checks'?'captured-disk':'captured-data-only';
function uniqueBlobs(entries){
  const unique=new Map();
  for(const entry of entries){
    const prior=unique.get(entry.sha);
    if(prior&&prior.size!==entry.size)throw fail('invalid_blob_size');
    unique.set(entry.sha,entry);
  }
  return unique;
}
const withinRequestBudget=unique=>unique.size+6<=4000;


function projectExecutionInput({baseSha,treeSha,entries}){
  const excluded=entries.filter(entry=>!diskPath(entry.path));
  if(excluded.length<1||excluded.length>8||excluded.some(entry=>
    !/^(?:\.claude|\.codex|\.gemini)\/[a-zA-Z0-9_.-]{1,100}$/.test(entry.path)||
    entry.mode!=='100644'||entry.size>65536))return null;
  const excludedShas=new Set(excluded.map(entry=>entry.sha));
  const selected=entries.filter(entry=>diskPath(entry.path));
  // A kept path sharing the same blob would still deliver the excluded bytes.
  if(selected.some(entry=>excludedShas.has(entry.sha)))return null;
  return {entries:selected,projection:Object.freeze({
    policy:CONFIG_PROJECTION,excludedFileCount:excluded.length,
    sha256:hash([CONFIG_PROJECTION,baseSha,treeSha,excluded.map(entry=>[entry.path,entry.mode,entry.sha,entry.size])])
  })};
}

export function validateDiskProjection(projection){
  return exact(projection,['policy','excludedFileCount','sha256'])&&projection.policy===CONFIG_PROJECTION&&
    Number.isSafeInteger(projection.excludedFileCount)&&projection.excludedFileCount>=1&&projection.excludedFileCount<=8&&digest(projection.sha256);
}
function sameProjection(left,right){
  return validateDiskProjection(left)&&left.policy===right.policy&&left.excludedFileCount===right.excludedFileCount&&left.sha256===right.sha256;
}
export async function inspectDiskExecutionInput({get,signal,timeoutMs=90000}){
  if(process.env.GITHUB_ACTIONS==='true')throw fail('invalid_configuration');
  const session=privateReadSession({get,signal,timeoutMs,requestLimit:6});
  try{
    const inventory=await readMainInventory({request:session.request});
    if(await readPrivateMainHead(session.request)!==inventory.baseSha)throw fail('main_moved');
    session.checkStopped();
    const {baseSha,treeSha,entries,totalBytes}=inventory;
    const summary={baseSha,treeSha,fileCount:entries.length,totalBytes,publishAuthorized:false};
    if(!withinCapacity(entries,totalBytes))return {phase:'blocked-capacity',...summary};
    if(!hasProject(entries))return {phase:'blocked-input-policy',...summary};
    if(entries.every(entry=>diskPath(entry.path))){
      const phase=withinRequestBudget(uniqueBlobs(entries))?'eligible-for-capture':'blocked-request-budget';
      return {phase,...summary};
    }
    const projected=projectExecutionInput(inventory);
    if(!projected)return {phase:'blocked-input-policy',...summary};
    if(!withinRequestBudget(uniqueBlobs(projected.entries)))return {phase:'blocked-request-budget',...summary};
    return {phase:'projection-available',...summary,excludedFileCount:projected.projection.excludedFileCount,
      projectionSha256:projected.projection.sha256};
  }finally{session.dispose();}
}
async function readPrivate(path,limit){
  const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const stat=await f.stat();if(!stat.isFile()||stat.uid!==process.getuid()||(stat.mode&0o077)||stat.size>limit)throw fail('unsafe_cache');
    const b=Buffer.alloc(limit+1);let n=0;
    while(n<b.length){const {bytesRead}=await f.read(b,n,b.length-n,n);if(!bytesRead)break;n+=bytesRead;}
    if(n>limit)throw fail('unsafe_cache');return b.subarray(0,n);
  }finally{await f.close();}
}
async function verifyBlob(path,entry,{collect=false,check=()=>{},copyTo}={}){
  check();const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK),chunks=[];
  try{
    const s=await f.stat();if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o077)||s.nlink!==1||s.size!==entry.size)throw fail('unsafe_cache_blob');
    if(collect&&entry.size>1048576)throw fail('memory_capacity');
    const h1=createHash('sha1').update('blob '+entry.size+'\0'),h256=createHash('sha256'),b=Buffer.alloc(65536);let n=0;
    while(true){check();const {bytesRead}=await f.read(b,0,b.length,n);if(!bytesRead)break;n+=bytesRead;if(n>entry.size)throw fail('blob_integrity');
      const part=b.subarray(0,bytesRead);h1.update(part);h256.update(part);if(collect)chunks.push(Buffer.from(part));
      if(copyTo){
        let offset=0;
        while(offset<bytesRead){
          check();
          const {bytesWritten}=await copyTo.write(part,offset,bytesRead-offset);
          if(!bytesWritten)throw fail('disk_write_failed');
          offset+=bytesWritten;
        }
      }
    }
    const hash=h256.digest('hex');check();
    if(n!==entry.size||h1.digest('hex')!==entry.sha||(entry.sha256&&hash!==entry.sha256))throw fail('blob_integrity');
    return {sha256:hash,...(collect?{content:Buffer.concat(chunks,n).toString('base64')}:{})};
  }finally{await f.close();}
}
async function copyCacheBlob(source,entry,destination,check){
  check();
  const target=await open(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{
    await verifyBlob(join(source,entry.sha),entry,{check,copyTo:target});
    await target.sync();
    check();
  }finally{await target.close();}
}
function validateIndex(value,baseSha){
  const projected=value?.purpose===PROJECTED;
  if(!exact(value,projected?[...indexFields,'projection']:indexFields)||
    !['checks','data-only',PROJECTED].includes(value.purpose)||
    value.schemaVersion!==2||value.repository!==BASELINE_REPOSITORY||value.ref!=='refs/heads/main'||value.baseSha!==baseSha||!sha(value.baseSha)||!sha(value.treeSha)||
    typeof value.bundleDirectory!=='string'||!/^\.disk-[a-zA-Z0-9]{6,20}$/.test(value.bundleDirectory)||
    typeof value.observedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.observedAt)||!Number.isFinite(Date.parse(value.observedAt))||
    !digest(value.manifestSha256)||!Array.isArray(value.files))throw fail('invalid_cache_index');
  const fullEntries=checkTree({sha:value.treeSha,truncated:false,tree:value.treeEntries},value.treeSha);
  if(!withinCapacity(fullEntries,countBytes(fullEntries)))throw fail('invalid_cache_index');
  let entries=fullEntries;
  if(projected){
    const selection=projectExecutionInput({...value,entries:fullEntries});
    if(!selection||!sameProjection(value.projection,selection.projection))throw fail('invalid_cache_index');
    entries=selection.entries;
    value={...value,projection:selection.projection};
  }
  if(!hasProject(entries)||entries.length!==value.fileCount||value.files.length!==entries.length||
    countBytes(entries)!==value.totalBytes||entries.some(e=>!diskPath(e.path,value.purpose==='data-only')))throw fail('invalid_cache_index');
  const files=value.files.map((f,i)=>{
    const e=entries[i];if(!exact(f,['path','mode','sha','size','sha256'])||f.path!==e.path||f.mode!==e.mode||f.sha!==e.sha||f.size!==e.size||!digest(f.sha256))throw fail('invalid_cache_index');
    return {path:f.path,mode:f.mode,sha:f.sha,size:f.size,sha256:f.sha256};
  });
  if(manifestDigest({...value,files})!==value.manifestSha256)throw fail('cache_manifest_integrity');
  const bySha=new Map();for(const f of files){const old=bySha.get(f.sha);if(old&&(old.size!==f.size||old.sha256!==f.sha256))throw fail('cache_manifest_integrity');bySha.set(f.sha,f);}
  return {...value,files};
}
function handle(root,index){
  for(const f of index.files)Object.freeze(f);Object.freeze(index.files);Object.freeze(index);
  const snapshot=Object.freeze({kind:'disk-baseline-v1',executionEligible:index.purpose!=='data-only',baseSha:index.baseSha,treeSha:index.treeSha,fileCount:index.fileCount,totalBytes:index.totalBytes,
    manifestSha256:index.manifestSha256,observedAt:index.observedAt,...(index.projection?{projection:index.projection}:{})});handles.set(snapshot,{root,index});return snapshot;
}
export async function openDiskBaseline({root,baseSha,signal}){
  return reopenDiskBaseline({root,baseSha,signal});
}
async function reopenDiskBaseline({root,baseSha,signal,expectedPurpose}){
  if(process.env.GITHUB_ACTIONS==='true'||!sha(baseSha))throw fail('invalid_configuration');
  const directory=await ensurePrivateStateRoot(root),index=validateIndex(JSON.parse((await readPrivate(join(directory,baseSha+'.json'),MAX_INDEX)).toString('utf8')),baseSha);
  if(expectedPurpose!==undefined&&index.purpose!==expectedPurpose)throw fail('cache_provenance_mismatch');
  const blobs=await ensurePrivateStateRoot(join(directory,index.bundleDirectory,'blobs')),done=new Set();
  for(const f of index.files)if(!done.has(f.sha)){
    await verifyBlob(join(blobs,f.sha),f,{check:()=>{if(signal?.aborted)throw fail('cancelled');}});done.add(f.sha);
  }
  if(signal?.aborted)throw fail('cancelled');return handle(directory,index);
}
export async function collectDiskBaseline({root,get,streamBlob=fetchGitBlobToFile,expectedBaseSha,signal,timeoutMs=1800000,onProgress,purpose='checks',projectionSha256,reuseSnapshot}){
  if(process.env.GITHUB_ACTIONS==='true'||!['checks','data-only',PROJECTED].includes(purpose)||
    (purpose===PROJECTED?!digest(projectionSha256):projectionSha256!==undefined)||typeof streamBlob!=='function'||expectedBaseSha!==undefined&&!sha(expectedBaseSha))throw fail('invalid_configuration');
  const prior=handles.get(reuseSnapshot);
  if(reuseSnapshot!==undefined&&(!prior||purpose==='data-only'||prior.index.purpose!==purpose))throw fail('invalid_configuration');
  const directory=await ensurePrivateStateRoot(root),session=privateReadSession({get,signal,timeoutMs,requestLimit:4000});
  const {request,checkStopped}=session;let stage=null,committed=false,baseSha;
  try{
    const inventory=await readMainInventory({request,expectedBaseSha});baseSha=inventory.baseSha;
    const {treeSha,treeEntries}=inventory;
    let {entries,totalBytes}=inventory;
    const summary={baseSha,treeSha,fileCount:entries.length,totalBytes,publishAuthorized:false};
    checkStopped();
    if(!withinCapacity(entries,totalBytes))return {phase:'blocked-capacity',...summary};
    let projection;
    if(purpose===PROJECTED){
      const selected=projectExecutionInput(inventory);
      if(!selected||selected.projection.sha256!==projectionSha256)throw fail('projection_mismatch');
      ({entries,projection}=selected);
      totalBytes=countBytes(entries);
      Object.assign(summary,{fileCount:entries.length,totalBytes,projection});
    }
    if(!hasProject(entries)||entries.some(e=>!diskPath(e.path,purpose==='data-only')))return {phase:'blocked-input-policy',...summary};
    const unique=uniqueBlobs(entries);
    if(!withinRequestBudget(unique))return {phase:'blocked-request-budget',...summary};
    let existing=false;
    try{await readPrivate(join(directory,baseSha+'.json'),MAX_INDEX);existing=true;}catch(e){if(e.code!=='ENOENT')throw e;}
    if(existing){
      const snapshot=await reopenDiskBaseline({root:directory,baseSha,signal:session.signal,expectedPurpose:purpose});
      if(snapshot.treeSha!==treeSha||snapshot.projection?.sha256!==projectionSha256)throw fail('cache_provenance_mismatch');
      if(await readPrivateMainHead(request)!==baseSha)throw fail('main_moved');checkStopped();return {phase:capturePhase(purpose),...summary,snapshot};
    }
    const bytes=[...unique.values()].reduce((n,e)=>n+e.size,0),space=await statfs(directory,{bigint:true});
    if(space.bavail*space.bsize<BigInt(bytes)+67108864n)return {phase:'blocked-disk-space',...summary};
    stage=await mkdtemp(join(directory,'.disk-'));
    await writePrivateStateFile(join(directory,baseSha+'.claim'),Buffer.from(JSON.stringify({schemaVersion:1,baseSha,bundleDirectory:basename(stage)})+'\n'));
    const blobs=join(stage,'blobs');await mkdir(blobs,{mode:0o700});
    const objects=[...unique.values()],verified=new Map();
    const reusable=prior?uniqueBlobs(prior.index.files):new Map();
    const source=prior?await ensurePrivateStateRoot(join(prior.root,prior.index.bundleDirectory,'blobs')):null;
    let cursor=0,received=0,reusedBlobs=0,error=null;
    async function worker(){
      try{while(true){checkStopped();const i=cursor++;if(i>=objects.length)return;const e=objects[i],destination=join(blobs,e.sha);
        const previous=reusable.get(e.sha);
        if(previous){
          if(previous.size!==e.size)throw fail('invalid_blob_size');
          await copyCacheBlob(source,previous,destination,checkStopped);
          reusedBlobs++;
        }else{
          await streamBlob({sha:e.sha,size:e.size,destination,signal:session.signal,timeoutMs:180000});
        }
        checkStopped();
        const checked=await verifyBlob(destination,previous??e,{check:checkStopped});verified.set(e.sha,checked.sha256);received+=e.size;
        onProgress?.({completedBlobs:verified.size,totalBlobs:objects.length,receivedBytes:received,totalBytes:bytes});
      }}catch(e){if(!error)error=e;session.abort('capture_failed');throw e;}
    }
    await Promise.allSettled(Array.from({length:Math.min(3,objects.length)},worker));if(error)throw error;
    if(await readPrivateMainHead(request)!==baseSha)throw fail('main_moved');checkStopped();
    const files=entries.map(e=>({path:e.path,mode:e.mode,sha:e.sha,size:e.size,sha256:verified.get(e.sha)}));
    const index={schemaVersion:2,purpose,repository:BASELINE_REPOSITORY,ref:'refs/heads/main',baseSha,treeSha,observedAt:new Date().toISOString(),fileCount:entries.length,totalBytes,
      manifestSha256:'',bundleDirectory:basename(stage),treeEntries,files,...(projection?{projection}:{})};
    index.manifestSha256=manifestDigest(index);
    validateIndex(index,baseSha);const encoded=Buffer.from(JSON.stringify(index)+'\n');if(encoded.length>MAX_INDEX)throw fail('index_capacity');
    await writePrivateStateFile(join(stage,'index.json'),encoded);checkStopped();
    await link(join(stage,'index.json'),join(directory,baseSha+'.json'));committed=true;
    return {phase:capturePhase(purpose),...summary,...(prior?{reusedBlobs}:{}),snapshot:handle(directory,index)};
  }finally{session.dispose();if(stage&&!committed)await rm(stage,{recursive:true,force:true});}
}
export function getMaterializedDiskProof(baseline){return materialized.get(baseline)??null;}
export async function materializeDiskBaseline(snapshot,{signal}={}){
  const state=handles.get(snapshot);if(!state)throw fail('unrecognized_disk_snapshot');const {root,index}=state;
  if(index.purpose!=='checks')return {phase:'blocked-input-policy',fileCount:index.fileCount,totalBytes:index.totalBytes,publishAuthorized:false};
  if(index.totalBytes>33554432||index.files.some(f=>f.size>1048576||!isSafeBaselinePath(f.path)))
    return {phase:'blocked-checker-capacity',fileCount:index.fileCount,totalBytes:index.totalBytes,publishAuthorized:false};
  const files=[];
  for(const f of index.files){const r=await verifyBlob(join(root,index.bundleDirectory,'blobs',f.sha),f,{collect:true,check:()=>{if(signal?.aborted)throw fail('cancelled');}});files.push({path:f.path,content:r.content});}
  const baseline=captureBaselineInput({baseSha:index.baseSha,files}),proof=Object.freeze({schemaVersion:1,repository:BASELINE_REPOSITORY,ref:'refs/heads/main',baseSha:index.baseSha,
    treeSha:index.treeSha,baselineContentSha256:baselineContentDigest(baseline.files),fileCount:index.fileCount,totalBytes:index.totalBytes,observedAt:index.observedAt});
  for(const f of baseline.files)Object.freeze(f);Object.freeze(baseline.files);Object.freeze(baseline);materialized.set(baseline,proof);
  return {phase:'materialized',baseline,publishAuthorized:false};
}

// Trusted host transfer only; data-only handles can never expose an execution stream.
export function createDiskBaselineArchive(snapshot,{signal}={}){
  const state=handles.get(snapshot);
  if(process.env.GITHUB_ACTIONS==='true'||!state||state.index.purpose==='data-only')throw fail('disk_execution_denied');
  const {root,index}=state;let used=false;
  const check=()=>{if(signal?.aborted)throw fail('cancelled');};check();
  const manifest=Buffer.from(JSON.stringify({schemaVersion:1,files:index.files,totalBytes:index.totalBytes})+'\n');
  if(manifest.length>MAX_INDEX)throw fail('index_capacity');
  async function* generate(){
    check();yield makeTarHeader('manifest.json',manifest.length);
    for(let at=0;at<manifest.length;at+=65536){check();yield manifest.subarray(at,at+65536);}
    yield Buffer.alloc((512-manifest.length%512)%512);
    const blobs=await ensurePrivateStateRoot(join(root,index.bundleDirectory,'blobs')),seen=new Set();
    for(const e of index.files){
      check();if(seen.has(e.sha))continue;seen.add(e.sha);
      const file=await open(join(blobs,e.sha),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try{
        const s=await file.stat();
        if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o077)||s.nlink!==1||s.size!==e.size)throw fail('unsafe_cache_blob');
        const h1=createHash('sha1').update('blob '+e.size+'\0'),h256=createHash('sha256');let n=0;
        yield makeTarHeader(e.sha,e.size);
        while(true){check();const bytes=Buffer.alloc(65536),{bytesRead}=await file.read(bytes,0,bytes.length,n);if(!bytesRead)break;
          n+=bytesRead;if(n>e.size)throw fail('blob_integrity');const part=bytes.subarray(0,bytesRead);h1.update(part);h256.update(part);yield part;}
        check();if(n!==e.size||h1.digest('hex')!==e.sha||h256.digest('hex')!==e.sha256)throw fail('blob_integrity');
        yield Buffer.alloc((512-e.size%512)%512);
      }finally{await file.close();}
    }
    check();yield Buffer.alloc(1024);
  }
  const inputStream=Object.freeze({[Symbol.asyncIterator](){if(used)throw fail('archive_already_consumed');used=true;return generate();}});
  return Object.freeze({inputStream,provenance:Object.freeze({baselineBinding:index.projection?'github-main-projected':'github-main-pinned',baseSha:index.baseSha,treeSha:index.treeSha,
    manifestSha256:index.manifestSha256,fileCount:index.fileCount,totalBytes:index.totalBytes,observedAt:index.observedAt,...(index.projection?{projection:index.projection}:{}),publishAuthorized:false})});
}

// Metadata only, gated by the same non-copyable checks-purpose capability.
export function diskExecutionMetadata(snapshot){
  const state=handles.get(snapshot);
  if(process.env.GITHUB_ACTIONS==='true'||!state||state.index.purpose==='data-only')throw fail('disk_execution_denied');
  return Object.freeze({files:state.index.files,provenance:Object.freeze({schemaVersion:2,repository:BASELINE_REPOSITORY,ref:'refs/heads/main',
    baseSha:snapshot.baseSha,treeSha:snapshot.treeSha,manifestSha256:snapshot.manifestSha256,fileCount:snapshot.fileCount,totalBytes:snapshot.totalBytes,observedAt:snapshot.observedAt,...(snapshot.projection?{projection:snapshot.projection}:{})})});
}

export function isSafeDiskExecutionPath(path){return diskPath(path);}

export function selectDiskDeveloperSources(snapshot,paths){
  const {files}=diskExecutionMetadata(snapshot);
  if(!Array.isArray(paths)||paths.length>8)throw fail('developer_source_scope');
  const selected=[...paths];
  if(new Set(selected).size!==selected.length||selected.some(path=>!diskPath(path)||!isSafeManifestPath(path)))throw fail('developer_source_scope');
  const inventory=new Map(files.map(file=>[file.path,file]));
  const entries=selected.sort().map(path=>inventory.get(path));
  if(entries.some(entry=>!entry||entry.size>65000)||countBytes(entries)>262144)throw fail('developer_source_capacity');
  return entries;
}

export async function readDiskDeveloperSources(snapshot,paths,{signal}={}){
  const entries=selectDiskDeveloperSources(snapshot,paths);
  const check=()=>{if(signal?.aborted)throw fail('cancelled');};
  check();
  try{
    const {root,index}=handles.get(snapshot),blobs=await ensurePrivateStateRoot(join(root,index.bundleDirectory,'blobs'));
    const sources=[];
    for(const entry of entries){
      const {content}=await verifyBlob(join(blobs,entry.sha),entry,{collect:true,check});
      sources.push({path:entry.path,bytes:Buffer.from(content,'base64')});
    }
    check();
    return sources;
  }catch(error){
    throw error.failureKind?error:fail('developer_source_unavailable');
  }
}

// Read only the root npm manifests from an eligible snapshot, with the original Git integrity checks.
export async function readDiskNpmManifests(snapshot,{signal}={}){
  const {files}=diskExecutionMetadata(snapshot);
  // npm ci would prefer a root shrinkwrap over the lockfile attested by this profile.
  if(files.some(file=>file.path==='npm-shrinkwrap.json'))throw fail('invalid_dependency_lock');
  const {root,index}=handles.get(snapshot);
  const blobs=await ensurePrivateStateRoot(join(root,index.bundleDirectory,'blobs'));
  const manifests=[];
  for(const name of ['package.json','package-lock.json']){
    const entry=files.find(file=>file.path===name);
    if(!entry||entry.size>1048576)throw fail('invalid_dependency_lock');
    const {content}=await verifyBlob(join(blobs,entry.sha),entry,{collect:true,check:()=>{
      if(signal?.aborted)throw fail('cancelled');
    }});
    manifests.push(Buffer.from(content,'base64'));
  }
  return manifests;
}
