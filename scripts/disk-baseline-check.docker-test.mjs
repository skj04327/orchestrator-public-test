// Synthetic sources only. No game cache, provider authentication or network.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import * as checker from './disk-baseline-check.mjs';
import {collectDiskBaseline} from './disk-baseline.mjs';
import {gitBaselineFixture} from './test-fixtures/git-baseline.mjs';
const imageId=process.env.ORCHESTRATOR_TEST_IMAGE,actions=process.env.GITHUB_ACTIONS;
if(!/^sha256:[a-f0-9]{64}$/.test(imageId||''))throw Error('Actual local image required');
before(()=>{delete process.env.GITHUB_ACTIONS;});after(()=>{if(actions===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=actions;});
const file=(path,b)=>({path,content:Buffer.from(b).toString('base64')});
async function fixture(root,{large=false,mode='safe',purpose='checks'}={}){
  const asset=Buffer.alloc(large?40*1024*1024:4,7),hash=createHash('sha256').update(asset).digest('hex');
  const script=mode==='timeout'?`setInterval(()=>{},1000)`:mode==='output'?`process.stdout.write('PRIVATE_OUTPUT'.repeat(50000));setInterval(()=>{},1000)`:`
const fs=require('fs'),assert=require('assert/strict'),{createHash}=require('crypto');
assert.equal(createHash('sha256').update(fs.readFileSync('public/고려 지도.bin')).digest('hex'),${JSON.stringify(hash)});
assert.equal(fs.statSync('tool.sh').mode&0o111,0o111);assert.equal(process.getuid(),1000);
for(const key of ['GH_TOKEN','GITHUB_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','PRIVATE_GAME_WRITE_TOKEN','OPENAI_API_KEY','NODE_OPTIONS'])assert.equal(process.env[key],undefined);
for(const path of ['/var/run/docker.sock','/root/.config/gh/hosts.yml','/work/project/previous-stage'])assert.equal(fs.existsSync(path),false);
assert.throws(()=>fs.writeFileSync('/input/manifest.json','BAD'));assert.throws(()=>fs.writeFileSync('/root/stolen','BAD'));
const policy=fs.readFileSync('/etc/resolv.conf','utf8');assert.equal(typeof policy,'string');
fs.writeFileSync('/work/project/previous-stage','SYNTHETIC');
`;
  const pkg={name:'synthetic-baseline',version:'1.0.0',scripts:{typecheck:'node check.cjs',test:'node check.cjs',build:'node check.cjs'}};
  const lock=mode==='offline'?{name:pkg.name,version:'1.0.0',lockfileVersion:3,requires:true,packages:{'':{name:pkg.name,version:'1.0.0',dependencies:{'synthetic-absent-package':'1.0.0'}},'node_modules/synthetic-absent-package':{version:'1.0.0',resolved:'https://registry.npmjs.org/synthetic-absent-package/-/synthetic-absent-package-1.0.0.tgz',integrity:'sha512-'+'A'.repeat(86)+'=='}}}:{name:pkg.name,version:'1.0.0',lockfileVersion:3,requires:true,packages:{'':{name:pkg.name,version:'1.0.0'}}};
  if(mode==='offline')pkg.dependencies={'synthetic-absent-package':'1.0.0'};
  const source=await gitBaselineFixture({files:[file('package.json',JSON.stringify(pkg)),file('package-lock.json',JSON.stringify(lock)),file('check.cjs',script),file('tool.sh','#!/bin/sh\nexit 0\n'),file('public/고려 지도.bin',asset)]},{executablePaths:['tool.sh']});
  return collectDiskBaseline({root,get:source.get,purpose,streamBlob:async({sha,destination})=>writeFile(destination,Buffer.from(source.values.get('/git/blobs/'+sha).content,'base64'),{flag:'wx',mode:0o600})});
}
async function noResources(){
  for(const args of [['ps','-a','--filter','label=orchestrator.disk-baseline-check=true','--format','{{.Names}}'],['volume','ls','--filter','label=orchestrator.disk-baseline-check=true','--format','{{.Name}}']])assert.equal((await promisify(execFile)('docker',args,{env:{PATH:process.env.PATH}})).stdout.trim(),'');
}
test('large Unicode/executable disk baseline reaches three fresh real offline npm stages without credentials or publish authority',async()=>{
  assert.equal(typeof checker.runDiskBaselineStage,'function');const root=await mkdtemp(join(tmpdir(),'disk-check-real-'));
  process.env.PRIVATE_GAME_WRITE_TOKEN='SYNTHETIC_HOST_SECRET';
  try{
    const r=await fixture(root,{large:true});
    for(const stage of ['typecheck','unit-test','build']){
      const report=await checker.runDiskBaselineStage({diskSnapshot:r.snapshot,imageId,stage,timeoutMs:60000});
      assert.equal(report.status,'passed');assert.equal(report.removed,true);assert.equal(report.publishAuthorized,false);assert.equal(report.variant,'baseline');assert.equal(report.baseSha,r.snapshot.baseSha);assert.equal(report.manifestSha256,r.snapshot.manifestSha256);assert.equal(report.baselineBinding,'github-main-pinned');
    }
    await noResources();
  }finally{delete process.env.PRIVATE_GAME_WRITE_TOKEN;await rm(root,{recursive:true,force:true});}
});
test('real offline dependency miss, timeout and output exhaustion fail and remove every fresh resource',async()=>{
  assert.equal(typeof checker.runDiskBaselineStage,'function');
  for(const mode of ['offline','timeout','output']){
    const root=await mkdtemp(join(tmpdir(),'disk-check-fail-'));
    try{
      const r=await fixture(root,{mode}),report=await checker.runDiskBaselineStage({diskSnapshot:r.snapshot,imageId,stage:'build',timeoutMs:mode==='timeout'?2000:30000,outputLimit:mode==='output'?1024:240000});
      assert.equal(report.status,'failed');assert.equal(report.failureKind,mode==='offline'?'check_failed':mode==='timeout'?'timeout':'output_limit');assert.equal(report.publishAuthorized,false);assert.ok(!JSON.stringify(report).includes('PRIVATE_OUTPUT'));await noResources();
    }finally{await rm(root,{recursive:true,force:true});}
  }
});
test('data-only, forged, aborted and Actions calls cannot start a baseline checker',async()=>{
  assert.equal(typeof checker.runDiskBaselineStage,'function');const root=await mkdtemp(join(tmpdir(),'disk-check-denied-'));
  try{
    const r=await fixture(root,{purpose:'data-only'}),options={diskSnapshot:r.snapshot,imageId,stage:'build'};
    await assert.rejects(checker.runDiskBaselineStage(options));await assert.rejects(checker.runDiskBaselineStage({...options,diskSnapshot:structuredClone(r.snapshot)}));
    const controller=new AbortController();controller.abort();await assert.rejects(checker.runDiskBaselineStage({...options,signal:controller.signal}));
    process.env.GITHUB_ACTIONS='true';await assert.rejects(checker.runDiskBaselineStage(options));delete process.env.GITHUB_ACTIONS;await noResources();
  }finally{delete process.env.GITHUB_ACTIONS;await rm(root,{recursive:true,force:true});}
});
