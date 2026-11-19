// Runs inside the disposable worker. Rootfs/control/input are read-only.
import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
const root='/work';
await cp('/input/private-game',join(root,'private-game'),{recursive:true});
await cp('/input/task-private',join(root,'task-private'),{recursive:true});
await mkdir('/work/home',{mode:0o700});
await mkdir('/work/audit',{mode:0o700});
const auth=JSON.parse(await readFile('/input/auth.json','utf8'));
if(auth.codex){
  await mkdir('/work/home/.codex',{recursive:true,mode:0o700});
  await writeFile('/work/home/.codex/auth.json',auth.codex,{mode:0o600});
}
if(auth.gemini){
  const dir='/work/home/.gemini/antigravity-cli';await mkdir(dir,{recursive:true,mode:0o700});
  await writeFile(join(dir,'antigravity-oauth-token'),auth.gemini,{mode:0o600});
}
const child=spawn('node',['/opt/control/execute-private-task.mjs'],{
  cwd:root,stdio:'inherit',env:{...process.env,CLAUDE_CODE_OAUTH_TOKEN:auth.claude||'',
    ORCHESTRATOR_WORKER_HAS_AUTH:auth.codex||auth.gemini||auth.claude?'1':'0'}
});
child.on('error',()=>{process.exitCode=1;});
child.on('exit',(code)=>{process.exitCode=code===0?0:1;});
