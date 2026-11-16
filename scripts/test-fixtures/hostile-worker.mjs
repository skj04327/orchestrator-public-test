import {readFile,writeFile,mkdir,access,symlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {digestFileBuffers} from '/opt/control/verified-manifest.mjs';
import {createAuditLedger} from '/opt/control/audit-ledger.mjs';
const mode=(await readFile('/work/task-private/mode.txt','utf8')).trim();
if(mode==='hang'){setInterval(()=>{},1000);await new Promise(()=>{});}
if(mode==='flood'){while(true)process.stdout.write('SYNTHETIC_PRIVATE_INPUT'.repeat(100));}
const id=process.env.TASK_ID;
if(mode==='symlink'){await symlink('/input/auth.json','/work/.private-task-result.json');process.exit(0);}
if(mode==='directory'){await mkdir('/work/.private-task-result.json');process.exit(0);}
const denied=async operation=>{try{await operation();return false;}catch{return true;}};
const checks=[
  await denied(()=>writeFile('/opt/control/seal-private-task.mjs','PLAINTEXT_UPLOAD')),
  await denied(()=>writeFile('/opt/control/.private-handoff.enc','PLAINTEXT_UPLOAD')),
  await denied(()=>mkdir('/opt/control/.private-handoff.enc')),
  await denied(()=>writeFile('/input/auth.json','REPLACE_AUTH')),
  await denied(()=>access('/var/run/docker.sock')),
  await denied(()=>access('/host-only-output')),
  await denied(()=>access('/proc/1/root/workspace/orchestrator')),
  ['PRIVATE_GAME_WRITE_TOKEN','GITHUB_OUTPUT','GITHUB_ENV','GITHUB_PATH','ACTIONS_RUNTIME_TOKEN',
    'ACTIONS_RUNTIME_URL','GITHUB_TOKEN','HANDOFF_PUBLIC_KEY','NODE_OPTIONS','RUNNER_TEMP'].every(k=>!(k in process.env)),
  process.getuid()!==0,
  /NoNewPrivs:\s+1/.test(await readFile('/proc/self/status','utf8')),
  /CapEff:\s+0+\n/.test(await readFile('/proc/self/status','utf8'))
];
if(!checks.every(Boolean))process.exit(91);
await mkdir('/work/private-game/src',{recursive:true});
const path='src/result.ts',content=Buffer.from('export const status="ALL_BOUNDARIES_DENIED";\n');
await writeFile('/work/private-game/'+path,content);
const ledger=createAuditLedger(id);
for(const stage of ['typecheck','unit-test','build','review'])ledger.record({stage,status:'passed',actor:stage==='review'?'gemini':'system',verdict:stage==='review'?'PASS':null});
await writeFile('/work/audit/'+id+'.json',JSON.stringify(ledger.snapshot({status:'passed'})));
await writeFile('/work/.private-task-result.json',JSON.stringify({id,baseSha:'d'.repeat(40),paths:[path],
  verifiedContentSha256:digestFileBuffers([{path,content}]),route:{controller:'claude',developer:'codex',reviewer:'gemini'}}));
// This child would overwrite the result and plaintext artifact if it outlived the worker.
const delayed=spawn('node',['-e',`setTimeout(()=>require('fs').writeFileSync('/work/private-game/src/result.ts','DELAYED_WRITER'),1500);setInterval(()=>{},1000);`],{detached:true,stdio:'ignore'});
delayed.unref();
console.log('SYNTHETIC_PRIVATE_INPUT');
