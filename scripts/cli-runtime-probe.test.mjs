import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeCliProbe,CLI_PROBES,probeCliRuntime} from './cli-runtime-probe.mjs';
import {mkdtemp,mkdir,writeFile,readFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('version/help observations never assert authentication, model, tokens, cost or CI permission',()=>{
  const report=summarizeCliProbe('agy','1.5.9\n','Usage: agy -p --print --output-format --sandbox');
  assert.equal(report.cliVersion,'1.5.9');
  assert.equal(report.flags['-p'],true);
  assert.equal(report.authenticated,false);assert.equal(report.inferenceAttempted,false);
  assert.equal(report.modelId,null);assert.equal(report.tokenUsage,null);assert.equal(report.cost,null);
  assert.equal(report.subscriptionCiApproved,false);
  assert.deepEqual(CLI_PROBES.codex.helpArgs,['exec','--help']);
  assert.throws(()=>summarizeCliProbe('other','1.0',''));
  assert.throws(()=>summarizeCliProbe('codex','secret\nsecond line',''));
  assert.equal(summarizeCliProbe('codex','codex-cli 0.169.0','--sandbox-extra').flags['--sandbox'],false);
});
test('help on stderr is observed and cancellation still removes the active container',async()=>{
  for(const mode of ['stderr','cancel']){
    const dir=await mkdtemp(join(tmpdir(),'cli-probe-contract-')),log=join(dir,'calls'),state=join(dir,'state');
    const original=process.env.PATH;let poll;
    try{
      await mkdir(join(dir,'bin'));await writeFile(log,'');
      const shim=`#!/usr/bin/env node
import {appendFileSync,writeFileSync,readFileSync} from 'node:fs';
const a=process.argv.slice(2);appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
if(a[0]==='create')writeFileSync(${JSON.stringify(state)},a.includes('--version')?'version':'help');
if(a[0]==='inspect')console.log(JSON.stringify({Running:false,ExitCode:0}));
if(a[0]==='start'){
 if(${JSON.stringify(mode)}==='cancel')setInterval(()=>{},1000);
 else if(readFileSync(${JSON.stringify(state)},'utf8')==='version')console.log('1.5.9');
 else process.stderr.write('Usage of agy: -p --print --output-format --sandbox');
}
`;
      const path=join(dir,'bin','docker');await writeFile(path,shim);await chmod(path,0o755);process.env.PATH=join(dir,'bin')+':'+original;
      const controller=new AbortController();
      if(mode==='cancel')poll=setInterval(async()=>{
        try{if((await readFile(log,'utf8')).includes('"start"'))controller.abort();}catch{}
      },20);
      const operation=probeCliRuntime('sha256:'+'a'.repeat(64),{clis:['agy'],signal:controller.signal});
      if(mode==='cancel')await assert.rejects(operation);
      else assert.ok(Object.values((await operation).results[0].flags).every(Boolean));
      clearInterval(poll);
      const calls=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(calls.at(-1)[0],'rm','Cleanup must run after cancellation, without aborted signal');
    }finally{clearInterval(poll);process.env.PATH=original;await rm(dir,{recursive:true,force:true});}
  }
});
test('unknown CLI/image/volume or extra commands fail before Docker',async()=>{
  for(const options of [{clis:[]},{clis:['codex exec prompt']},{clis:['agy','agy']},{publicVolume:'../../private'}])
    await assert.rejects(probeCliRuntime('sha256:'+'a'.repeat(64),options));
  await assert.rejects(probeCliRuntime('latest'));
  await assert.rejects(probeCliRuntime('sha256:'+'a'.repeat(64),{signal:AbortSignal.abort()}));
});
