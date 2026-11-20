// Reviewed workflow metadata belongs to the trusted publisher configuration.
// Bind it to all workflow files from the checked default branch before remote writes.
import {createHash} from 'node:crypto';
import {objectHash,readMainInventory,readPrivateMainHead} from './main-inventory.mjs';
import {privateReadSession} from './private-read-session.mjs';
import {isVerifiedDigest} from './verified-manifest.mjs';

const prefix='.github/workflows/';
const supportedEvents=new Set(['push','pull_request','workflow_dispatch']);
const workflowPath=/^\.github\/workflows\/[a-zA-Z0-9_.-]{1,128}\.ya?ml$/;
const failure=kind=>Object.assign(Error('Draft Actions policy unavailable'),{failureKind:kind});
const exact=(value,fields)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===fields.length&&fields.every(field=>Object.hasOwn(value,field));
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

function normalize(policy){
  if(!exact(policy,['schemaVersion','workflows'])||policy.schemaVersion!==1||!Array.isArray(policy.workflows)||policy.workflows.length>8)
    throw failure('actions_policy_required');
  const seen=new Set();
  return Array.from(policy.workflows,item=>{
    if(!exact(item,['path','sha256','events'])||typeof item.path!=='string'||!workflowPath.test(item.path)||seen.has(item.path)||
      !isVerifiedDigest(item.sha256)||!Array.isArray(item.events)||item.events.length<1||item.events.length>supportedEvents.size)
      throw failure('actions_workflow_not_reviewed');
    const events=[...item.events];
    if(new Set(events).size!==events.length||events.some(event=>!supportedEvents.has(event)))throw failure('actions_workflow_not_reviewed');
    seen.add(item.path);
    return {path:item.path,sha256:item.sha256,events:events.sort()};
  }).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}

function requireMainDefault(request){
  return async path=>{
    const value=await request(path);
    if(path===''&&value?.default_branch!=='main')throw failure('actions_default_branch_unverified');
    return value;
  };
}
export function readPublishingMain(request){
  return readPrivateMainHead(requireMainDefault(request));
}
export function readPublishingInventory({request,expectedBaseSha}){
  return readMainInventory({request:requireMainDefault(request),expectedBaseSha});
}

export async function verifyDraftActionsPolicy({actionsPolicy,inventory,request}){
  if(process.env.GITHUB_ACTIONS==='true')throw failure('local_host_required');
  const reviewed=normalize(actionsPolicy),workflows=inventory.entries.filter(file=>file.path.startsWith(prefix));
  if(reviewed.length!==workflows.length)throw failure('actions_workflow_set_changed');
  const paths=new Map(workflows.map(file=>[file.path,file]));
  for(const entry of reviewed){
    const file=paths.get(entry.path);
    if(!file||file.mode!=='100644'||file.size<1||file.size>100000)throw failure('actions_workflow_not_reviewed');
    const raw=await request('/git/blobs/'+file.sha);
    if(raw?.sha!==file.sha||raw.encoding!=='base64'||raw.size!==file.size||typeof raw.content!=='string'||raw.content.length>150000)
      throw failure('actions_workflow_integrity');
    const encoded=raw.content.replace(/\r?\n/g,''),bytes=Buffer.from(encoded,'base64');
    if(bytes.toString('base64')!==encoded||bytes.length!==file.size||objectHash('blob',bytes)!==file.sha||sha256(bytes)!==entry.sha256)
      throw failure('actions_workflow_integrity');
  }
  return {workflowCount:reviewed.length,actionsPolicySha256:sha256(JSON.stringify({schemaVersion:1,workflows:reviewed}))};
}

export async function inspectDraftActionsPolicy({actionsPolicy,get,expectedBaseSha,signal}){
  if(process.env.GITHUB_ACTIONS==='true')throw failure('local_host_required');
  const session=privateReadSession({get,signal,timeoutMs:60000,requestLimit:14});
  try{
    const inventory=await readPublishingInventory({request:session.request,expectedBaseSha});
    const result=await verifyDraftActionsPolicy({actionsPolicy,inventory,request:session.request});
    if(await readPublishingMain(session.request)!==inventory.baseSha)throw failure('main_moved');
    return {phase:'actions-policy-verified',...result,publishAuthorized:false};
  }finally{session.dispose();}
}
