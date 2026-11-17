import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {makeLocalReceipt} from './test-fixtures/local-receipt.mjs';
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
