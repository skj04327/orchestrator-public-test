// Trusted-host disk baseline/candidate stage. This observation never grants publication.
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {constants} from 'node:fs';
import {open,rm} from 'node:fs/promises';
import {ensurePrivateStateRoot} from './private-queue.mjs';
import {docker,failure,parseExitedDockerState} from './docker-command.mjs';
import {makeTarFile} from './container-tar.mjs';
import {createDiskBaselineArchive} from './disk-baseline.mjs';
import {createDiskCheckArchive} from './disk-check-input.mjs';
import {createOfflineNpmArchive} from './offline-npm-runtime.mjs';
import {captureCheckConfiguration} from './isolated-check.mjs';
const stages={typecheck:['run','typecheck'],'unit-test':['test','--','--reporter=dot'],build:['run','build']};
const entry=Buffer.from(`
const fs=require('node:fs'),{spawn}=require('node:child_process');
const manifest=JSON.parse(fs.readFileSync('/input/manifest.json','utf8'));
fs.mkdirSync('/work/project',{mode:0o700});fs.mkdirSync('/work/home',{mode:0o700});
for(const f of manifest.files){
  const path='/work/project/'+f.path;
  fs.mkdirSync(require('node:path').dirname(path),{recursive:true,mode:0o700});
  fs.copyFileSync('/input/'+f.sha,path,fs.constants.COPYFILE_EXCL);fs.chmodSync(path,f.mode==='100755'?0o755:0o644);
}
if(!['baseline','candidate'].includes(process.argv[3]))throw Error('Invalid variant');
if(process.argv[3]==='candidate'){
  const overlay=JSON.parse(fs.readFileSync('/input/candidate.json','utf8'));
  for(const f of overlay.files){const path='/work/project/'+f.path;fs.mkdirSync(require('node:path').dirname(path),{recursive:true,mode:0o700});
    fs.copyFileSync('/input/candidate-'+f.sha256,path);fs.chmodSync(path,f.mode==='100755'?0o755:0o644);}
}
const stages={typecheck:['run','typecheck'],'unit-test':['test','--','--reporter=dot'],build:['run','build']};
function run(args,cwd='/work/project'){return new Promise((resolve,reject)=>{
  const p=spawn('/usr/local/bin/npm',args,{cwd,stdio:'inherit',env:{
    PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/work/home',NPM_CONFIG_CACHE:'/work/npm-cache',
    NPM_CONFIG_USERCONFIG:'/dev/null',NPM_CONFIG_GLOBALCONFIG:'/input/empty-global-npmrc',NPM_CONFIG_OFFLINE:'true',
    NPM_CONFIG_AUDIT:'false',NPM_CONFIG_FUND:'false'}});
  p.on('error',reject);p.on('close',code=>resolve(code===0));
});}
(async()=>{
  if(!Object.hasOwn(stages,process.argv[2]))throw Error('Invalid stage');
  if(process.argv[4]==='with-dependencies'){
    const count=Number(fs.readFileSync('/input/npm-dependency-count','utf8'));
    if(!Number.isSafeInteger(count)||count<0||count>1000)throw Error('Invalid dependency count');
    for(let offset=0;offset<count;offset+=8){
      const batch=Array.from({length:Math.min(8,count-offset)},(_,i)=>'/input/npm-dependency-'+(offset+i)+'.tgz');
      if(!await run(['cache','add','--offline','--ignore-scripts','--no-audit','--no-fund',...batch],'/work/home')){
        process.exitCode=1;return;
      }
    }
  }
  if(!await run(['ci','--offline','--no-audit','--no-fund'])){process.exitCode=1;return;}
  if(!await run(stages[process.argv[2]]))process.exitCode=1;
})().catch(()=>{process.exitCode=1;});
`);
const DEFAULT_TIMEOUT=420000;
const BASELINE_TEST_TIMEOUT=900000;
function configuration({imageId,stage,timeoutMs,outputLimit,signal},baseline=false){
  const cap=baseline&&stage==='unit-test'?BASELINE_TEST_TIMEOUT:DEFAULT_TIMEOUT;
  if(process.env.GITHUB_ACTIONS==='true'||!Object.hasOwn(stages,stage)||
    !Number.isSafeInteger(timeoutMs)||timeoutMs>cap)throw failure('invalid_configuration');
  captureCheckConfiguration({imageId,timeoutMs:Math.min(timeoutMs,DEFAULT_TIMEOUT),outputLimit});
  if(signal?.aborted)throw failure('cancelled');
}
export async function runDiskBaselineStage({diskSnapshot,offlineDependencies,imageId,stage,timeoutMs=DEFAULT_TIMEOUT,outputLimit=240000,signal,diagnosticsRoot}){
  const config={imageId,stage,timeoutMs,outputLimit,signal};configuration(config,true);
  const archive=createDiskBaselineArchive(diskSnapshot,{signal});
  const dependencyArchive=createOfflineNpmArchive(offlineDependencies,diskSnapshot,{signal});
  let privateDiagnostics;
  if(diagnosticsRoot!==undefined){
    try{privateDiagnostics=await ensurePrivateStateRoot(diagnosticsRoot);}
    catch{throw failure('diagnostics_unavailable');}
  }
  return runPreparedDiskStage({...config,variant:'baseline',archive:{...archive,dependencyArchive},privateDiagnostics});
}
export async function runDiskCheckStage({checkInput,variant,stage,offlineDependencies,imageId,timeoutMs=DEFAULT_TIMEOUT,outputLimit=240000,signal}){
  const config={imageId,stage,timeoutMs,outputLimit,signal};configuration(config);
  return runPreparedDiskStage({...config,variant,archive:createDiskCheckArchive(checkInput,{variant,offlineDependencies,signal})});
}
async function saveDiagnostics(path,bytes,signal){
  let created=false;
  try{
    const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    created=true;
    try{await file.writeFile(bytes);await file.sync();}
    finally{await file.close();}
    if(signal?.aborted)throw failure('cancelled');
  }catch(error){
    if(created){
      try{await rm(path,{force:true});}
      catch{throw failure('diagnostics_write_failed');}
    }
    throw failure(error.failureKind==='cancelled'?'cancelled':'diagnostics_write_failed');
  }
}
async function runPreparedDiskStage({archive,variant,imageId,stage,timeoutMs,outputLimit,signal,privateDiagnostics}){
  const {inputStream,overlayArchive,dependencyArchive,provenance,proof}=archive;
  const workFlags=dependencyArchive?'rw,exec':'rw';
  const name='orch-disk-check-'+randomUUID(),seed=name+'-seed',volume=name+'-input',began=Date.now();
  const label='orchestrator.disk-baseline-check=true';let volumeCreated=false,seedCreated=false,created=false,status='failed',failureKind=null,exitCode=null;
  const request=(args,opts={})=>docker(args,{...opts,signal});
  let diagnosticOutput,diagnosticId;
  const captureOutput=privateDiagnostics?bytes=>{diagnosticOutput=bytes;}:undefined;
  try{
    volumeCreated=true;await request(['volume','create','--label',label,volume]);
    seedCreated=true;await request(['create','--name',seed,'--label',label,'--pull=never','--read-only','--network','none',
      '--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','32','--memory','128m','--memory-swap','128m','--cpus','1',
      '--mount','type=volume,source='+volume+',target=/input',imageId,'node','-e','process.exit(0)']);
    await request(['cp','-',seed+':/input/'],{inputStream,timeout:Math.min(timeoutMs,DEFAULT_TIMEOUT)});
    if(dependencyArchive)await request(['cp','-',seed+':/input/'],{inputStream:dependencyArchive,timeout:Math.min(timeoutMs,DEFAULT_TIMEOUT)});
    if(overlayArchive)await request(['cp','-',seed+':/input/'],{input:overlayArchive});
    await request(['cp','-',seed+':/input/'],{input:makeTarFile('disk-check-entry.cjs',entry)});
    await request(['rm','--force',seed]);seedCreated=false;
    created=true;await request(['create','--name',name,'--label',label,'--pull=never','--read-only','--network','none',
      '--user','1000:1000','--workdir','/work','--ipc','private','--cap-drop','ALL','--security-opt','no-new-privileges','--log-driver','none',
      '--pids-limit','128','--memory','3g','--memory-swap','3g','--cpus','2',
      '--tmpfs','/work:'+workFlags+',nosuid,nodev,size=2g,uid=1000,gid=1000,mode=0700','--tmpfs','/tmp:rw,nosuid,nodev,size=128m',
      '--mount','type=volume,source='+volume+',target=/input,readonly',imageId,'node','/input/disk-check-entry.cjs',stage,variant,dependencyArchive?'with-dependencies':'without-dependencies']);
    let startFailure=null;
    try{await request(['start','--attach',name],{timeout:timeoutMs,limit:outputLimit,captureOutput});}
    catch(error){if(error.failureKind!=='docker_error')throw error;startFailure=error;}
    const state=parseExitedDockerState(JSON.parse((await request(['inspect','--format','{{json .State}}',name])).toString()));
    exitCode=state.ExitCode;
    if(state.OOMKilled)failureKind='resource_limit';
    else if(exitCode!==0)failureKind='check_failed';
    else if(startFailure)throw startFailure;
    else status='passed';
  }catch(error){failureKind=error.failureKind||'invalid_output';}
  finally{
    const cleanup=[];
    if(created)cleanup.push(['rm','--force',name]);if(seedCreated)cleanup.push(['rm','--force',seed]);if(volumeCreated)cleanup.push(['volume','rm',volume]);
    let failed=false;for(const args of cleanup)try{await docker(args);}catch{failed=true;}
    if(failed)throw failure('cleanup_failed');
  }
  if(signal?.aborted)throw failure('cancelled');
  if(diagnosticOutput){
    diagnosticId=name+'.log';
    await saveDiagnostics(join(privateDiagnostics,diagnosticId),diagnosticOutput,signal);
  }
  return {kind:'disk-baseline-stage-v1',variant,stage,status,failureKind,exitCode,removed:true,durationMs:Date.now()-began,...provenance,...(diagnosticId?{diagnosticId}:{}),...(proof?{candidateContentSha256:proof.candidateContentSha256}:{}),publishAuthorized:false};
}
