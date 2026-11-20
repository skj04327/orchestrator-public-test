// Synthetic local receipt for general and real-Docker integration tests only.
import {join} from 'node:path';
import {createReadyManifest,receivePrivateTask} from '../private-queue.mjs';
export async function makeLocalReceipt(root,{references=[]}={}){
  const id='20261116T130000Z-123-456',receiptRoot=join(root,'receipts'),stateRoot=join(root,'jobs');
  const path='docs/orchestrator/tasks/'+id+'.txt',content=Buffer.from('SYNTHETIC_LOCAL_JOB');
  const inputs=[{kind:'task',path,content}];
  if(references.length)inputs.push({kind:'references',path:'docs/orchestrator/references/'+id+'.json',content:Buffer.from(JSON.stringify({version:1,urls:references}))});
  const manifest=createReadyManifest(id,{mode:'stable',controller:'auto'},inputs);
  const values=new Map(inputs.map(input=>[input.path,input.content]));
  values.set('docs/orchestrator/requests/'+id+'.json',Buffer.from(JSON.stringify(manifest)));
  const get=async endpoint=>{
    if(endpoint==='')return {private:true,full_name:'skj04327/the-twilight-of-korea'};
    if(endpoint.startsWith('/git/ref/'))return {object:{type:'commit',sha:'e'.repeat(40)}};
    const value=values.get(endpoint.slice('/contents/'.length).split('?')[0]);
    if(!value)throw Error('Missing synthetic input');
    return {type:'file',encoding:'base64',size:value.length,content:value.toString('base64')};
  };
  await receivePrivateTask({id,root:receiptRoot,get});return {id,receiptRoot,stateRoot,path};
}
