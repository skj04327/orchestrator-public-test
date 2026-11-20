import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile,spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
import {makeLocalReceipt} from './test-fixtures/local-receipt.mjs';
import {diskCheckFixture} from './test-fixtures/disk-check.mjs';
import {recipientKey} from './private-handoff.mjs';
const exec=promisify(execFile),cli=resolve('scripts/local-job-cli.mjs');
test('actual CLI prepares and reports metadata only, denies live run and Actions before state writes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'local-cli-'));
  try{
    const f=await makeLocalReceipt(root),env={...process.env,GITHUB_ACTIONS:''};
    await assert.rejects(exec(process.execPath,[cli,'prepare',f.id,f.stateRoot,f.receiptRoot],{env:{...env,GITHUB_ACTIONS:'true'}}));
    await assert.rejects(access(f.stateRoot));
    const result=await exec(process.execPath,[cli,'prepare',f.id,f.stateRoot,f.receiptRoot],{env});
    assert.equal(JSON.parse(result.stdout).phase,'prepared');
    assert.ok(!result.stdout.includes('SYNTHETIC_LOCAL_JOB'));
    const status=await exec(process.execPath,[cli,'status',f.id,f.stateRoot],{env});
    assert.deepEqual(JSON.parse(status.stdout),JSON.parse(result.stdout));
    await assert.rejects(exec(process.execPath,[cli,'run',f.id,f.stateRoot],{env}),e=>e.stderr.trim()==='RESULT: LOCAL_JOB_FAILED');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('the local CLI reads a candidate from stdin and returns only pending job metadata',async()=>{
  const root=await mkdtemp(join(tmpdir(),'candidate-cli-')),actions=process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_ACTIONS;
  try{
    const f=await makeLocalReceipt(root),env={...process.env,GITHUB_ACTIONS:''};
    const prepared=JSON.parse((await exec(process.execPath,[cli,'prepare',f.id,f.stateRoot,f.receiptRoot],{env})).stdout);
    const {diskSnapshot}=await diskCheckFixture(root,{context:prepared.context});
    const {publicKey}=recipientKey('SYNTHETIC_CLI',prepared.context);
    const args=[cli,'submit-candidate',f.id,f.stateRoot,join(root,'cache'),diskSnapshot.baseSha,publicKey];
    const baselineStatus=JSON.parse((await exec(process.execPath,[resolve('scripts/disk-baseline-cli.mjs'),'status',join(root,'cache'),diskSnapshot.baseSha],{env})).stdout);
    assert.equal(baselineStatus.baselineManifestSha256,diskSnapshot.manifestSha256);
    const input=JSON.stringify({schemaVersion:1,runId:prepared.context.runId,baselineManifestSha256:baselineStatus.baselineManifestSha256,
      files:[{path:'src/status.ts',content:'export const n=4; // SYNTHETIC_CLI_CANDIDATE'}]});
    const blocked=spawnSync(process.execPath,args,{env:{...env,GITHUB_ACTIONS:'true'},input,encoding:'utf8',timeout:6000});
    assert.equal(blocked.status,1);
    const accepted=spawnSync(process.execPath,args,{env,input,encoding:'utf8',timeout:6000});
    assert.equal(accepted.status,0,accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout).phase,'awaiting-independent-validation');
    assert.doesNotMatch(accepted.stdout,/SYNTHETIC_CLI_CANDIDATE/);
  }finally{
    if(actions!==undefined)process.env.GITHUB_ACTIONS=actions;
    await rm(root,{recursive:true,force:true});
  }
});
