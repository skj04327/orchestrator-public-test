// Local-only private main GET adapter. Credentials go to gh, never to code checks.
import {spawn} from 'node:child_process';
import {ghPrivateEnvironment} from './gh-private-environment.mjs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {collectPrivateBaseline,BASELINE_REPOSITORY} from './pinned-private-baseline.mjs';
export function ghBaselineGet(path,{signal}={}){
  if(typeof path!=='string'||(path!==''&&path!=='/git/ref/heads/main'&&!/^\/git\/(commits|blobs)\/[a-f0-9]{40}$/.test(path)&&
    !/^\/git\/trees\/[a-f0-9]{40}\?recursive=1$/.test(path)))return Promise.reject(Error('Unavailable baseline endpoint'));
  if(signal?.aborted)return Promise.reject(Error('Baseline read cancelled'));
  return new Promise((done,reject)=>{
    const env=ghPrivateEnvironment();
    const p=spawn('gh',['api','--hostname','github.com','-X','GET','repos/'+BASELINE_REPOSITORY+path],{env,stdio:['ignore','pipe','pipe']});
    let total=0,chunks=[],limited=false;
    const stop=()=>{limited=true;p.kill('SIGKILL');},timer=setTimeout(stop,30000);
    signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
    const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);};
    const collect=(data,out)=>{total+=data.length;if(total>4000000)stop();else if(out)chunks.push(data);};
    p.stdout.on('data',d=>collect(d,true));p.stderr.on('data',d=>collect(d,false));
    p.on('error',()=>{finish();reject(Error('Private baseline read failed'));});
    p.on('close',code=>{finish();if(code!==0||limited){reject(Error('Private baseline read failed'));return;}
      try{done(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(Error('Invalid private baseline response'));}
    });
  });
}
async function main(){
  if(process.env.GITHUB_ACTIONS==='true'||process.argv.length!==3||process.argv[2]!=='inspect')throw Error('Local inspect required');
  const r=await collectPrivateBaseline({get:ghBaselineGet});
  console.log(JSON.stringify({phase:r.phase,fileCount:r.fileCount,totalBytes:r.totalBytes,publishAuthorized:false}));
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)
  main().catch(()=>{console.error('RESULT: PINNED_BASELINE_INSPECT_FAILED');process.exitCode=1;});
