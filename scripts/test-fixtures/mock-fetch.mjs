// Blocks ALL real network operations during the offline publisher contract test.
import { appendFileSync } from 'node:fs';
const json=(value,status=200)=>new Response(JSON.stringify(value),{
  status,headers:{'content-type':'application/json'}});
globalThis.fetch=async(input,options={})=>{
  const url=new URL(String(input)),method=(options.method||'GET').toUpperCase();
  if(url.hostname!=='api.github.com')throw Error('Mock network denied');
  if(options.headers?.Authorization!=='Bearer FIXTURE_TOKEN')throw Error('Incorrect fake credentials');
  const body=options.body?JSON.parse(options.body):null;
  const row={method,path:url.pathname,draft:body?.draft??null,
    branch:body?.branch??null,hasContent:typeof body?.content==='string'};
  appendFileSync(process.env.MOCK_FETCH_LOG,JSON.stringify(row)+'\n');
  if(method==='GET'&&url.pathname.endsWith('/git/ref/heads/main'))
    return json({object:{sha:process.env.MOCK_GIT_HEAD}});
  if(method==='GET'&&url.pathname.includes('/contents/'))return json({message:'Not Found'},404);
  if(method==='POST'&&url.pathname.endsWith('/git/refs'))return json({ref:body.ref},201);
  if(method==='PUT'&&url.pathname.includes('/contents/'))return json({content:{sha:'fixture-only'}},201);
  if(method==='POST'&&url.pathname.endsWith('/pulls'))
    return json({html_url:'https://github.com/skj04327/the-twilight-of-korea/pull/999999'},201);
  throw Error('Unexpected mocked request: '+method+' '+url.pathname);
};
