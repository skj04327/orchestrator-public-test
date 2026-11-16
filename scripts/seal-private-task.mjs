// Worker-side exporter. This job never receives PRIVATE_GAME_WRITE_TOKEN.
import {readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {contextFromEnv,seal} from './private-handoff.mjs';
import {captureBundle} from './private-task-bundle.mjs';
async function main(){
  const output='.private-handoff.enc';
  await rm(output,{force:true});
  if(process.env.PRIVATE_GAME_WRITE_TOKEN)throw Error('Write credential in execution environment');
  const context=contextFromEnv();
  const executionOutcome=process.env.EXECUTION_OUTCOME;
  let audit=null;
  try{audit=JSON.parse(await readFile(join(process.env.ORCHESTRATOR_AUDIT_DIR,context.taskId+'.json'),'utf8'));}catch{}
  const result=executionOutcome==='success'?JSON.parse(await readFile('.private-task-result.json','utf8')):null;
  const bundle=await captureBundle({context,executionOutcome,result,audit,baseSha:result?.baseSha,
    root:join(process.cwd(),'private-game')});
  await writeFile(output,seal(bundle,process.env.HANDOFF_PUBLIC_KEY,context),{mode:0o600,flag:'wx'});
  console.log('STATUS: ENCRYPTED_HANDOFF_READY');
}
main().catch(()=>{console.error('RESULT: HANDOFF_FAILED');process.exitCode=1;});
