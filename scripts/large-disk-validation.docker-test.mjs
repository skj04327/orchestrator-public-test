// Real Docker/npm, only synthetic Git source and encrypted synthetic worker output.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {makeLocalReceipt} from './test-fixtures/local-receipt.mjs';
import {prepareLocalJob,runPreparedLocalJob,readLocalJob} from './local-jobs.mjs';
import {recipientKey,seal} from './private-handoff.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import * as stageRunner from './disk-baseline-check.mjs';
import * as independent from './local-independent-checks.mjs';
import {captureDiskCheckInput} from './disk-check-input.mjs';
import {diskCheckFixture,encoded} from './test-fixtures/disk-check.mjs';
const actions=process.env.GITHUB_ACTIONS,imageId=process.env.ORCHESTRATOR_TEST_IMAGE;
if(!/^sha256:[a-f0-9]{64}$/.test(imageId||''))throw Error('Actual local image required');
before(()=>{delete process.env.GITHUB_ACTIONS;});after(()=>{if(actions===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=actions;});
async function fixture(root,options={}){
  const f=await diskCheckFixture(root,{extra:[encoded('public/고려 지도.bin',Buffer.alloc(40*1024*1024,7))],...options});
  return f;
}
test('candidate archive reaches a fresh real Docker stage with captured bytes and unchanged large assets',async()=>{
  assert.equal(typeof stageRunner.runDiskCheckStage,'function');const root=await mkdtemp(join(tmpdir(),'disk-candidate-real-'));
  try{
    const f=await fixture(root),input=captureDiskCheckInput(f);f.bundle.files[0].content=Buffer.from('export const n=;').toString('base64');
    const report=await stageRunner.runDiskCheckStage({checkInput:input,imageId,stage:'typecheck',variant:'candidate',timeoutMs:30000});
    assert.equal(report.status,'passed');assert.equal(report.variant,'candidate');assert.equal(report.candidateContentSha256,input.candidateContentSha256);assert.equal(report.publishAuthorized,false);
  }finally{await rm(root,{recursive:true,force:true});}
});

function lifecycleProject(baseline){
  const replace=(path,b)=>{const old=baseline.files.find(f=>f.path===path);if(old)old.content=Buffer.from(b).toString('base64');else baseline.files.push(encoded(path,b));};
  const pkg=JSON.parse(Buffer.from(baseline.files.find(f=>f.path==='package.json').content,'base64'));
  pkg.scripts={postinstall:'node install.cjs',typecheck:'node stage.cjs typecheck',test:'node stage.cjs unit-test',build:'node stage.cjs build'};
  replace('package.json',JSON.stringify(pkg));replace('install.cjs',"require('fs').writeFileSync('npm-installed','yes')");
  const hash=createHash('sha256').update(Buffer.alloc(40*1024*1024,7)).digest('hex');
  replace('stage.cjs',`
const fs=require('fs'),assert=require('assert/strict'),{spawnSync}=require('child_process'),{createHash}=require('crypto'),stage=process.argv[2];
assert.equal(stage,fs.readFileSync('/proc/1/cmdline','utf8').split('\\0')[2]);
assert.equal(process.env.npm_lifecycle_event,{'typecheck':'typecheck','unit-test':'test','build':'build'}[stage]);
assert.deepEqual(process.argv.slice(3),stage==='unit-test'?['--reporter=dot']:[]);
assert.equal(fs.readFileSync('npm-installed','utf8'),'yes');assert.equal(fs.existsSync('stage-marker'),false);
assert.equal(createHash('sha256').update(fs.readFileSync('public/고려 지도.bin')).digest('hex'),${JSON.stringify(hash)});
assert.equal(process.getuid(),1000);for(const k of ['GITHUB_TOKEN','PRIVATE_GAME_WRITE_TOKEN','OPENAI_API_KEY','LOCAL_DECRYPTION_KEY'])assert.equal(process.env[k],undefined);
assert.throws(()=>fs.writeFileSync('/input/manifest.json','FORGED'));
let result;
if(stage==='typecheck')result=spawnSync(process.execPath,['--check','src/status.ts'],{stdio:'inherit'});
else if(stage==='unit-test')result=spawnSync(process.execPath,['--test',...fs.readdirSync('tests',{recursive:true}).filter(p=>p.endsWith('.test.ts')).map(p=>'tests/'+p)],{stdio:'inherit'});
else if(stage==='build'){fs.mkdirSync('dist');fs.copyFileSync('src/status.ts','dist/status.js');result={status:0};}
else throw Error('Unexpected mapping');
fs.writeFileSync('stage-marker','previous');fs.writeFileSync('src/status.ts','BROKEN_BY_PREVIOUS_STAGE');process.exitCode=result.status??1;
`);
}
async function localFixture(root,options){
  const f=await makeLocalReceipt(root),job=await prepareLocalJob(f),source=await fixture(root,{context:job.context,transform:lifecycleProject,...options}),key=recipientKey('SYNTHETIC_LOCAL_KEY',job.context);
  await runPreparedLocalJob({...f,publicKey:key.publicKey,worker:async()=>({removed:true,executionOutcome:'success',encrypted:seal(source.bundle,key.publicKey,job.context)})});
  return {...f,context:job.context,diskSnapshot:source.snapshot,privateKey:key.privateKey};
}
async function noResources(){for(const a of [['ps','-a','--filter','label=orchestrator.disk-baseline-check=true','--format','{{.Names}}'],['volume','ls','--filter','label=orchestrator.disk-baseline-check=true','--format','{{.Name}}']])assert.equal((await promisify(execFile)('docker',a,{env:{PATH:process.env.PATH}})).stdout.trim(),'');}
test('one shared claim runs six fresh large-disk checks with exact npm lifecycle/args and private schema2 report',async()=>{
  const root=await mkdtemp(join(tmpdir(),'disk-six-real-'));
  try{
    const f=await localFixture(root),options={...f,imageId,timeoutMs:30000},competing=await Promise.allSettled([independent.runLargeDiskIndependentChecks(options),independent.runLargeDiskIndependentChecks(options)]);
    assert.equal(competing.filter(r=>r.status==='fulfilled').length,1);
    const report=competing.find(r=>r.status==='fulfilled').value;
    assert.equal(report.schemaVersion,2);assert.equal(report.inputProfile,'disk-v1');assert.equal(report.phase,'checks-passed-awaiting-review');assert.equal(report.review,'not-run');assert.equal(report.publishAuthorized,false);assert.equal(report.checks.length,6);assert.ok(report.checks.every(r=>r.status==='passed'&&r.removed));
    assert.equal(report.baselineManifestSha256,f.diskSnapshot.manifestSha256);assert.equal((await readLocalJob(f)).phase,'awaiting-independent-validation');
    await assert.rejects(independent.runLargeDiskIndependentChecks(options),e=>e.code==='EEXIST');await noResources();
    const path=join(f.stateRoot,f.id,'independent-report.json'),raw=await readFile(path,'utf8');assert.ok(!raw.includes('export const'));assert.ok(!raw.includes('SYNTHETIC_LOCAL_KEY'));
    const bad=structuredClone(report);bad.checks[0].variant='candidate';await writeFile(path,JSON.stringify(bad));await assert.rejects(independent.readIndependentCheckStatus(f));
    await writeFile(path,raw);
    const cli=await promisify(execFile)(process.execPath,['scripts/independent-check-cli.mjs','status',f.id,f.stateRoot],{env:{...process.env,GITHUB_ACTIONS:''}});assert.equal(JSON.parse(cli.stdout).inputProfile,'disk-v1');
  }finally{await rm(root,{recursive:true,force:true});}
});
test('baseline or candidate command failure still compares all six stages and forged worker audit never grants pass',async()=>{
  for(const mode of ['baselineFails','candidateFails']){
    const root=await mkdtemp(join(tmpdir(),'disk-six-fail-'));
    try{
      const f=await localFixture(root,{[mode]:true}),report=await independent.runLargeDiskIndependentChecks({...f,imageId,timeoutMs:30000});
      assert.equal(report.phase,'checks-failed');assert.equal(report.publishAuthorized,false);assert.equal(report.checks.length,6);
      const bad=report.checks.filter(r=>r.status==='failed');assert.equal(bad.length,1);assert.equal(bad[0].stage,'unit-test');assert.equal(bad[0].variant,mode==='baselineFails'?'baseline':'candidate');await noResources();
    }finally{await rm(root,{recursive:true,force:true});}
  }
});
