// Host-only supervisor/exporter. Never load code from the game or worker output.
import {docker,failure} from './docker-command.mjs';
import {randomUUID} from 'node:crypto';
import {resolve,basename} from 'node:path';
import {lstat} from 'node:fs/promises';
import {makeTarFile,readDockerFile} from './container-tar.mjs';
import {handoffContext,seal} from './private-handoff.mjs';
import {validateBundle} from './private-task-bundle.mjs';
import {isSafeManifestPath} from './verified-manifest.mjs';

// Fixed trusted initializer only; never import/execute game, auth or copied control code.
// Docker cp can preserve a host UID different from the nonroot worker's UID.
export const INPUT_OWNERSHIP_SCRIPT=`
const fs=require('node:fs');let count=0;
function visit(path){
  if(++count>100000)throw Error('Input tree limit');
  const stat=fs.lstatSync(path);
  if(!stat.isDirectory()&&!stat.isFile())throw Error('Unsupported input node');
  fs.chownSync(path,1000,1000);
  if(stat.isDirectory())for(const name of fs.readdirSync(path))visit(path+'/'+name);
}
for(const path of ['/input/private-game','/input/task-private','/opt/control'])visit(path);
`;

export async function runProtectedTask({imageId,context,controlDir,gameDir,queueDir,publicKey,
  auth={},network='none',routingMode='auto',controller='auto',timeoutMs=3000000,outputLimit=240000,signal}){
  handoffContext(context);
  if(!/^sha256:[a-f0-9]{64}$/.test(imageId||'')||!['none','bridge'].includes(network)||
    !['auto','stable','manual'].includes(routingMode)||!['auto','claude','gemini','codex'].includes(controller)||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>3000000||
    !Number.isSafeInteger(outputLimit)||outputLimit<1024||outputLimit>240000)
    throw failure('invalid_configuration');
  for(const dir of [controlDir,gameDir,queueDir]){
    const stat=await lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw failure('invalid_configuration');
  }
  const authData=Buffer.from(JSON.stringify({codex:auth.codex||'',gemini:auth.gemini||'',claude:auth.claude||''}));
  if(authData.length>100000)throw failure('invalid_configuration');
  const name='orch-worker-'+randomUUID(),volume=name+'-data',inputVolume=name+'-input',controlVolume=name+'-control',seed=name+'-seed';
  const volumes=[];
  let seedCreated=false,created=false,executionOutcome='failure',failureKind=null,bundle=null;
  if(signal?.aborted)throw failure('cancelled');
  const request=(args,options={})=>docker(args,{...options,signal});
  try{
    for(const next of [volume,inputVolume,controlVolume]){
      if(signal?.aborted)throw failure('cancelled');
      volumes.push(next); // Register intent before the client can lose an accepted response.
      await request(['volume','create','--label','orchestrator.protected-worker=true',next]);
    }
    // Docker refuses cp into read-only rootfs. Seed separate volumes with a
    // bounded trusted initializer, then mount control and input read-only in worker.
    seedCreated=true;
    await request(['create','--name',seed,'--label','orchestrator.protected-worker=true',
      '--pull=never','--network','none','--user','0:0',
      '--cap-drop','ALL','--cap-add','CHOWN','--cap-add','DAC_OVERRIDE','--security-opt','no-new-privileges',
      '--pids-limit','64','--memory','128m','--memory-swap','128m','--cpus','1','--log-driver','none',
      '--mount','type=volume,source='+inputVolume+',target=/input',
      '--mount','type=volume,source='+controlVolume+',target=/opt/control',imageId,'node','-e',INPUT_OWNERSHIP_SCRIPT]);
    for(const [source,destination] of [[controlDir,'/opt/control'],[gameDir,'/input/private-game'],[queueDir,'/input/task-private']])
      await request(['cp',resolve(source)+(destination==='/opt/control'?'/.' : ''),seed+':'+destination],{limit:32768});
    await request(['cp','-',seed+':/input/'],{input:makeTarFile('auth.json',authData)});
    authData.fill(0);
    await request(['start','--attach',seed]);
    const seeded=JSON.parse((await request(['inspect','--format','{{json .State}}',seed])).toString());
    if(seeded.Running||seeded.Paused||seeded.Restarting||seeded.ExitCode!==0)throw failure('input_setup_failed');
    await request(['rm','--force',seed]);seedCreated=false;
    const env={TASK_ID:context.taskId,HOME:'/work/home',CODEX_HOME:'/work/home/.codex',
      ORCHESTRATOR_AUDIT_DIR:'/work/audit',ORCHESTRATOR_ROUTING_MODE:routingMode,ORCHESTRATOR_CONTROLLER:controller,
      ANTHROPIC_API_KEY:'',OPENAI_API_KEY:'',GEMINI_API_KEY:'',GOOGLE_API_KEY:''};
    created=true;
    await request(['create','--name',name,'--label','orchestrator.protected-worker=true',
      '--pull=never','--read-only','--user','1000:1000','--workdir','/work',
      '--network',network,'--ipc','private','--cap-drop','ALL','--security-opt','no-new-privileges',
      '--pids-limit','128','--memory','1g','--memory-swap','1g','--cpus','2','--log-driver','none',
      '--tmpfs','/tmp:rw,nosuid,nodev,size=128m',
      '--mount','type=volume,source='+volume+',target=/work',
      '--mount','type=volume,source='+inputVolume+',target=/input,readonly',
      '--mount','type=volume,source='+controlVolume+',target=/opt/control,readonly',
      ...Object.entries(env).flatMap(([k,v])=>['--env',k+'='+v]),
      imageId,'node','/opt/control/worker-entry.mjs']);
    await request(['start','--attach',name],{timeout:timeoutMs,limit:outputLimit});
    const state=JSON.parse((await request(['inspect','--format','{{json .State}}',name])).toString());
    if(state.Running||state.Paused||state.Restarting)throw failure('worker_still_running');
    if(state.ExitCode!==0)throw failure('worker_failed');
    async function read(path,limit){
      const bytes=await request(['cp',name+':'+path,'-'],{limit:limit+4096});
      try{return readDockerFile(bytes,basename(path),limit);}catch{throw failure('invalid_output');}
    }
    const result=JSON.parse((await read('/work/.private-task-result.json',16384)).toString());
    if(!Array.isArray(result.paths)||result.paths.length<1||result.paths.length>8||
      result.paths.some(p=>!isSafeManifestPath(p)))throw failure('invalid_output');
    const audit=JSON.parse((await read('/work/audit/'+context.taskId+'.json',80000)).toString());
    const files=[];
    for(const path of result.paths)files.push({path,content:(await read('/work/private-game/'+path,65000)).toString('base64')});
    bundle={version:1,context,executionOutcome:'success',baseSha:result.baseSha,result,audit,files};
    validateBundle(bundle,context);executionOutcome='success';
  }catch(error){failureKind=error.failureKind||'invalid_output';}
  finally{
    authData.fill(0);
    // No handoff is returned unless every process and its writable volume are gone.
    // Cleanup uses a fresh non-aborted request, including when the caller was cancelled.
    const cleanup=[];
    if(created)cleanup.push(['rm','--force',name]);
    if(seedCreated)cleanup.push(['rm','--force',seed]);
    cleanup.push(...volumes.reverse().map(next=>['volume','rm',next]));
    let cleanupFailed=false;
    for(const args of cleanup){try{await docker(args);}catch{cleanupFailed=true;}}
    if(cleanupFailed)throw failure('cleanup_failed');
  }
  if(signal?.aborted)throw failure('cancelled');
  if(executionOutcome!=='success')bundle={version:1,context,executionOutcome:'failure',baseSha:null,result:null,audit:null,files:[]};
  validateBundle(bundle,context);
  return {executionOutcome,failureKind,removed:true,encrypted:seal(bundle,publicKey,context)};
}
