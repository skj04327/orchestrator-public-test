import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,readdir,stat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gitBaselineFixture} from './test-fixtures/git-baseline.mjs';
import {collectDiskBaseline,openDiskBaseline,materializeDiskBaseline,getMaterializedDiskProof} from './disk-baseline.mjs';
const actions=process.env.GITHUB_ACTIONS;
before(()=>{delete process.env.GITHUB_ACTIONS;});after(()=>{if(actions===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=actions;});
const file=(path,content)=>({path,content:Buffer.from(content).toString('base64')});
async function fixture(extra=[]){
  const f=await gitBaselineFixture({files:[file('package.json','{}'),file('package-lock.json','{}'),file('src/a.ts','SYNTHETIC_SOURCE'),...extra]});
  const transfers=[];
  const streamBlob=async({sha,destination,signal})=>{if(signal.aborted)throw Error('aborted');transfers.push(sha);const b=f.values.get('/git/blobs/'+sha);await writeFile(destination,Buffer.from(b.content,'base64'),{flag:'wx',mode:0o600});};
  return {...f,transfers,streamBlob};
}
test('disk capture deduplicates blobs, commits private index last, reopens integrity, and materializes compatible provenance',async()=>{
  const root=await mkdtemp(join(tmpdir(),'disk-baseline-'));
  try{
    const f=await fixture(),r=await collectDiskBaseline({root,get:f.get,streamBlob:f.streamBlob});
    assert.equal(r.phase,'captured-disk');assert.equal(r.publishAuthorized,false);assert.equal(f.transfers.length,2);
    const snapshot=await openDiskBaseline({root,baseSha:f.baseSha}),small=await materializeDiskBaseline(snapshot);
    assert.equal(small.phase,'materialized');assert.equal(small.baseline.files.length,3);
    assert.equal(getMaterializedDiskProof(small.baseline).treeSha,f.treeSha);
    assert.equal(getMaterializedDiskProof(structuredClone(small.baseline)),null);
    assert.equal((await stat(join(root,f.baseSha+'.json'))).mode&0o777,0o600);
    const calls=f.transfers.length;await collectDiskBaseline({root,get:f.get,streamBlob:f.streamBlob});assert.equal(f.transfers.length,calls);
    const index=JSON.parse(await readFile(join(root,f.baseSha+'.json'),'utf8')),blob=join(root,index.bundleDirectory,'blobs',index.files[0].sha);
    await writeFile(blob,'TAMPERED');await assert.rejects(openDiskBaseline({root,baseSha:f.baseSha}));
  }finally{await rm(root,{recursive:true,force:true});}
});
test('disk-only large blob and Unicode assets are captured without relaxing memory-checker limits',async()=>{
  const root=await mkdtemp(join(tmpdir(),'disk-large-'));
  try{
    const f=await fixture([file('public/고려 지도.bin',Buffer.alloc(2*1024*1024,7))]);
    const r=await collectDiskBaseline({root,get:f.get,streamBlob:f.streamBlob});assert.equal(r.phase,'captured-disk');
    assert.equal((await materializeDiskBaseline(r.snapshot)).phase,'blocked-checker-capacity');
    assert.equal((await openDiskBaseline({root,baseSha:f.baseSha})).baseSha,f.baseSha);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('failed transfers wait for all writers and never expose an index; retained attempt prevents silent retry',async()=>{
  const root=await mkdtemp(join(tmpdir(),'disk-failure-'));
  try{
    const f=await fixture([file('src/b.ts','SECOND'),file('src/c.ts','THIRD')]);let active=0;
    const streamBlob=async({destination})=>{active++;try{await new Promise(r=>setTimeout(r,30));await writeFile(destination,'PARTIAL',{flag:'wx',mode:0o600});throw Error('SYNTHETIC_PRIVATE_DIAGNOSTIC');}finally{active--;}};
    await assert.rejects(collectDiskBaseline({root,get:f.get,streamBlob}));assert.equal(active,0);
    await assert.rejects(stat(join(root,f.baseSha+'.json')));assert.ok(!(await readdir(root)).some(n=>n.startsWith('.disk-')));
    await assert.rejects(collectDiskBaseline({root,get:f.get,streamBlob:f.streamBlob}));assert.equal(f.transfers.length,0);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('unsafe tree policy/cap blocks before disk downloads and symlink blobs cannot reopen',async()=>{
  for(const mode of ['credential','capacity','symlink']){
    const root=await mkdtemp(join(tmpdir(),'disk-policy-'));
    try{
      const f=await fixture(mode==='credential'?[file('.aws/credentials','SYNTHETIC')]:[]);
      if(mode==='capacity')f.values.get('/git/trees/'+f.treeSha+'?recursive=1').tree.find(e=>e.type==='blob').size=2000000000;
      const r=await collectDiskBaseline({root,get:f.get,streamBlob:f.streamBlob});
      if(mode!=='symlink'){assert.match(r.phase,/^blocked-/);assert.equal(f.transfers.length,0);continue;}
      const index=JSON.parse(await readFile(join(root,f.baseSha+'.json'),'utf8')),blob=join(root,index.bundleDirectory,'blobs',index.files[0].sha);
      await rm(blob);await symlink('/etc/passwd',blob);await assert.rejects(openDiskBaseline({root,baseSha:f.baseSha}));
    }finally{await rm(root,{recursive:true,force:true});}
  }
});
test('explicit data-only cache preserves full sensitive-path tree but never materializes execution input',async()=>{
  const root=await mkdtemp(join(tmpdir(),'disk-data-only-'));
  try{
    const f=await fixture([file('.env.example','SYNTHETIC_SENSITIVE_DATA')]);
    const r=await collectDiskBaseline({root,get:f.get,streamBlob:f.streamBlob,purpose:'data-only'});
    assert.equal(r.phase,'captured-data-only');assert.equal(r.snapshot.executionEligible,false);
    const reopened=await openDiskBaseline({root,baseSha:f.baseSha});
    assert.equal((await materializeDiskBaseline(reopened)).phase,'blocked-input-policy');
    const calls=f.transfers.length;
    assert.equal((await collectDiskBaseline({root,get:f.get,streamBlob:f.streamBlob})).phase,'blocked-input-policy');assert.equal(f.transfers.length,calls);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('missing completed cache blobs fail without silently downloading a repair',async()=>{
  const root=await mkdtemp(join(tmpdir(),'disk-missing-'));
  try{
    const f=await fixture();await collectDiskBaseline({root,get:f.get,streamBlob:f.streamBlob});
    const index=JSON.parse(await readFile(join(root,f.baseSha+'.json'),'utf8'));
    await rm(join(root,index.bundleDirectory,'blobs',index.files[0].sha));await rm(join(root,f.baseSha+'.claim'));f.transfers.length=0;
    await assert.rejects(collectDiskBaseline({root,get:f.get,streamBlob:f.streamBlob}));assert.equal(f.transfers.length,0);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('index purpose corruption and hardlinked or public-mode blobs cannot gain execution eligibility',async()=>{
  for(const mode of ['purpose','hardlink','permissions']){
    const root=await mkdtemp(join(tmpdir(),'disk-tamper-'));
    try{
      const f=await fixture();await collectDiskBaseline({root,get:f.get,streamBlob:f.streamBlob,purpose:mode==='purpose'?'data-only':'checks'});
      const path=join(root,f.baseSha+'.json'),index=JSON.parse(await readFile(path,'utf8')),blob=join(root,index.bundleDirectory,'blobs',index.files[0].sha);
      if(mode==='purpose'){index.purpose='checks';await writeFile(path,JSON.stringify(index));}
      if(mode==='hardlink'){const {link}=await import('node:fs/promises');await link(blob,join(root,'alias'));}
      if(mode==='permissions'){const {chmod}=await import('node:fs/promises');await chmod(blob,0o644);}
      await assert.rejects(openDiskBaseline({root,baseSha:f.baseSha}));
    }finally{await rm(root,{recursive:true,force:true});}
  }
});
test('one failing download cancels peers and waits for their asynchronous cleanup before removing stage',async()=>{
  const root=await mkdtemp(join(tmpdir(),'disk-cancel-peers-'));
  try{
    const f=await fixture([file('src/b.ts','SECOND')]);let active=0,started=0,sawAbort=0,release;
    const allStarted=new Promise(resolve=>{release=resolve;});
    const streamBlob=async({destination,signal})=>{
      const ordinal=++started;active++;if(started===3)release();
      try{
        if(ordinal===1){await allStarted;throw Error('SYNTHETIC_FAILURE');}
        await writeFile(destination,'PARTIAL',{flag:'wx',mode:0o600});
        await new Promise(resolve=>{signal.addEventListener('abort',resolve,{once:true});if(signal.aborted)resolve();});sawAbort++;
      }finally{await new Promise(resolve=>setTimeout(resolve,20));await rm(destination,{force:true});active--;}
    };
    await assert.rejects(collectDiskBaseline({root,get:f.get,streamBlob}));assert.equal(active,0);assert.equal(sawAbort,2);
    assert.ok(!(await readdir(root)).some(n=>n.startsWith('.disk-')));
  }finally{await rm(root,{recursive:true,force:true});}
});
test('fresh main/tree mismatch or final main movement prevents reuse or index commit',async()=>{
  for(const mode of ['tree-mismatch','main-moved']){
    const root=await mkdtemp(join(tmpdir(),'disk-main-'));
    try{
      const f=await fixture();
      if(mode==='tree-mismatch'){
        await collectDiskBaseline({root,get:f.get,streamBlob:f.streamBlob});const other=await fixture([file('src/b.ts','OTHER_TREE')]);
        f.values.get('/git/commits/'+f.baseSha).tree.sha=other.treeSha;
        f.values.set('/git/trees/'+other.treeSha+'?recursive=1',other.values.get('/git/trees/'+other.treeSha+'?recursive=1'));f.transfers.length=0;
        await assert.rejects(collectDiskBaseline({root,get:f.get,streamBlob:f.streamBlob}));assert.equal(f.transfers.length,0);
      }else{
        let heads=0;const get=async path=>{const value=await f.get(path);if(path==='/git/ref/heads/main'&&++heads===2)value.object.sha='a'.repeat(40);return value;};
        await assert.rejects(collectDiskBaseline({root,get,streamBlob:f.streamBlob}));await assert.rejects(stat(join(root,f.baseSha+'.json')));
      }
    }finally{await rm(root,{recursive:true,force:true});}
  }
});
