import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {makeLocalReceipt} from './test-fixtures/local-receipt.mjs';
const exec=promisify(execFile);
test('actual independent CLI reports status only, refuses run and Actions without accepting keys',async()=>{
  const root=await mkdtemp(join(tmpdir(),'independent-cli-'));
  try{
    const f=await makeLocalReceipt(root),env={...process.env,GITHUB_ACTIONS:''};
    await exec(process.execPath,[resolve('scripts/local-job-cli.mjs'),'prepare',f.id,f.stateRoot,f.receiptRoot],{env});
    const cli=resolve('scripts/independent-check-cli.mjs');
    const status=await exec(process.execPath,[cli,'status',f.id,f.stateRoot],{env});
    assert.deepEqual(JSON.parse(status.stdout),{taskId:f.id,phase:'not-started',publishAuthorized:false});
    for(const [command,runEnv]of [['run',env],['status',{...env,GITHUB_ACTIONS:'true'}]])
      await assert.rejects(exec(process.execPath,[cli,command,f.id,f.stateRoot],{env:runEnv}),e=>e.stderr.trim()==='RESULT: INDEPENDENT_CHECK_STATUS_FAILED');
  }finally{await rm(root,{recursive:true,force:true});}
});
