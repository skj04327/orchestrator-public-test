// Git itself generates the expected tree/commit objects; only synthetic source.
import {mkdtemp,mkdir,writeFile,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
const exec=promisify(execFile),repo='skj04327/the-twilight-of-korea';
export async function gitBaselineFixture(baseline,{executablePaths=[]}={}){
  const root=await mkdtemp(join(tmpdir(),'git-baseline-'));
  try{
    const env={PATH:process.env.PATH,HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',
      GIT_AUTHOR_NAME:'Synthetic',GIT_AUTHOR_EMAIL:'synthetic@example.invalid',GIT_COMMITTER_NAME:'Synthetic',GIT_COMMITTER_EMAIL:'synthetic@example.invalid',
      GIT_AUTHOR_DATE:'2026-11-17T00:00:00Z',GIT_COMMITTER_DATE:'2026-11-17T00:00:00Z'};
    const git=async args=>(await exec('git',['-c','core.hooksPath=/dev/null',...args],{cwd:root,env})).stdout.trim();
    await git(['init','--quiet']);
    for(const f of baseline.files){await mkdir(dirname(join(root,f.path)),{recursive:true});await writeFile(join(root,f.path),Buffer.from(f.content,'base64'));if(executablePaths.includes(f.path))await chmod(join(root,f.path),0o755);}
    await git(['add','--all']);await git(['commit','--quiet','-m','Synthetic baseline']);
    const baseSha=await git(['rev-parse','HEAD']),treeSha=await git(['rev-parse','HEAD^{tree}']);
    const listed=await git(['ls-tree','-r','-t','-l',treeSha]);
    const entries=listed.split('\n').filter(Boolean).map(line=>{
      const [meta,path]=line.split('\t'),[mode,type,sha,size]=meta.trim().split(/\s+/);
      return {path,mode,type,sha,...(type==='blob'?{size:Number(size)}:{})};
    });
    const blobs=new Map(baseline.files.map(f=>{
      const b=Buffer.from(f.content,'base64'),sha=createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
      return [sha,{sha,size:b.length,encoding:'base64',content:b.toString('base64')}];
    }));
    const values=new Map([['',{private:true,full_name:repo}],['/git/ref/heads/main',{object:{type:'commit',sha:baseSha}}],
      ['/git/commits/'+baseSha,{sha:baseSha,tree:{sha:treeSha}}],['/git/trees/'+treeSha+'?recursive=1',{sha:treeSha,truncated:false,tree:entries}],
      ...[...blobs].map(([sha,v])=>['/git/blobs/'+sha,v])]);
    const calls=[];
    const get=async path=>{calls.push(path);if(!values.has(path))throw Error('Unexpected synthetic GET');return structuredClone(values.get(path));};
    return {baseSha,treeSha,entries,values,calls,get};
  }finally{await rm(root,{recursive:true,force:true});}
}
