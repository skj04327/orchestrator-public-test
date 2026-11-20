// Isolated local publication. No project code, dependency installer, or provider process runs here.
import {join} from 'node:path';
import {constants} from 'node:fs';
import {link,mkdtemp,open,rm} from 'node:fs/promises';
import {readLocalJob} from './local-jobs.mjs';
import {loadReviewedLocalCandidate} from './local-independent-review.mjs';
import {MAX_HANDOFF_BYTES} from './private-handoff.mjs';
import {readPrivateStateFile,writePrivateStateFile} from './private-queue.mjs';
import {BASELINE_REPOSITORY,checkTree,objectHash,readMainInventory,readPrivateMainHead} from './main-inventory.mjs';
import {assertCandidateOverlayPaths} from './independent-check-input.mjs';
import {digestFileBuffers,isVerifiedDigest} from './verified-manifest.mjs';

const api='https://api.github.com/repos/'+BASELINE_REPOSITORY;
const gitSha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const privateRepo=repo=>repo?.private===true&&repo.full_name===BASELINE_REPOSITORY;
const prUrl=value=>typeof value==='string'&&/^https:\/\/github\.com\/skj04327\/the-twilight-of-korea\/pull\/[1-9][0-9]{0,19}$/.test(value);
const branchFor=context=>'orchestrator/local-'+context.taskId+'-'+context.runId;
const failure=kind=>Object.assign(Error('Local Draft publish failed'),{failureKind:kind});
const claimFields=['schemaVersion','taskId','runId','branch','baseSha','artifactSha256','candidateContentSha256','reviewRequestSha256'];
const exact=(value,fields)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===fields.length&&fields.every(field=>Object.hasOwn(value,field));

async function readState(path){
  let bytes;
  try{bytes=await readPrivateStateFile(path,4096);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  try{
    const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if(value&&typeof value==='object'&&!Array.isArray(value))return value;
  }catch{}
  throw failure('invalid_publish_state');
}
async function syncDirectory(dir){
  const directory=await open(dir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{await directory.sync();}finally{await directory.close();}
}
async function recordState(dir,name,value,check=()=>{}){
  const staging=await mkdtemp(join(dir,'.local-draft-'));
  let committed=false;
  try{
    const path=join(staging,'state.json');
    await writePrivateStateFile(path,Buffer.from(JSON.stringify(value)+'\n'));
    check();
    await link(path,join(dir,name));
    committed=true;
    await syncDirectory(dir);
  }finally{
    try{await rm(staging,{recursive:true,force:true});}
    catch(error){if(!committed)throw error;}
  }
}
const status=(taskId,phase,fields={})=>({taskId,phase,...fields});
export async function readLocalDraftStatus({id,stateRoot}){
  if(process.env.GITHUB_ACTIONS==='true')throw failure('local_host_required');
  const task=await readLocalJob({id,stateRoot}),dir=join(stateRoot,id);
  // The records are append-only. Observe dependent records before their prerequisites.
  const receipt=await readState(join(dir,'local-draft.json'));
  const plannedHead=await readState(join(dir,'local-draft-head.json'));
  const claim=await readState(join(dir,'local-draft-claim.json'));
  if(!claim){
    if(receipt||plannedHead)throw failure('invalid_publish_state');
    return status(id,'not-started');
  }
  if(task.phase!=='awaiting-independent-validation'||!exact(claim,claimFields)||claim.schemaVersion!==1||claim.taskId!==id||claim.runId!==task.context.runId||
    claim.branch!==branchFor(task.context)||!gitSha(claim.baseSha)||claim.artifactSha256!==task.artifactSha256||
    !['artifactSha256','candidateContentSha256','reviewRequestSha256'].every(field=>isVerifiedDigest(claim[field])))throw failure('invalid_publish_state');
  if(plannedHead&&(!exact(plannedHead,['headSha'])||!gitSha(plannedHead.headSha)))throw failure('invalid_publish_state');
  if(!receipt)return status(id,'needs-recovery',{branch:claim.branch,...(plannedHead??{})});
  if(!exact(receipt,[...claimFields,'headSha','prUrl'])||claimFields.some(field=>claim[field]!==receipt[field])||
    !plannedHead||receipt.headSha!==plannedHead.headSha||!prUrl(receipt.prUrl))throw failure('invalid_publish_state');
  return status(id,'draft-created',{branch:claim.branch,headSha:receipt.headSha,prUrl:receipt.prUrl});
}

function githubClient(token,signal){
  if(typeof token!=='string'||! /^[A-Za-z0-9_]{1,256}$/.test(token))throw failure('invalid_publish_token');
  const deadline=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(180000)]);
  let calls=0;
  const checkStopped=()=>{if(deadline.aborted)throw failure(signal?.aborted?'cancelled':'publish_timeout');};
  async function request(path,method='GET',payload){
    checkStopped();
    if(++calls>40)throw failure('publish_request_limit');
    try{
      const response=await fetch(api+path,{method,redirect:'error',signal:AbortSignal.any([deadline,AbortSignal.timeout(20000)]),
        headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},
        body:payload===undefined?undefined:JSON.stringify(payload)});
      if(!response.ok){
        await response.body?.cancel();
        throw failure([401,403].includes(response.status)?'github_authorization_failed':'github_request_failed');
      }
      const chunks=[];let bytes=0;
      for await(const chunk of response.body){
        bytes+=chunk.length;
        if(bytes>4*1024*1024)throw failure('github_response_limit');
        chunks.push(chunk);
      }
      checkStopped();
      return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes)));
    }catch(error){checkStopped();throw error.failureKind?error:failure('github_request_failed');}
  }
  return {request,checkStopped};
}

