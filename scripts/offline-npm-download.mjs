// Fixed-origin public tarball GETs on the trusted host. Package code runs only in the checker.
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {link,mkdir,open,rm,rmdir} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {ensurePrivateStateRoot} from './private-queue.mjs';
import {failure} from './docker-command.mjs';
import {
  MAX_TARBALL,MAX_TOTAL,measureOfflineNpmTarball,planOfflineNpmDependencies,prepareOfflineNpmDependencies,
} from './offline-npm-runtime.mjs';

const transientExitCodes=new Set([6,7,18,28,35,52,55,56]);
const proxyKeys=['PATH','HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy','NO_PROXY','no_proxy','SSL_CERT_FILE','SSL_CERT_DIR','CURL_CA_BUNDLE'];
function checkSignal(signal){
  if(signal?.aborted)throw failure('cancelled');
}
function childEnvironment(){
  const env={};
  for(const key of proxyKeys)if(process.env[key]!==undefined)env[key]=process.env[key];
  return env;
}

async function downloadTarball(root,{filename,resolved},limit,signal){
  checkSignal(signal);
  const temp=join(root,'.npm-download-'+randomUUID());
  const destination=join(root,filename);
  let file=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{
    checkSignal(signal);
    const child=spawn('curl',['-q','--proto','=https','--globoff','--silent','--fail',
      '--max-time','25','--connect-timeout','8','--max-redirs','0',
      '--write-out','%{stderr}%{http_code}\n','--',resolved],
    {env:childEnvironment(),stdio:['ignore','pipe','pipe']});
    const closed=new Promise(resolve=>{
      let spawnFailed=false;
      child.once('error',()=>{spawnFailed=true;});
      child.once('close',code=>resolve({code,spawnFailed}));
    });
    let stderr='',overflow=false,timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},25000);
    child.stderr.on('data',chunk=>{
      if(stderr.length+chunk.length>64){overflow=true;child.kill('SIGKILL');}
      else stderr+=chunk.toString('ascii');
    });
    const abort=()=>child.kill('SIGKILL');
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
    let size=0;
    const hash=createHash('sha512');
    try{
      for await(const chunk of child.stdout){
        checkSignal(signal);
        size+=chunk.length;
        if(size>limit)throw failure('npm_download_capacity');
        hash.update(chunk);
        let offset=0;
        while(offset<chunk.length){
          const {bytesWritten}=await file.write(chunk,offset,chunk.length-offset);
          if(!bytesWritten)throw failure('disk_write_failed');
          offset+=bytesWritten;
        }
      }
      const {code,spawnFailed}=await closed;
      checkSignal(signal);
      const status=/^[0-9]{3}\n$/.test(stderr)?Number(stderr.slice(0,3)):null;
      if(!overflow&&!spawnFailed&&(status===429||(status>=500&&status<=599)||timedOut||transientExitCodes.has(code)))
        throw failure('npm_download_transient');
      if(overflow||spawnFailed||code!==0||status!==200)throw failure('npm_download_rejected');
    }finally{
      clearTimeout(timer);
      signal.removeEventListener('abort',abort);
      child.kill('SIGKILL');
      await closed;
    }
    if(!size||hash.digest('hex')+'.tgz'!==filename)throw failure('blob_integrity');
    await file.sync();
    await file.close();
    file=null;
    checkSignal(signal);
    // Link is exclusive: a concurrent cache entry is never overwritten.
    await link(temp,destination);
    return size;
  }finally{
    try{if(file)await file.close();}
    finally{await rm(temp,{force:true});}
  }
}

export async function downloadOfflineNpmDependencies({diskSnapshot,tarballRoot,signal,onProgress}){
  if(process.env.GITHUB_ACTIONS==='true')throw failure('invalid_configuration');
  if(onProgress!==undefined&&typeof onProgress!=='function')throw failure('invalid_configuration');
  const deadline=AbortSignal.timeout(600000);
  const bounded=signal?AbortSignal.any([signal,deadline]):deadline;
  try{
    const plan=await planOfflineNpmDependencies({diskSnapshot,signal:bounded});
    const root=await ensurePrivateStateRoot(tarballRoot);
    const lock=join(root,'.npm-download-lock');
    try{await mkdir(lock,{mode:0o700});}
    catch(error){if(error.code==='EEXIST')throw failure('npm_download_busy');throw error;}
    try{return await fillCache({diskSnapshot,root,plan,signal:bounded,onProgress});}
    finally{await rmdir(lock);}
  }catch(error){
    if(bounded.aborted)throw failure('cancelled');
    if(!error.failureKind&&error.code)throw failure('npm_download_storage_failed');
    throw error;
  }
}

async function fillCache({diskSnapshot,root,plan,signal,onProgress}){
  let downloaded=0,reused=0,totalBytes=0,retryBudget=12;
  for(const entry of plan.packages){
    checkSignal(signal);
    try{
      totalBytes+=await measureOfflineNpmTarball(root,entry.filename,{signal,maxBytes:MAX_TOTAL-totalBytes});
      reused++;
    }catch(error){
      if(error.code!=='ENOENT')throw error;
      const limit=Math.min(MAX_TARBALL,MAX_TOTAL-totalBytes);
      if(limit<1)throw failure('npm_download_capacity');
      try{
        totalBytes+=await downloadTarball(root,entry,limit,signal);
      }catch(error){
        if(error.failureKind!=='npm_download_transient'||retryBudget===0)throw error;
        retryBudget--;
        try{await delay(1100,undefined,{signal});}catch{throw failure('cancelled');}
        totalBytes+=await downloadTarball(root,entry,limit,signal);
      }
      downloaded++;
    }
    if(totalBytes>MAX_TOTAL)throw failure('npm_download_capacity');
    onProgress?.({completed:downloaded+reused,total:plan.packages.length});
  }
  checkSignal(signal);
  const dependencies=await prepareOfflineNpmDependencies({diskSnapshot,tarballRoot:root,signal});
  return {dependencies,downloaded,reused,totalBytes,lockSha256:plan.lockSha256,publishAuthorized:false};
}
