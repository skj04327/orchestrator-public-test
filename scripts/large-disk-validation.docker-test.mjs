// Real Docker/npm, only synthetic Git source and encrypted synthetic worker output.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
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
import {prepareOfflineNpmDependencies} from './offline-npm-runtime.mjs';
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

function lifecycleProject(baseline,dependencies=[],projected=false){
  const replace=(path,b)=>{const old=baseline.files.find(f=>f.path===path);if(old)old.content=Buffer.from(b).toString('base64');else baseline.files.push(encoded(path,b));};
  const pkg=JSON.parse(Buffer.from(baseline.files.find(f=>f.path==='package.json').content,'base64'));
  pkg.scripts={postinstall:'node install.cjs',typecheck:'node stage.cjs typecheck',test:'node stage.cjs unit-test',build:'node stage.cjs build'};
  if(dependencies.length){
    pkg.dependencies=Object.fromEntries(dependencies.map(dep=>[dep.name,'1.0.0']));
    const lock=JSON.parse(Buffer.from(baseline.files.find(f=>f.path==='package-lock.json').content,'base64'));
    lock.packages[''].dependencies=pkg.dependencies;
    for(const dep of dependencies)lock.packages['node_modules/'+dep.name]={version:'1.0.0',resolved:'https://registry.npmjs.org/'+dep.name+'/-/'+dep.name+'-1.0.0.tgz',integrity:dep.integrity,hasInstallScript:true};
    replace('package-lock.json',JSON.stringify(lock));
  }
  replace('package.json',JSON.stringify(pkg));replace('install.cjs',"require('fs').writeFileSync('npm-installed','yes')");
  const hash=createHash('sha256').update(Buffer.alloc(40*1024*1024,7)).digest('hex');
  replace('stage.cjs',`
const fs=require('fs'),assert=require('assert/strict'),{spawnSync}=require('child_process'),{createHash}=require('crypto'),stage=process.argv[2];
assert.equal(stage,fs.readFileSync('/proc/1/cmdline','utf8').split('\\0')[2]);
assert.equal(process.env.npm_lifecycle_event,{'typecheck':'typecheck','unit-test':'test','build':'build'}[stage]);
assert.deepEqual(process.argv.slice(3),stage==='unit-test'?['--reporter=dot']:[]);
for(const name of ${JSON.stringify(dependencies.map(dep=>dep.name))}){
  assert.equal(require(name),name);
  assert.equal(fs.readFileSync('node_modules/'+name+'/install-marker','utf8'),'ci');
  assert.throws(()=>fs.writeFileSync('/input/npm-dependency-0.tgz','FORGED'));
}
if(${projected})assert.equal(fs.existsSync('.codex/config.toml'),false);
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
async function syntheticTarballs(root){
  const tarballRoot=join(root,'packages');
  await mkdir(tarballRoot,{mode:0o700});
  const dependencies=[];
  for(const name of ['synthetic-offline-a','synthetic-offline-b']){
    const pkgRoot=join(root,name);
    await mkdir(join(pkgRoot,'package'),{recursive:true,mode:0o700});
    await writeFile(join(pkgRoot,'package','package.json'),JSON.stringify({name,version:'1.0.0',scripts:{postinstall:'node install.cjs'}}));
    await writeFile(join(pkgRoot,'package','index.js'),'module.exports='+JSON.stringify(name));
    await writeFile(join(pkgRoot,'package','install.cjs'),"if(process.env.npm_command!=='ci')process.exit(17);require('fs').writeFileSync('install-marker','ci')");
    const {stdout}=await promisify(execFile)('tar',['-czf','-','-C',pkgRoot,'package'],{encoding:'buffer',env:{PATH:process.env.PATH}});
    const checksum=createHash('sha512').update(stdout).digest();
    await writeFile(join(tarballRoot,checksum.toString('hex')+'.tgz'),stdout,{mode:0o600});
    dependencies.push({name,integrity:'sha512-'+checksum.toString('base64')});
  }
  return {tarballRoot,dependencies};
}
async function localFixture(root,options={}){
  const {withDependencies,projected=false,...projectOptions}=options;
  const packages=withDependencies?await syntheticTarballs(root):null;
  const f=await makeLocalReceipt(root),job=await prepareLocalJob(f);
  const source=await fixture(root,{context:job.context,purpose:projected?'checks-projected':'checks',transform:baseline=>{
    lifecycleProject(baseline,packages?.dependencies,projected);
    if(projected)baseline.files.push(encoded('.codex/config.toml','SYNTHETIC_EXCLUDED_CONFIG'));
  },...projectOptions});
  const key=recipientKey('SYNTHETIC_LOCAL_KEY',job.context);
  await runPreparedLocalJob({...f,publicKey:key.publicKey,worker:async()=>({removed:true,executionOutcome:'success',encrypted:seal(source.bundle,key.publicKey,job.context)})});
  const offlineDependencies=packages?await prepareOfflineNpmDependencies({diskSnapshot:source.snapshot,tarballRoot:packages.tarballRoot}):undefined;
  return {...f,context:job.context,diskSnapshot:source.snapshot,privateKey:key.privateKey,offlineDependencies};
}
async function noResources(){for(const a of [['ps','-a','--filter','label=orchestrator.disk-baseline-check=true','--format','{{.Names}}'],['volume','ls','--filter','label=orchestrator.disk-baseline-check=true','--format','{{.Name}}']])assert.equal((await promisify(execFile)('docker',a,{env:{PATH:process.env.PATH}})).stdout.trim(),'');}
test('six projected disk checks install locked dependencies offline and report the excluded configuration',async()=>{
  const root=await mkdtemp(join(tmpdir(),'disk-six-real-'));
  try{
    const f=await localFixture(root,{withDependencies:true,projected:true}),options={...f,imageId,timeoutMs:30000};
    const missing=await stageRunner.runDiskBaselineStage({diskSnapshot:f.diskSnapshot,imageId,stage:'build',timeoutMs:30000});
    assert.equal(missing.failureKind,'check_failed');
    await assert.rejects(independent.runLargeDiskIndependentChecks({...options,offlineDependencies:structuredClone(f.offlineDependencies)}));
    const competing=await Promise.allSettled([independent.runLargeDiskIndependentChecks(options),independent.runLargeDiskIndependentChecks(options)]);
    assert.equal(competing.filter(r=>r.status==='fulfilled').length,1);
    const report=competing.find(r=>r.status==='fulfilled').value;
    assert.equal(report.schemaVersion,2);assert.equal(report.inputProfile,'disk-v1');assert.equal(report.phase,'checks-passed-awaiting-review');assert.equal(report.review,'not-run');assert.equal(report.publishAuthorized,false);assert.equal(report.checks.length,6);assert.ok(report.checks.every(r=>r.status==='passed'&&r.removed));
    assert.equal(report.baselineBinding,'github-main-projected');
    assert.deepEqual(report.baselineProvenance.projection,f.diskSnapshot.projection);
    assert.equal(report.baselineProvenance.projection.excludedFileCount,1);
    assert.equal(report.offlineDependencies.tarballCount,2);
    assert.equal(report.offlineDependencies.baselineManifestSha256,f.diskSnapshot.manifestSha256);
    assert.equal(report.baselineManifestSha256,f.diskSnapshot.manifestSha256);assert.equal((await readLocalJob(f)).phase,'awaiting-independent-validation');
    await assert.rejects(independent.runLargeDiskIndependentChecks(options),e=>e.code==='EEXIST');await noResources();
    const path=join(f.stateRoot,f.id,'independent-report.json'),raw=await readFile(path,'utf8');assert.ok(!raw.includes('export const'));assert.ok(!raw.includes('SYNTHETIC_LOCAL_KEY'));
    assert.doesNotMatch(raw,/config\.toml|SYNTHETIC_EXCLUDED_CONFIG/);
    const wrongDependency=structuredClone(report);
    wrongDependency.offlineDependencies.lockSha256='a'.repeat(64);
    const wrongStage=structuredClone(report);
    wrongStage.checks[0].variant='candidate';
    const wrongBinding={...report,baselineBinding:'github-main-pinned'};
    for(const bad of [wrongDependency,wrongStage,wrongBinding]){
      await writeFile(path,JSON.stringify(bad));
      await assert.rejects(independent.readIndependentCheckStatus(f));
    }
    await writeFile(path,raw);
    const cli=await promisify(execFile)(process.execPath,['scripts/independent-check-cli.mjs','status',f.id,f.stateRoot],{env:{...process.env,GITHUB_ACTIONS:''}});const status=JSON.parse(cli.stdout);
    assert.equal(status.inputProfile,'disk-v1');
    assert.equal(status.baselineBinding,'github-main-projected');
    assert.deepEqual(status.baselineProvenance.projection,f.diskSnapshot.projection);
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
