// Treat every field from the execution runner as untrusted input.
import {collectVerifiedFiles,digestFileBuffers,isVerifiedDigest} from './verified-manifest.mjs';
import {handoffContext} from './private-handoff.mjs';
import {finalizePrivateReport} from './persist-private-audit.mjs';

export function decodeBundleFiles(files){
  return files.map(f=>{
    if(typeof f?.content!=='string'||f.content.length>86668||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.content))throw Error('Invalid file encoding');
    const content=Buffer.from(f.content,'base64');
    if(content.toString('base64')!==f.content)throw Error('Invalid file encoding');
    return {path:f.path,content};
  });
}

export function validateBundle(bundle,context){
  if(!bundle||bundle.version!==1||!handoffContext(bundle.context).equals(handoffContext(context))||
    !['success','failure','cancelled'].includes(bundle.executionOutcome))throw Error('Invalid bundle context');
  if(bundle.audit?.events&&!Array.isArray(bundle.audit.events))throw Error('Invalid audit events');
  if(bundle.audit?.events?.length>90)throw Error('Oversized authorization audit');
  // Normalize allowlisted metadata. Never forward arbitrary worker strings to logs/PRs.
  const audit=finalizePrivateReport(context.taskId,bundle.audit,'skipped');
  if(bundle.executionOutcome!=='success'){
    if(bundle.result!==null||!Array.isArray(bundle.files)||bundle.files.length)throw Error('Failed execution has source payload');
    return {audit,result:null,files:[]};
  }
  const result=bundle.result;
  if(!/^[a-f0-9]{40}$/.test(bundle.baseSha)||result?.id!==context.taskId||
    !Array.isArray(result.paths)||!isVerifiedDigest(result.verifiedContentSha256)||
    bundle.audit?.status!=='passed'||!Array.isArray(bundle.files)||bundle.files.length!==result.paths.length)
    throw Error('Missing validated bundle');
  const events=audit.events;
  for(const stage of ['typecheck','unit-test','build','review']){
    const last=events.filter(e=>e.stage===stage).at(-1);
    if(last?.status!=='passed'||(stage==='review'&&last.verdict!=='PASS'))throw Error('Missing passed validation');
  }
  const route=result.route;
  if(!['claude','gemini'].includes(route?.controller)||!['claude','gemini'].includes(route?.reviewer)||
    route.controller===route.reviewer||route.developer!=='codex')throw Error('Invalid independent route');
  const review=events.filter(e=>e.stage==='review').at(-1);
  if(review.actor!==route.reviewer)throw Error('Reviewer does not match route');
  const files=decodeBundleFiles(bundle.files);
  if(digestFileBuffers(files)!==result.verifiedContentSha256||
    new Set(result.paths).size!==files.length||files.some(f=>!result.paths.includes(f.path)))
    throw Error('Source changed after review');
  return {audit:{...audit,status:'passed'},files,baseSha:bundle.baseSha,result:{id:result.id,paths:files.map(f=>f.path),
    verifiedContentSha256:result.verifiedContentSha256,
    route:{controller:route.controller,developer:'codex',reviewer:route.reviewer}}};
}
export async function captureBundle({context,executionOutcome,result,audit,baseSha,root}){
  const files=executionOutcome==='success'?(await collectVerifiedFiles(root,result.paths)).files:[];
  const bundle={version:1,context,executionOutcome,baseSha:baseSha??null,
    result:executionOutcome==='success'?result:null,audit,
    files:files.map(f=>({path:f.path,content:f.content.toString('base64')}))};
  validateBundle(bundle,context);return bundle;
}
