import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import fs from 'node:fs';
import {mkdtemp,readFile,rm,writeFile,stat} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareLocalIndependentReview,reviewVerdictMessage,submitLocalIndependentReview,readLocalIndependentReview} from './local-independent-review.mjs';
import {prepareLocalJob} from './local-jobs.mjs';
import {makeLocalReceipt} from './test-fixtures/local-receipt.mjs';
import {diskCheckFixture} from './test-fixtures/disk-check.mjs';
import {captureDiskCheckInput,getDiskCheckProvenance} from './disk-check-input.mjs';
import {recipientKey} from './private-handoff.mjs';
import {submitLocalCandidate} from './local-candidate-intake.mjs';
import {digestFileBuffers} from './verified-manifest.mjs';

const actions=process.env.GITHUB_ACTIONS;
before(()=>{delete process.env.GITHUB_ACTIONS;});
after(()=>{if(actions===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=actions;});
const json=value=>Buffer.from(JSON.stringify(value));

async function fixture(root){
  const f=await makeLocalReceipt(root),job=await prepareLocalJob(f);
  const {diskSnapshot,bundle}=await diskCheckFixture(root,{context:job.context});
  const key=recipientKey('SYNTHETIC_REVIEW_RECIPIENT',job.context),reviewer=generateKeyPairSync('ed25519');
  const response=json({schemaVersion:1,runId:job.context.runId,baselineManifestSha256:diskSnapshot.manifestSha256,
    files:bundle.files.map(({path,content})=>({path,content:Buffer.from(content,'base64').toString('utf8')}))});
  const state=await submitLocalCandidate({...f,diskSnapshot,publicKey:key.publicKey,response});
  const proof=getDiskCheckProvenance(captureDiskCheckInput({diskSnapshot,bundle,context:job.context}));
  const claim={schemaVersion:2,inputProfile:'disk-v1',context:job.context,artifactSha256:state.artifactSha256,...proof,imageId:'sha256:'+'a'.repeat(64)};
  const checks=['baseline','candidate'].flatMap(variant=>['typecheck','unit-test','build'].map(stage=>({variant,stage,status:'passed',failureKind:null,exitCode:0,removed:true,durationMs:1})));
  const report={...claim,phase:'checks-passed-awaiting-review',checks,baselineBinding:'github-main-pinned',review:'not-run',publishAuthorized:false,failureKind:null};
  const dir=join(f.stateRoot,f.id);
  await writeFile(join(dir,'independent-claim.json'),json(claim),{mode:0o600});
  return {options:{...f,diskSnapshot,privateKey:key.privateKey,reviewerPublicKey:reviewer.publicKey},reviewer,report,
    reportPath:join(dir,'independent-report.json'),reviewPath:join(dir,'independent-review.json')};
}

test('a review can only bind verified candidate bytes after all six checks and accepts exactly one valid signature',async()=>{
  const root=await mkdtemp(join(tmpdir(),'local-review-binding-'));
  try{
    const {options,reviewer,report,reportPath,reviewPath}=await fixture(root);
    const other=generateKeyPairSync('ed25519');
    assert.equal((await readLocalIndependentReview(options)).phase,'not-ready');
    await assert.rejects(prepareLocalIndependentReview(options));
    await writeFile(reportPath,json(report),{mode:0o600});
    assert.equal((await readLocalIndependentReview(options)).phase,'awaiting-review');
    await assert.rejects(prepareLocalIndependentReview({...options,diskSnapshot:structuredClone(options.diskSnapshot)}));
    await assert.rejects(prepareLocalIndependentReview({...options,privateKey:other.privateKey}));
    const {request,files}=await prepareLocalIndependentReview(options);
    assert.equal(request.candidateContentSha256,digestFileBuffers(files));
    assert.equal(request.baselineManifestSha256,report.baselineManifestSha256);
    assert.equal(request.artifactSha256,report.artifactSha256);
    assert.equal(request.runId,report.context.runId);
    const signature=sign(null,reviewVerdictMessage(request,'pass'),reviewer.privateKey);
    const changedRequest={...request,runId:'3dfdb025-3a63-4fcf-94e0-d433d19f8d1c'};
    for(const invalid of [
      {verdict:'fail',signature},
      {verdict:'pass',signature:sign(null,reviewVerdictMessage(changedRequest,'pass'),reviewer.privateKey)},
      {verdict:'pass',signature:sign(null,reviewVerdictMessage({...request,candidateContentSha256:'a'.repeat(64)},'pass'),reviewer.privateKey)},
      {verdict:'pass',signature:sign(null,reviewVerdictMessage(request,'pass'),other.privateKey)},
      {verdict:'pass',signature,reviewerPublicKey:other.publicKey},
      {verdict:'pass',signature,signal:AbortSignal.abort()}
    ])await assert.rejects(submitLocalIndependentReview({...options,...invalid}));
    assert.equal((await readLocalIndependentReview(options)).phase,'awaiting-review');
    const competing=await Promise.allSettled([0,1].map(()=>submitLocalIndependentReview({...options,verdict:'pass',signature})));
    assert.equal(competing.filter(result=>result.status==='fulfilled').length,1);
    const status=await readLocalIndependentReview(options);
    assert.equal(status.phase,'review-passed');
    assert.equal(status.publishAuthorized,false);
    assert.equal((await stat(reviewPath)).mode&0o777,0o600);
    assert.doesNotMatch(await readFile(reviewPath,'utf8'),/export const|SYNTHETIC_REVIEW_RECIPIENT/);
    const changed=structuredClone(report);changed.checks[0].durationMs++;
    await writeFile(reportPath,json(changed));
    await assert.rejects(readLocalIndependentReview(options));
    await writeFile(reportPath,json(report));
    const saved=JSON.parse(await readFile(reviewPath,'utf8'));
    await writeFile(reviewPath,json({...saved,verdict:'fail'}));
    await assert.rejects(readLocalIndependentReview(options));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a signed rejection is terminal and failed checks cannot reach review',async()=>{
  const root=await mkdtemp(join(tmpdir(),'local-review-failed-'));
  try{
    const {options,reviewer,report,reportPath,reviewPath}=await fixture(root);
    const failed=structuredClone(report);failed.phase='checks-failed';
    Object.assign(failed.checks[4],{status:'failed',failureKind:'check_failed',exitCode:1});
    await writeFile(reportPath,json(failed),{mode:0o600});
    await assert.rejects(prepareLocalIndependentReview(options));
    await assert.rejects(submitLocalIndependentReview({...options,verdict:'pass',signature:Buffer.alloc(64)}));
    await assert.rejects(stat(reviewPath),{code:'ENOENT'});
    await writeFile(reportPath,json(report));
    const {request}=await prepareLocalIndependentReview(options);
    const rejected=await submitLocalIndependentReview({...options,verdict:'fail',signature:sign(null,reviewVerdictMessage(request,'fail'),reviewer.privateKey)});
    assert.equal(rejected.phase,'review-failed');
    assert.equal(rejected.publishAuthorized,false);
    await assert.rejects(submitLocalIndependentReview({...options,verdict:'pass',signature:sign(null,reviewVerdictMessage(request,'pass'),reviewer.privateKey)}));
    assert.deepEqual(await readLocalIndependentReview(options),rejected);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('status accepts a valid verdict committed while starting an earlier status read',async()=>{
  const root=await mkdtemp(join(tmpdir(),'local-review-race-')),originalOpen=fs.promises.open;
  try{
    const {options,reviewer,report,reportPath}=await fixture(root);
    await writeFile(reportPath,json(report),{mode:0o600});
    const {request}=await prepareLocalIndependentReview(options);
    const signature=sign(null,reviewVerdictMessage(request,'pass'),reviewer.privateKey);
    await rm(reportPath);
    let committed=false;
    fs.promises.open=async(...args)=>{
      try{return await originalOpen(...args);}catch(error){
        if(!committed&&args[0]===reportPath&&error.code==='ENOENT'){
          committed=true;
          await writeFile(reportPath,json(report),{mode:0o600});
          await submitLocalIndependentReview({...options,verdict:'pass',signature});
        }
        throw error;
      }
    };
    syncBuiltinESMExports();
    const status=await readLocalIndependentReview(options);
    assert.equal(committed,true);
    assert.equal(status.phase,'review-passed');
  }finally{
    fs.promises.open=originalOpen;syncBuiltinESMExports();
    await rm(root,{recursive:true,force:true});
  }
});

test('a changed report during staging cannot acquire the terminal review record',async()=>{
  const root=await mkdtemp(join(tmpdir(),'local-review-staging-')),originalOpen=fs.promises.open;
  try{
    const {options,reviewer,report,reportPath,reviewPath}=await fixture(root);
    await writeFile(reportPath,json(report),{mode:0o600});
    const {request}=await prepareLocalIndependentReview(options);
    const signature=sign(null,reviewVerdictMessage(request,'pass'),reviewer.privateKey);
    const changed=structuredClone(report);changed.checks[1].durationMs++;
    let staged=false;
    fs.promises.open=async(...args)=>{
      if(!staged&&String(args[0]).includes('/.independent-review-')){
        staged=true;
        await writeFile(reportPath,json(changed));
      }
      return originalOpen(...args);
    };
    syncBuiltinESMExports();
    await assert.rejects(submitLocalIndependentReview({...options,verdict:'pass',signature}));
    assert.equal(staged,true);
    await assert.rejects(stat(reviewPath),{code:'ENOENT'});
  }finally{
    fs.promises.open=originalOpen;syncBuiltinESMExports();
    await rm(root,{recursive:true,force:true});
  }
});

test('a job marked as failed cannot obtain a verdict using a previously valid check report',async()=>{
  const root=await mkdtemp(join(tmpdir(),'local-review-failed-job-'));
  try{
    const {options,reviewer,report,reportPath,reviewPath}=await fixture(root);
    await writeFile(reportPath,json(report),{mode:0o600});
    const {request}=await prepareLocalIndependentReview(options);
    const signature=sign(null,reviewVerdictMessage(request,'pass'),reviewer.privateKey);
    const terminalPath=join(options.stateRoot,options.id,'events','0002.json');
    const state=JSON.parse(await readFile(terminalPath,'utf8'));
    await writeFile(terminalPath,json({...state,phase:'failed'}));
    await assert.rejects(prepareLocalIndependentReview(options));
    await assert.rejects(submitLocalIndependentReview({...options,verdict:'pass',signature}));
    await assert.rejects(stat(reviewPath),{code:'ENOENT'});
  }finally{await rm(root,{recursive:true,force:true});}
});
