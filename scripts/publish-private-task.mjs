import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const cwd=join(process.cwd(),'private-game');
const token=process.env.PRIVATE_GAME_WRITE_TOKEN;
const id=process.env.TASK_ID;
if(!token||!/^[0-9]{8}T[0-9]{6}Z-[0-9]+-[0-9]+$/.test(id||''))throw Error('Missing publishing credentials/context');
const report=JSON.parse(await readFile('.private-task-result.json','utf8'));
if(report.id!==id||!Array.isArray(report.paths)||!report.paths.length||report.paths.length>8)throw Error('Missing validated manifest');
async function git(args){
  return await new Promise((resolve,reject)=>{
    const p=spawn('git',args,{cwd,stdio:['ignore','pipe','pipe']});
    let out='',err='';
    p.stdout.on('data',d=>out+=d);
    p.stderr.on('data',d=>err+=d);
    p.on('close',code=>code===0?resolve(out.trim()):reject(Error('Git read check failed')));
    p.on('error',reject);
  });
}
async function api(method,path,payload){
  const response=await fetch('https://api.github.com/repos/skj04327/the-twilight-of-korea'+path,{
    method,
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},
    body:payload===undefined?undefined:JSON.stringify(payload)
  });
  if(!response.ok)throw Error('GitHub API '+method+' HTTP '+response.status);
  return await response.json();
}
const allowed=p=>/^(src\/(?!assets\/)[a-zA-Z0-9_./-]+\.(ts|tsx)|tests\/[a-zA-Z0-9_./-]+\.test\.ts)$/.test(p)&&!p.includes('..')&&!p.includes('//');
try {
  const seen=new Set();
  for(const path of report.paths){
    if(!allowed(path)||seen.has(path))throw Error('Manifest path outside allowlist');
    seen.add(path);
  }
  const porcelain=await git(['status','--porcelain','--untracked-files=all']);
  const statusLines=porcelain.split('\n').filter(Boolean);
  const modified=statusLines.map(x=>x.slice(3));
  if(modified.length!==seen.size||modified.some(p=>!seen.has(p)))throw Error('Checkout changed after verification');
  const localHead=await git(['rev-parse','HEAD']);
  const main=await api('GET','/git/ref/heads/main');
  if(main.object.sha!==localHead)throw Error('Main moved since validation: refusing stale PR');
  const branch='orchestrator/task-'+id;
  await api('POST','/git/refs',{ref:'refs/heads/'+branch,sha:localHead});
  for(const path of report.paths) {
    const stat=await lstat(join(cwd,path));
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65000)throw Error('Unsafe file');
    const content=(await readFile(join(cwd,path),'utf8'));
    const existing=await fetch('https://api.github.com/repos/skj04327/the-twilight-of-korea/contents/'+path+'?ref='+encodeURIComponent(branch),{
      headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28'}
    });
    if(existing.status!==200&&existing.status!==404)throw Error('Cannot inspect destination file');
    const old=existing.status===200?await existing.json():null;
    const request={message:'feat: AI-assisted task '+id,branch,content:Buffer.from(content).toString('base64')};
    if(old)request.sha=old.sha;
    await api('PUT','/contents/'+path.split('/').map(encodeURIComponent).join('/'),request);
  }
  const pr=await api('POST','/pulls',{
    title:'AI task '+id,
    head:branch,base:'main',draft:true,
    body:'Private Termux task '+id+'; Claude planning, Codex implementation, Gemini independent review. npm typecheck, unit tests and production build passed. Changed paths: '+report.paths.map(x=>'\`'+x+'\`').join(', ')+'. Human review required. No automatic merge.'
  });
  console.log('RESULT: DRAFT_PR_CREATED '+pr.html_url);
}catch(e){
  console.error('RESULT: PUBLISH_FAILED '+String(e.message).replace(/[^a-zA-Z0-9 _.():/-]/g,'').slice(0,160));
  process.exitCode=1;
}
