// Candidate transport for local checks. It carries no execution or review verdict.
import {handoffContext,seal} from './private-handoff.mjs';
import {decodeBundleFiles,validateBundle} from './private-task-bundle.mjs';
import {digestFileBuffers,isVerifiedDigest} from './verified-manifest.mjs';

const kind='local-candidate-v1';
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const isBaseSha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const fields=['kind','context','baseSha','candidateContentSha256','files'];
function candidateDigest(files){
  const digest=digestFileBuffers(files);
  if(files.some(({path})=>path.split('/').includes('.')))throw Error('Unsafe candidate path');
  return digest;
}

export function createLocalCandidateBundle({context,baseSha,baselineManifestSha256,files}){
  if(context?.kind!=='local'||!isBaseSha(baseSha)||
    (baselineManifestSha256!==undefined&&!isVerifiedDigest(baselineManifestSha256)))throw Error('Invalid local candidate context');
  const candidateContentSha256=candidateDigest(files);
  return {kind,context,baseSha,candidateContentSha256,
    ...(baselineManifestSha256===undefined?{}:{baselineManifestSha256}),
    files:files.map(({path,content})=>({path,content:content.toString('base64')}))};
}

export function sealLocalCandidate({context,publicKey,baseSha,baselineManifestSha256,files}){
  return seal(createLocalCandidateBundle({context,baseSha,baselineManifestSha256,files}),publicKey,context);
}

export function validateLocalCheckBundle(bundle,context){
  if(context?.kind!=='local')throw Error('Local check context required');
  if(bundle?.kind!==kind){
    const {baseSha,files}=validateBundle(bundle,context);
    return {baseSha,files};
  }
  const bound=Object.hasOwn(bundle,'baselineManifestSha256');
  if(!exact(bundle,bound?[...fields,'baselineManifestSha256']:fields)||!isBaseSha(bundle.baseSha)||
    (bound&&!isVerifiedDigest(bundle.baselineManifestSha256))||
    !handoffContext(bundle.context).equals(handoffContext(context))||!Array.isArray(bundle.files)||
    bundle.files.length<1||bundle.files.length>8||bundle.files.some(file=>!exact(file,['path','content'])))
    throw Error('Invalid local candidate');
  const files=decodeBundleFiles(bundle.files);
  if(candidateDigest(files)!==bundle.candidateContentSha256)throw Error('Local candidate changed');
  return {baseSha:bundle.baseSha,baselineManifestSha256:bundle.baselineManifestSha256,files};
}
