import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {mkdtemp,readFile,rm,unlink,writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectLocalDeveloperScope,prepareLocalDeveloperInput} from './local-developer-input.mjs';
import {prepareLocalJob,readLocalJob} from './local-jobs.mjs';
import {recipientKey} from './private-handoff.mjs';
import {submitLocalCandidate} from './local-candidate-intake.mjs';
import {makeLocalReceipt} from './test-fixtures/local-receipt.mjs';
import {diskCheckFixture,encoded} from './test-fixtures/disk-check.mjs';

const actions=process.env.GITHUB_ACTIONS;
before(()=>{delete process.env.GITHUB_ACTIONS;});
after(()=>{if(actions===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=actions;});
const hash=value=>createHash('sha256').update(value).digest('hex');

test('the approved developer packet contains only the pinned task and explicit source files',async()=>{
  const root=await mkdtemp(join(tmpdir(),'developer-input-'));
  try{
    const f=await makeLocalReceipt(root),job=await prepareLocalJob(f);
    const chosen='\ufeffexport const approved = "합성";\r\n';
    const {diskSnapshot}=await diskCheckFixture(root,{context:job.context,purpose:'checks-projected',extra:[
      encoded('src/approved.ts',chosen),encoded('src/other.ts','SYNTHETIC_UNAPPROVED'),encoded('.codex/config.toml','SYNTHETIC_SETTINGS'),
      encoded('public/map.bin',Buffer.alloc(40*1024*1024,7))]});
    const opts={...f,diskSnapshot};
    const scope=await inspectLocalDeveloperScope({...opts,paths:['src/approved.ts']});
    assert.equal(scope.taskId,f.id);
    assert.equal(scope.runId,job.context.runId);
    assert.equal(scope.baselineManifestSha256,diskSnapshot.manifestSha256);
    assert.deepEqual(scope.files,[{path:'src/approved.ts',sha256:hash(chosen)}]);
    assert.doesNotMatch(JSON.stringify(scope),/합성|SYNTHETIC_LOCAL_JOB/);

    // Reading the selected scope must not scan or materialize other project blobs.
    const index=JSON.parse(await readFile(join(root,'cache',diskSnapshot.baseSha+'.json'),'utf8'));
    const other=index.files.find(file=>file.path==='src/other.ts');
    await unlink(join(root,'cache',index.bundleDirectory,'blobs',other.sha));
    const prepared=await prepareLocalDeveloperInput({...opts,approvedScope:scope});
    assert.equal(prepared.scopeSha256,hash(JSON.stringify(scope)));
    assert.equal(prepared.inputSha256,hash(prepared.input));
    assert.deepEqual(JSON.parse(prepared.input),{schemaVersion:1,provider:'codex',runId:job.context.runId,
      baselineManifestSha256:diskSnapshot.manifestSha256,task:'SYNTHETIC_LOCAL_JOB',files:[{path:'src/approved.ts',content:chosen}]});
    assert.doesNotMatch(prepared.input,/SYNTHETIC_UNAPPROVED|SYNTHETIC_SETTINGS|chunk|map\.bin|package-lock/);
    assert.equal((await readLocalJob(f)).phase,'prepared');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('the developer packet rejects copied or archive snapshots, unapproved paths, and changed approved bytes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'developer-input-gate-'));
  try{
    const f=await makeLocalReceipt(root),job=await prepareLocalJob(f);
    const {diskSnapshot}=await diskCheckFixture(root,{context:job.context,extra:[encoded('src/oversized.ts',Buffer.alloc(65001,65))]});
    const opts={...f,diskSnapshot};
    const scope=await inspectLocalDeveloperScope({...opts,paths:['src/status.ts']});
    for(const paths of [['package.json'],['src/../src/status.ts'],['src/oversized.ts'],['src/missing.ts'],['src/status.ts','src/status.ts']]){
      await assert.rejects(inspectLocalDeveloperScope({...opts,paths}));
    }
    for(const approvedScope of [undefined,{...scope,provider:'gemini'},{...scope,taskId:'20261120T010000Z-456-789'},
      {...scope,runId:'other'},{...scope,taskSha256:'b'.repeat(64)},
      {...scope,baselineManifestSha256:'a'.repeat(64)},{...scope,files:[{...scope.files[0],sha256:'a'.repeat(64)}]}]){
      await assert.rejects(prepareLocalDeveloperInput({...opts,approvedScope}));
    }
    await assert.rejects(prepareLocalDeveloperInput({...opts,diskSnapshot:structuredClone(diskSnapshot),approvedScope:scope}));
    const archive=await diskCheckFixture(join(root,'archive'),{context:job.context,purpose:'data-only'});
    await assert.rejects(inspectLocalDeveloperScope({...opts,diskSnapshot:archive.diskSnapshot,paths:[]}));
    await assert.rejects(prepareLocalDeveloperInput({...opts,approvedScope:scope,signal:AbortSignal.abort()}));
    const index=JSON.parse(await readFile(join(root,'cache',diskSnapshot.baseSha+'.json'),'utf8'));
    const source=index.files.find(file=>file.path==='src/status.ts');
    const blobPath=join(root,'cache',index.bundleDirectory,'blobs',source.sha);
    await writeFile(blobPath,Buffer.alloc(source.size,65));
    await assert.rejects(prepareLocalDeveloperInput({...opts,approvedScope:scope}),{failureKind:'blob_integrity'});
    await unlink(blobPath);
    await assert.rejects(prepareLocalDeveloperInput({...opts,approvedScope:scope}),{failureKind:'developer_source_unavailable',message:'Private baseline unavailable'});
    await writeFile(join(f.stateRoot,f.id,'input','task-private',f.path),'SYNTHETIC_TAMPERED_TASK');
    await assert.rejects(prepareLocalDeveloperInput({...opts,approvedScope:scope}),/Prepared input changed/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a task edit while reading approved source bytes prevents preparation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'developer-input-race-')),originalOpen=fs.promises.open;
  try{
    const f=await makeLocalReceipt(root),job=await prepareLocalJob(f);
    const {diskSnapshot}=await diskCheckFixture(root,{context:job.context});
    const options={...f,diskSnapshot};
    const approvedScope=await inspectLocalDeveloperScope({...options,paths:['src/status.ts']});
    const index=JSON.parse(await readFile(join(root,'cache',diskSnapshot.baseSha+'.json'),'utf8'));
    const source=index.files.find(file=>file.path==='src/status.ts');
    const blobPath=join(root,'cache',index.bundleDirectory,'blobs',source.sha);
    let edited=false;
    fs.promises.open=async(...args)=>{
      if(!edited&&args[0]===blobPath){
        edited=true;
        await writeFile(join(f.stateRoot,f.id,'input','task-private',f.path),'SYNTHETIC_TAMPERED_DURING_PREPARE');
      }
      return originalOpen(...args);
    };
    syncBuiltinESMExports();
    await assert.rejects(prepareLocalDeveloperInput({...options,approvedScope}),/Prepared input changed/);
    assert.equal(edited,true);
  }finally{
    fs.promises.open=originalOpen;syncBuiltinESMExports();
    await rm(root,{recursive:true,force:true});
  }
});

test('preparing developer input cannot silently drop attachments from a queued task',async()=>{
  const root=await mkdtemp(join(tmpdir(),'developer-input-media-'));
  try{
    const f=await makeLocalReceipt(root,{references:['https://en.wikipedia.org/wiki/Goryeo']}),job=await prepareLocalJob(f);
    const {diskSnapshot}=await diskCheckFixture(root,{context:job.context});
    await assert.rejects(inspectLocalDeveloperScope({...f,diskSnapshot,paths:[]}),/Attachments require a reviewed provider profile/);
    const approvedScope={schemaVersion:1,provider:'codex',taskId:f.id,runId:job.context.runId,baselineManifestSha256:diskSnapshot.manifestSha256,
      taskSha256:hash('SYNTHETIC_LOCAL_JOB'),files:[]};
    await assert.rejects(prepareLocalDeveloperInput({...f,diskSnapshot,approvedScope}),/Attachments require a reviewed provider profile/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('source and serialized limits apply before any packet leaves the local API',async()=>{
  const root=await mkdtemp(join(tmpdir(),'developer-input-limits-'));
  try{
    const f=await makeLocalReceipt(root),job=await prepareLocalJob(f);
    const large=Array.from({length:5},(_,index)=>encoded('src/large-'+index+'.ts',Buffer.alloc(60000,1)));
    const extra=[...large,encoded('src/nul.ts',Buffer.from([0])),encoded('src/invalid.ts',Buffer.from([255]))];
    const {diskSnapshot}=await diskCheckFixture(root,{context:job.context,extra});
    const options={...f,diskSnapshot};
    await assert.rejects(inspectLocalDeveloperScope({...options,paths:large.map(file=>file.path)}),{failureKind:'developer_source_capacity'});
    for(const paths of [large.slice(0,2).map(file=>file.path),['src/nul.ts'],['src/invalid.ts']]){
      const approvedScope=await inspectLocalDeveloperScope({...options,paths});
      await assert.rejects(prepareLocalDeveloperInput({...options,approvedScope}));
    }
    process.env.GITHUB_ACTIONS='true';
    try{
      await assert.rejects(inspectLocalDeveloperScope({...options,paths:[]}));
      await assert.rejects(prepareLocalDeveloperInput(options));
    }finally{delete process.env.GITHUB_ACTIONS;}
  }finally{await rm(root,{recursive:true,force:true});}
});

test('the prepared packet provides the exact identifiers for candidate intake',async()=>{
  const root=await mkdtemp(join(tmpdir(),'developer-input-intake-'));
  try{
    const f=await makeLocalReceipt(root),job=await prepareLocalJob(f);
    const {diskSnapshot}=await diskCheckFixture(root,{context:job.context});
    const options={...f,diskSnapshot},paths=['src/status.ts'];
    const approvedScope=await inspectLocalDeveloperScope({...options,paths});
    const packet=JSON.parse((await prepareLocalDeveloperInput({...options,approvedScope})).input);
    const response=Buffer.from(JSON.stringify({schemaVersion:1,runId:packet.runId,baselineManifestSha256:packet.baselineManifestSha256,
      files:[{path:'src/status.ts',content:'export const n=3;'}]}));
    const {publicKey}=recipientKey('SYNTHETIC_DEVELOPER_INTAKE',job.context);
    assert.equal((await submitLocalCandidate({...options,publicKey,response})).phase,'awaiting-independent-validation');
    await assert.rejects(prepareLocalDeveloperInput({...options,approvedScope}),/Local job is not prepared/);
  }finally{await rm(root,{recursive:true,force:true});}
});
