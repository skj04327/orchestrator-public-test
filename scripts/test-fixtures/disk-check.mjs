// Synthetic host-only disk input; never reads private game data.
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {gitBaselineFixture} from './git-baseline.mjs';
import {independentProject} from './independent-project.mjs';
import {collectDiskBaseline} from '../disk-baseline.mjs';
import {digestFileBuffers} from '../verified-manifest.mjs';
export const diskContext={kind:'local',schemaVersion:2,taskId:'20261118T130000Z-123-456',runId:'12345678-1234-4234-8234-123456789abc',queueCommitSha:'e'.repeat(40),receiptSha256:'f'.repeat(64)};
export const encoded=(path,b)=>({path,content:Buffer.from(b).toString('base64')});
export function replaceCandidate(bundle,files){bundle.files=files;bundle.result.paths=files.map(f=>f.path);bundle.result.verifiedContentSha256=digestFileBuffers(files.map(f=>({path:f.path,content:Buffer.from(f.content,'base64')})));}
export async function diskCheckFixture(root,{context=diskContext,extra=[],purpose='checks',transform,...options}={}){
  const p=independentProject(context,options);p.baseline.files.push(...extra);if(transform)transform(p.baseline);
  const source=await gitBaselineFixture(p.baseline);
  p.bundle.baseSha=source.baseSha;p.bundle.result.baseSha=source.baseSha;
  const collected=await collectDiskBaseline({root:join(root,'cache'),get:source.get,purpose,streamBlob:async({sha,destination})=>writeFile(destination,Buffer.from(source.values.get('/git/blobs/'+sha).content,'base64'),{flag:'wx',mode:0o600})});
  return {source,bundle:p.bundle,snapshot:collected.snapshot,diskSnapshot:collected.snapshot,context};
}
