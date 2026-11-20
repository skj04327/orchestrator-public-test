import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import fs from 'node:fs';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {publishLocalReviewedDraft,readLocalDraftStatus} from './local-reviewed-draft.mjs';
import {inspectDraftActionsPolicy} from './local-draft-actions-policy.mjs';
import {prepareLocalIndependentReview,reviewVerdictMessage,submitLocalIndependentReview} from './local-independent-review.mjs';
import {prepareLocalJob} from './local-jobs.mjs';
import {submitLocalCandidate} from './local-candidate-intake.mjs';
import {captureDiskCheckInput,getDiskCheckProvenance} from './disk-check-input.mjs';
import {diskCheckFixture,encoded,replaceCandidate} from './test-fixtures/disk-check.mjs';
import {gitBaselineFixture} from './test-fixtures/git-baseline.mjs';
import {makeLocalReceipt} from './test-fixtures/local-receipt.mjs';
import {recipientKey} from './private-handoff.mjs';

const actions=process.env.GITHUB_ACTIONS;
before(()=>{delete process.env.GITHUB_ACTIONS;});
after(()=>{if(actions===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=actions;});
const repo='skj04327/the-twilight-of-korea',origin='https://api.github.com/repos/'+repo;
const token='SYNTHETIC_DRAFT_TOKEN',commitSha='1'.repeat(40);
const json=value=>Buffer.from(JSON.stringify(value));

async function fixture(root,{verdict='pass',maliciousTree=false,extraWorkflow=false,fullBudget=false}={}){
  const f=await makeLocalReceipt(root),job=await prepareLocalJob(f);
  const workflowText='name: Synthetic\non:\n  push:\n  pull_request:\n  workflow_dispatch:\n';
  const workflows=Array.from({length:fullBudget?8:1},(_,index)=>({path:'.github/workflows/check-'+index+'.yml',
    sha256:createHash('sha256').update(workflowText).digest('hex'),events:['push','pull_request','workflow_dispatch']}));
  const extra=[encoded('.codex/config.toml','SYNTHETIC_EXCLUDED_SETTINGS'),...workflows.map(entry=>encoded(entry.path,workflowText))];
  if(extraWorkflow)extra.push(encoded('.github/workflows/unreviewed.yml','on: pull_request_target'));
  const {diskSnapshot,source,bundle}=await diskCheckFixture(root,{context:job.context,purpose:'checks-projected',
    extra});
  const candidate=[encoded('src/status.ts','export const n=5;'),encoded('tests/new.test.ts','// SYNTHETIC ADDED TEST')];
  if(fullBudget)for(let index=0;index<6;index++)candidate.push(encoded('src/add-'+index+'.ts','export const additional='+index+';'));
  replaceCandidate(bundle,candidate);
  const key=recipientKey('SYNTHETIC_PRIVATE_HANDOFF',job.context),reviewer=generateKeyPairSync('ed25519');
  const response=json({schemaVersion:1,runId:job.context.runId,baselineManifestSha256:diskSnapshot.manifestSha256,
    files:candidate.map(({path,content})=>({path,content:Buffer.from(content,'base64').toString('utf8')}))});
  const state=await submitLocalCandidate({...f,diskSnapshot,publicKey:key.publicKey,response});
  const proof=getDiskCheckProvenance(captureDiskCheckInput({diskSnapshot,bundle,context:job.context}));
  const claim={schemaVersion:2,inputProfile:'disk-v1',context:job.context,artifactSha256:state.artifactSha256,...proof,imageId:'sha256:'+'a'.repeat(64)};
  const checks=['baseline','candidate'].flatMap(variant=>['typecheck','unit-test','build'].map(stage=>({variant,stage,status:'passed',failureKind:null,exitCode:0,removed:true,durationMs:1})));
  const report={...claim,phase:'checks-passed-awaiting-review',checks,baselineBinding:'github-main-projected',review:'not-run',publishAuthorized:false,failureKind:null};
  const dir=join(f.stateRoot,f.id);
  await writeFile(join(dir,'independent-claim.json'),json(claim),{mode:0o600});
  await writeFile(join(dir,'independent-report.json'),json(report),{mode:0o600});
  const actionsPolicy={schemaVersion:1,workflows};
  const options={...f,diskSnapshot,privateKey:key.privateKey,reviewerPublicKey:reviewer.publicKey,token,actionsPolicy};
  if(verdict){
    const {request}=await prepareLocalIndependentReview(options);
    await submitLocalIndependentReview({...options,verdict,signature:sign(null,reviewVerdictMessage(request,verdict),reviewer.privateKey)});
  }
  const expected=new Map(source.entries.filter(entry=>entry.type==='blob').map(({path,sha})=>[path,{path,content:source.values.get('/git/blobs/'+sha).content}]));
  for(const entry of candidate)expected.set(entry.path,entry);
  if(maliciousTree)expected.set('src/unexpected.ts',encoded('src/unexpected.ts','// SYNTHETIC UNEXPECTED PATH'));
  const next=await gitBaselineFixture({files:[...expected.values()]});
  const changed=candidate.map(file=>next.entries.find(entry=>entry.path===file.path));
  return {options,source,next,changed,branch:'orchestrator/local-'+f.id+'-'+job.context.runId,dir};
}

function fakeGitHub(t,f,{mode}={}){
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    assert.equal(init.redirect,'error');
    assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+token);
    assert.ok(String(url).startsWith(origin));
    const route=String(url).slice(origin.length),method=init.method,data=init.body?JSON.parse(init.body):undefined;
    calls.push({method,route,data});
    const target={full_name:repo,private:true};
    if(method==='GET'){
      if(!route&&(mode==='public'||(mode==='public-before-write'&&calls.filter(call=>call.route==='').length>1)))return Response.json({...target,private:false});
      if(!route)return Response.json({...target,default_branch:mode==='unknown-default'?'other':'main'});
      const written=path=>calls.some(call=>call.method==='POST'&&call.route===path);
      if(route==='/git/ref/heads/main'&&(mode==='stale'||(mode==='moved'&&written('/git/commits'))||(mode==='moved-after-ref'&&written('/git/refs')))){
        return Response.json({object:{type:'commit',sha:'2'.repeat(40)}});
      }
      if(route==='/git/ref/heads/'+f.branch)return Response.json({ref:'refs/heads/'+f.branch,object:{type:'commit',sha:commitSha}});
      if(route==='/git/commits/'+commitSha){
        const commit=calls.find(call=>call.method==='POST'&&call.route==='/git/commits').data;
        return Response.json({sha:commitSha,parents:[{sha:f.source.baseSha}],tree:{sha:commit.tree},
          message:mode==='skip-removed-readback'?'Synthetic commit without marker':commit.message});
      }
      const value=f.source.values.get(route)??f.next.values.get(route);
      if(route.startsWith('/git/blobs/')&&mode==='bad-blob'&&f.changed.some(file=>route.endsWith(file.sha)))return Response.json({...value,content:'Zg=='});
      assert.ok(value,'Unexpected synthetic GET '+route);
      return Response.json(value);
    }
    assert.equal(method,'POST');
    if(route==='/git/blobs'){
      assert.equal(data.encoding,'base64');
      const entry=f.changed.find(file=>f.next.values.get('/git/blobs/'+file.sha).content===data.content);
      assert.ok(entry,'Only candidate blobs may be sent');
      return Response.json({sha:entry.sha},{status:201});
    }
    if(route==='/git/trees'){
      assert.equal(data.base_tree,f.source.treeSha);
      assert.deepEqual(data.tree,f.changed.map(({path,mode,type,sha})=>({path,mode,type,sha})));
      return Response.json({sha:f.next.treeSha},{status:201});
    }
    if(route==='/git/commits'){
      assert.deepEqual(data.parents,[f.source.baseSha]);assert.equal(data.tree,f.next.treeSha);
      assert.equal(data.message,'[skip ci] Implement orchestrator task '+f.options.id);
      return Response.json({sha:commitSha,parents:[{sha:f.source.baseSha}],tree:{sha:f.next.treeSha},
        message:mode==='skip-removed'?'Synthetic commit without marker':data.message},{status:201});
    }
    if(route==='/git/refs'){
      assert.deepEqual(data,{ref:'refs/heads/'+f.branch,sha:commitSha});
      if(mode==='branch-exists')return Response.json({message:'Reference already exists'},{status:422});
      return Response.json({ref:data.ref,object:{type:'commit',sha:commitSha}},{status:201});
    }
    assert.equal(route,'/pulls');
    assert.equal(data.draft,true);assert.equal(data.base,'main');assert.equal(data.head,f.branch);
    if(mode==='pull-response-lost')throw Error('Synthetic response lost after mutation');
    return Response.json({html_url:'https://github.com/'+repo+'/pull/654',state:'open',draft:mode!=='wrong-pr',
      head:{ref:f.branch,sha:commitSha,repo:target},base:{ref:'main',sha:f.source.baseSha,repo:target}},{status:201});
  });
  return calls;
}

