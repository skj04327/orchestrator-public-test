// Trusted-host opaque overlay. Candidate bytes are bounded separately from disk assets.
import {createHash} from 'node:crypto';
import {diskExecutionMetadata,createDiskBaselineArchive,isSafeDiskExecutionPath,validateDiskProjection} from './disk-baseline.mjs';
import {validateBundle} from './private-task-bundle.mjs';
import {handoffContext} from './private-handoff.mjs';
import {assertCandidateOverlayPaths} from './independent-check-input.mjs';
import {digestFileBuffers} from './verified-manifest.mjs';
import {makeTarHeader} from './container-tar.mjs';
import {createOfflineNpmArchive} from './offline-npm-runtime.mjs';
const captures=new WeakMap(),digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...k].sort().join(',');
export function validateDiskCheckProvenance(p,claim){
  const keys=['schemaVersion','repository','ref','baseSha','treeSha','manifestSha256','fileCount','totalBytes','observedAt'];
  const projected=p&&Object.hasOwn(p,'projection');
  if(!exact(p,projected?[...keys,'projection']:keys)||p.schemaVersion!==2||
    p.repository!=='skj04327/the-twilight-of-korea'||p.ref!=='refs/heads/main'||!sha(p.baseSha)||!sha(p.treeSha)||!digest(p.manifestSha256)||
    p.baseSha!==claim.baseSha||p.manifestSha256!==claim.baselineManifestSha256||
    !Number.isSafeInteger(p.fileCount)||p.fileCount<1||p.fileCount>10000||!Number.isSafeInteger(p.totalBytes)||p.totalBytes<0||p.totalBytes>1073741824||
    typeof p.observedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(p.observedAt)||!Number.isFinite(Date.parse(p.observedAt))||
    (projected&&(!validateDiskProjection(p.projection)||p.fileCount+p.projection.excludedFileCount>10000)))throw Error('Invalid disk provenance');
}
export function captureDiskCheckInput({diskSnapshot,context,bundle}){
  if(context?.kind!=='local')throw Error('Local check context required');handoffContext(context);
  const {files:baseline,provenance}=diskExecutionMetadata(diskSnapshot),verified=validateBundle(bundle,context);
  if(!verified.result||verified.baseSha!==provenance.baseSha)throw Error('Wrong disk baseline');
  const candidate=verified.files.map(f=>({path:f.path,content:Buffer.from(f.content)}));
  if(candidate.some(f=>!isSafeDiskExecutionPath(f.path)))throw Error('Unsafe disk candidate path');
  assertCandidateOverlayPaths(baseline.map(f=>f.path),candidate.map(f=>f.path));
  const combined=new Map(baseline.map(f=>[f.path,f.size]));for(const f of candidate)combined.set(f.path,f.content.length);
  if(combined.size>10000||[...combined.values()].reduce((n,v)=>n+v,0)>1073741824)throw Error('Combined disk capacity exceeded');
  const proof=Object.freeze({baseSha:provenance.baseSha,baselineManifestSha256:provenance.manifestSha256,
    candidateContentSha256:digestFileBuffers(candidate),baselineProvenance:provenance});
  const input=Object.freeze({kind:'disk-check-input-v1',...proof});captures.set(input,{diskSnapshot,baseline,candidate,proof});return input;
}
export function getDiskCheckProvenance(input){const state=captures.get(input);if(!state)throw Error('Unknown disk check input');return state.proof;}
export function createDiskCheckArchive(input,{variant,offlineDependencies,signal}={}){
  const state=captures.get(input);if(!state||!['baseline','candidate'].includes(variant))throw Error('Unknown disk check input');
  const archive=createDiskBaselineArchive(state.diskSnapshot,{signal});let overlayArchive=null;
  if(variant==='candidate'){
    const previous=new Map(state.baseline.map(f=>[f.path,f])),parts=[],seen=new Set();
    const files=state.candidate.map(f=>({path:f.path,mode:previous.get(f.path)?.mode??'100644',sha256:createHash('sha256').update(f.content).digest('hex')}));
    const add=(name,b)=>parts.push(makeTarHeader(name,b.length),b,Buffer.alloc((512-b.length%512)%512));
    add('candidate.json',Buffer.from(JSON.stringify({files})+'\n'));
    for(let i=0;i<files.length;i++)if(!seen.has(files[i].sha256)){seen.add(files[i].sha256);add('candidate-'+files[i].sha256,Buffer.from(state.candidate[i].content));}
    parts.push(Buffer.alloc(1024));overlayArchive=Buffer.concat(parts);
  }
  const dependencyArchive=createOfflineNpmArchive(offlineDependencies,state.diskSnapshot,{signal});
  return {...archive,overlayArchive,dependencyArchive,proof:state.proof};
}
