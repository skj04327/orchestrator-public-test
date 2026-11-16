import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {validateReadyManifest} from './private-queue.mjs';
const exec=promisify(execFile),AI=resolve('termux/ai'),RECEIVE=resolve('scripts/private-queue-cli.mjs');
async function setup(options={}){
  const root=await mkdtemp(join(tmpdir(),'private-queue-cli-')),bin=join(root,'bin'),store=join(root,'store.json'),log=join(root,'calls');
  await mkdir(bin);await writeFile(store,'{}');await writeFile(log,'');
  const gh=join(bin,'gh');await writeFile(gh,await readFile('scripts/test-fixtures/mock-private-queue-gh.mjs'));await chmod(gh,0o755);
  await writeFile(join(bin,'queue-config.json'),JSON.stringify({store,log,...options}));
  return {root,store,log,env:{...process.env,PATH:bin+':'+process.env.PATH,GITHUB_ACTIONS:''}};
}
test('actual Termux intake saves ready proof last, never dispatches public Actions, and actual local CLI receives it',async()=>{
  const f=await setup();
  try{
    const png=join(f.root,'image.png');
    await writeFile(png,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=','base64'));
    const run=await exec('bash',[AI,'--controller','claude','--reference','https://en.wikipedia.org/wiki/Goryeo','--image',png,'SYNTHETIC_PRIVATE_TASK'],{env:f.env});
    assert.ok(!run.stdout.includes('SYNTHETIC_PRIVATE_TASK'));
    const calls=(await readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(calls.every(c=>c.command==='api'),'No public workflow command is allowed');
    const writes=calls.filter(c=>c.method==='PUT');assert.equal(writes.length,4);
    assert.match(writes.at(-1).endpoint,/\/requests\//);
    const store=JSON.parse(await readFile(f.store,'utf8'));
    const path=Object.keys(store).find(p=>p.includes('/requests/')),manifest=JSON.parse(Buffer.from(store[path],'base64'));
    const id=manifest.taskId;validateReadyManifest(manifest,id);
    assert.equal(manifest.routing.controller,'claude');
    const state=join(f.root,'private-state');
    const received=await exec(process.execPath,[RECEIVE,'receive',id,state],{env:f.env});
    assert.equal(JSON.parse(received.stdout).phase,'received');assert.ok(!received.stdout.includes('SYNTHETIC_PRIVATE_TASK'));
    const status=await exec(process.execPath,[RECEIVE,'status',id,state],{env:f.env});assert.equal(JSON.parse(status.stdout).phase,'received');
    await assert.rejects(exec(process.execPath,[RECEIVE,'receive',id,state],{env:f.env}));
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('partial upload has no ready marker; public repo and CI retrieval fail without private side effects',async()=>{
  for(const options of [{failKind:'references'},{public:true}]){
    const f=await setup(options);
    try{
      await assert.rejects(exec('bash',[AI,'--reference','https://en.wikipedia.org/wiki/Goryeo','SYNTHETIC_PRIVATE_TASK'],{env:f.env}));
      const store=JSON.parse(await readFile(f.store,'utf8'));assert.ok(!Object.keys(store).some(p=>p.includes('/requests/')));
      if(options.public)assert.deepEqual(store,{});
    }finally{await rm(f.root,{recursive:true,force:true});}
  }
  const f=await setup();
  try{
    await assert.rejects(exec('bash',[AI,'SYNTHETIC_PRIVATE_TASK'],{env:{...f.env,GITHUB_ACTIONS:'true'}}));
    assert.equal(await readFile(f.log,'utf8'),'');
    await assert.rejects(exec(process.execPath,[RECEIVE,'receive','20261116T120000Z-123-456',join(f.root,'state')],{env:{...f.env,GITHUB_ACTIONS:'true'}}));
    assert.equal(await readFile(f.log,'utf8'),'');
    await assert.rejects(exec(process.execPath,[RECEIVE,'receive','20261115T121256Z-10360-7098',join(f.root,'state')],{env:f.env}));
    assert.equal(await readFile(f.log,'utf8'),'');
  }finally{await rm(f.root,{recursive:true,force:true});}
});
