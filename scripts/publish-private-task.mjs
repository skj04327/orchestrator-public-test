// TRUSTED runner only: decrypt/validate data, never execute a game checkout or its tools.
import {open as openFile,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {contextFromEnv,recipientKey,open,MAX_HANDOFF_BYTES} from './private-handoff.mjs';
import {validateBundle} from './private-task-bundle.mjs';
import {writePrivateAuditReport} from './audit-ledger.mjs';

const REPO='https://api.github.com/repos/skj04327/the-twilight-of-korea';
async function readEncryptedFile(){
  const file=await openFile(process.env.ORCHESTRATOR_HANDOFF_FILE||'.private-handoff.enc',constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const stat=await file.stat();
    if(!stat.isFile()||stat.size>MAX_HANDOFF_BYTES)throw Error('Unsafe handoff file');
    const bytes=Buffer.alloc(MAX_HANDOFF_BYTES+1);
    const {bytesRead}=await file.read(bytes,0,bytes.length,0);
    if(bytesRead>MAX_HANDOFF_BYTES)throw Error('Oversized handoff');
    return bytes.subarray(0,bytesRead);
  }finally{await file.close();}
}
async function main(){
  const context=contextFromEnv(),token=process.env.PRIVATE_GAME_WRITE_TOKEN;
  const key=recipientKey(token,context);
  const payload=open(await readEncryptedFile(),key.privateKey,context);
  if(payload.executionOutcome!==process.env.EXECUTION_OUTCOME)throw Error('Worker outcome mismatch');
  const bundle=validateBundle(payload,context);
  if(!process.env.ORCHESTRATOR_AUDIT_DIR)throw Error('Missing private report directory');
  await writePrivateAuditReport(process.env.ORCHESTRATOR_AUDIT_DIR,bundle.audit);
  if(!bundle.result)throw Error('Execution did not pass');
  const {files,result:report,baseSha}=bundle;
  async function request(method,path,payload){
    return fetch(REPO+path,{
      method,redirect:'error',signal:AbortSignal.timeout(30000),
      headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},
      body:payload===undefined?undefined:JSON.stringify(payload)
    });
  }
  async function api(method,path,payload){
    const response=await request(method,path,payload);
    if(!response.ok)throw Error('GitHub request failed');
    return response.json();
  }
  const main=await api('GET','/git/ref/heads/main');
  if(main.object.sha!==baseSha)throw Error('Main moved since validation');
  const oldFiles=new Map();
  for(const {path} of files){
    const response=await request('GET','/contents/'+path+'?ref='+baseSha);
    if(response.status!==200&&response.status!==404)throw Error('Cannot inspect destination');
    const old=response.status===200?await response.json():null;
    if(path.startsWith('tests/')&&old)throw Error('Existing tests cannot be modified');
    oldFiles.set(path,old);
  }
  const branch='orchestrator/task-'+context.taskId;
  await api('POST','/git/refs',{ref:'refs/heads/'+branch,sha:baseSha});
  for(const {path,content} of files){
    const payload={message:'feat: AI-assisted task '+context.taskId,branch,content:content.toString('base64')};
    if(oldFiles.get(path))payload.sha=oldFiles.get(path).sha;
    await api('PUT','/contents/'+path,payload);
  }
  const pr=await api('POST','/pulls',{
    title:'AI task '+context.taskId,head:branch,base:'main',draft:true,
    body:'Private Termux task '+context.taskId+'; control tower: '+report.route.controller+
      ', developer: Codex, independent reviewer: '+report.route.reviewer+
      '. Worker reported successful typecheck, full unit tests, production build and independent review. '+
      'Publisher rechecked the encrypted snapshot SHA-256. Human review required. No automatic merge.'
  });
  if(!/^https:\/\/github\.com\/skj04327\/the-twilight-of-korea\/pull\/\d+$/.test(pr.html_url))throw Error('Invalid private PR URL');
  await writeFile('.private-task-pr.json',JSON.stringify({prUrl:pr.html_url}),{mode:0o600});
  console.log('RESULT: DRAFT_PR_CREATED '+pr.html_url);
}
main().catch(()=>{
  console.error('RESULT: PUBLISH_FAILED');process.exitCode=1;
});