test('the local publisher verifies the signed candidate and creates a single atomic commit and private Draft',async t=>{
  const root=await mkdtemp(join(tmpdir(),'local-draft-'));
  try{
    const f=await fixture(root),calls=fakeGitHub(t,f);
    const policy=await inspectDraftActionsPolicy({actionsPolicy:f.options.actionsPolicy,expectedBaseSha:f.source.baseSha,
      get:path=>path===''?{full_name:repo,private:true,default_branch:'main'}:f.source.get(path)});
    assert.equal(policy.phase,'actions-policy-verified');
    assert.equal(policy.workflowCount,1);assert.equal(policy.publishAuthorized,false);
    assert.equal((await readLocalDraftStatus(f.options)).phase,'not-started');
    const competing=await Promise.allSettled([0,1].map(()=>publishLocalReviewedDraft(f.options)));
    const done=competing.filter(result=>result.status==='fulfilled');
    assert.equal(done.length,1,competing.filter(result=>result.status==='rejected').map(result=>result.reason.failureKind??result.reason.message).join(', '));
    assert.equal(done[0].value.phase,'draft-created');
    assert.equal(done[0].value.headSha,commitSha);
    assert.equal(done[0].value.branch,f.branch);
    assert.deepEqual(await readLocalDraftStatus(f.options),done[0].value);
    assert.deepEqual(calls.filter(call=>call.method==='POST').map(call=>call.route),['/git/blobs','/git/blobs','/git/trees','/git/commits','/git/refs','/pulls']);
    assert.doesNotMatch(JSON.stringify(calls),/SYNTHETIC_EXCLUDED_SETTINGS|SYNTHETIC_LOCAL_JOB/);
    assert.doesNotMatch(await readFile(join(f.dir,'local-draft.json'),'utf8'),/SYNTHETIC_DRAFT_TOKEN|export const/);
    assert.equal(JSON.parse(await readFile(join(f.dir,'local-draft.json'),'utf8')).actionsPolicySha256,policy.actionsPolicySha256);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('no token request occurs for an absent review, signed rejection, altered candidate, or public Actions',async t=>{
  for(const mode of ['absent','rejected','tampered','actions']){
    const root=await mkdtemp(join(tmpdir(),'local-draft-gate-'));
    const original=process.env.GITHUB_ACTIONS;
    try{
      const f=await fixture(root,{verdict:mode==='absent'?null:mode==='rejected'?'fail':'pass'}),calls=fakeGitHub(t,f);
      if(mode==='tampered'){
        const path=join(f.dir,'result.enc'),bytes=await readFile(path);bytes[bytes.length-1]^=1;await writeFile(path,bytes);
      }
      if(mode==='actions')process.env.GITHUB_ACTIONS='true';
      await assert.rejects(publishLocalReviewedDraft(f.options));
      assert.deepEqual(calls,[]);
      t.mock.restoreAll();
    }finally{if(original===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=original;await rm(root,{recursive:true,force:true});}
  }
});

test('private and main checks prevent preflight writes, and ambiguous or changed GitHub state requires recovery',async t=>{
  for(const mode of ['public','public-before-write','stale','bad-blob','changed-tree','moved','skip-removed','skip-removed-readback','branch-exists','moved-after-ref','wrong-pr','pull-response-lost']){
    const root=await mkdtemp(join(tmpdir(),'local-draft-recovery-'));
    try{
      const f=await fixture(root,{maliciousTree:mode==='changed-tree'}),calls=fakeGitHub(t,f,{mode});
      await assert.rejects(publishLocalReviewedDraft(f.options));
      const writes=calls.filter(call=>call.method==='POST');
      const result=await readLocalDraftStatus(f.options),{phase}=result;
      if(['public','public-before-write','stale'].includes(mode)){assert.equal(phase,'not-started');assert.equal(writes.length,0);}
      else{
        assert.equal(phase,'needs-recovery');
        if(!['branch-exists','moved-after-ref','wrong-pr','pull-response-lost'].includes(mode))assert.ok(writes.every(call=>!['/git/refs','/pulls'].includes(call.route)));
        if(['branch-exists','moved-after-ref'].includes(mode))assert.ok(writes.some(call=>call.route==='/git/refs')&&!writes.some(call=>call.route==='/pulls'));
        if(['branch-exists','wrong-pr','pull-response-lost'].includes(mode))assert.equal(result.headSha,commitSha);
        const before=calls.length;
        await assert.rejects(publishLocalReviewedDraft(f.options));
        assert.equal(calls.length,before);
      }
      t.mock.restoreAll();
    }finally{await rm(root,{recursive:true,force:true});}
  }
});

test('unreviewed workflow bytes, events or default branch prevent every publication write',async t=>{
  for(const mode of ['absent','different-digest','unsafe-event','missing-event','unrecognized-file','unknown-default']){
    const root=await mkdtemp(join(tmpdir(),'local-draft-actions-'));
    try{
      const f=await fixture(root,{extraWorkflow:mode==='unrecognized-file'}),calls=fakeGitHub(t,f,{mode});
      const policy=structuredClone(f.options.actionsPolicy);
      if(mode==='different-digest')policy.workflows[0].sha256='f'.repeat(64);
      if(mode==='unsafe-event')policy.workflows[0].events.push('pull_request_target');
      if(mode==='missing-event')delete policy.workflows[0].events[0];
      await assert.rejects(publishLocalReviewedDraft({...f.options,actionsPolicy:mode==='absent'?undefined:policy}));
      assert.equal((await readLocalDraftStatus(f.options)).phase,'not-started');
      assert.ok(calls.every(call=>call.method==='GET'));
      t.mock.restoreAll();
    }finally{await rm(root,{recursive:true,force:true});}
  }
});

test('eight workflow blobs and eight unique candidate blobs fit the publication request limit',async t=>{
  const root=await mkdtemp(join(tmpdir(),'local-draft-limit-'));
  try{
    const f=await fixture(root,{fullBudget:true}),calls=fakeGitHub(t,f);
    const {workflowCount}=await inspectDraftActionsPolicy({actionsPolicy:f.options.actionsPolicy,expectedBaseSha:f.source.baseSha,
      get:path=>path===''?{full_name:repo,private:true,default_branch:'main'}:f.source.get(path)});
    assert.equal(workflowCount,8);
    assert.equal((await publishLocalReviewedDraft(f.options)).phase,'draft-created');
    assert.equal(calls.length,41);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('status can overlap completion of a publish without claiming inconsistent state',async t=>{
  const root=await mkdtemp(join(tmpdir(),'local-draft-read-race-')),originalOpen=fs.promises.open;
  try{
    const f=await fixture(root);fakeGitHub(t,f);
    const claimPath=join(f.dir,'local-draft-claim.json');
    let published=false;
    fs.promises.open=async(...args)=>{
      try{return await originalOpen(...args);}catch(error){
        if(!published&&args[0]===claimPath&&error.code==='ENOENT'){
          published=true;
          await publishLocalReviewedDraft(f.options);
        }
        throw error;
      }
    };
    syncBuiltinESMExports();
    assert.equal((await readLocalDraftStatus(f.options)).phase,'not-started');
    assert.equal(published,true);
    assert.equal((await readLocalDraftStatus(f.options)).phase,'draft-created');
  }finally{
    fs.promises.open=originalOpen;syncBuiltinESMExports();
    await rm(root,{recursive:true,force:true});
  }
});

test('a job or state root sync failure prevents every remote write',async t=>{
  for(const mode of ['job','root']){
    const root=await mkdtemp(join(tmpdir(),'local-draft-sync-')),originalOpen=fs.promises.open;
    try{
      const f=await fixture(root),calls=fakeGitHub(t,f),syncTarget=mode==='job'?f.dir:f.options.stateRoot;
      let syncAttempted=false;
      fs.promises.open=async(...args)=>{
        const handle=await originalOpen(...args);
        if(args[0]===syncTarget)handle.sync=async()=>{syncAttempted=true;throw Error('Synthetic directory sync failure');};
        return handle;
      };
      syncBuiltinESMExports();
      await assert.rejects(publishLocalReviewedDraft(f.options),/Synthetic directory sync failure/);
      assert.equal(syncAttempted,true);
      assert.equal((await readLocalDraftStatus(f.options)).phase,'needs-recovery');
      assert.ok(calls.every(call=>call.method==='GET'));
    }finally{
      fs.promises.open=originalOpen;syncBuiltinESMExports();
      t.mock.restoreAll();
      await rm(root,{recursive:true,force:true});
    }
  }
});
