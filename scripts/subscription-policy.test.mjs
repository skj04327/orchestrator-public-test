import test from 'node:test';
import assert from 'node:assert/strict';
import {assessSubscriptionCi,assertSubscriptionCi} from './subscription-policy.mjs';
import {mkdtemp,mkdir,writeFile,readFile,chmod,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const current={repository:'skj04327/orchestrator-public-test',visibility:'public',providers:['claude','codex','agy']};
test('public Codex account CI is denied using official guidance even if flags claim approval',()=>{
  const report=assessSubscriptionCi({...current,approved:true,freeStorageConfirmed:true});
  assert.equal(report.allowed,false);
  assert.ok(report.reasons.includes('CODEX_ACCOUNT_AUTH_PUBLIC_CI_DISALLOWED'));
  assert.ok(report.reasons.includes('AGY_SUBSCRIPTION_CI_UNVERIFIED'));
  assert.throws(()=>assertSubscriptionCi(current),{code:'SUBSCRIPTION_CI_BLOCKED'});
  assert.equal(assessSubscriptionCi({...current,visibility:'private'}).allowed,false);
});
test('trusted host refuses public subscription execution before Docker or artifact writes',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'subscription-denial-')),entry=resolve('scripts/run-protected-task.mjs');
  try{
    for(const name of ['bin','private-game','task-private'])await mkdir(join(dir,name));
    const log=join(dir,'docker-calls'),output=join(dir,'github-output');await writeFile(log,'');await writeFile(output,'');
    const shim=join(dir,'bin','docker');
    await writeFile(shim,`#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(log)},'CALLED');process.exit(1);\n`);await chmod(shim,0o755);
    const encoded=Buffer.from('{"fixture":"auth"}').toString('base64');
    const env={...process.env,PATH:join(dir,'bin')+':'+process.env.PATH,
      GITHUB_REPOSITORY:current.repository,ORCHESTRATOR_REPOSITORY_VISIBILITY:'public',
      GITHUB_RUN_ID:'84',GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:'c'.repeat(40),TASK_ID:'20261116T110000Z-123-456',
      GITHUB_OUTPUT:output,RUNNER_TEMP:dir,ORCHESTRATOR_WORKER_IMAGE_ID:'sha256:'+'a'.repeat(64),
      CODEX_AUTH_JSON_B64:encoded,ANTIGRAVITY_OAUTH_B64:encoded,CLAUDE_CODE_OAUTH_TOKEN:'SYNTHETIC_SECRET',
      PRIVATE_GAME_WRITE_TOKEN:''};
    const execute=promisify(execFile);
    await assert.rejects(execute(process.execPath,[entry],{cwd:dir,env}),error=>{
      assert.equal(error.code,1);assert.ok(!error.stderr.includes('SYNTHETIC_SECRET'));return true;
    });
    assert.equal(await readFile(log,'utf8'),'','Denied subscription must not invoke Docker');
    assert.equal(await readFile(output,'utf8'),'','Denied subscription must not mark an artifact ready');
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('unknown context/provider or private account lifecycle cannot silently pass',()=>{
  for(const context of [
    {...current,visibility:'unknown'}, {...current,providers:['claude','imaginary']},
    {...current,providers:[]}, {...current,repository:'other/private',visibility:'private',providers:['codex']}
  ])assert.equal(assessSubscriptionCi(context).allowed,false);
  const report=assessSubscriptionCi({...current,repository:'other/private',visibility:'private',providers:['codex']});
  assert.ok(report.reasons.includes('CODEX_CI_AUTH_LIFECYCLE_UNVERIFIED'));
  assert.ok(!JSON.stringify(report).includes('secret-value'));
});
