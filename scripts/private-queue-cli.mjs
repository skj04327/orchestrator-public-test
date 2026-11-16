// Local receipt only; never run private queue retrieval in public Actions.
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PRIVATE_QUEUE_REPO,receivePrivateTask,readLocalReceipt,validateQueueTaskId} from './private-queue.mjs';
export function ghQueueGet(path){
  if(path!==''&&path!=='/git/ref/heads/orchestrator/task-queue'&&
    !/^\/contents\/docs\/orchestrator\/(requests|tasks|references|media)\/[0-9]{8}T[0-9]{6}Z-[0-9]+-[0-9]+\.(txt|json|png|jpg|jpeg)\?ref=[a-f0-9]{40}$/.test(path))
    return Promise.reject(Error('Unavailable queue endpoint'));
  return new Promise((done,reject)=>{
    const env={GH_NO_UPDATE_NOTIFIER:'1',GH_PROMPT_DISABLED:'1'};
    for(const key of ['PATH','HOME','XDG_CONFIG_HOME','GH_CONFIG_DIR','GH_TOKEN','GITHUB_TOKEN',
      'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','SSL_CERT_FILE','SSL_CERT_DIR'])
      if(process.env[key]!==undefined)env[key]=process.env[key];
    const p=spawn('gh',['api','--hostname','github.com','-X','GET','repos/'+PRIVATE_QUEUE_REPO+path],{env,stdio:['ignore','pipe','pipe']});
    let bytes=0,chunks=[],limited=false;
    const timer=setTimeout(()=>{limited=true;p.kill('SIGKILL');},30000);
    const collect=(data,out)=>{bytes+=data.length;if(bytes>1100000){limited=true;p.kill('SIGKILL');}else if(out)chunks.push(data);};
    p.stdout.on('data',d=>collect(d,true));p.stderr.on('data',d=>collect(d,false));
    p.on('error',()=>{clearTimeout(timer);reject(Error('Private queue unavailable'));});
    p.on('close',code=>{clearTimeout(timer);if(code!==0||limited){reject(Error('Private queue unavailable'));return;}
      try{done(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(Error('Invalid private queue response'));}
    });
  });
}
async function main(){
  if(process.env.GITHUB_ACTIONS==='true'||process.argv.length!==5)throw Error('Local receipt context required');
  const [command,id,root]=process.argv.slice(2);validateQueueTaskId(id);
  if(!['receive','status'].includes(command))throw Error('Unsupported receipt command');
  const receipt=command==='receive'?await receivePrivateTask({id,root,get:ghQueueGet}):await readLocalReceipt({id,root});
  // Safe metadata only. No prompt, reference content, image or credential output.
  console.log(JSON.stringify({taskId:receipt.taskId,phase:receipt.phase,queueCommitSha:receipt.queueCommitSha,routing:receipt.routing}));
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  main().catch(()=>{console.error('RESULT: PRIVATE_QUEUE_RECEIPT_FAILED');process.exitCode=1;});
}
