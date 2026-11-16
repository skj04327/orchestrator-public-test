// Trusted host entrypoint. Raw worker/Docker output never reaches Actions logs.
import {mkdir,writeFile,appendFile,lstat} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {contextFromEnv} from './private-handoff.mjs';
import {runProtectedTask} from './protected-worker.mjs';
const abort=new AbortController();
process.once('SIGTERM',()=>abort.abort());process.once('SIGINT',()=>abort.abort());
try{
  if(process.env.PRIVATE_GAME_WRITE_TOKEN||!process.env.RUNNER_TEMP||!process.env.GITHUB_OUTPUT)
    throw Error('Invalid trusted host context');
  const decode=name=>{
    const value=process.env[name];
    if(typeof value!=='string'||value.length>120000||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)||!value)
      throw Error('Missing valid subscriber auth');
    const bytes=Buffer.from(value,'base64');if(bytes.toString('base64')!==value)throw Error('Invalid auth encoding');
    return bytes.toString('utf8');
  };
  const auth={codex:decode('CODEX_AUTH_JSON_B64'),gemini:decode('ANTIGRAVITY_OAUTH_B64'),claude:process.env.CLAUDE_CODE_OAUTH_TOKEN};
  if(!auth.claude)throw Error('Missing subscriber auth');
  const result=await runProtectedTask({context:contextFromEnv(),imageId:process.env.ORCHESTRATOR_WORKER_IMAGE_ID,
    controlDir:dirname(fileURLToPath(import.meta.url)),gameDir:resolve('private-game'),queueDir:resolve('task-private'),
    publicKey:process.env.HANDOFF_PUBLIC_KEY,auth,network:'bridge',
    routingMode:process.env.ORCHESTRATOR_ROUTING_MODE||'auto',controller:process.env.ORCHESTRATOR_CONTROLLER||'auto',signal:abort.signal});
  if(abort.signal.aborted)throw Error('Cancelled before handoff');
  const dir=join(process.env.RUNNER_TEMP,'protected-handoff');
  await mkdir(dir,{mode:0o700});
  const stat=await lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Unsafe host output directory');
  await writeFile(join(dir,'bundle.enc'),result.encrypted,{flag:'wx',mode:0o600});
  await appendFile(process.env.GITHUB_OUTPUT,'handoff_ready=true\n');
  console.log('STATUS: PROTECTED_WORKER_'+(result.executionOutcome==='success'?'PASSED':'FAILED'));
  if(result.executionOutcome!=='success')process.exitCode=1;
}catch{
  console.error('RESULT: PROTECTED_WORKER_FAILED');process.exitCode=1;
}
