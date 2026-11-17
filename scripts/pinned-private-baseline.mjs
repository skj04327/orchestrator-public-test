// Read-only trusted-host collector; never executes source or approves publishing.
import {createHash} from 'node:crypto';
import {captureBaselineInput,isSafeBaselinePath,baselineContentDigest} from './independent-check-input.mjs';
export const BASELINE_REPOSITORY='skj04327/the-twilight-of-korea';
const SHA=/^[a-f0-9]{40}$/,DIGEST=/^[a-f0-9]{64}$/;
const sha=v=>typeof v==='string'&&SHA.test(v),digest=v=>typeof v==='string'&&DIGEST.test(v);
const proofs=new WeakMap();
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
function fail(kind){const e=Error('Private baseline unavailable');e.failureKind=kind;return e;}
function objectHash(type,bytes){return createHash('sha1').update(type+' '+bytes.length+'\0').update(bytes).digest('hex');}
function checkTree(value,treeSha){
  if(value?.sha!==treeSha||value.truncated!==false||!Array.isArray(value.tree)||value.tree.length>20000)throw fail('invalid_tree');
  const nodes=new Map(),children=new Map([['',[]]]);
  for(const e of value.tree){
    if(typeof e.path!=='string'||!e.path||e.path.length>4096||e.path.includes('\0')||e.path.split('/').some(p=>!p||p==='.'||p==='..')||
      Buffer.from(e.path).toString('utf8')!==e.path||nodes.has(e.path)||!sha(e.sha)||
      !(e.type==='tree'&&e.mode==='040000'||e.type==='blob'&&['100644','100755'].includes(e.mode)))throw fail('unsupported_tree');
    if(e.type==='blob'&&(!Number.isSafeInteger(e.size)||e.size<0))throw fail('invalid_size');
    nodes.set(e.path,{path:e.path,type:e.type,mode:e.mode,sha:e.sha,...(e.type==='blob'?{size:e.size}:{})});
    if(e.type==='tree')children.set(e.path,[]);
  }
  for(const e of nodes.values()){
    const i=e.path.lastIndexOf('/'),parent=i<0?'':e.path.slice(0,i),name=e.path.slice(i+1);
    if(!children.has(parent))throw fail('missing_tree_parent');
    children.get(parent).push({...e,name});
  }
  for(const [path,entries]of children){
    entries.sort((a,b)=>Buffer.compare(Buffer.from(a.name+(a.type==='tree'?'/':'')),Buffer.from(b.name+(b.type==='tree'?'/':''))));
    const bytes=Buffer.concat(entries.map(e=>Buffer.concat([Buffer.from((e.type==='tree'?'40000':e.mode)+' '+e.name+'\0'),Buffer.from(e.sha,'hex')])));
    if(objectHash('tree',bytes)!==(path?nodes.get(path).sha:treeSha))throw fail('tree_integrity');
  }
  return [...nodes.values()].filter(e=>e.type==='blob').sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
export function getPinnedBaselineProof(baseline){return proofs.get(baseline)??null;}
export function validatePinnedBaselineProof(value,{baseSha,baselineContentSha256}){
  if(!exact(value,['schemaVersion','repository','ref','baseSha','treeSha','baselineContentSha256','fileCount','totalBytes','observedAt'])||
    value.schemaVersion!==1||value.repository!==BASELINE_REPOSITORY||value.ref!=='refs/heads/main'||
    !sha(value.baseSha)||value.baseSha!==baseSha||!sha(value.treeSha)||
    !digest(value.baselineContentSha256)||value.baselineContentSha256!==baselineContentSha256||
    !Number.isSafeInteger(value.fileCount)||value.fileCount<1||value.fileCount>10000||
    !Number.isSafeInteger(value.totalBytes)||value.totalBytes<0||value.totalBytes>33554432||
    typeof value.observedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.observedAt)||!Number.isFinite(Date.parse(value.observedAt)))throw fail('invalid_provenance');
  return value;
}
export async function collectPrivateBaseline({get,expectedBaseSha,signal,timeoutMs=180000}){
  if(typeof get!=='function'||expectedBaseSha!==undefined&&!sha(expectedBaseSha)||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>180000)throw fail('invalid_configuration');
  if(signal?.aborted)throw fail('cancelled');
  const controller=new AbortController(),deadline=Date.now()+timeoutMs;let reason='cancelled',calls=0;
  const abort=()=>controller.abort(),timer=setTimeout(()=>{reason='timeout';controller.abort();},timeoutMs);
  signal?.addEventListener('abort',abort,{once:true});
  function checkStopped(){
    if(controller.signal.aborted)throw fail(reason);
    if(Date.now()>=deadline){reason='timeout';controller.abort();throw fail(reason);}
  }
  async function request(path){
    checkStopped();if(++calls>10006)throw fail('request_limit');
    let onAbort;
    const stopped=new Promise((_,reject)=>{onAbort=()=>reject(fail(reason));controller.signal.addEventListener('abort',onAbort,{once:true});});
    try{
      const value=await Promise.race([get(path,{signal:controller.signal}),stopped]);
      checkStopped();return value;
    }finally{controller.signal.removeEventListener('abort',onAbort);}
  }
  async function privateRepo(){const r=await request('');if(r?.private!==true||r.full_name!==BASELINE_REPOSITORY)throw fail('repo_not_private');}
  async function mainSha(){const r=await request('/git/ref/heads/main');if(r?.object?.type!=='commit'||!sha(r.object.sha))throw fail('invalid_main');return r.object.sha;}
  try{
    await privateRepo();const baseSha=await mainSha();
    if(expectedBaseSha!==undefined&&baseSha!==expectedBaseSha)throw fail('main_moved');
    const commit=await request('/git/commits/'+baseSha),treeSha=commit?.tree?.sha;
    if(commit?.sha!==baseSha||!sha(treeSha))throw fail('invalid_commit');
    const entries=checkTree(await request('/git/trees/'+treeSha+'?recursive=1'),treeSha);
    checkStopped();
    const totalBytes=entries.reduce((n,e)=>n+e.size,0);if(!Number.isSafeInteger(totalBytes))throw fail('invalid_size');
    const summary={baseSha,treeSha,fileCount:entries.length,totalBytes,publishAuthorized:false};
    if(entries.length>10000||totalBytes>33554432||entries.some(e=>e.size>1048576))return {phase:'blocked-capacity',...summary};
    if(!entries.length||entries.some(e=>!isSafeBaselinePath(e.path))||!entries.some(e=>e.path==='package.json')||!entries.some(e=>e.path==='package-lock.json'))
      return {phase:'blocked-input-policy',...summary};
    const files=[],cache=new Map();
    for(const entry of entries){
      let blob=cache.get(entry.sha);
      if(!blob){
        const b=await request('/git/blobs/'+entry.sha);
        if(b?.sha!==entry.sha||b.encoding!=='base64'||b.size!==entry.size||typeof b.content!=='string'||b.content.length>1450000)throw fail('invalid_blob');
        const content=b.content.replace(/\s/g,''),bytes=Buffer.from(content,'base64');
        if(bytes.length!==entry.size||bytes.toString('base64')!==content||objectHash('blob',bytes)!==entry.sha)throw fail('blob_integrity');
        blob={size:bytes.length,content};cache.set(entry.sha,blob);
      }
      if(blob.size!==entry.size)throw fail('blob_integrity');files.push({path:entry.path,content:blob.content});
    }
    await privateRepo();if(await mainSha()!==baseSha)throw fail('main_moved');
    checkStopped();
    const baseline=captureBaselineInput({baseSha,files}),proof=Object.freeze({schemaVersion:1,repository:BASELINE_REPOSITORY,ref:'refs/heads/main',
      baseSha,treeSha,baselineContentSha256:baselineContentDigest(baseline.files),fileCount:entries.length,totalBytes,observedAt:new Date().toISOString()});
    checkStopped();
    for(const f of baseline.files)Object.freeze(f);Object.freeze(baseline.files);Object.freeze(baseline);proofs.set(baseline,proof);
    return {phase:'captured',...summary,baseline,proof};
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
