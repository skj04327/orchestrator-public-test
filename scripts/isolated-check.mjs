// Independent host observations; no game-authored status or audit file is accepted.
import {randomUUID} from 'node:crypto';
import {docker,failure,parseExitedDockerState} from './docker-command.mjs';
import {makeTarFile} from './container-tar.mjs';
import {parseCheckPayload} from './independent-check-input.mjs';
const stages={typecheck:['run','typecheck'],'unit-test':['test','--','--reporter=dot'],build:['run','build']};
const entry=Buffer.from(`
const fs=require('node:fs'),{spawn}=require('node:child_process');
const input=JSON.parse(fs.readFileSync('/input/snapshot.json','utf8'));
const files=new Map(input.baseline.map(f=>[f.path,f.content]));
if(process.argv[3]==='candidate')for(const f of input.candidate)files.set(f.path,f.content);
fs.mkdirSync('/work/project',{mode:0o700});fs.mkdirSync('/work/home',{mode:0o700});
for(const [path,content] of files){
  fs.mkdirSync(require('node:path').dirname('/work/project/'+path),{recursive:true,mode:0o700});
  fs.writeFileSync('/work/project/'+path,Buffer.from(content,'base64'),{flag:'wx',mode:0o600});
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
  if(!stages[process.argv[2]]||!['baseline','candidate'].includes(process.argv[3]))throw Error('Invalid check');
  if(!await run(['ci','--offline','--no-audit','--no-fund'])){process.exitCode=1;return;}
  if(!await run(stages[process.argv[2]]))process.exitCode=1;
})().catch(()=>{process.exitCode=1;});
`);
export function captureCheckConfiguration({imageId,timeoutMs=420000,outputLimit=240000}){
  if(typeof imageId!=='string'||!/^sha256:[a-f0-9]{64}$/.test(imageId||'')||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>420000||
    !Number.isSafeInteger(outputLimit)||outputLimit<1024||outputLimit>240000)throw failure('invalid_configuration');
  return Object.freeze({imageId,timeoutMs,outputLimit});
}
export async function runIsolatedCheck({imageId,payload,variant,stage,timeoutMs=420000,outputLimit=240000,signal}){
  captureCheckConfiguration({imageId,timeoutMs,outputLimit});
  if(!['baseline','candidate'].includes(variant)||!Object.hasOwn(stages,stage))throw failure('invalid_configuration');
  const captured=Buffer.from(JSON.stringify(parseCheckPayload(payload)));
  if(signal?.aborted)throw failure('cancelled');
  const name='orch-check-'+randomUUID(),seed=name+'-seed',volume=name+'-input';
  const began=Date.now();let volumeCreated=false,seedCreated=false,created=false,status='failed',failureKind=null,exitCode=null;
  const request=(args,opts={})=>docker(args,{...opts,signal});
  try{
    volumeCreated=true;await request(['volume','create','--label','orchestrator.independent-check=true',volume]);
    seedCreated=true;await request(['create','--name',seed,'--label','orchestrator.independent-check=true',
      '--pull=never','--network','none','--mount','type=volume,source='+volume+',target=/input',imageId,'node','-e','process.exit(0)']);
    for(const [path,content] of [['snapshot.json',captured],['check-entry.cjs',entry]])
      await request(['cp','-',seed+':/input/'],{input:makeTarFile(path,content)});
    await request(['rm','--force',seed]);seedCreated=false;
    created=true;await request(['create','--name',name,'--label','orchestrator.independent-check=true',
      '--pull=never','--read-only','--network','none','--user','1000:1000','--workdir','/work',
      '--ipc','private','--cap-drop','ALL','--security-opt','no-new-privileges','--log-driver','none',
      '--pids-limit','128','--memory','1g','--memory-swap','1g','--cpus','2',
      '--tmpfs','/work:rw,nosuid,nodev,size=512m,uid=1000,gid=1000,mode=0700',
      '--tmpfs','/tmp:rw,nosuid,nodev,size=128m',
      '--mount','type=volume,source='+volume+',target=/input,readonly',
      imageId,'node','/input/check-entry.cjs',stage,variant]);
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
    if(created)cleanup.push(['rm','--force',name]);if(seedCreated)cleanup.push(['rm','--force',seed]);
    if(volumeCreated)cleanup.push(['volume','rm',volume]);
    let failed=false;
    for(const args of cleanup)try{await docker(args);}catch{failed=true;}
    if(failed)throw failure('cleanup_failed');
  }
  if(signal?.aborted)throw failure('cancelled');
  return {variant,stage,status,failureKind,exitCode,removed:true,durationMs:Date.now()-began};
}
