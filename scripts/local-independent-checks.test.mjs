import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,access,writeFile,chmod} from 'node:fs/promises';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {makeLocalReceipt} from './test-fixtures/local-receipt.mjs';
import {independentProject} from './test-fixtures/independent-project.mjs';
import {prepareLocalJob,runPreparedLocalJob,readLocalJob} from './local-jobs.mjs';
import {captureCheckSnapshot} from './independent-check-input.mjs';
import {recipientKey,seal} from './private-handoff.mjs';
import {runLocalIndependentChecks,readIndependentCheckStatus} from './local-independent-checks.mjs';
const actions=process.env.GITHUB_ACTIONS;
before(()=>{delete process.env.GITHUB_ACTIONS;});after(()=>{if(actions===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=actions;});
test('not-started is not publishable; abort, invalid key/base/image fail before independent claim or Docker',async()=>{
  const root=await mkdtemp(join(tmpdir(),'independent-gate-'));
  try{
    const f=await makeLocalReceipt(root),job=await prepareLocalJob(f),project=independentProject(job.context),key=recipientKey('SYNTHETIC',job.context);
    await runPreparedLocalJob({...f,publicKey:key.publicKey,worker:async()=>({removed:true,executionOutcome:'success',encrypted:seal(project.bundle,key.publicKey,job.context)})});
    assert.equal((await readIndependentCheckStatus(f)).phase,'not-started');
    assert.equal((await readIndependentCheckStatus(f)).publishAuthorized,false);
    const options={...f,baseline:project.baseline,privateKey:key.privateKey,imageId:'sha256:'+'a'.repeat(64)};
    for(const patch of [{signal:AbortSignal.abort()},{privateKey:recipientKey('WRONG',job.context).privateKey},
      {baseline:{...project.baseline,baseSha:'a'.repeat(40)}},{imageId:'latest'}]){
      await assert.rejects(runLocalIndependentChecks({...options,...patch}));
      await assert.rejects(access(join(f.stateRoot,f.id,'independent-claim.json')));
    }
  }finally{await rm(root,{recursive:true,force:true});}
});
test('abort during final real filesystem integrity read cannot commit a passed report',async()=>{
  const root=await mkdtemp(join(tmpdir(),'independent-cancel-')),oldPath=process.env.PATH,originalOpen=fs.promises.open;
  try{
    const f=await makeLocalReceipt(root),job=await prepareLocalJob(f),p=independentProject(job.context),key=recipientKey('SYNTHETIC',job.context);
    await runPreparedLocalJob({...f,publicKey:key.publicKey,worker:async()=>({removed:true,executionOutcome:'success',encrypted:seal(p.bundle,key.publicKey,job.context)})});
    const marker=join(root,'docker-observed'),binary=join(root,'docker');
    // Fault simulator replaces only the external daemon; filesystem integrity reads stay real.
    await writeFile(binary,`#!/usr/bin/env node
import {writeFileSync} from 'node:fs';if(process.argv[2]==='inspect'){
writeFileSync(${JSON.stringify(marker)},'done');console.log(JSON.stringify({Running:false,Paused:false,Restarting:false,ExitCode:0}));}`);
    await chmod(binary,0o755);process.env.PATH=root+':'+oldPath;
    const abort=new AbortController(),artifact=join(f.stateRoot,f.id,'result.enc');
    fs.promises.open=async(...args)=>{
      const handle=await originalOpen(...args);
      if(String(args[0])===artifact&&fs.existsSync(marker))abort.abort();
      return handle;
    };syncBuiltinESMExports();
    const report=await runLocalIndependentChecks({...f,baseline:p.baseline,privateKey:key.privateKey,imageId:'sha256:'+'a'.repeat(64),signal:abort.signal});
    assert.equal(abort.signal.aborted,true);assert.equal(report.phase,'needs-recovery');assert.equal(report.failureKind,'cancelled');
    assert.equal(report.publishAuthorized,false);
  }finally{fs.promises.open=originalOpen;syncBuiltinESMExports();process.env.PATH=oldPath;await rm(root,{recursive:true,force:true});}
});
test('interrupted independent claim is never retried and incomplete or unclaimed reports fail closed',async()=>{
  const root=await mkdtemp(join(tmpdir(),'independent-claim-'));
  try{
    const f=await makeLocalReceipt(root),job=await prepareLocalJob(f),p=independentProject(job.context),key=recipientKey('SYNTHETIC',job.context);
    await runPreparedLocalJob({...f,publicKey:key.publicKey,worker:async()=>({removed:true,executionOutcome:'success',encrypted:seal(p.bundle,key.publicKey,job.context)})});
    const state=await readLocalJob(f),snapshot=captureCheckSnapshot({context:job.context,bundle:p.bundle,baseline:p.baseline}),imageId='sha256:'+'a'.repeat(64);
    const claim={schemaVersion:1,context:state.context,artifactSha256:state.artifactSha256,baseSha:snapshot.baseSha,
      baselineContentSha256:snapshot.baselineContentSha256,candidateContentSha256:snapshot.candidateContentSha256,imageId};
    const dir=join(f.stateRoot,f.id);await writeFile(join(dir,'independent-claim.json'),JSON.stringify(claim),{mode:0o600});
    assert.equal((await readIndependentCheckStatus(f)).phase,'running-or-needs-recovery');
    await assert.rejects(runLocalIndependentChecks({...f,privateKey:key.privateKey,baseline:p.baseline,imageId}),e=>e.code==='EEXIST');
    await writeFile(join(dir,'independent-report.json'),'{',{mode:0o600});await assert.rejects(readIndependentCheckStatus(f));
    await rm(join(dir,'independent-claim.json'));await writeFile(join(dir,'independent-report.json'),'{}');await assert.rejects(readIndependentCheckStatus(f));
  }finally{await rm(root,{recursive:true,force:true});}
});