function planTree(inventory,files){
  const before=new Map(inventory.entries.map(file=>[file.path,file]));
  assertCandidateOverlayPaths([...before.keys()],files.map(file=>file.path));
  const folders=new Set(inventory.treeEntries.filter(entry=>entry.type==='tree').map(entry=>entry.path));
  if(files.some(file=>folders.has(file.path)))throw failure('remote_path_collision');
  const expected=new Map(before);
  const updates=files.map(({path,content})=>{
    const mode=before.get(path)?.mode??'100644',sha=objectHash('blob',content);
    expected.set(path,{path,type:'blob',mode,sha,size:content.length});
    const parts=path.split('/');parts.pop();
    while(parts.length){folders.add(parts.join('/'));parts.pop();}
    return {path,type:'blob',mode,sha};
  });
  if(updates.every(file=>before.get(file.path)?.sha===file.sha))throw failure('no_candidate_changes');
  return {updates,expected,folders};
}
function verifyTree(value,sha,{expected,folders}){
  const files=checkTree(value,sha),dirs=value.tree.filter(entry=>entry.type==='tree');
  if(files.length!==expected.size||dirs.length!==folders.size||dirs.some(entry=>!folders.has(entry.path))||
    files.some(file=>{const wanted=expected.get(file.path);return !wanted||file.sha!==wanted.sha||file.mode!==wanted.mode||file.size!==wanted.size;}))
    throw failure('remote_tree_mismatch');
}
function verifyBlob(value,sha,content){
  if(value?.sha!==sha||value.encoding!=='base64'||value.size!==content.length||typeof value.content!=='string'||
    value.content.length>MAX_HANDOFF_BYTES||value.content.replace(/\r?\n/g,'')!==content.toString('base64'))throw failure('remote_blob_mismatch');
}
function verifyRef(value,ref,sha){
  if(value?.ref!==ref||value.object?.type!=='commit'||value.object.sha!==sha)throw failure('remote_ref_mismatch');
}

