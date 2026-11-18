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
const MAX_TOTAL=1073741824,MAX_INDEX=8388608,handles=new WeakMap(),materialized=new WeakMap();
const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v),digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
function diskPath(path,allowSensitive=false){
  return typeof path==='string'&&path.length<=240&&path.split('/').length<=32&&/^[\p{L}\p{M}\p{N}_.@ /()-]+$/u.test(path)&&
    path.split('/').every(p=>p&&p!=='.'&&p!=='..'&&(allowSensitive||!/^(?:\.git|node_modules|\.env.*|\.npmrc|\.codex|\.claude|\.gemini|\.aws|\.ssh|\.config|\.docker|\.azure|\.kube|\.gnupg|\.npm|\.cache|\.local)$/.test(p)));
}
const manifestDigest=index=>createHash('sha256').update(JSON.stringify(['disk-baseline-v1',index.schemaVersion,index.purpose,index.repository,index.ref,
  index.baseSha,index.treeSha,index.observedAt,index.bundleDirectory,index.files])).digest('hex');
async function readPrivate(path,limit){
  const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const stat=await f.stat();if(!stat.isFile()||stat.uid!==process.getuid()||(stat.mode&0o077)||stat.size>limit)throw fail('unsafe_cache');
    const b=Buffer.alloc(limit+1);let n=0;
    while(n<b.length){const {bytesRead}=await f.read(b,n,b.length-n,n);if(!bytesRead)break;n+=bytesRead;}
    if(n>limit)throw fail('unsafe_cache');return b.subarray(0,n);
  }finally{await f.close();}
}
async function verifyBlob(path,entry,{collect=false,check=()=>{}}={}){
  check();const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK),chunks=[];
  try{
    const s=await f.stat();if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o077)||s.nlink!==1||s.size!==entry.size)throw fail('unsafe_cache_blob');
    if(collect&&entry.size>1048576)throw fail('memory_capacity');
    const h1=createHash('sha1').update('blob '+entry.size+'\0'),h256=createHash('sha256'),b=Buffer.alloc(65536);let n=0;
    while(true){check();const {bytesRead}=await f.read(b,0,b.length,n);if(!bytesRead)break;n+=bytesRead;if(n>entry.size)throw fail('blob_integrity');
      const part=b.subarray(0,bytesRead);h1.update(part);h256.update(part);if(collect)chunks.push(Buffer.from(part));}
    const hash=h256.digest('hex');check();
    if(n!==entry.size||h1.digest('hex')!==entry.sha||(entry.sha256&&hash!==entry.sha256))throw fail('blob_integrity');
    return {sha256:hash,...(collect?{content:Buffer.concat(chunks,n).toString('base64')}:{})};
  }finally{await f.close();}
}
function validateIndex(value,baseSha){
  if(!exact(value,['schemaVersion','purpose','repository','ref','baseSha','treeSha','observedAt','fileCount','totalBytes','manifestSha256','bundleDirectory','treeEntries','files'])||
    !['checks','data-only'].includes(value.purpose)||
    value.schemaVersion!==2||value.repository!==BASELINE_REPOSITORY||value.ref!=='refs/heads/main'||value.baseSha!==baseSha||!sha(value.baseSha)||!sha(value.treeSha)||
    typeof value.bundleDirectory!=='string'||!/^\.disk-[a-zA-Z0-9]{6,20}$/.test(value.bundleDirectory)||
    typeof value.observedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.observedAt)||!Number.isFinite(Date.parse(value.observedAt))||
    !digest(value.manifestSha256)||!Array.isArray(value.files))throw fail('invalid_cache_index');
  const entries=checkTree({sha:value.treeSha,truncated:false,tree:value.treeEntries},value.treeSha),total=entries.reduce((n,e)=>n+e.size,0);
  if(entries.length<1||entries.length>10000||entries.length!==value.fileCount||value.files.length!==entries.length||
    total!==value.totalBytes||total>MAX_TOTAL||entries.some(e=>e.size>MAX_DISK_BLOB||!diskPath(e.path,value.purpose==='data-only')))throw fail('invalid_cache_index');
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
  const snapshot=Object.freeze({kind:'disk-baseline-v1',executionEligible:index.purpose==='checks',baseSha:index.baseSha,treeSha:index.treeSha,fileCount:index.fileCount,totalBytes:index.totalBytes,
    manifestSha256:index.manifestSha256,observedAt:index.observedAt});handles.set(snapshot,{root,index});return snapshot;
}
export async function openDiskBaseline({root,baseSha,signal}){
  if(process.env.GITHUB_ACTIONS==='true'||!sha(baseSha))throw fail('invalid_configuration');
  const directory=await ensurePrivateStateRoot(root),index=validateIndex(JSON.parse((await readPrivate(join(directory,baseSha+'.json'),MAX_INDEX)).toString('utf8')),baseSha);
  const blobs=await ensurePrivateStateRoot(join(directory,index.bundleDirectory,'blobs')),done=new Set();
  for(const f of index.files)if(!done.has(f.sha)){
    await verifyBlob(join(blobs,f.sha),f,{check:()=>{if(signal?.aborted)throw fail('cancelled');}});done.add(f.sha);
  }
  if(signal?.aborted)throw fail('cancelled');return handle(directory,index);
}
export async function collectDiskBaseline({root,get,streamBlob=fetchGitBlobToFile,expectedBaseSha,signal,timeoutMs=1800000,onProgress,purpose='checks'}){
  if(process.env.GITHUB_ACTIONS==='true'||!['checks','data-only'].includes(purpose)||typeof streamBlob!=='function'||expectedBaseSha!==undefined&&!sha(expectedBaseSha))throw fail('invalid_configuration');
  const directory=await ensurePrivateStateRoot(root),session=privateReadSession({get,signal,timeoutMs,requestLimit:4000});
  const {request,checkStopped}=session;let stage=null,claimed=false,committed=false,baseSha;
  try{
    const inventory=await readMainInventory({request,expectedBaseSha});baseSha=inventory.baseSha;
    const {treeSha,entries,totalBytes,treeEntries}=inventory,summary={baseSha,treeSha,fileCount:entries.length,totalBytes,publishAuthorized:false};
    checkStopped();
    if(entries.length>10000||totalBytes>MAX_TOTAL||entries.some(e=>e.size>MAX_DISK_BLOB))return {phase:'blocked-capacity',...summary};
    if(!entries.length||entries.some(e=>!diskPath(e.path,purpose==='data-only'))||!entries.some(e=>e.path==='package.json')||!entries.some(e=>e.path==='package-lock.json'))return {phase:'blocked-input-policy',...summary};
    const unique=new Map();for(const e of entries){const old=unique.get(e.sha);if(old&&old.size!==e.size)throw fail('invalid_blob_size');unique.set(e.sha,e);}
    if(unique.size+6>4000)return {phase:'blocked-request-budget',...summary};
    let existing=false;
    try{await readPrivate(join(directory,baseSha+'.json'),MAX_INDEX);existing=true;}catch(e){if(e.code!=='ENOENT')throw e;}
    if(existing){
      const snapshot=await openDiskBaseline({root:directory,baseSha,signal:session.signal});
      if(snapshot.treeSha!==treeSha||snapshot.executionEligible!==(purpose==='checks'))throw fail('cache_provenance_mismatch');
      if(await readPrivateMainHead(request)!==baseSha)throw fail('main_moved');checkStopped();return {phase:purpose==='checks'?'captured-disk':'captured-data-only',...summary,snapshot};
    }
    const bytes=[...unique.values()].reduce((n,e)=>n+e.size,0),space=await statfs(directory,{bigint:true});
    if(space.bavail*space.bsize<BigInt(bytes)+67108864n)return {phase:'blocked-disk-space',...summary};
    stage=await mkdtemp(join(directory,'.disk-'));
    await writePrivateStateFile(join(directory,baseSha+'.claim'),Buffer.from(JSON.stringify({schemaVersion:1,baseSha,bundleDirectory:basename(stage)})+'\n'));claimed=true;
    const blobs=join(stage,'blobs');await mkdir(blobs,{mode:0o700});
    const objects=[...unique.values()],verified=new Map();let cursor=0,received=0,error=null;
    async function worker(){
      try{while(true){checkStopped();const i=cursor++;if(i>=objects.length)return;const e=objects[i],destination=join(blobs,e.sha);
        await streamBlob({sha:e.sha,size:e.size,destination,signal:session.signal,timeoutMs:180000});checkStopped();
        const checked=await verifyBlob(destination,e,{check:checkStopped});verified.set(e.sha,checked.sha256);received+=e.size;
        onProgress?.({completedBlobs:verified.size,totalBlobs:objects.length,receivedBytes:received,totalBytes:bytes});
      }}catch(e){if(!error)error=e;session.abort('capture_failed');throw e;}
    }
    await Promise.allSettled(Array.from({length:Math.min(3,objects.length)},worker));if(error)throw error;
    if(await readPrivateMainHead(request)!==baseSha)throw fail('main_moved');checkStopped();
    const files=entries.map(e=>({path:e.path,mode:e.mode,sha:e.sha,size:e.size,sha256:verified.get(e.sha)}));
    const index={schemaVersion:2,purpose,repository:BASELINE_REPOSITORY,ref:'refs/heads/main',baseSha,treeSha,observedAt:new Date().toISOString(),fileCount:entries.length,totalBytes,
      manifestSha256:'',bundleDirectory:basename(stage),treeEntries,files};
    index.manifestSha256=manifestDigest(index);
    validateIndex(index,baseSha);const encoded=Buffer.from(JSON.stringify(index)+'\n');if(encoded.length>MAX_INDEX)throw fail('index_capacity');
    await writePrivateStateFile(join(stage,'index.json'),encoded);checkStopped();
    await link(join(stage,'index.json'),join(directory,baseSha+'.json'));committed=true;
    return {phase:purpose==='checks'?'captured-disk':'captured-data-only',...summary,snapshot:handle(directory,index)};
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
  if(process.env.GITHUB_ACTIONS==='true'||!state||state.index.purpose!=='checks')throw fail('disk_execution_denied');
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
  return Object.freeze({inputStream,provenance:Object.freeze({baselineBinding:'github-main-pinned',baseSha:index.baseSha,treeSha:index.treeSha,
    manifestSha256:index.manifestSha256,fileCount:index.fileCount,totalBytes:index.totalBytes,observedAt:index.observedAt,publishAuthorized:false})});
}

// Metadata only, gated by the same non-copyable checks-purpose capability.
export function diskExecutionMetadata(snapshot){
  const state=handles.get(snapshot);
  if(process.env.GITHUB_ACTIONS==='true'||!state||state.index.purpose!=='checks')throw fail('disk_execution_denied');
  return Object.freeze({files:state.index.files,provenance:Object.freeze({schemaVersion:2,repository:BASELINE_REPOSITORY,ref:'refs/heads/main',
    baseSha:snapshot.baseSha,treeSha:snapshot.treeSha,manifestSha256:snapshot.manifestSha256,fileCount:snapshot.fileCount,totalBytes:snapshot.totalBytes,observedAt:snapshot.observedAt})});
}

export function isSafeDiskExecutionPath(path){return diskPath(path);}
