import test from 'node:test';
import assert from 'node:assert/strict';
import {gitBaselineFixture} from './test-fixtures/git-baseline.mjs';
import {collectPrivateBaseline,getPinnedBaselineProof,validatePinnedBaselineProof} from './pinned-private-baseline.mjs';
const encoded=(path,content)=>({path,content:Buffer.from(content).toString('base64')});
const baseline={files:[encoded('package.json','{}'),encoded('package-lock.json','{}'),encoded('sort/a.c','a'),encoded('sort/a/file.ts','b')]};
test('real Git generated trees and blobs produce immutable main-bound baseline, not forgeable by JSON copying',async()=>{
  const f=await gitBaselineFixture(baseline,{executablePaths:['sort/a.c']}),r=await collectPrivateBaseline({get:f.get});
  assert.equal(f.entries.find(e=>e.path==='sort/a.c').mode,'100755');
  assert.equal(r.phase,'captured');assert.equal(r.baseline.baseSha,f.baseSha);assert.equal(r.baseline.files.length,4);
  const proof=getPinnedBaselineProof(r.baseline);assert.equal(proof.treeSha,f.treeSha);assert.equal(proof.ref,'refs/heads/main');
  assert.throws(()=>validatePinnedBaselineProof({...proof,treeSha:[proof.treeSha]},proof));
  assert.equal(proof.repository,'skj04327/the-twilight-of-korea');assert.match(proof.baselineContentSha256,/^[a-f0-9]{64}$/);
  assert.throws(()=>r.baseline.files[0].content='FORGED');assert.equal(getPinnedBaselineProof(structuredClone(r.baseline)),null);
  assert.equal(f.calls.filter(p=>p==='/git/ref/heads/main').length,2);
});
test('capacity is checked from complete tree before any blob; no partial asset snapshot is accepted',async()=>{
  const f=await gitBaselineFixture(baseline),tree=f.values.get('/git/trees/'+f.treeSha+'?recursive=1');
  tree.tree.find(e=>e.type==='blob').size=40000000;
  const r=await collectPrivateBaseline({get:f.get});assert.equal(r.phase,'blocked-capacity');assert.equal(r.baseline,undefined);
  assert.ok(!f.calls.some(p=>p.startsWith('/git/blobs/')));
});
test('tampered tree/blob, truncation, public repo, wrong main and moved main fail closed',async()=>{
  for(const mode of ['omitted','blob','truncated','public','wrong-main','moved','became-public','cancel-final']){
    const f=await gitBaselineFixture(baseline),tree=f.values.get('/git/trees/'+f.treeSha+'?recursive=1');
    if(mode==='omitted')tree.tree.pop();if(mode==='truncated')tree.truncated=true;
    if(mode==='public')f.values.get('').private=false;
    if(mode==='blob'){const e=tree.tree.find(e=>e.type==='blob');f.values.get('/git/blobs/'+e.sha).content='Zm9yZ2Vk';}
    let reads=0,repoReads=0;const controller=new AbortController();
    const get=async p=>{
      const v=await f.get(p);
      if(p==='/git/ref/heads/main'&&++reads===2){if(mode==='moved')v.object.sha='a'.repeat(40);if(mode==='cancel-final')controller.abort();}
      if(mode==='became-public'&&p===''&&++repoReads===2)v.private=false;return v;
    };
    await assert.rejects(collectPrivateBaseline({get,signal:controller.signal,...(mode==='wrong-main'?{expectedBaseSha:'a'.repeat(40)}:{})}));
  }
});
test('links, submodules, duplicate nodes and credential paths never trigger blob retrieval',async()=>{
  for(const mode of ['symlink','submodule','duplicate','credentials']){
    const value=structuredClone(baseline);
    if(mode==='credentials')value.files.push(encoded('.config/gcloud/application_default_credentials.json','SYNTHETIC_CREDENTIAL'));
    const f=await gitBaselineFixture(value),tree=f.values.get('/git/trees/'+f.treeSha+'?recursive=1'),entry=tree.tree.find(e=>e.type==='blob');
    if(mode==='symlink')entry.mode='120000';if(mode==='submodule'){entry.mode='160000';entry.type='commit';}
    if(mode==='duplicate')tree.tree.push({...entry});
    if(mode==='credentials')assert.equal((await collectPrivateBaseline({get:f.get})).phase,'blocked-input-policy');
    else await assert.rejects(collectPrivateBaseline({get:f.get}));
    assert.ok(!f.calls.some(p=>p.startsWith('/git/blobs/')));
  }
});
test('pre-abort and bounded deadline stop even noncooperative read-only adapters',async()=>{
  let calls=0;const get=async()=>{calls++;return new Promise(()=>{});};
  await assert.rejects(collectPrivateBaseline({get,signal:AbortSignal.abort()}));assert.equal(calls,0);
  await assert.rejects(collectPrivateBaseline({get,timeoutMs:100}));assert.equal(calls,1);
});
test('an elapsed deadline cannot be accepted when synchronous adapter work delays the timer callback',async()=>{
  const f=await gitBaselineFixture(baseline);let delayed=false;
  const get=async path=>{
    if(!delayed){delayed=true;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);}
    return f.get(path);
  };
  await assert.rejects(collectPrivateBaseline({get,timeoutMs:100}),e=>e.failureKind==='timeout');
});
