import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  normalizePublicUrl,normalizeReferenceList,fetchPublicReference,readTaskReferences,
  loadPublicReferences,findTaskImage,buildReferenceContext,describeTaskImage
} from './reference-gateway.mjs';
const ID='20261115T121256Z-10360-7098';
test('URL allowlist rejects private addresses, HTTP, redirects and credentials',()=>{
  assert.match(normalizePublicUrl('https://ko.wikipedia.org/wiki/%EA%B3%A0%EB%A0%A4'),/^https:/);
  for(const url of [
    'http://en.wikipedia.org/wiki/Goryeo','https://127.0.0.1/a','https://169.254.169.254/latest/meta-data',
    'https://en.wikipedia.org.evil.test/a','https://name:pw@en.wikipedia.org/wiki/a',
    'https://en.wikipedia.org:8443/wiki/a','file:///etc/passwd',
    'https://en.wikipedia.org/wiki/a?token=SECRET'
  ])assert.throws(()=>normalizePublicUrl(url));
  assert.throws(()=>normalizeReferenceList(['https://en.wikipedia.org/wiki/A','https://en.wikipedia.org/wiki/A']));
  assert.throws(()=>normalizeReferenceList([1]));
});
test('bounded HTML read with no authorization header; strips active HTML',async()=>{
  const url='https://en.wikipedia.org/wiki/Goryeo';
  let seen;
  const got=await fetchPublicReference(url,async(u,opts)=>{
    seen={u,opts};
    return new Response('<script>attack()</script><h1>History</h1> &amp; geography',
      {headers:{'content-type':'text/html'}});
  });
  assert.equal(seen.u,url);
  assert.equal(seen.opts.redirect,'error');
  assert.equal(seen.opts.credentials,'omit');
  assert.ok(!JSON.stringify(seen.opts).includes('Authorization'));
  assert.equal(got.text,'History & geography');
  await assert.rejects(fetchPublicReference(url,async()=>new Response('hello',{headers:{'content-type':'application/json'}})));
  await assert.rejects(fetchPublicReference(url,async()=>new Response('x'.repeat(120001),{headers:{'content-type':'text/plain'}})));
});
test('private metadata uses only validated URLs, does not read missing file',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ref-test-'));
 try{
  assert.deepEqual(await readTaskReferences(root,ID),[]);
  const dir=join(root,'docs','orchestrator','references');
  await mkdir(dir,{recursive:true});
  await writeFile(join(dir,ID+'.json'),JSON.stringify({version:1,urls:['https://ko.wikipedia.org/wiki/Goryeo']}));
  const refs=await loadPublicReferences(root,ID,{fetcher:async()=>new Response('History',{headers:{'content-type':'text/plain'}})});
  const c=buildReferenceContext(refs,'A village has a river');
  assert.match(c,/UNTRUSTED/);
  assert.match(c,/History/);
  assert.match(c,/river/);
  await writeFile(join(dir,ID+'.json'),JSON.stringify({version:1,urls:['http://localhost']})); 
  await assert.rejects(readTaskReferences(root,ID));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('image validates PNG dimensions, caps size, and rejects symlinks',async()=>{
 const root=await mkdtemp(join(tmpdir(),'image-test-'));
 try{
  const dir=join(root,'docs','orchestrator','media');await mkdir(dir,{recursive:true});
  const buf=Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a','hex').copy(buf);
  buf.writeUInt32BE(13,8);buf.write('IHDR',12);
  buf.writeUInt32BE(200,16);buf.writeUInt32BE(100,20);
  await writeFile(join(dir,ID+'.png'),buf);
  const image=await findTaskImage(root,ID);
  assert.equal(image.width,200);assert.equal(image.height,100);
  await writeFile(join(dir,ID+'.png'),Buffer.concat([buf,Buffer.alloc(700000)]));
  await assert.rejects(findTaskImage(root,ID));
  await rm(join(dir,ID+'.png'));
  await symlink('/etc/passwd',join(dir,ID+'.jpg'));
  await assert.rejects(findTaskImage(root,ID));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('private reference image is passed as one actual Codex image attachment',async()=>{
 const img={path:'/fixture/reference.png'};
 let call;
 const out=await describeTaskImage(img,async(bin,args,opts)=>{
  call={bin,args,opts};return 'Buildings line a road.';
 });
 assert.equal(out,'Buildings line a road.');
 assert.equal(call.bin,'codex');
 assert.ok(call.args.includes('--image'));
 assert.ok(call.args.includes('/fixture/reference.png'));
 assert.equal(call.opts.timeout,120000);
 await assert.rejects(describeTaskImage(img,async()=>'')); 
});
