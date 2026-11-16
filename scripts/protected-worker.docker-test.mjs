// Explicit real-Docker attack suite, not a mocked Docker CLI. No skip fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {runProtectedTask} from './protected-worker.mjs';
import {recipientKey,open} from './private-handoff.mjs';
const context={repository:'skj04327/orchestrator-public-test',taskId:'20261116T110000Z-123-456',runId:'84',runAttempt:'1',workflowSha:'c'.repeat(40)};
const imageId=process.env.ORCHESTRATOR_TEST_IMAGE;
if(!/^sha256:[a-f0-9]{64}$/.test(imageId||''))throw Error('Real Docker fixture image ID is required');
const recipient=recipientKey('SYNTHETIC_PUBLISHER_SECRET',context);
async function fixture(mode){
  const root=await mkdtemp(join(tmpdir(),'protected-worker-'));
  const control=join(root,'control');
  await cp(resolve('scripts'),control,{recursive:true});
  const game=join(root,'game'),queue=join(root,'queue');
  await mkdir(game);await mkdir(queue);
  await writeFile(join(game,'input.txt'),'SYNTHETIC_PRIVATE_INPUT');
  await writeFile(join(control,'execute-private-task.mjs'),await readFile('scripts/test-fixtures/hostile-worker.mjs','utf8'));
  await writeFile(join(queue,'mode.txt'),mode);
  return {root,control,game,queue};
}
async function run(mode,options={}){
  const f=await fixture(mode);
  try{
    const result=await runProtectedTask({imageId,context,controlDir:f.control,gameDir:f.game,queueDir:f.queue,
      publicKey:recipient.publicKey,auth:{claude:'SYNTHETIC_SUBSCRIPTION_SECRET'},network:'none',timeoutMs:15000,...options});
    // Host exporter file was never visible to any worker.
    assert.equal((await readFile(join(f.control,'seal-private-task.mjs'),'utf8')).includes('captureBundle'),true);
    // Independent daemon observation, not the supervisor's returned removed flag.
    const exec=promisify(execFile);
    for(const args of [
      ['ps','-a','--filter','label=orchestrator.protected-worker=true','--format','{{.Names}}'],
      ['volume','ls','--filter','label=orchestrator.protected-worker=true','--format','{{.Name}}']
    ])assert.equal((await exec('docker',args,{env:{PATH:process.env.PATH}})).stdout.trim(),'','Disposable Docker resources remain');
    return {...result,bundle:open(result.encrypted,recipient.privateKey,context)};
  }finally{await rm(f.root,{recursive:true,force:true});}
}
test('real Docker denies exporter/host/socket/control-token access and stops delayed writers before sealing',async()=>{
  // Host-only sentinels must not enter container env. Real auth sentinel is allowed only in /input.
  process.env.PRIVATE_GAME_WRITE_TOKEN='SYNTHETIC_HOST_WRITE_TOKEN';
  process.env.GITHUB_OUTPUT='/host-only-output';process.env.ACTIONS_RUNTIME_TOKEN='SYNTHETIC_ACTIONS_TOKEN';
  process.env.HANDOFF_PUBLIC_KEY=recipient.publicKey;
  try{
    const result=await run('attacks');
    assert.equal(result.executionOutcome,'success',result.failureKind);
    assert.equal(result.bundle.result.paths[0],'src/result.ts');
    const code=Buffer.from(result.bundle.files[0].content,'base64').toString();
    assert.match(code,/ALL_BOUNDARIES_DENIED/);
    assert.ok(!code.includes('DELAYED_WRITER'));
    assert.ok(!result.encrypted.includes(Buffer.from('SYNTHETIC_PRIVATE_INPUT')));
    assert.equal(result.removed,true);
  }finally{delete process.env.PRIVATE_GAME_WRITE_TOKEN;delete process.env.GITHUB_OUTPUT;delete process.env.ACTIONS_RUNTIME_TOKEN;delete process.env.HANDOFF_PUBLIC_KEY;}
});
test('real Docker rejects result symlink and directory substitution before source export',async()=>{
  for(const mode of ['symlink','directory']){
    const result=await run(mode);
    assert.equal(result.executionOutcome,'failure');
    assert.equal(result.bundle.result,null);assert.deepEqual(result.bundle.files,[]);
    assert.equal(result.removed,true);
  }
});
test('real Docker output exhaustion and timeout kill the container and return only encrypted failure metadata',async()=>{
  for(const [mode,options,kind] of [
    ['flood',{outputLimit:4096},'output_limit'],['hang',{timeoutMs:1000},'timeout']
  ]){
    const result=await run(mode,options);
    assert.equal(result.executionOutcome,'failure');assert.equal(result.failureKind,kind);
    assert.equal(result.bundle.result,null);assert.equal(result.removed,true);
  }
});
