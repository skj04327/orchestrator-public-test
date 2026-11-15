// Cryptographic bind between the validated checkout and files written to a Draft PR.
// No network, CLI, tokens or task text are used in this module.
import {createHash} from 'node:crypto';
import {lstat,readFile} from 'node:fs/promises';
import {join} from 'node:path';

const ALLOWED=/^(?:src\/(?!assets\/)[a-zA-Z0-9_./-]+\.(?:ts|tsx)|tests\/[a-zA-Z0-9_./-]+\.test\.ts)$/;
const DIGEST=/^[a-f0-9]{64}$/;
const LIMIT=65000;

export function isSafeManifestPath(path){
  return typeof path==='string'&&
    ALLOWED.test(path)&&!path.includes('..')&&!path.includes('//');
}
export function isVerifiedDigest(digest){
  return typeof digest==='string'&&DIGEST.test(digest);
}
export async function digestChangedFiles(root,paths){
  if(typeof root!=='string'||!root||!Array.isArray(paths)||
     paths.length<1||paths.length>8||
     new Set(paths).size!==paths.length||
     paths.some(p=>!isSafeManifestPath(p)))
    throw Error('Unsafe PR manifest');
  const hasher=createHash('sha256');
  for(const p of [...paths].sort()){
    const file=join(root,p);
    const stat=await lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>LIMIT)
      throw Error('Unsafe PR file type or size');
    const content=await readFile(file);
    if(content.length>LIMIT)throw Error('Unsafe PR file size');
    hasher.update(p,'utf8');
    hasher.update('\0');
    hasher.update(String(content.length),'utf8');
    hasher.update('\0');
    hasher.update(content);
    hasher.update('\0');
  }
  return hasher.digest('hex');
}
