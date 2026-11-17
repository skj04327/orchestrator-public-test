// Read-only trusted-host collector; never executes source or approves publishing.
import {BASELINE_REPOSITORY,objectHash,readPrivateMainHead,readMainInventory} from './main-inventory.mjs';
import {privateReadSession} from './private-read-session.mjs';
import {getMaterializedDiskProof} from './disk-baseline.mjs';
import {captureBaselineInput,isSafeBaselinePath,baselineContentDigest} from './independent-check-input.mjs';
export {BASELINE_REPOSITORY} from './main-inventory.mjs';
const SHA=/^[a-f0-9]{40}$/,DIGEST=/^[a-f0-9]{64}$/;
const sha=v=>typeof v==='string'&&SHA.test(v),digest=v=>typeof v==='string'&&DIGEST.test(v);
const proofs=new WeakMap();
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
function fail(kind){const e=Error('Private baseline unavailable');e.failureKind=kind;return e;}
export function getPinnedBaselineProof(baseline){return proofs.get(baseline)??getMaterializedDiskProof(baseline);}
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
  const session=privateReadSession({get,signal,timeoutMs});
  const {request,checkStopped}=session;
  try{
    const {baseSha,treeSha,entries,totalBytes}=await readMainInventory({request,expectedBaseSha});
    checkStopped();
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
    if(await readPrivateMainHead(request)!==baseSha)throw fail('main_moved');
    checkStopped();
    const baseline=captureBaselineInput({baseSha,files}),proof=Object.freeze({schemaVersion:1,repository:BASELINE_REPOSITORY,ref:'refs/heads/main',
      baseSha,treeSha,baselineContentSha256:baselineContentDigest(baseline.files),fileCount:entries.length,totalBytes,observedAt:new Date().toISOString()});
    checkStopped();
    for(const f of baseline.files)Object.freeze(f);Object.freeze(baseline.files);Object.freeze(baseline);proofs.set(baseline,proof);
    return {phase:'captured',...summary,baseline,proof};
  }finally{session.dispose();}
}
