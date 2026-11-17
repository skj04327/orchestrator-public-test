// Prepare/status only: no live run switch or user-selected executable.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {prepareLocalJob,readLocalJob} from './local-jobs.mjs';
async function main(){
  if(process.env.GITHUB_ACTIONS==='true')throw Error('Local host required');
  const [command,id,stateRoot,receiptRoot]=process.argv.slice(2);
  let job;
  if(command==='prepare'&&process.argv.length===6)job=await prepareLocalJob({id,stateRoot,receiptRoot});
  else if(command==='status'&&process.argv.length===5)job=await readLocalJob({id,stateRoot});
  else throw Error('Unsupported local job command');
  console.log(JSON.stringify(job));
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  main().catch(()=>{console.error('RESULT: LOCAL_JOB_FAILED');process.exitCode=1;});
}
