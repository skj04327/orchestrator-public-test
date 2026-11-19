// Bounded trusted-host Docker client. No host credentials enter child env.
import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
export function failure(kind){const error=Error('Protected worker failed');error.failureKind=kind;return error;}
export async function docker(args,{input,inputStream,limit=16384,timeout=30000,signal,captureOutput}={}){
  if(inputStream!==undefined&&(input!==undefined||typeof inputStream?.[Symbol.asyncIterator]!=='function'))throw failure('invalid_configuration');
  if(captureOutput!==undefined&&typeof captureOutput!=='function')throw failure('invalid_configuration');
  if(signal?.aborted)throw failure('cancelled');
  let source;
  try{source=inputStream===undefined?null:Readable.from(inputStream,{objectMode:false,highWaterMark:65536});}
  catch{throw failure('input_failed');}
  return new Promise((done,reject)=>{
    const child=spawn('docker',args,{stdio:['pipe','pipe','pipe'],
      // Docker client gets no host credentials, preload settings or daemon overrides.
      env:{PATH:process.env.PATH}});
    let bytes=0,chunks=[],reason=null;
    const diagnostics=captureOutput?[]:null;
    const stop=kind=>{if(!reason){reason=kind;child.kill('SIGKILL');}};
    const timer=setTimeout(()=>stop('timeout'),timeout);
    const abort=()=>stop('cancelled');
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const collect=(data,isOutput)=>{
      if(diagnostics&&bytes<limit)diagnostics.push(data.subarray(0,limit-bytes));
      bytes+=data.length;
      if(bytes>limit){stop('output_limit');return;}
      if(isOutput)chunks.push(data);
    };
    child.stdout.on('data',d=>collect(d,true));child.stderr.on('data',d=>collect(d,false));
    child.stdin.on('error',()=>{});
    // Observe pump errors immediately, but finish only after child + producer stop.
    const pumped=source?pipeline(source,child.stdin).then(()=>null,error=>{
      const kind=['blob_integrity','unsafe_cache_blob','cancelled'].includes(error.failureKind)?error.failureKind:'input_failed';stop(kind);return kind;
    }):Promise.resolve(null);
    if(!source)child.stdin.end(input);
    const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    child.on('error',()=>{if(!reason)reason='docker_error';});
    child.on('close',async code=>{source?.destroy();const pumpFailure=await pumped;if(pumpFailure&&!reason)reason=pumpFailure;finish();
      if(diagnostics){
        try{captureOutput(Buffer.concat(diagnostics));}
        catch{reject(failure('capture_failed'));return;}
      }
      if(reason||code!==0)reject(failure(reason||'docker_error'));
      else done(Buffer.concat(chunks));
    });
  });
}

// ExitCode defaults to zero even for never-started containers. Require a finished run.
export function parseExitedDockerState(state){
  const timestamp=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(v)?Date.parse(v):NaN;
  if(!state||Array.isArray(state)||state.Status!=='exited'||state.Running!==false||state.Paused!==false||state.Restarting!==false||
    state.Dead!==false||typeof state.OOMKilled!=='boolean'||state.Error!==''||state.Pid!==0||
    !Number.isInteger(state.ExitCode)||state.ExitCode<0||state.ExitCode>255||
    !(timestamp(state.StartedAt)>0)||!(timestamp(state.FinishedAt)>=timestamp(state.StartedAt)))throw failure('invalid_state');
  return state;
}
