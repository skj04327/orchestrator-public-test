#!/usr/bin/env node
// Local synthetic GitHub CLI protocol fixture. NEVER calls a network service.
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
const config=JSON.parse(readFileSync(join(dirname(process.argv[1]),'queue-config.json'),'utf8'));
const args=process.argv.slice(2),at=name=>args.indexOf(name)>=0?args[args.indexOf(name)+1]:null;
const endpoint=args.find(a=>a.startsWith('repos/')||a==='user')||'';
const method=at('-X')||'GET';
appendFileSync(config.log,JSON.stringify({command:args[0],method,endpoint})+'\n');
if(args[0]!=='api')process.exit(91);
if(endpoint==='user'){console.log('skj04327');process.exit(0);}
const repo='repos/skj04327/the-twilight-of-korea';
if(!endpoint.startsWith(repo))process.exit(92);
if(endpoint===repo){console.log(args.includes('--jq')?String(!config.public):JSON.stringify({private:!config.public,full_name:'skj04327/the-twilight-of-korea'}));process.exit(0);}
if(endpoint===repo+'/git/ref/heads/orchestrator/task-queue'){
  console.log(JSON.stringify({object:{type:'commit',sha:'e'.repeat(40)}}));process.exit(0);
}
const store=JSON.parse(readFileSync(config.store,'utf8'));
const path=endpoint.slice((repo+'/contents/').length).split('?')[0];
if(method==='PUT'){
  let request;
  if(at('--input'))request=JSON.parse(readFileSync(at('--input'),'utf8'));
  else{
    request={};for(let i=0;i<args.length;i++)if(args[i]==='-f'){const field=args[i+1],j=field.indexOf('=');request[field.slice(0,j)]=field.slice(j+1);}
  }
  if(request.branch!=='orchestrator/task-queue'||(config.failKind&&path.includes('/'+config.failKind+'/')))process.exit(93);
  store[path]=request.content;writeFileSync(config.store,JSON.stringify(store));process.exit(0);
}
if(method!=='GET'||!(path in store))process.exit(94);
const data=Buffer.from(store[path],'base64');
console.log(JSON.stringify({type:'file',encoding:'base64',size:data.length,content:store[path]}));
