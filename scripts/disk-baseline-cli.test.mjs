import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {gitBaselineFixture} from './test-fixtures/git-baseline.mjs';
const exec=promisify(execFile),file=(path,content)=>({path,content:Buffer.from(content).toString('base64')});
test('actual disk CLI captures and verifies metadata without printing source; CI/run/extra args make no calls',async()=>{
  const root=await mkdtemp(join(tmpdir(),'disk-cli-'));
  try{
    const f=await gitBaselineFixture({files:[file('package.json','{}'),file('package-lock.json','{}'),file('src/a.ts','SYNTHETIC_PRIVATE_DISK_SOURCE')]}),store=join(root,'store'),log=join(root,'calls');
    await writeFile(store,JSON.stringify(Object.fromEntries(f.values)));await writeFile(log,'');
    await writeFile(join(root,'gh'),`#!/usr/bin/env node
import {readFileSync,appendFileSync} from 'node:fs';const a=process.argv.slice(2);
if(a[0]!=='api'||a[1]!=='--hostname'||a[2]!=='github.com'||a[3]!=='-X'||a[4]!=='GET')process.exit(91);
const route=a.at(-1);if(!route.startsWith('repos/skj04327/the-twilight-of-korea'))process.exit(92);
const path=route.slice('repos/skj04327/the-twilight-of-korea'.length),v=JSON.parse(readFileSync(${JSON.stringify(store)},'utf8'))[path];
appendFileSync(${JSON.stringify(log)},path+'\\n');if(!v)process.exit(93);if(a.includes('-H'))process.stdout.write(Buffer.from(v.content,'base64'));else console.log(JSON.stringify(v));`);
    await chmod(join(root,'gh'),0o755);const env={...process.env,PATH:root+':'+process.env.PATH,GITHUB_ACTIONS:''},cli=resolve('scripts/disk-baseline-cli.mjs'),cache=join(root,'cache');
    const capture=await exec(process.execPath,[cli,'capture',cache],{env}),r=JSON.parse(capture.stdout);
    assert.equal(r.phase,'captured-disk');assert.equal(r.baseSha,f.baseSha);assert.equal(r.publishAuthorized,false);
    assert.ok(!capture.stdout.includes('SYNTHETIC_PRIVATE_DISK_SOURCE'));assert.ok(!capture.stderr.includes('src/a.ts'));
    const status=JSON.parse((await exec(process.execPath,[cli,'status',cache,f.baseSha],{env})).stdout);
    assert.equal(status.phase,'captured-disk');const calls=await readFile(log,'utf8');
    for(const args of [['run',cache],['capture',cache,'extra']])await assert.rejects(exec(process.execPath,[cli,...args],{env}));
    await assert.rejects(exec(process.execPath,[cli,'capture',cache],{env:{...env,GITHUB_ACTIONS:'true'}}));assert.equal(await readFile(log,'utf8'),calls);
    const projected=await gitBaselineFixture({files:[file('package.json','{}'),file('package-lock.json','{}'),file('.codex/config.toml','SYNTHETIC_EXCLUDE')]});
    await writeFile(store,JSON.stringify(Object.fromEntries(projected.values)));
    await writeFile(log,'');
    const preflight=JSON.parse((await exec(process.execPath,[cli,'preflight'],{env})).stdout);
    assert.equal(preflight.phase,'projection-available');
    assert.doesNotMatch(await readFile(log,'utf8'),/blobs/);
    const projectedRoot=join(root,'projected');
    const result=JSON.parse((await exec(process.execPath,[cli,'capture-projected',projectedRoot,preflight.projectionSha256],{env})).stdout);
    assert.equal(result.phase,'captured-projected');
    assert.equal(result.excludedFileCount,1);
    const latest=JSON.parse((await exec(process.execPath,[cli,'status',projectedRoot,projected.baseSha],{env})).stdout);
    assert.equal(latest.phase,'captured-projected');
    assert.equal(latest.projectionSha256,preflight.projectionSha256);
    assert.doesNotMatch(await readFile(log,'utf8'),new RegExp(projected.entries.find(entry=>entry.path==='.codex/config.toml').sha));

  }finally{await rm(root,{recursive:true,force:true});}
});
