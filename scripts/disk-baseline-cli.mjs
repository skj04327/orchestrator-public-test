// Local capture/status only. No worker execution, provider or publication switch.
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {lstat} from 'node:fs/promises';
import {ensurePrivateStateRoot} from './private-queue.mjs';
import {collectDiskBaseline,openDiskBaseline} from './disk-baseline.mjs';
import {ghBaselineGet} from './pinned-baseline-cli.mjs';
async function main(){
  if(process.env.GITHUB_ACTIONS==='true')throw Error('Local host required');
  const [command,root,baseSha]=process.argv.slice(2);let result;
  if(['capture','capture-data'].includes(command)&&process.argv.length===4){
    let last=0;
    result=await collectDiskBaseline({root,get:ghBaselineGet,purpose:command==='capture-data'?'data-only':'checks',onProgress:p=>{
      if(p.completedBlobs===p.totalBlobs||Date.now()-last>5000){last=Date.now();console.error('STATUS: DISK_BLOBS '+p.completedBlobs+'/'+p.totalBlobs);}
    }});
  }else if(command==='status'&&process.argv.length===5&&/^[a-f0-9]{40}$/.test(baseSha)){
    const directory=await ensurePrivateStateRoot(root);let exists=true;
    try{await lstat(join(directory,baseSha+'.json'));}catch(e){if(e.code!=='ENOENT')throw e;exists=false;}
    if(exists){const snapshot=await openDiskBaseline({root:directory,baseSha});result={phase:snapshot.executionEligible?'captured-disk':'captured-data-only',...snapshot};}
    else{let claimed=true;try{await lstat(join(directory,baseSha+'.claim'));}catch(e){if(e.code!=='ENOENT')throw e;claimed=false;}
      result={phase:claimed?'running-or-needs-recovery':'not-captured',baseSha};}
  }else throw Error('Unsupported disk baseline command');
  console.log(JSON.stringify({phase:result.phase,baseSha:result.baseSha,fileCount:result.fileCount,totalBytes:result.totalBytes,publishAuthorized:false}));
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)
  main().catch(()=>{console.error('RESULT: DISK_BASELINE_FAILED');process.exitCode=1;});
