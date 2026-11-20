// Prepare, status and completed candidate import. No live run switch or executable argument.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {addAbortSignal} from 'node:stream';
import {prepareLocalJob,readLocalJob} from './local-jobs.mjs';
import {openDiskBaseline} from './disk-baseline.mjs';
import {MAX_HANDOFF_BYTES} from './private-handoff.mjs';
import {submitLocalCandidate} from './local-candidate-intake.mjs';

async function readResponse(signal){
  const chunks=[];let size=0;
  for await(const chunk of addAbortSignal(AbortSignal.any([signal,AbortSignal.timeout(30000)]),process.stdin)){
    size+=chunk.length;
    if(size>MAX_HANDOFF_BYTES)throw Error('Candidate response too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks,size);
}

async function main(){
  if(process.env.GITHUB_ACTIONS==='true')throw Error('Local host required');
  const [command,id,stateRoot,inputRoot,baseSha,publicKey]=process.argv.slice(2);
  let job;
  if(command==='prepare'&&process.argv.length===6)job=await prepareLocalJob({id,stateRoot,receiptRoot:inputRoot});
  else if(command==='status'&&process.argv.length===5)job=await readLocalJob({id,stateRoot});
  else if(command==='submit-candidate'&&process.argv.length===8){
    const abort=new AbortController(),cancel=()=>abort.abort();
    process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
    try{
      const response=await readResponse(abort.signal);
      const diskSnapshot=await openDiskBaseline({root:inputRoot,baseSha,signal:abort.signal});
      job=await submitLocalCandidate({id,stateRoot,diskSnapshot,publicKey,response,signal:abort.signal});
    }finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
  }
  else throw Error('Unsupported local job command');
  console.log(JSON.stringify(job));
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  main().catch(()=>{console.error('RESULT: LOCAL_JOB_FAILED');process.exitCode=1;});
}
