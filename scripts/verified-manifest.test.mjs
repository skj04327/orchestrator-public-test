import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectVerifiedFiles,digestChangedFiles,isSafeManifestPath,isVerifiedDigest} from './verified-manifest.mjs';

test('file hash detects post-review source changes, independent of path order',async()=>{
  const root=await mkdtemp(join(tmpdir(),'verified-manifest-'));
  try{
    await mkdir(join(root,'src'),{recursive:true});
    await writeFile(join(root,'src','one.ts'),'export const one=1;\n');
    await writeFile(join(root,'src','two.ts'),'export const two=2;\n');
    const files=['src/two.ts','src/one.ts'];
    const old=await digestChangedFiles(root,files);
    assert.equal(old,await digestChangedFiles(root,[...files].reverse()));
    assert.ok(isVerifiedDigest(old));
    await writeFile(join(root,'src','one.ts'),'export const one=99;\n');
    assert.notEqual(old,await digestChangedFiles(root,files));
  }finally{await rm(root,{recursive:true,force:true});}
});
test('manifest rejects traversal, duplicate files, and off-allowlist paths',async()=>{
  const root=await mkdtemp(join(tmpdir(),'verified-manifest-'));
  try{
    await mkdir(join(root,'src'),{recursive:true});
    await writeFile(join(root,'src','safe.ts'),'export const safe=true;\n');
    for(const invalid of [
      ['.github/workflows/secrets.yml'],['src/assets/private.ts'],
      ['src/../secret.ts'],['src/safe.ts','src/safe.ts'],
      [],Array(9).fill('src/safe.ts')
    ])await assert.rejects(digestChangedFiles(root,invalid));
    assert.equal(isSafeManifestPath('src/safe.ts'),true);
    assert.equal(isSafeManifestPath('src/../../token.ts'),false);
    assert.equal(isVerifiedDigest('f'.repeat(63)),false);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('rejects symlinks and oversized source payloads',async()=>{
  const root=await mkdtemp(join(tmpdir(),'verified-manifest-'));
  try{
    await mkdir(join(root,'src'),{recursive:true});
    await writeFile(join(root,'src','target.ts'),'const hi=1;\n');
    await symlink(join(root,'src','target.ts'),join(root,'src','link.ts'));
    await assert.rejects(digestChangedFiles(root,['src/link.ts']));
    await mkdir(join(root,'outside'),{recursive:true});
    await writeFile(join(root,'outside','secret.ts'),'synthetic source\n');
    await symlink(join(root,'outside'),join(root,'src','alias'));
    await assert.rejects(digestChangedFiles(root,['src/alias/secret.ts']));
    await writeFile(join(root,'src','target.ts'),'x'.repeat(65001));
    await assert.rejects(digestChangedFiles(root,['src/target.ts']));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('publisher uses pre-verified buffer, never a second disk read',async()=>{
  const root=await mkdtemp(join(tmpdir(),'verified-manifest-'));
  try{
    await mkdir(join(root,'src'),{recursive:true});
    await writeFile(join(root,'src','one.ts'),'const one = 1;\n');
    const capture=await collectVerifiedFiles(root,['src/one.ts']);
    assert.ok(isVerifiedDigest(capture.digest));
    await writeFile(join(root,'src','one.ts'),'const one = 999;\n');
    assert.equal(capture.files[0].content.toString('utf8'),'const one = 1;\n');
    assert.notEqual(capture.digest,await digestChangedFiles(root,['src/one.ts']));
  }finally{await rm(root,{recursive:true,force:true});}
});
