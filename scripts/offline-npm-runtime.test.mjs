import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import * as runtime from './offline-npm-runtime.mjs';
import {diskCheckFixture} from './test-fixtures/disk-check.mjs';

const bytes=Buffer.from('synthetic compressed artifact bytes');
const checksum=createHash('sha512').update(bytes).digest();
const filename=checksum.toString('hex')+'.tgz';
const packageEntry={version:'1.0.0',resolved:'https://registry.npmjs.org/synthetic-package/-/synthetic-package-1.0.0.tgz',integrity:'sha512-'+checksum.toString('base64')};
async function fixture(root,entry=packageEntry,purpose='checks'){
  const transform=baseline=>{
    const lock=baseline.files.find(file=>file.path==='package-lock.json');
    lock.content=Buffer.from(JSON.stringify({lockfileVersion:3,packages:{'':{},'node_modules/synthetic-package':entry}})).toString('base64');
  };
  return diskCheckFixture(root,{transform,purpose});
}
test('only a real checks snapshot and verified regular local tarball can seed the exact bound snapshot',async()=>{
  assert.equal(typeof runtime.prepareOfflineNpmDependencies,'function');
  const actions=process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_ACTIONS;
  const root=await mkdtemp(join(tmpdir(),'npm-offline-'));
  try{
    const f=await fixture(root);
    const tarballRoot=join(root,'packages');
    await mkdir(tarballRoot,{mode:0o700});
    const tarball=join(tarballRoot,filename);
    const options={diskSnapshot:f.snapshot,tarballRoot};
    const plan=await runtime.planOfflineNpmDependencies(options);
    assert.deepEqual(plan.packages.map(p=>p.filename),[filename]);
    await assert.rejects(runtime.prepareOfflineNpmDependencies(options));
    await writeFile(tarball,bytes,{mode:0o600});
    const prepared=await runtime.prepareOfflineNpmDependencies(options);
    const proof=runtime.offlineNpmProvenance(prepared,f.snapshot);
    assert.equal(proof.tarballCount,1);
    assert.equal(proof.totalBytes,bytes.length);
    assert.throws(()=>runtime.offlineNpmProvenance(structuredClone(prepared),f.snapshot));
    assert.throws(()=>runtime.offlineNpmProvenance(prepared,structuredClone(f.snapshot)));
    const archive=runtime.createOfflineNpmArchive(prepared,f.snapshot);
    const chunks=[];
    for await(const chunk of archive) chunks.push(chunk);
    assert.ok(Buffer.concat(chunks).includes(bytes));
    await writeFile(tarball,Buffer.alloc(bytes.length,7));
    await assert.rejects(async()=>{for await(const chunk of runtime.createOfflineNpmArchive(prepared,f.snapshot)) void chunk;},error=>error.failureKind==='blob_integrity');
    await assert.rejects(runtime.prepareOfflineNpmDependencies(options));
    await rm(tarball);
    await symlink('/dev/null',tarball);
    await assert.rejects(runtime.prepareOfflineNpmDependencies(options));
  }finally{
    if(actions!==undefined)process.env.GITHUB_ACTIONS=actions;
    await rm(root,{recursive:true,force:true});
  }
});
test('dependency plan refuses data-only, unverifiable integrity, links and noncanonical registry addresses',async()=>{
  assert.equal(typeof runtime.planOfflineNpmDependencies,'function');
  const actions=process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_ACTIONS;
  const root=await mkdtemp(join(tmpdir(),'npm-policy-'));
  try{
    for(const entry of [{...packageEntry,integrity:'sha1-aaa'},{...packageEntry,link:true},
      ...['file:dep.tgz','https://example.invalid/dep.tgz',packageEntry.resolved+'?private=true',packageEntry.resolved.replace('registry.npmjs.org','name@registry.npmjs.org'),packageEntry.resolved.replace('/-/','/../-/')].map(resolved=>({...packageEntry,resolved}))]){
      const f=await fixture(await mkdtemp(join(root,'invalid-')),entry);
      await assert.rejects(runtime.planOfflineNpmDependencies({diskSnapshot:f.snapshot}),/Dependency lock/);
    }
    const data=await fixture(join(root,'data'),packageEntry,'data-only');
    await assert.rejects(runtime.planOfflineNpmDependencies({diskSnapshot:data.snapshot}));
  }finally{
    if(actions!==undefined)process.env.GITHUB_ACTIONS=actions;
    await rm(root,{recursive:true,force:true});
  }
});
test('rejects a root shrinkwrap that npm ci would prefer over the verified package-lock',async()=>{
  const actions=process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_ACTIONS;
  const root=await mkdtemp(join(tmpdir(),'npm-shrinkwrap-'));
  try{
    const shrinkwrap={path:'npm-shrinkwrap.json',content:Buffer.from('{"lockfileVersion":3,"packages":{"":{}}}').toString('base64')};
    const f=await diskCheckFixture(root,{extra:[shrinkwrap]});
    await assert.rejects(runtime.planOfflineNpmDependencies({diskSnapshot:f.snapshot}),error=>error.failureKind==='invalid_dependency_lock');
  }finally{
    if(actions!==undefined)process.env.GITHUB_ACTIONS=actions;
    await rm(root,{recursive:true,force:true});
  }
});
test('source policy also covers npm dependency declarations and overrides used during install',async()=>{
  const actions=process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_ACTIONS;
  const root=await mkdtemp(join(tmpdir(),'npm-source-policy-'));
  try{
    for(const [manifest,locked] of [
      [{dependencies:{dep:'file:dep.tgz'}},{}],
      [{dependencies:{dep:'dep.tgz'}},{}],
      [{dependencies:{dep:'owner/repo'}},{}],
      [{overrides:{dep:{'.':'file:dep.tgz'}}},{}],
      [{workspaces:['packages/*']},{}],
      [{},{dependencies:{dep:'git+https://example.invalid/repo.git'}}],
    ]){
      const transform=baseline=>{
        const set=(path,value)=>{baseline.files.find(file=>file.path===path).content=Buffer.from(JSON.stringify(value)).toString('base64');};
        set('package.json',{name:'project',version:'1.0.0',...manifest});
        set('package-lock.json',{lockfileVersion:3,packages:{'':{},'node_modules/synthetic-package':{...packageEntry,...locked}}});
      };
      const f=await diskCheckFixture(await mkdtemp(join(root,'case-')),{transform});
      await assert.rejects(runtime.planOfflineNpmDependencies({diskSnapshot:f.snapshot}),/Dependency lock/);
    }
  }finally{
    if(actions!==undefined)process.env.GITHUB_ACTIONS=actions;
    await rm(root,{recursive:true,force:true});
  }
});
