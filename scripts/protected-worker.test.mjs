import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runProtectedTask} from './protected-worker.mjs';
import {recipientKey} from './private-handoff.mjs';
const context={repository:'skj04327/orchestrator-public-test',taskId:'20261116T110000Z-123-456',runId:'84',runAttempt:'1',workflowSha:'c'.repeat(40)};
test('Docker ambiguous creation and cleanup failure still attempt every registered resource and block handoff',async()=>{
  for(const mode of ['pre-aborted','cancel-setup','cancel-capture','ambiguous-create','cleanup-fails','input-init-fails']){
    const dir=await mkdtemp(join(tmpdir(),'docker-lifecycle-')),log=join(dir,'calls.jsonl');
    const originalPath=process.env.PATH;
    try{
      for(const name of ['bin','control','game','queue'])await mkdir(join(dir,name));
      await writeFile(log,'');
      // Docker fault simulator only: daemon accepted create, CLI loses response;
      // or a removal request fails. No real source, secrets or network are involved.
      const shim=`#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
const a=process.argv.slice(2);appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
const mode=${JSON.stringify(mode)};
if(mode==='cancel-setup'&&a[0]==='cp'){setTimeout(()=>process.exit(0),5000);}
else if(mode==='cancel-capture'&&a[0]==='cp'&&a[1].includes(':')){setTimeout(()=>process.exit(0),5000);}
else if(['ambiguous-create','cleanup-fails'].includes(mode)&&a[0]==='cp')process.exit(1);
else if(mode==='ambiguous-create'&&a[0]==='create')process.exit(1);
else if(mode==='cleanup-fails'&&a[0]==='rm')process.exit(1);
else if(a[0]==='inspect'){console.log(JSON.stringify({Running:false,Paused:false,Restarting:false,ExitCode:mode==='input-init-fails'?1:0}));}
else process.exit(0);
`;
      await writeFile(join(dir,'bin','docker'),shim);await chmod(join(dir,'bin','docker'),0o755);
      process.env.PATH=join(dir,'bin')+':'+originalPath;
      const controller=new AbortController();
      let poll;
      if(mode.startsWith('cancel-'))poll=setInterval(async()=>{
        const rows=(await readFile(log,'utf8')).split('\n').filter(Boolean).map(JSON.parse);
        if(rows.some(a=>a[0]==='cp'&&(mode==='cancel-setup'||a[1].includes(':'))))controller.abort();
      },20);
      const operation=()=>runProtectedTask({imageId:'sha256:'+'a'.repeat(64),context,
        controlDir:join(dir,'control'),gameDir:join(dir,'game'),queueDir:join(dir,'queue'),
        signal:mode==='pre-aborted'?AbortSignal.abort():controller.signal,
        publicKey:recipientKey('synthetic-secret',context).publicKey});
      if(['ambiguous-create','input-init-fails'].includes(mode)){
        // Reconciled cleanup may return encrypted failure metadata, never successful source.
        const result=await operation();assert.equal(result.executionOutcome,'failure');
        if(mode==='input-init-fails')assert.equal(result.failureKind,'input_setup_failed');
      }else try{await assert.rejects(operation());}finally{clearInterval(poll);}
      const calls=(await readFile(log,'utf8')).split('\n').filter(Boolean).map(JSON.parse);
      if(mode==='input-init-fails')assert.ok(!calls.some(a=>a[0]==='create'&&!a.includes('--cap-add')),'Initializer failure must prevent worker creation');
      if(mode==='pre-aborted'){assert.equal(calls.length,0,'Cancelled task must not create or start resources');continue;}
      assert.ok(calls.some(a=>a[0]==='rm'&&a.at(-1).endsWith('-seed')),'Ambiguous seed create must be removed');
      assert.equal(calls.filter(a=>a[0]==='volume'&&a[1]==='rm').length,3,'All volume removals must be attempted');
    }finally{process.env.PATH=originalPath;await rm(dir,{recursive:true,force:true});}
  }
});
