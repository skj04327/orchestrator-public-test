import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {watch} from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {prepareLocalJob,runPreparedLocalJob,readLocalJob} from './local-jobs.mjs';
import {makeLocalReceipt} from './test-fixtures/local-receipt.mjs';
import {recipientKey,seal} from './private-handoff.mjs';
// Only synthetic in-process fixtures simulate a local host; production guards stay on.
const actions=process.env.GITHUB_ACTIONS;
before(()=>{delete process.env.GITHUB_ACTIONS;});
after(()=>{if(actions===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=actions;});
test('prepared job owns a fresh input snapshot and rejects duplicate preparation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'local-job-'));
  try{
    const f=await makeLocalReceipt(root),job=await prepareLocalJob(f);
    assert.equal(job.phase,'prepared');assert.equal(job.context.kind,'local');
    assert.equal(await readFile(join(f.stateRoot,f.id,'input','task-private',f.path),'utf8'),'SYNTHETIC_LOCAL_JOB');
    await assert.rejects(prepareLocalJob(f));
    assert.ok(!JSON.stringify(job).includes('SYNTHETIC_LOCAL_JOB'));
  }finally{await rm(root,{recursive:true,force:true});}
});
test('interruption after claim or running event never makes a job runnable again; invalid journals fail closed',async()=>{
  for(const mode of ['claim','running','forged']){
    const root=await mkdtemp(join(tmpdir(),'local-job-'));
    try{
      const f=await makeLocalReceipt(root),job=await prepareLocalJob(f),dir=join(f.stateRoot,f.id);
      const key=recipientKey('SYNTHETIC_SECRET',job.context);
      await writeFile(join(dir,'worker-claim.json'),JSON.stringify({runId:job.context.runId}),{mode:0o600});
      if(mode!=='claim'){
        const event=JSON.parse(await readFile(join(dir,'events','0000.json')));
        await writeFile(join(dir,'events','0001.json'),JSON.stringify({...event,sequence:1,phase:mode==='running'?'running':'awaiting-independent-validation'}),{mode:0o600});
      }
      if(mode==='forged')await assert.rejects(readLocalJob(f));
      else assert.equal((await readLocalJob(f)).phase,mode==='claim'?'needs-recovery':'running');
      let called=false;
      await assert.rejects(runPreparedLocalJob({...f,publicKey:key.publicKey,worker:async()=>{called=true;}}));
      assert.equal(called,false);
    }finally{await rm(root,{recursive:true,force:true});}
  }
});
test('failed, unconfirmed cleanup, malformed result and late cancellation cannot become a validated success',async()=>{
  for(const mode of ['failure','cleanup','malformed','cancelled']){
    const root=await mkdtemp(join(tmpdir(),'local-job-'));
    try{
      const f=await makeLocalReceipt(root),job=await prepareLocalJob(f),key=recipientKey('SYNTHETIC_SECRET',job.context);
      const abort=new AbortController();
      const worker=async({context,publicKey})=>{
        if(mode==='cancelled')abort.abort();
        return {removed:mode!=='cleanup',executionOutcome:mode==='failure'?'failure':'success',
          encrypted:mode==='malformed'?Buffer.from('PLAINTEXT'):seal({fixture:true},publicKey,context)};
      };
      if(mode==='failure')assert.equal((await runPreparedLocalJob({...f,worker,publicKey:key.publicKey})).phase,'failed');
      else{
        await assert.rejects(runPreparedLocalJob({...f,worker,publicKey:key.publicKey,signal:abort.signal}));
        assert.equal((await readLocalJob(f)).phase,'needs-recovery');
      }
      await assert.rejects(runPreparedLocalJob({...f,worker,publicKey:key.publicKey}));
    }finally{await rm(root,{recursive:true,force:true});}
  }
});
test('only one competing backend starts and reported success still awaits independent validation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'local-job-'));
  try{
    const f=await makeLocalReceipt(root),job=await prepareLocalJob(f),key=recipientKey('SYNTHETIC_LOCAL_PUBLISHER_SECRET',job.context);
    let calls=0;
    const worker=async({context,publicKey})=>{calls++;return {removed:true,executionOutcome:'success',encrypted:seal({context,fixture:true},publicKey,context)};};
    const outcomes=await Promise.allSettled([1,2].map(()=>runPreparedLocalJob({...f,worker,publicKey:key.publicKey})));
    assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(calls,1);
    assert.equal((await readLocalJob(f)).phase,'awaiting-independent-validation');
    await assert.rejects(runPreparedLocalJob({...f,worker,publicKey:key.publicKey}));
    await writeFile(join(f.stateRoot,f.id,'result.enc'),'TAMPERED');await assert.rejects(readLocalJob(f));
  }finally{await rm(root,{recursive:true,force:true});}
});
test('cancellation during encrypted-result persistence is observed before completion commit',async()=>{
  const root=await mkdtemp(join(tmpdir(),'local-job-'));let watcher;
  try{
    const f=await makeLocalReceipt(root),job=await prepareLocalJob(f),key=recipientKey('SYNTHETIC_SECRET',job.context);
    const abort=new AbortController();
    watcher=watch(join(f.stateRoot,f.id),{persistent:false},(_,name)=>{if(String(name)==='result.enc')abort.abort();});
    const worker=async({context,publicKey})=>({removed:true,executionOutcome:'success',encrypted:seal({fixture:'x'.repeat(500000)},publicKey,context)});
    await assert.rejects(runPreparedLocalJob({...f,worker,publicKey:key.publicKey,signal:abort.signal}));
    assert.equal(abort.signal.aborted,true);assert.equal((await readLocalJob(f)).phase,'needs-recovery');
  }finally{watcher?.close();await rm(root,{recursive:true,force:true});}
});
test('a host process killed after worker entry leaves a nonretryable running job',async()=>{
  const root=await mkdtemp(join(tmpdir(),'local-job-'));let child;
  try{
    const f=await makeLocalReceipt(root),job=await prepareLocalJob(f),key=recipientKey('SYNTHETIC_SECRET',job.context);
    const source=`import {runPreparedLocalJob} from ${JSON.stringify(new URL('./local-jobs.mjs',import.meta.url).href)};
      await runPreparedLocalJob({...JSON.parse(process.argv[1]),worker:async()=>{process.send('entered');await new Promise(()=>setInterval(()=>{},1000));}});`;
    child=spawn(process.execPath,['--input-type=module','--eval',source,JSON.stringify({...f,publicKey:key.publicKey})],
      {env:{...process.env,GITHUB_ACTIONS:''},stdio:['ignore','ignore','ignore','ipc']});
    const closed=once(child,'close'),entered=once(child,'message');
    const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
    try{
      await Promise.race([entered,closed.then(()=>{throw Error('Fixture exited before worker entry');})]);
      child.kill('SIGKILL');await closed;
    }finally{clearTimeout(timer);}
    assert.equal((await readLocalJob(f)).phase,'running');let called=false;
    await assert.rejects(runPreparedLocalJob({...f,publicKey:key.publicKey,worker:async()=>{called=true;}}));
    assert.equal(called,false);
  }finally{if(child?.exitCode===null)child.kill('SIGKILL');await rm(root,{recursive:true,force:true});}
});
test('changed prepared packet cannot start a worker; uncertain cleanup never becomes a retryable success',async()=>{
  for(const mode of ['tampered','uncertain']){
    const root=await mkdtemp(join(tmpdir(),'local-job-'));
    try{
      const f=await makeLocalReceipt(root),job=await prepareLocalJob(f),key=recipientKey('SYNTHETIC_SECRET',job.context);
      let called=false;
      if(mode==='tampered')await writeFile(join(f.stateRoot,f.id,'input','task-private',f.path),'CHANGED');
      const worker=async()=>{called=true;throw Error('SYNTHETIC_PRIVATE_DIAGNOSTIC');};
      await assert.rejects(runPreparedLocalJob({...f,worker,publicKey:key.publicKey}));
      const state=await readLocalJob(f);assert.ok(!JSON.stringify(state).includes('SYNTHETIC_PRIVATE_DIAGNOSTIC'));
      if(mode==='tampered'){assert.equal(called,false);assert.equal(state.phase,'prepared');}
      else{assert.equal(called,true);assert.equal(state.phase,'needs-recovery');}
    }finally{await rm(root,{recursive:true,force:true});}
  }
});
