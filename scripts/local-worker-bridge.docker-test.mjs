// Explicit synthetic local-host → real Docker bridge; no provider login/network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {makeLocalReceipt} from './test-fixtures/local-receipt.mjs';
import {prepareLocalJob,runPreparedLocalJob,readLocalJob} from './local-jobs.mjs';
import {runProtectedTask,INPUT_OWNERSHIP_SCRIPT} from './protected-worker.mjs';
import {recipientKey,open} from './private-handoff.mjs';
import {validateBundle} from './private-task-bundle.mjs';
const imageId=process.env.ORCHESTRATOR_TEST_IMAGE;
if(!/^sha256:[a-f0-9]{64}$/.test(imageId||''))throw Error('Real Docker fixture image ID is required');
test('trusted volume initializer preserves private modes across UID mismatch and refuses symlinks',async()=>{
  const volume='orch-uid-fixture-'+randomUUID(),controlVolume=volume+'-control',exec=promisify(execFile);
  const docker=(args)=>exec('docker',args,{env:{PATH:process.env.PATH},timeout:30000});
  const setup=`const f=require('node:fs');
    for(const p of ['/input/private-game','/input/task-private','/opt/control']){
      f.mkdirSync(p,{recursive:true,mode:0o700});f.chmodSync(p,0o700);
      f.writeFileSync(p+'/fixture.txt','SYNTHETIC_UID',{mode:0o600});
      f.chownSync(p,1001,1001);f.chownSync(p+'/fixture.txt',1001,1001);
    }`;
  try{
    await docker(['volume','create',volume]);
    await docker(['volume','create',controlVolume]);
    const base=['run','--rm','--pull=never','--network','none',
      '--mount','type=volume,source='+volume+',target=/input',
      '--mount','type=volume,source='+controlVolume+',target=/opt/control'];
    await docker([...base,'--user','0:0',imageId,'node','-e',setup]);
    await assert.rejects(docker([...base,'--user','1000:1000',imageId,'node','-e',"require('fs').readFileSync('/input/task-private/fixture.txt')"]),e=>e.stderr.includes('EACCES'));
    await docker([...base,'--user','0:0','--cap-drop','ALL','--cap-add','CHOWN','--cap-add','DAC_OVERRIDE',
      '--security-opt','no-new-privileges',imageId,'node','-e',"require('fs').mkdirSync('/opt/control',{recursive:true});"+INPUT_OWNERSHIP_SCRIPT]);
    const verify=`const f=require('node:fs'),a=require('node:assert/strict');a.equal(process.getuid(),1000);
      for(const p of ['/input/private-game','/input/task-private','/opt/control']){
        a.equal(f.statSync(p).mode&511,448);a.equal(f.statSync(p).uid,1000);
        a.equal(f.statSync(p+'/fixture.txt').mode&511,384);a.equal(f.statSync(p+'/fixture.txt').uid,1000);
        a.equal(f.readFileSync(p+'/fixture.txt','utf8'),'SYNTHETIC_UID');
      }`;
    await docker([...base,'--user','1000:1000',imageId,'node','-e',verify]);
    await docker([...base,'--user','0:0',imageId,'node','-e',"require('fs').symlinkSync('/opt/control','/input/task-private/link')"]);
    await assert.rejects(docker([...base,'--user','0:0','--cap-drop','ALL','--cap-add','CHOWN','--cap-add','DAC_OVERRIDE',
      '--security-opt','no-new-privileges',imageId,'node','-e',"require('fs').mkdirSync('/opt/control',{recursive:true});"+INPUT_OWNERSHIP_SCRIPT]),e=>e.stderr.includes('Unsupported input node'));
  }finally{await docker(['volume','rm',volume,controlVolume]);}
});
test('received input reaches a disposable Docker worker; encrypted local-context result stays pending independent validation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'local-bridge-')),actions=process.env.GITHUB_ACTIONS;
  // This public no-secret test simulates a local host only for the synthetic fixture.
  delete process.env.GITHUB_ACTIONS;
  try{
    const f=await makeLocalReceipt(root),job=await prepareLocalJob(f);
    const key=recipientKey('SYNTHETIC_LOCAL_PUBLISHER_SECRET',job.context);
    const control=join(root,'control'),game=join(root,'game');
    await cp(resolve('scripts'),control,{recursive:true});await mkdir(game);
    await writeFile(join(game,'input.txt'),'SYNTHETIC_PRIVATE_INPUT');
    const source=await readFile('scripts/test-fixtures/hostile-worker.mjs','utf8');
    const modeLine="const mode=(await readFile('/work/task-private/mode.txt','utf8')).trim();";
    assert.ok(source.includes(modeLine));
    const verify="if((await readFile('/work/task-private/"+f.path+"','utf8'))!=='SYNTHETIC_LOCAL_JOB')process.exit(92);\n";
    await writeFile(join(control,'execute-private-task.mjs'),source.replace(modeLine,"const mode='attacks';\n"+verify));
    const worker=({context,routing,queueDir,publicKey,signal})=>runProtectedTask({imageId,controlDir:control,gameDir:game,
      queueDir,context,publicKey,signal,auth:{},network:'none',timeoutMs:15000,routingMode:routing.mode,controller:routing.controller});
    const state=await runPreparedLocalJob({...f,worker,publicKey:key.publicKey});
    assert.equal(state.phase,'awaiting-independent-validation');
    const encrypted=await readFile(join(f.stateRoot,f.id,'result.enc'));
    assert.ok(!encrypted.includes(Buffer.from('SYNTHETIC_PRIVATE_INPUT')));
    const bundle=open(encrypted,key.privateKey,job.context);validateBundle(bundle,job.context);
    assert.equal(bundle.executionOutcome,'success');assert.equal(bundle.files[0].path,'src/result.ts');
    assert.match(Buffer.from(bundle.files[0].content,'base64').toString(),/ALL_BOUNDARIES_DENIED/);
    assert.deepEqual(await readLocalJob(f),state);
    const exec=promisify(execFile);
    for(const args of [
      ['ps','-a','--filter','label=orchestrator.protected-worker=true','--format','{{.Names}}'],
      ['volume','ls','--filter','label=orchestrator.protected-worker=true','--format','{{.Name}}']
    ])assert.equal((await exec('docker',args,{env:{PATH:process.env.PATH}})).stdout.trim(),'');
  }finally{
    if(actions===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=actions;
    await rm(root,{recursive:true,force:true});
  }
});
