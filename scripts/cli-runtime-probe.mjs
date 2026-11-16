// Diagnostic only: fixed version/help commands in credential-free network=none
// containers. Never accept a prompt, task text, auth file or extra command flags.
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export const CLI_PROBES=Object.freeze({
  codex:{helpArgs:['exec','--help'],flags:['--sandbox','--image','--output-last-message']},
  claude:{helpArgs:['--help'],optionArgs:['--max-turns','1','--help'],flags:['--output-format','--max-turns','--allowedTools','--mcp-config','--strict-mcp-config']},
  agy:{helpArgs:['--help'],flags:['-p','--print','--output-format','--sandbox']},
  gemini:{helpArgs:['--help'],flags:['--prompt','--output-format','--sandbox']}
});
export function summarizeCliProbe(cli,version,help){
  if(!Object.hasOwn(CLI_PROBES,cli)||typeof version!=='string'||typeof help!=='string'||
    help.length>100000||! /^[a-zA-Z0-9 ._()+-]{1,100}$/.test(version.trim())||
    !/\d+\.\d+\.\d+/.test(version.trim()))throw Error('Invalid CLI observation');
  const flags=Object.fromEntries(CLI_PROBES[cli].flags.map(flag=>{
    const escaped=flag.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    return [flag,new RegExp('(?:^|[\\s,\\[])'+escaped+'(?=$|[\\s,=\\]])').test(help)];
  }));
  return {cli,cliVersion:version.trim(),flags,authenticated:false,inferenceAttempted:false,
    subscriptionCiApproved:false,modelId:null,tokenUsage:null,cost:null};
}
async function docker(args,{limit=100000,includeStderr=false,signal}={}){
  if(signal?.aborted)throw Error('CLI probe cancelled');
  return new Promise((done,reject)=>{
    const proc=spawn('docker',args,{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH}});
    let chunks=[],size=0,failed=false;
    const abort=()=>{failed=true;proc.kill('SIGKILL');};
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const timer=setTimeout(()=>{failed=true;proc.kill('SIGKILL');},30000);
    const collect=(data,out)=>{size+=data.length;if(size>limit){failed=true;proc.kill('SIGKILL');}else if(out||includeStderr)chunks.push(data);};
    proc.stdout.on('data',d=>collect(d,true));proc.stderr.on('data',d=>collect(d,false));
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    proc.on('error',()=>{cleanup();reject(Error('CLI probe unavailable'));});
    proc.on('close',code=>{cleanup();if(code!==0||failed)reject(Error('CLI probe failed'));else done(Buffer.concat(chunks).toString());});
  });
}
export async function probeCliRuntime(imageId,{clis=Object.keys(CLI_PROBES),publicVolume=null,signal}={}){
  if(!/^sha256:[a-f0-9]{64}$/.test(imageId||'')||!Array.isArray(clis)||clis.length<1||clis.length>4||
    new Set(clis).size!==clis.length||clis.some(c=>!Object.hasOwn(CLI_PROBES,c))||
    (publicVolume!==null&&!/^orch-cli-public-[a-zA-Z0-9-]{1,70}$/.test(publicVolume)))throw Error('Invalid diagnostic context');
  if(signal?.aborted)throw Error('CLI probe cancelled');
  const request=(args,options={})=>docker(args,{...options,signal});
  const results=[];
  for(const cli of clis){
    const config=CLI_PROBES[cli];
    const observed=[];
    for(const args of [['--version'],config.helpArgs,...(config.optionArgs?[config.optionArgs]:[])]){
      const name='orch-cli-probe-'+randomUUID();
      try{
        await request(['create','--name',name,'--pull=never','--network','none','--read-only',
          '--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges',
          '--memory','1g','--memory-swap','1g','--cpus','1','--pids-limit','64','--log-driver','none',
          '--tmpfs','/tmp:rw,nosuid,nodev,size=128m','--workdir','/tmp',
          '--env','HOME=/tmp/cli-probe','--env','DISABLE_AUTOUPDATER=1',
          '--env','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
          ...(publicVolume?['--mount','type=volume,source='+publicVolume+',target=/opt/cli,readonly',
            '--env','PATH=/opt/cli/node_modules/.bin:/opt/cli/bin:/usr/local/bin:/usr/bin:/bin']:[]),imageId,cli,...args]);
        observed.push(await request(['start','--attach',name],{includeStderr:true}));
        const state=JSON.parse(await request(['inspect','--format','{{json .State}}',name]));
        if(state.Running||state.ExitCode!==0)throw Error('CLI probe failed');
      }finally{await docker(['rm','--force',name]);}
    }
    results.push({...summarizeCliProbe(cli,observed[0],observed[1]),optionParsingVerified:!!config.optionArgs});
  }
  return {schemaVersion:1,observedAt:new Date().toISOString(),imageId,network:'none',
    credentialsProvided:false,diagnosticOnly:true,allProvidersChecked:results.length===4,
    publicPackageVolume:publicVolume?{readOnly:true,contentDigestVerified:false}:null,results};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const abort=new AbortController();
  process.once('SIGINT',()=>abort.abort());process.once('SIGTERM',()=>abort.abort());
  if(process.argv.length!==2){console.error('RESULT: CLI_PROBE_FAILED');process.exitCode=1;}
  else probeCliRuntime(process.env.ORCHESTRATOR_PROBE_IMAGE_ID,{
    clis:process.env.ORCHESTRATOR_PROBE_CLIS?.split(','),publicVolume:process.env.ORCHESTRATOR_PUBLIC_CLI_VOLUME||null,signal:abort.signal
  }).then(r=>console.log(JSON.stringify(r,null,2)))
    .catch(()=>{console.error('RESULT: CLI_PROBE_FAILED');process.exitCode=1;});
}
