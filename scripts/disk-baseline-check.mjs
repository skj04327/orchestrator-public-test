// Trusted-host baseline stage only. This observation is never a task publication gate.
import {randomUUID} from 'node:crypto';
import {docker,failure,parseExitedDockerState} from './docker-command.mjs';
import {makeTarFile} from './container-tar.mjs';
import {createDiskBaselineArchive} from './disk-baseline.mjs';
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
const stages={typecheck:['run','typecheck'],'unit-test':['test','--','--reporter=dot'],build:['run','build']};
function run(args){return new Promise((resolve,reject)=>{
  const p=spawn('/usr/local/bin/npm',args,{cwd:'/work/project',stdio:'inherit',env:{
    PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/work/home',NPM_CONFIG_CACHE:'/work/npm-cache',
    NPM_CONFIG_USERCONFIG:'/dev/null',NPM_CONFIG_GLOBALCONFIG:'/input/empty-global-npmrc',NPM_CONFIG_OFFLINE:'true',
    NPM_CONFIG_AUDIT:'false',NPM_CONFIG_FUND:'false'}});
  p.on('error',reject);p.on('close',code=>resolve(code===0));
});}
(async()=>{
  if(!Object.hasOwn(stages,process.argv[2]))throw Error('Invalid stage');
  if(!await run(['ci','--offline','--no-audit','--no-fund'])){process.exitCode=1;return;}
  if(!await run(stages[process.argv[2]]))process.exitCode=1;
})().catch(()=>{process.exitCode=1;});
`);
export async function runDiskBaselineStage({diskSnapshot,imageId,stage,timeoutMs=420000,outputLimit=240000,signal}){
  if(process.env.GITHUB_ACTIONS==='true'||!Object.hasOwn(stages,stage))throw failure('invalid_configuration');
  captureCheckConfiguration({imageId,timeoutMs,outputLimit});
  if(signal?.aborted)throw failure('cancelled');
  // Purpose/capability checks run synchronously before creating any Docker resources.
  const {inputStream,provenance}=createDiskBaselineArchive(diskSnapshot,{signal});
  const name='orch-disk-check-'+randomUUID(),seed=name+'-seed',volume=name+'-input',began=Date.now();
  const label='orchestrator.disk-baseline-check=true';let volumeCreated=false,seedCreated=false,created=false,status='failed',failureKind=null,exitCode=null;
  const request=(args,opts={})=>docker(args,{...opts,signal});
  try{
    volumeCreated=true;await request(['volume','create','--label',label,volume]);
    seedCreated=true;await request(['create','--name',seed,'--label',label,'--pull=never','--read-only','--network','none',
      '--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','32','--memory','128m','--memory-swap','128m','--cpus','1',
      '--mount','type=volume,source='+volume+',target=/input',imageId,'node','-e','process.exit(0)']);
    await request(['cp','-',seed+':/input/'],{inputStream,timeout:timeoutMs});
    await request(['cp','-',seed+':/input/'],{input:makeTarFile('disk-check-entry.cjs',entry)});
    await request(['rm','--force',seed]);seedCreated=false;
    created=true;await request(['create','--name',name,'--label',label,'--pull=never','--read-only','--network','none',
      '--user','1000:1000','--workdir','/work','--ipc','private','--cap-drop','ALL','--security-opt','no-new-privileges','--log-driver','none',
      '--pids-limit','128','--memory','3g','--memory-swap','3g','--cpus','2',
      '--tmpfs','/work:rw,nosuid,nodev,size=2g,uid=1000,gid=1000,mode=0700','--tmpfs','/tmp:rw,nosuid,nodev,size=128m',
      '--mount','type=volume,source='+volume+',target=/input,readonly',imageId,'node','/input/disk-check-entry.cjs',stage]);
    let startFailure=null;
    try{await request(['start','--attach',name],{timeout:timeoutMs,limit:outputLimit});}
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
  return {kind:'disk-baseline-stage-v1',variant:'baseline',stage,status,failureKind,exitCode,removed:true,durationMs:Date.now()-began,...provenance,publishAuthorized:false};
}
