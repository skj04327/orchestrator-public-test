// Fixed private raw GET. Source bytes are never collected in an output string.
import {spawn} from 'node:child_process';
import {open,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {ensurePrivateStateRoot} from './private-queue.mjs';
import {ghPrivateEnvironment} from './gh-private-environment.mjs';
import {BASELINE_REPOSITORY} from './main-inventory.mjs';
export const MAX_DISK_BLOB=128*1024*1024;
function failure(kind){const e=Error('Private blob transfer failed');e.failureKind=kind;return e;}
export async function fetchGitBlobToFile({sha,size,destination,signal,timeoutMs=180000}){
  if(process.env.GITHUB_ACTIONS==='true'||typeof sha!=='string'||! /^[a-f0-9]{40}$/.test(sha)||
    !Number.isSafeInteger(size)||size<0||size>MAX_DISK_BLOB||typeof destination!=='string'||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>180000)throw failure('invalid_configuration');
  if(signal?.aborted)throw failure('cancelled');
  const deadline=Date.now()+timeoutMs;
  function checkStopped(){if(signal?.aborted)throw failure('cancelled');if(Date.now()>=deadline)throw failure('timeout');}
  await ensurePrivateStateRoot(dirname(destination));
  checkStopped();
  const file=await open(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  let child,timer,closed,stop,kind=null,count=0,maxChunkBytes=0,stderrBytes=0,success=false;
  const hash1=createHash('sha1').update('blob '+size+'\0'),hash256=createHash('sha256');
  try{
    checkStopped();
    child=spawn('gh',['api','--hostname','github.com','-X','GET','-H','Accept: application/vnd.github.raw+json',
      'repos/'+BASELINE_REPOSITORY+'/git/blobs/'+sha],{env:ghPrivateEnvironment(),stdio:['ignore','pipe','pipe']});
    stop=next=>{if(!kind)kind=next;child.kill('SIGKILL');};
    closed=new Promise(resolve=>{
      child.once('error',()=>{if(!kind)kind='github_read_failed';});
      child.once('close',code=>{if(code!==0&&!kind)kind='github_read_failed';resolve();});
    });
    const abort=()=>stop('cancelled');
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    timer=setTimeout(()=>stop('timeout'),Math.max(1,deadline-Date.now()));
    child.stderr.on('data',bytes=>{stderrBytes+=bytes.length;if(stderrBytes>16384)stop('output_limit');});
    try{
      for await(const bytes of child.stdout){
        if(kind)break;count+=bytes.length;maxChunkBytes=Math.max(maxChunkBytes,bytes.length);
        if(count>size||bytes.length>262144){stop('size_mismatch');break;}
        hash1.update(bytes);hash256.update(bytes);
        let offset=0;
        while(offset<bytes.length){const {bytesWritten}=await file.write(bytes,offset,bytes.length-offset);if(!bytesWritten)throw failure('disk_write_failed');offset+=bytesWritten;}
      }
      await closed;
    }catch(error){stop(error.failureKind||'disk_write_failed');await closed;}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
    if(kind)throw failure(kind);
    checkStopped();
    if(count!==size)throw failure('size_mismatch');
    if(hash1.digest('hex')!==sha)throw failure('blob_integrity');
    const sha256=hash256.digest('hex');await file.sync();checkStopped();success=true;
    return {sha,size:count,sha256,maxChunkBytes};
  }finally{
    clearTimeout(timer);
    if(!success&&child){child.kill('SIGKILL');await closed;}
    await file.close();if(!success)await rm(destination,{force:true});
  }
}
