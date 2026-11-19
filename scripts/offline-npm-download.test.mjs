import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmod,mkdtemp,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {diskCheckFixture} from './test-fixtures/disk-check.mjs';
import * as downloader from './offline-npm-download.mjs';

const bytes=Buffer.from('SYNTHETIC MOCK NPM BYTES');
const digest=createHash('sha512').update(bytes).digest();
const file=digest.toString('hex')+'.tgz';
const origin='https://registry.npmjs.org/synthetic/-/synthetic-1.0.0.tgz';
async function workflow(mode,fn){
  const root=await mkdtemp(join(tmpdir(),'npm-download-'));
  const env={PATH:process.env.PATH,GITHUB_ACTIONS:process.env.GITHUB_ACTIONS,GH_TOKEN:process.env.GH_TOKEN,OPENAI_API_KEY:process.env.OPENAI_API_KEY};
  try{
    delete process.env.GITHUB_ACTIONS;
    const transform=baseline=>{
      const lock=baseline.files.find(f=>f.path==='package-lock.json');
      lock.content=Buffer.from(JSON.stringify({lockfileVersion:3,packages:{'':{},'node_modules/synthetic':{
        version:'1.0.0',resolved:origin,integrity:'sha512-'+digest.toString('base64')
      }}})).toString('base64');
    };
    const source=await diskCheckFixture(root,{transform});
    const exe=join(root,'curl'),log=join(root,'calls'),cache=join(root,'downloads');
    await writeFile(log,'');
    await writeFile(exe,`#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2);
const log=${JSON.stringify(log)};
const past=fs.readFileSync(log,'utf8');
if(args[0]!=='-q'||args[args.indexOf('--proto')+1]!=='=https'||args[args.indexOf('--max-time')+1]!=='25'||args[args.indexOf('--connect-timeout')+1]!=='8'||args.some(arg=>['--location','--insecure','--retry'].includes(arg))||args.at(-2)!=='--'||args.at(-1)!==${JSON.stringify(origin)}||process.env.GH_TOKEN||process.env.OPENAI_API_KEY)process.exit(91);
fs.appendFileSync(log,'call\\n');
const mode=${JSON.stringify(mode)};
if(mode==='transient'&&!past){process.stderr.write('503\\n');process.exitCode=22;}
else if(mode==='redirect'){process.stderr.write('302\\n');process.stdout.write('redirect body');}
else if(mode==='oversize'){process.stdout.write(Buffer.alloc(33*1024*1024));process.stderr.write('200\\n');}
else if(mode==='cancel'){setInterval(()=>process.stdout.write('partial'),25);}
else{process.stdout.write(mode==='bad'?'WRONG':Buffer.from(${JSON.stringify(bytes.toString('base64'))},'base64'));process.stderr.write('200\\n');}
`);
    await chmod(exe,0o700);
    process.env.PATH=root+':'+env.PATH;
    process.env.GH_TOKEN='SYNTHETIC_PROVIDER_SECRET';
    process.env.OPENAI_API_KEY='SYNTHETIC_MODEL_KEY';
    const options={diskSnapshot:source.snapshot,tarballRoot:cache};
    await fn({options,cache,log});
  }finally{
    for(const [key,value] of Object.entries(env)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    await rm(root,{recursive:true,force:true});
  }
}
test('hash-verified download resumes from valid files and rejects cache corruption',async()=>{
  assert.equal(typeof downloader.downloadOfflineNpmDependencies,'function');
  await workflow('transient',async({options,cache,log})=>{
    const r=await downloader.downloadOfflineNpmDependencies(options);
    assert.equal(r.downloaded,1);
    assert.equal(r.reused,0);
    assert.deepEqual(await readFile(join(cache,file)),bytes);
    const next=await downloader.downloadOfflineNpmDependencies(options);
    assert.equal(next.downloaded,0);
    assert.equal(next.reused,1);
    assert.equal(await readFile(log,'utf8'),'call\ncall\n');
    await writeFile(join(cache,file),'CORRUPTED');
    await assert.rejects(downloader.downloadOfflineNpmDependencies(options),e=>e.failureKind==='blob_integrity');
    assert.equal(await readFile(log,'utf8'),'call\ncall\n');
  });
});
test('redirect, wrong digest and oversize never leave committed or staged files',async()=>{
  assert.equal(typeof downloader.downloadOfflineNpmDependencies,'function');
  for(const [mode,kind] of [['redirect','npm_download_rejected'],['bad','blob_integrity'],['oversize','npm_download_capacity']]){
    await workflow(mode,async({options,cache})=>{
      await assert.rejects(downloader.downloadOfflineNpmDependencies(options),e=>e.failureKind===kind);
      assert.deepEqual(await readdir(cache),[]);
    });
  }
});
test('a second invocation sees a busy cache before it starts a request',async()=>{
  const {setTimeout:delay}=await import('node:timers/promises');
  await workflow('cancel',async({options,cache,log})=>{
    const abort=new AbortController();
    const first=assert.rejects(downloader.downloadOfflineNpmDependencies({...options,signal:abort.signal}),e=>e.failureKind==='cancelled');
    try{
      const deadline=Date.now()+2000;
      while(!(await readFile(log,'utf8'))&&Date.now()<deadline)await delay(10);
      assert.equal(await readFile(log,'utf8'),'call\n');
      await assert.rejects(downloader.downloadOfflineNpmDependencies({...options,signal:AbortSignal.timeout(400)}),e=>e.failureKind==='npm_download_busy');
      assert.equal(await readFile(log,'utf8'),'call\n');
    }finally{
      abort.abort();
      await first;
    }
    assert.deepEqual(await readdir(cache),[]);
  });
});
