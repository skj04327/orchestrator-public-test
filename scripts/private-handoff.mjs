// Confidential transport, NOT proof that an untrusted worker ran honest checks.
// No token or decryption key is ever available to the execution job.
import {createPrivateKey,createPublicKey,diffieHellman,generateKeyPairSync,
  hkdfSync,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';

export const MAX_HANDOFF_BYTES=800000;
const MAGIC=Buffer.from('ORCHENC1');
const PRIVATE_PREFIX=Buffer.from('302e020100300506032b656e04220420','hex');
const PUBLIC_PREFIX=Buffer.from('302a300506032b656e032100','hex');
const FIELDS=['repository','taskId','runId','runAttempt','workflowSha'];
export function handoffContext(value){
  if(!value||Object.keys(value).length!==FIELDS.length||FIELDS.some(k=>typeof value[k]!=='string')||
    value.repository!=='skj04327/orchestrator-public-test'||
    !/^[0-9]{8}T[0-9]{6}Z-[0-9]+-[0-9]+$/.test(value.taskId)||value.taskId.length>80||
    !/^[1-9][0-9]{0,19}$/.test(value.runId)||! /^[1-9][0-9]{0,5}$/.test(value.runAttempt)||
    !/^[a-f0-9]{40}$/.test(value.workflowSha))throw Error('Invalid handoff context');
  return Buffer.from(JSON.stringify(FIELDS.map(k=>value[k])));
}
export function contextFromEnv(env=process.env){
  const context={repository:env.GITHUB_REPOSITORY,taskId:env.TASK_ID,
    runId:env.GITHUB_RUN_ID,runAttempt:env.GITHUB_RUN_ATTEMPT,workflowSha:env.GITHUB_SHA};
  handoffContext(context);return context;
}
export function recipientKey(secret,context){
  if(typeof secret!=='string'||!secret)throw Error('Missing recipient secret');
  const material=Buffer.from(hkdfSync('sha256',Buffer.from(secret),handoffContext(context),
    Buffer.from('orchestrator-recipient-v1'),32));
  const privateKey=createPrivateKey({key:Buffer.concat([PRIVATE_PREFIX,material]),format:'der',type:'pkcs8'});
  material.fill(0);
  return {privateKey,publicKey:createPublicKey(privateKey).export({format:'der',type:'spki'}).toString('base64')};
}
function transportKey(privateKey,publicKey,context){
  const shared=diffieHellman({privateKey,publicKey});
  try{return Buffer.from(hkdfSync('sha256',shared,handoffContext(context),Buffer.from('orchestrator-transport-v1'),32));}
  finally{shared.fill(0);}
}
function publicKeyFromString(value){
  if(typeof value!=='string'||!/^[A-Za-z0-9+/]{59}=$/.test(value))throw Error('Invalid recipient key');
  const bytes=Buffer.from(value,'base64');
  if(bytes.length!==44||!bytes.subarray(0,12).equals(PUBLIC_PREFIX)||bytes.toString('base64')!==value)throw Error('Invalid recipient key');
  return createPublicKey({key:bytes,format:'der',type:'spki'});
}
export function seal(payload,recipient,context){
  const aad=handoffContext(context),plain=Buffer.from(JSON.stringify(payload));
  if(plain.length>MAX_HANDOFF_BYTES-80)throw Error('Handoff exceeds size limit');
  const ephemeral=generateKeyPairSync('x25519'),nonce=randomBytes(12);
  const key=transportKey(ephemeral.privateKey,publicKeyFromString(recipient),context);
  try{
    const cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad);
    const encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);
    const pub=ephemeral.publicKey.export({format:'der',type:'spki'}).subarray(12);
    return Buffer.concat([MAGIC,pub,nonce,cipher.getAuthTag(),encrypted]);
  }finally{key.fill(0);plain.fill(0);}
}
export function open(bytes,privateKey,context){
  if(!Buffer.isBuffer(bytes)||bytes.length<70||bytes.length>MAX_HANDOFF_BYTES||!bytes.subarray(0,8).equals(MAGIC))throw Error('Invalid encrypted handoff');
  const publicKey=createPublicKey({key:Buffer.concat([PUBLIC_PREFIX,bytes.subarray(8,40)]),format:'der',type:'spki'});
  const key=transportKey(privateKey,publicKey,context);
  try{
    const cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(40,52));
    cipher.setAAD(handoffContext(context));cipher.setAuthTag(bytes.subarray(52,68));
    const plain=Buffer.concat([cipher.update(bytes.subarray(68)),cipher.final()]);
    try{return JSON.parse(plain.toString('utf8'));}finally{plain.fill(0);}
  }finally{key.fill(0);}
}
