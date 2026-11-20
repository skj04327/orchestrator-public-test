// Trusted host snapshot boundary. A supplied commit is a caller claim, not GitHub proof.
import {createHash} from 'node:crypto';
import {validateLocalCheckBundle} from './local-candidate-bundle.mjs';
import {digestFileBuffers,isSafeManifestPath} from './verified-manifest.mjs';
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
export const MAX_CHECK_PAYLOAD=46000000;
export function isSafeBaselinePath(path){
  return typeof path==='string'&&path.length<=240&&/^[a-zA-Z0-9_.@/-]+$/.test(path)&&path.split('/').length<=32&&
    !path.split('/').some(p=>!p||p==='.'||p==='..'||/^(?:\.git|node_modules|\.env.*|\.npmrc|\.codex|\.claude|\.gemini|\.aws|\.ssh|\.config|\.docker|\.azure|\.kube|\.gnupg|\.npm|\.cache|\.local)$/.test(p));
}
function files(value,candidate=false){
  if(!Array.isArray(value)||!value.length||value.length>(candidate?8:10000))throw Error('Invalid check files');
  const paths=new Set();let total=0;
  const captured=value.map(f=>{
    if(!exact(f,['path','content'])||!isSafeBaselinePath(f.path)||
      (candidate&&!isSafeManifestPath(f.path))||paths.has(f.path)||typeof f.content!=='string'||
      f.content.length>Math.ceil((candidate?65000:1048576)/3)*4)throw Error('Unsafe check file');
    const content=Buffer.from(f.content,'base64');total+=content.length;
    if(content.toString('base64')!==f.content||content.length>(candidate?65000:1048576)||total>33554432)throw Error('Invalid check bytes');
    paths.add(f.path);return {path:f.path,content:content.toString('base64')};
  }).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  for(const p of paths){
    const parts=p.split('/');parts.pop();
    while(parts.length){if(paths.has(parts.join('/')))throw Error('Check file/directory collision');parts.pop();}
  }
  return captured;
}
export function assertCandidateOverlayPaths(baselinePaths,candidatePaths){
  const paths=new Set(baselinePaths),all=new Set([...baselinePaths,...candidatePaths]);
  const testPath=p=>/(?:^|\/)(?:tests?|__tests__)\//i.test(p)||/\.(?:test|spec)\.[a-z0-9]+$/i.test(p);
  if(candidatePaths.some(p=>testPath(p)&&paths.has(p)))throw Error('Existing tests cannot be replaced');
  for(const p of all){const parts=p.split('/');parts.pop();while(parts.length){if(all.has(parts.join('/')))throw Error('Check file/directory collision');parts.pop();}}
}
function normalize(value){
  if(!exact(value,['baseline','candidate']))throw Error('Invalid check snapshot');
  const baseline=files(value.baseline),candidate=files(value.candidate,true),paths=new Set(baseline.map(f=>f.path));
  if(!paths.has('package.json')||!paths.has('package-lock.json'))throw Error('Missing locked npm project');
  assertCandidateOverlayPaths([...paths],candidate.map(f=>f.path));
  // Check cross-set file/directory collisions as well as collisions inside either set.
  const combined=new Map(baseline.map(f=>[f.path,f]));for(const f of candidate)combined.set(f.path,f);
  files([...combined.values()]);return {baseline,candidate};
}
export function parseCheckPayload(payload){
  if(!Buffer.isBuffer(payload)||payload.length>MAX_CHECK_PAYLOAD)throw Error('Oversized check payload');
  return normalize(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(payload)));
}
export function captureBaselineInput(baseline){
  if(!exact(baseline,['baseSha','files'])||typeof baseline.baseSha!=='string'||! /^[a-f0-9]{40}$/.test(baseline.baseSha))throw Error('Invalid baseline');
  // Capture this synchronously at the public host API boundary, before any await.
  const captured=files(baseline.files),paths=new Set(captured.map(f=>f.path));
  if(!paths.has('package.json')||!paths.has('package-lock.json'))throw Error('Missing locked npm project');
  return {baseSha:baseline.baseSha,files:captured};
}
function digest(files){
  const h=createHash('sha256');
  for(const f of files){const b=Buffer.from(f.content,'base64');h.update(f.path+'\0'+b.length+'\0');h.update(b);h.update('\0');}
  return h.digest('hex');
}
export function baselineContentDigest(value){return digest(files(value));}
export function captureCheckSnapshot({context,bundle,baseline}){
  const verified=validateLocalCheckBundle(bundle,context);
  if(verified.baselineManifestSha256!==undefined)throw Error('Disk-bound candidate requires direct disk checks');
  if(!verified.files.length||!exact(baseline,['baseSha','files'])||baseline.baseSha!==verified.baseSha)throw Error('Wrong baseline commit');
  const snapshot=normalize({baseline:baseline.files,candidate:verified.files.map(f=>({path:f.path,content:f.content.toString('base64')}))});
  const payload=Buffer.from(JSON.stringify(snapshot));if(payload.length>MAX_CHECK_PAYLOAD)throw Error('Oversized check payload');
  return {payload,baseSha:verified.baseSha,baselineContentSha256:digest(snapshot.baseline),
    candidateContentSha256:digestFileBuffers(verified.files)};
}
