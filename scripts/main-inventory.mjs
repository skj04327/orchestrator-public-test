// Shared authenticated private-main inventory. Never execute repository data.
import {createHash} from 'node:crypto';
export const BASELINE_REPOSITORY='skj04327/the-twilight-of-korea';
const SHA=/^[a-f0-9]{40}$/;const sha=v=>typeof v==='string'&&SHA.test(v);
export function fail(kind){const e=Error('Private baseline unavailable');e.failureKind=kind;return e;}
export function objectHash(type,bytes){return createHash('sha1').update(type+' '+bytes.length+'\0').update(bytes).digest('hex');}
export function checkTree(value,treeSha){
  if(value?.sha!==treeSha||value.truncated!==false||!Array.isArray(value.tree)||value.tree.length>20000)throw fail('invalid_tree');
  const nodes=new Map(),children=new Map([['',[]]]);
  for(const e of value.tree){
    if(typeof e.path!=='string'||!e.path||e.path.length>4096||e.path.includes('\0')||e.path.split('/').some(p=>!p||p==='.'||p==='..')||
      Buffer.from(e.path).toString('utf8')!==e.path||nodes.has(e.path)||!sha(e.sha)||
      !(e.type==='tree'&&e.mode==='040000'||e.type==='blob'&&['100644','100755'].includes(e.mode)))throw fail('unsupported_tree');
    if(e.type==='blob'&&(!Number.isSafeInteger(e.size)||e.size<0))throw fail('invalid_size');
    nodes.set(e.path,{path:e.path,type:e.type,mode:e.mode,sha:e.sha,...(e.type==='blob'?{size:e.size}:{})});
    if(e.type==='tree')children.set(e.path,[]);
  }
  for(const e of nodes.values()){
    const i=e.path.lastIndexOf('/'),parent=i<0?'':e.path.slice(0,i),name=e.path.slice(i+1);
    if(!children.has(parent))throw fail('missing_tree_parent');
    children.get(parent).push({...e,name});
  }
  for(const [path,entries]of children){
    entries.sort((a,b)=>Buffer.compare(Buffer.from(a.name+(a.type==='tree'?'/':'')),Buffer.from(b.name+(b.type==='tree'?'/':''))));
    const bytes=Buffer.concat(entries.map(e=>Buffer.concat([Buffer.from((e.type==='tree'?'40000':e.mode)+' '+e.name+'\0'),Buffer.from(e.sha,'hex')])));
    if(objectHash('tree',bytes)!==(path?nodes.get(path).sha:treeSha))throw fail('tree_integrity');
  }
  return [...nodes.values()].filter(e=>e.type==='blob').sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
export async function readPrivateMainHead(request){
  const repo=await request('');
  if(repo?.private!==true||repo.full_name!==BASELINE_REPOSITORY)throw fail('repo_not_private');
  const ref=await request('/git/ref/heads/main');
  if(ref?.object?.type!=='commit'||!sha(ref.object.sha))throw fail('invalid_main');return ref.object.sha;
}
export async function readMainInventory({request,expectedBaseSha}){
  const baseSha=await readPrivateMainHead(request);
  if(expectedBaseSha!==undefined&&baseSha!==expectedBaseSha)throw fail('main_moved');
  const commit=await request('/git/commits/'+baseSha),treeSha=commit?.tree?.sha;
  if(commit?.sha!==baseSha||!sha(treeSha))throw fail('invalid_commit');
  const tree=await request('/git/trees/'+treeSha+'?recursive=1'),entries=checkTree(tree,treeSha);
  const totalBytes=entries.reduce((n,e)=>n+e.size,0);if(!Number.isSafeInteger(totalBytes))throw fail('invalid_size');
  const treeEntries=tree.tree.map(e=>({path:e.path,mode:e.mode,type:e.type,sha:e.sha,...(e.type==='blob'?{size:e.size}:{})}));
  return {baseSha,treeSha,entries,treeEntries,totalBytes};
}
