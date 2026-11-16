// Trusted key-only job: never checks out task queue/game or runs generated code.
import {appendFile} from 'node:fs/promises';
import {contextFromEnv,recipientKey} from './private-handoff.mjs';
try{
  const context=contextFromEnv();
  if(context.taskId==='20261115T121256Z-10360-7098')throw Error('Blocked old task');
  if(!process.env.GITHUB_OUTPUT)throw Error('Missing Actions output');
  const {publicKey}=recipientKey(process.env.PRIVATE_GAME_WRITE_TOKEN,context);
  await appendFile(process.env.GITHUB_OUTPUT,'public_key='+publicKey+'\n');
  console.log('STATUS: RECIPIENT_PUBLIC_KEY_READY');
}catch{console.error('RESULT: HANDOFF_KEY_FAILED');process.exitCode=1;}
