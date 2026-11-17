// Actual network-none Docker + npm, only synthetic code and forged audit fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {makeLocalReceipt} from './test-fixtures/local-receipt.mjs';
import {independentProject} from './test-fixtures/independent-project.mjs';
import {prepareLocalJob,runPreparedLocalJob,readLocalJob} from './local-jobs.mjs';
import {runLocalIndependentChecks,readIndependentCheckStatus,runPinnedIndependentChecks} from './local-independent-checks.mjs';
import {gitBaselineFixture} from './test-fixtures/git-baseline.mjs';
import {runIsolatedCheck} from './isolated-check.mjs';
import {captureCheckSnapshot} from './independent-check-input.mjs';
import {recipientKey,seal} from './private-handoff.mjs';
const imageId=process.env.ORCHESTRATOR_TEST_IMAGE;
if(!/^sha256:[a-f0-9]{64}$/.test(imageId||''))throw Error('Actual Docker image ID required');
async function fixture(options){
  const root=await mkdtemp(join(tmpdir(),'independent-real-')),f=await makeLocalReceipt(root),job=await prepareLocalJob(f);
  const project=independentProject(job.context,options),key=recipientKey('SYNTHETIC_PRIVATE_LOCAL_KEY',job.context);
  const source=options?.pinned?await gitBaselineFixture(project.baseline):null;
  if(source){project.baseline.baseSha=source.baseSha;project.bundle.baseSha=source.baseSha;project.bundle.result.baseSha=source.baseSha;}
  await runPreparedLocalJob({...f,publicKey:key.publicKey,worker:async()=>({removed:true,executionOutcome:'success',encrypted:seal(project.bundle,key.publicKey,job.context)})});
  return {...f,root,context:job.context,project,privateKey:key.privateKey,source};
}
async function noResources(){
  const exec=promisify(execFile);
  for(const args of [
    ['ps','-a','--filter','label=orchestrator.independent-check=true','--format','{{.Names}}'],
    ['volume','ls','--filter','label=orchestrator.independent-check=true','--format','{{.Name}}']
  ])assert.equal((await exec('docker',args,{env:{PATH:process.env.PATH}})).stdout.trim(),'');
}
test('six actual checks use fresh source, no credentials and no mutable cross-stage state; success never authorizes publishing',async()=>{
  const actions=process.env.GITHUB_ACTIONS;delete process.env.GITHUB_ACTIONS;
  process.env.PRIVATE_GAME_WRITE_TOKEN='SYNTHETIC_HOST_TOKEN';process.env.LOCAL_DECRYPTION_KEY='SYNTHETIC_HOST_KEY';
  let f;
  try{
    f=await fixture({isolation:true});
    const options={...f,baseline:f.project.baseline,imageId,timeoutMs:30000};
    const pending=[1,2].map(()=>runLocalIndependentChecks(options));
    // Host API must capture before its first async state read, not later in a helper.
    options.baseline.files.find(f=>f.path==='src/status.ts').content=Buffer.from('export const n=;').toString('base64');
    const competing=await Promise.allSettled(pending);
    assert.equal(competing.filter(r=>r.status==='fulfilled').length,1);
    const report=competing.find(r=>r.status==='fulfilled').value;
    assert.equal(report.phase,'checks-passed-awaiting-review');assert.equal(report.publishAuthorized,false);assert.equal(report.review,'not-run');
    assert.equal(report.checks.length,6);assert.ok(report.checks.every(r=>r.status==='passed'&&r.removed));
    assert.equal((await readLocalJob(f)).phase,'awaiting-independent-validation');
    await assert.rejects(runLocalIndependentChecks(options));await noResources();
    const path=join(f.stateRoot,f.id,'independent-report.json');assert.equal((await stat(path)).mode&0o777,0o600);
    const raw=await readFile(path,'utf8');assert.ok(!raw.includes('SYNTHETIC_HOST_TOKEN'));assert.ok(!raw.includes('export const'));
    await writeFile(path,JSON.stringify({...report,publishAuthorized:true}));await assert.rejects(readIndependentCheckStatus(f));
  }finally{if(f)await rm(f.root,{recursive:true,force:true});delete process.env.PRIVATE_GAME_WRITE_TOKEN;delete process.env.LOCAL_DECRYPTION_KEY;
    if(actions===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=actions;}
});
test('pinned GitHub protocol snapshot reaches six real Docker checks with bound provenance and no publish permission',async()=>{
  const actions=process.env.GITHUB_ACTIONS;delete process.env.GITHUB_ACTIONS;
  let f;
  try{
    f=await fixture({pinned:true});
    const report=await runPinnedIndependentChecks({...f,get:f.source.get,imageId,timeoutMs:30000});
    assert.equal(report.phase,'checks-passed-awaiting-review');assert.equal(report.baselineBinding,'github-main-pinned');
    assert.equal(report.baselineProvenance.baseSha,f.source.baseSha);assert.equal(report.baselineProvenance.treeSha,f.source.treeSha);
    assert.equal(report.baselineProvenance.baselineContentSha256,report.baselineContentSha256);
    assert.equal(report.publishAuthorized,false);assert.equal(report.checks.length,6);await noResources();
    const path=join(f.stateRoot,f.id,'independent-report.json');
    await writeFile(path,JSON.stringify({...report,baselineProvenance:{...report.baselineProvenance,treeSha:'a'.repeat(40)}}));
    await assert.rejects(readIndependentCheckStatus(f));
  }finally{if(f)await rm(f.root,{recursive:true,force:true});if(actions===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=actions;}
});
test('forged passed audit cannot hide candidate unit failure or excuse an already failing baseline',async()=>{
  const actions=process.env.GITHUB_ACTIONS;delete process.env.GITHUB_ACTIONS;
  try{
    for(const options of [{candidateFails:true},{baselineFails:true}]){
      const f=await fixture(options);
      try{
        const report=await runLocalIndependentChecks({...f,baseline:f.project.baseline,imageId,timeoutMs:30000});
        assert.equal(report.phase,'checks-failed');assert.equal(report.publishAuthorized,false);assert.equal(report.checks.length,6);
        const failed=report.checks.filter(r=>r.status==='failed');assert.equal(failed.length,1);
        assert.equal(failed[0].variant,options.candidateFails?'candidate':'baseline');assert.equal(failed[0].stage,'unit-test');
        assert.equal(failed[0].failureKind,'check_failed');await noResources();
      }finally{await rm(f.root,{recursive:true,force:true});}
    }
  }finally{if(actions===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=actions;}
});
test('actual independent container timeout and output exhaustion are cleaned without source diagnostics escaping',async()=>{
  const context={kind:'local',schemaVersion:2,taskId:'20261117T100000Z-123-456',runId:'12345678-1234-4234-8234-123456789abc',queueCommitSha:'e'.repeat(40),receiptSha256:'f'.repeat(64)};
  for(const [script,limits,kind]of [
    ['node -e "setInterval(()=>{},1000)"',{timeoutMs:2500},'timeout'],
    ['node -e "while(true)process.stdout.write(\'SYNTHETIC_PRIVATE_DIAGNOSTIC\'.repeat(100))"',{outputLimit:4096},'output_limit']
  ]){
    const p=independentProject(context),pkg=p.baseline.files.find(f=>f.path==='package.json'),value=JSON.parse(Buffer.from(pkg.content,'base64'));
    value.scripts.typecheck=script;pkg.content=Buffer.from(JSON.stringify(value)).toString('base64');
    const snapshot=captureCheckSnapshot({context,bundle:p.bundle,baseline:p.baseline});
    const result=await runIsolatedCheck({imageId,payload:snapshot.payload,variant:'candidate',stage:'typecheck',timeoutMs:30000,...limits});
    assert.equal(result.status,'failed');assert.equal(result.failureKind,kind);assert.equal(result.removed,true);
    assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_DIAGNOSTIC'));await noResources();
  }
});