export async function publishLocalReviewedDraft({id,stateRoot,privateKey,diskSnapshot,reviewerPublicKey,token,signal}){
  if(process.env.GITHUB_ACTIONS==='true'||signal?.aborted)throw failure('local_host_required');
  if((await readLocalDraftStatus({id,stateRoot})).phase!=='not-started')throw failure('already_claimed');
  const evidence={id,stateRoot,privateKey,diskSnapshot,reviewerPublicKey,signal};
  const {request:review,files,reviewRequestSha256,treeSha}=await loadReviewedLocalCandidate(evidence);
  const {request,checkStopped}=githubClient(token,signal),baseSha=review.baseSha;
  const inventory=await readMainInventory({request,expectedBaseSha:baseSha});
  if(inventory.treeSha!==treeSha||digestFileBuffers(files)!==review.candidateContentSha256)throw failure('publish_evidence_mismatch');
  const plan=planTree(inventory,files);
  const branch=branchFor({taskId:id,runId:review.runId}),ref='refs/heads/'+branch,dir=join(stateRoot,id);
  const claim={schemaVersion:1,taskId:id,runId:review.runId,branch,baseSha,artifactSha256:review.artifactSha256,
    candidateContentSha256:review.candidateContentSha256,reviewRequestSha256};
  async function requireCurrentMain(){if(await readPrivateMainHead(request)!==baseSha)throw failure('main_moved');}
  await requireCurrentMain();
  checkStopped();
  await recordState(dir,'local-draft-claim.json',claim,checkStopped);
  await syncDirectory(stateRoot);

  const seen=new Map();
  for(const [index,file] of files.entries()){
    const {sha}=plan.updates[index];
    if(seen.has(sha)){
      if(!seen.get(sha).equals(file.content))throw failure('ambiguous_git_blob');
      continue;
    }
    seen.set(sha,file.content);
    const blob=await request('/git/blobs','POST',{encoding:'base64',content:file.content.toString('base64')});
    if(blob?.sha!==sha)throw failure('remote_blob_mismatch');
    verifyBlob(await request('/git/blobs/'+sha),sha,file.content);
  }
  const tree=await request('/git/trees','POST',{base_tree:treeSha,tree:plan.updates});
  if(!gitSha(tree?.sha))throw failure('remote_tree_mismatch');
  verifyTree(await request('/git/trees/'+tree.sha+'?recursive=1'),tree.sha,plan);
  const commit=await request('/git/commits','POST',{message:'Implement orchestrator task '+id,tree:tree.sha,parents:[baseSha]});
  if(!gitSha(commit?.sha)||commit.tree?.sha!==tree.sha||!Array.isArray(commit.parents)||
    commit.parents.length!==1||commit.parents[0]?.sha!==baseSha)throw failure('remote_commit_mismatch');

  const current=await loadReviewedLocalCandidate(evidence);
  if(current.reviewRequestSha256!==reviewRequestSha256)throw failure('publish_evidence_mismatch');
  await recordState(dir,'local-draft-head.json',{headSha:commit.sha},checkStopped);
  await requireCurrentMain();
  verifyRef(await request('/git/refs','POST',{ref,sha:commit.sha}),ref,commit.sha);
  verifyRef(await request('/git/ref/heads/'+branch),ref,commit.sha);
  await requireCurrentMain();
  const draft=await request('/pulls','POST',{title:'Orchestrator task '+id,head:branch,base:'main',draft:true,
    body:'The baseline and candidate passed all six isolated checks. The changes have an independently signed review. Human merge approval is required.'});
  if(draft?.draft!==true||draft.state!=='open'||!prUrl(draft.html_url)||draft.head?.ref!==branch||draft.head.sha!==commit.sha||
    draft.base?.ref!=='main'||draft.base.sha!==baseSha||!privateRepo(draft.head.repo)||!privateRepo(draft.base.repo))throw failure('remote_draft_mismatch');
  await recordState(dir,'local-draft.json',{...claim,headSha:commit.sha,prUrl:draft.html_url});
  return status(id,'draft-created',{branch,headSha:commit.sha,prUrl:draft.html_url});
}
