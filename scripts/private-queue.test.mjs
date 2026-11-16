import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,readdir,lstat,symlink,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createReadyManifest,validateReadyManifest,receivePrivateTask,readLocalReceipt} from './private-queue.mjs';
const ID='20261116T120000Z-123-456',SHA='e'.repeat(40);
function fixture(){
  const inputs=[{kind:'task',path:'docs/orchestrator/tasks/'+ID+'.txt',content:Buffer.from('SYNTHETIC_PRIVATE_TASK')},
    {kind:'references',path:'docs/orchestrator/references/'+ID+'.json',content:Buffer.from(JSON.stringify({version:1,urls:['https://en.wikipedia.org/wiki/Goryeo']}))}];
  const manifest=createReadyManifest(ID,{mode:'manual',controller:'claude'},inputs);
  const files=new Map(inputs.map(f=>[f.path,f.content]));files.set('docs/orchestrator/requests/'+ID+'.json',Buffer.from(JSON.stringify(manifest)));
  const calls=[];
  const get=async path=>{
    calls.push(path);
    if(path==='')return {private:true,full_name:'skj04327/the-twilight-of-korea'};
    if(path==='/git/ref/heads/orchestrator/task-queue')return {object:{type:'commit',sha:SHA}};
    const prefix='/contents/';assert.ok(path.startsWith(prefix));assert.ok(path.endsWith('?ref='+SHA),'Every input must be pinned to one commit');
    const p=path.slice(prefix.length).split('?')[0],content=files.get(p);
    if(!content)throw Error('Synthetic missing input');
    return {type:'file',encoding:'base64',size:content.length,content:content.toString('base64')};
  };
  return {inputs,manifest,files,calls,get};
}
test('readiness proof binds exact inputs and routing; unsafe/legacy/prohibited work is refused',()=>{
  const f=fixture();assert.equal(validateReadyManifest(f.manifest,ID).routing.controller,'claude');
  for(const mutate of [
    m=>m.inputs[0].path='../secret',m=>m.inputs[0].sha256='bad',m=>m.inputs.push(m.inputs[0]),
    m=>m.routing={mode:'auto',controller:'claude'},m=>m.extra='untrusted',m=>m.taskId='other',
    m=>m.inputs[1]={...m.inputs[1],kind:['image'],path:'docs/orchestrator/media/'+ID+'.png'}
  ]){const m=structuredClone(f.manifest);mutate(m);assert.throws(()=>validateReadyManifest(m,ID));}
  assert.throws(()=>validateReadyManifest({},ID));
  assert.throws(()=>createReadyManifest('20261115T121256Z-10360-7098',{mode:'auto',controller:'auto'},f.inputs));
});
test('receiver pins queue commit, validates bytes, and commits a private received receipt without any execution',async()=>{
  const root=await mkdtemp(join(tmpdir(),'private-receipt-')),f=fixture();
  try{
    const receipt=await receivePrivateTask({id:ID,root,get:f.get});
    assert.equal(receipt.phase,'received');assert.equal(receipt.queueCommitSha,SHA);
    const index=JSON.parse(await readFile(join(root,ID+'.json'),'utf8'));
    assert.equal(index.phase,'received');assert.equal(index.routing.controller,'claude');
    assert.equal((await readLocalReceipt({id:ID,root})).phase,'received');
    assert.ok(!JSON.stringify(receipt).includes('SYNTHETIC_PRIVATE_TASK'));
    const stored=join(root,index.bundleDirectory,'task-private',f.inputs[0].path);
    assert.equal(await readFile(stored,'utf8'),'SYNTHETIC_PRIVATE_TASK');
    assert.equal((await lstat(stored)).mode&0o777,0o600);
    assert.equal((await lstat(join(root,index.bundleDirectory))).mode&0o777,0o700);
    await assert.rejects(receivePrivateTask({id:ID,root,get:f.get}));
  }finally{await rm(root,{recursive:true,force:true});}
});
test('Git working trees and forged validation status cannot become private receipt stores',async()=>{
  const root=await mkdtemp(join(tmpdir(),'private-receipt-')),f=fixture();
  try{
    await mkdir(join(root,'.git'));await writeFile(join(root,'.git','HEAD'),'ref: refs/heads/main\n');
    await assert.rejects(receivePrivateTask({id:ID,root:join(root,'state'),get:f.get}));
    await rm(join(root,'.git'),{recursive:true});
    await receivePrivateTask({id:ID,root,get:f.get});
    const index=JSON.parse(await readFile(join(root,ID+'.json'),'utf8'));index.phase='validated';
    await writeFile(join(root,ID+'.json'),JSON.stringify(index));
    await assert.rejects(readLocalReceipt({id:ID,root}));
  }finally{await rm(root,{recursive:true,force:true});}
});
test('a nonsticky writable ancestor cannot redirect private receipt writes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'private-receipt-')),f=fixture();
  try{
    const insecure=join(root,'insecure');await mkdir(insecure,{mode:0o777});
    const {chmod}=await import('node:fs/promises');await chmod(insecure,0o777);
    await assert.rejects(receivePrivateTask({id:ID,root:join(insecure,'state'),get:f.get}));
  }finally{await rm(root,{recursive:true,force:true});}
});
test('public repository, tampered bytes or incomplete inputs produce no receipt',async()=>{
  for(const reason of ['public','tampered','partial']){
    const root=await mkdtemp(join(tmpdir(),'private-receipt-')),f=fixture();
    try{
      if(reason==='tampered')f.files.set(f.inputs[0].path,Buffer.from('MODIFIED'));
      if(reason==='partial')f.files.delete(f.inputs[0].path);
      const get=reason==='public'?async()=>({private:false,full_name:'skj04327/the-twilight-of-korea'}):f.get;
      await assert.rejects(receivePrivateTask({id:ID,root,get}));
      assert.deepEqual(await readdir(root),[]);
    }finally{await rm(root,{recursive:true,force:true});}
  }
});
test('competing receipts have exactly one winner and symlink roots cannot redirect private writes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'private-receipt-')),f=fixture();
  try{
    const results=await Promise.allSettled([1,2].map(()=>receivePrivateTask({id:ID,root,get:f.get})));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal((await readdir(root)).filter(p=>p.startsWith('.receive-')).length,1);
    await mkdir(join(root,'real'));await symlink(join(root,'real'),join(root,'alias'));
    await assert.rejects(receivePrivateTask({id:ID,root:join(root,'alias'),get:f.get}));
  }finally{await rm(root,{recursive:true,force:true});}
});
