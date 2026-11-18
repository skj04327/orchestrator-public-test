import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as disk from './disk-baseline.mjs';
import {gitBaselineFixture} from './test-fixtures/git-baseline.mjs';
import {planOfflineNpmDependencies} from './offline-npm-runtime.mjs';
const actions=process.env.GITHUB_ACTIONS;
before(()=>{delete process.env.GITHUB_ACTIONS;});
after(()=>{if(actions!==undefined)process.env.GITHUB_ACTIONS=actions;});
const encode=(path,text)=>({path,content:Buffer.from(text).toString('base64')});
async function fixture(extra,executablePaths=[]){
  const f=await gitBaselineFixture({files:[encode('package.json','{}'),encode('package-lock.json','{"lockfileVersion":3,"packages":{"":{}}}'),encode('public/고려 지도.bin','KEEP_MAP'),...extra]},{executablePaths});
  const blobs=[];
  const streamBlob=async({sha,destination})=>{
    blobs.push(sha);
    await writeFile(destination,Buffer.from(f.values.get('/git/blobs/'+sha).content,'base64'),{flag:'wx',mode:0o600});
  };
  return {...f,blobs,streamBlob};
}
test('review binds the exact private tree and excludes an agent file without fetching or archiving it',async()=>{
  assert.equal(typeof disk.inspectDiskExecutionInput,'function');
  const root=await mkdtemp(join(tmpdir(),'disk-reviewed-'));
  try{
    const f=await fixture([encode('.codex/config.toml','SYNTHETIC_DO_NOT_COPY')]);
    const report=await disk.inspectDiskExecutionInput({get:f.get});
    assert.equal(report.phase,'projection-available');
    assert.equal(report.excludedFileCount,1);
    assert.match(report.projectionSha256,/^[0-9a-f]{64}$/);
    assert.equal(f.calls.some(path=>path.includes('/blobs/')),false);
    assert.doesNotMatch(JSON.stringify(report),/config\.toml|SYNTHETIC_DO_NOT_COPY/);
    const options={get:f.get,streamBlob:f.streamBlob,root};
    assert.equal((await disk.collectDiskBaseline(options)).phase,'blocked-input-policy');
    await assert.rejects(disk.collectDiskBaseline({...options,purpose:'checks-projected',projectionSha256:'0'.repeat(64)}),error=>error.failureKind==='projection_mismatch');
    assert.equal(f.blobs.length,0);
    const result=await disk.collectDiskBaseline({...options,purpose:'checks-projected',projectionSha256:report.projectionSha256});
    assert.equal(result.phase,'captured-projected');
    assert.equal(result.snapshot.fileCount,3);
    assert.equal(f.blobs.includes(f.entries.find(entry=>entry.path.startsWith('.codex/')).sha),false);
    const reopened=await disk.openDiskBaseline({root,baseSha:f.baseSha});
    const archive=disk.createDiskBaselineArchive(reopened);
    assert.equal(archive.provenance.baselineBinding,'github-main-projected');
    assert.equal(archive.provenance.projection.excludedFileCount,1);
    assert.equal((await disk.materializeDiskBaseline(reopened)).phase,'blocked-input-policy');
    assert.equal((await planOfflineNpmDependencies({diskSnapshot:reopened})).packages.length,0);
    const chunks=[];
    for await(const bytes of archive.inputStream)chunks.push(bytes);
    assert.match(Buffer.concat(chunks).toString(),/KEEP_MAP/);
    assert.doesNotMatch(Buffer.concat(chunks).toString(),/config\.toml|SYNTHETIC_DO_NOT_COPY/);
    const indexPath=join(root,f.baseSha+'.json');
    const index=JSON.parse(await readFile(indexPath,'utf8'));
    index.projection.excludedFileCount=2;
    await writeFile(indexPath,JSON.stringify(index));
    await assert.rejects(disk.openDiskBaseline({root,baseSha:f.baseSha}));
  }finally{await rm(root,{recursive:true,force:true});}
});
test('projection refuses secret paths, nested agent files and shared excluded blobs',async()=>{
  assert.equal(typeof disk.inspectDiskExecutionInput,'function');
  for(const extra of [
    [encode('.codex/config.toml','omit'),encode('.env','blocked')],
    [encode('.codex/nested/config.toml','blocked')],
    [encode('.claude/settings.json','KEEP_MAP')],
    [encode('.gemini/settings.json','x'.repeat(65537))],
    Array.from({length:9},(_,i)=>encode('.codex/setting-'+i+'.toml','omit-'+i)),
  ]){
    const f=await fixture(extra);
    const result=await disk.inspectDiskExecutionInput({get:f.get});
    assert.equal(result.phase,'blocked-input-policy');
    assert.equal(result.projectionSha256,undefined);
    assert.equal(f.calls.some(path=>path.includes('/blobs/')),false);
  }
  const executable=await fixture([encode('.codex/config.toml','blocked executable')],['.codex/config.toml']);
  assert.equal((await disk.inspectDiskExecutionInput({get:executable.get})).phase,'blocked-input-policy');
});

test('a data-only cache cannot supply a projected capture, and a changed tree invalidates the confirmation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'disk-reviewed-cache-'));
  try{
    const f=await fixture([encode('.claude/settings.json','SYNTHETIC_OLD_CONFIG')]);
    const review=await disk.inspectDiskExecutionInput({get:f.get});
    const data=(await disk.collectDiskBaseline({root,get:f.get,streamBlob:f.streamBlob,purpose:'data-only'})).snapshot;
    assert.throws(()=>disk.createDiskBaselineArchive(data));
    const index=JSON.parse(await readFile(join(root,f.baseSha+'.json'),'utf8'));
    const excluded=index.files.find(entry=>entry.path.startsWith('.claude/'));
    await rm(join(root,index.bundleDirectory,'blobs',excluded.sha));
    const options={root,purpose:'checks-projected',projectionSha256:review.projectionSha256};
    await assert.rejects(disk.collectDiskBaseline({...options,get:f.get,streamBlob:f.streamBlob}),error=>error.failureKind==='cache_provenance_mismatch');
    const next=await fixture([encode('.claude/settings.json','SYNTHETIC_NEW_CONFIG')]);
    await assert.rejects(disk.collectDiskBaseline({...options,get:next.get,streamBlob:next.streamBlob}),error=>error.failureKind==='projection_mismatch');
    assert.equal(next.blobs.length,0);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('metadata preflight accounts for the same request budget as projected capture',async()=>{
  const files=Array.from({length:3992},(_,i)=>encode('src/a'+i+'.ts','unique-'+i));
  const f=await fixture([...files,encode('.codex/config.toml','omit')]);
  const result=await disk.inspectDiskExecutionInput({get:f.get});
  assert.equal(result.phase,'blocked-request-budget');
  assert.equal(result.projectionSha256,undefined);
  assert.equal(f.calls.some(path=>path.includes('/blobs/')),false);
});
