// Accept a completed response on the trusted host. This entry point starts no provider or game process.
import {diskExecutionMetadata} from './disk-baseline.mjs';
import {captureDiskCheckInput} from './disk-check-input.mjs';
import {createLocalCandidateBundle} from './local-candidate-bundle.mjs';
import {readLocalJob,runPreparedLocalJob} from './local-jobs.mjs';
import {handoffContext,MAX_HANDOFF_BYTES,seal} from './private-handoff.mjs';

const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));

function parseCandidateResponse(response){
  if(!Buffer.isBuffer(response)||response.length>MAX_HANDOFF_BYTES)throw Error('Invalid candidate response');
  let parsed;
  try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(response));}
  catch{throw Error('Invalid candidate response');}
  if(!exact(parsed,['schemaVersion','runId','baselineManifestSha256','files'])||parsed.schemaVersion!==1||
    !Array.isArray(parsed.files)||parsed.files.length<1||parsed.files.length>8)throw Error('Invalid candidate response');
  const files=parsed.files.map(file=>{
    if(!exact(file,['path','content'])||typeof file.content!=='string'||!file.content.isWellFormed())
      throw Error('Invalid candidate reply file');
    return {path:file.path,content:Buffer.from(file.content,'utf8')};
  });
  return {runId:parsed.runId,baselineManifestSha256:parsed.baselineManifestSha256,files};
}

export async function submitLocalCandidate({id,stateRoot,diskSnapshot,publicKey,response,signal}){
  if(process.env.GITHUB_ACTIONS==='true'||signal?.aborted)throw Error('Local candidate intake unavailable');
  const reply=parseCandidateResponse(response),{provenance}=diskExecutionMetadata(diskSnapshot);
  if(reply.baselineManifestSha256!==provenance.manifestSha256)throw Error('Wrong candidate snapshot');
  const job=await readLocalJob({id,stateRoot});
  if(job.phase!=='prepared'||reply.runId!==job.context.runId||signal?.aborted)throw Error('Wrong candidate run');
  const bundle=createLocalCandidateBundle({context:job.context,baseSha:provenance.baseSha,
    baselineManifestSha256:provenance.manifestSha256,files:reply.files});
  captureDiskCheckInput({diskSnapshot,context:job.context,bundle});
  const encrypted=seal(bundle,publicKey,job.context);
  return runPreparedLocalJob({id,stateRoot,publicKey,signal,worker:({context})=>{
    if(!handoffContext(context).equals(handoffContext(job.context)))throw Error('Prepared candidate context changed');
    // The import runs no child process and has no runtime resources to clean up.
    return {removed:true,executionOutcome:'success',encrypted};
  }});
}
