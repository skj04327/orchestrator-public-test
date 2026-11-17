// Bounded trusted-host Docker client. No host credentials enter child env.
import {spawn} from 'node:child_process';
export function failure(kind){const error=Error('Protected worker failed');error.failureKind=kind;return error;}
export async function docker(args,{input,limit=16384,timeout=30000,signal}={}){
  if(signal?.aborted)throw failure('cancelled');
  return new Promise((done,reject)=>{
    const child=spawn('docker',args,{stdio:['pipe','pipe','pipe'],
      // Docker client gets no host credentials, preload settings or daemon overrides.
      env:{PATH:process.env.PATH}});
    let bytes=0,chunks=[],reason=null;
    const stop=kind=>{if(!reason){reason=kind;child.kill('SIGKILL');}};
    const timer=setTimeout(()=>stop('timeout'),timeout);
    const abort=()=>stop('cancelled');
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const collect=(data,isOutput)=>{
      bytes+=data.length;
      if(bytes>limit){stop('output_limit');return;}
      if(isOutput)chunks.push(data);
    };
    child.stdout.on('data',d=>collect(d,true));child.stderr.on('data',d=>collect(d,false));
    child.stdin.on('error',()=>{});child.stdin.end(input);
    const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    child.on('error',()=>{finish();reject(failure('docker_error'));});
    child.on('close',code=>{finish();
      if(reason||code!==0)reject(failure(reason||'docker_error'));
      else done(Buffer.concat(chunks));
    });
  });
}
