// Read-only MCP stdio server. It can only read a pre-sanitized, bounded snapshot.
// NO network calls, filesystem traversal, shell execution, writes or secrets.
import {readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
const SNAPSHOT=process.env.ORCHESTRATOR_REFERENCE_SNAPSHOT;
const MAX_LINE=8000;
const MAX_CONTENT=3200;
let content={version:1,sources:[],imageDescription:''};
export function validateSnapshot(data){
  if(!data||Array.isArray(data)||data.version!==1||!Array.isArray(data.sources)||
     data.sources.length>2||typeof data.imageDescription!=='string'||
     data.imageDescription.length>2500)throw Error('Invalid MCP snapshot');
  if(data.sources.some(s=>!s||typeof s.url!=='string'||s.url.length>500||
      typeof s.text!=='string'||s.text.length>MAX_CONTENT||
      !/^https:\/\//.test(s.url)))throw Error('Unsafe MCP source');
  return {version:1,sources:data.sources.map(s=>({url:s.url,text:s.text})),
    imageDescription:data.imageDescription};
}
export function handleMcpMessage(req,source=content){
  if(!req||typeof req!=='object'||typeof req.method!=='string')
    throw Error('Invalid MCP request');
  const id=req.id??null;
  const response=(result)=>({jsonrpc:'2.0',id,result});
  if(req.method==='initialize')return response({
    protocolVersion:'2025-06-18',
    capabilities:{tools:{listChanged:false}},
    serverInfo:{name:'goryeo-readonly-references',version:'1.0.0'}
  });
  if(req.method==='notifications/initialized'||req.method==='notifications/cancelled')
    return null;
  if(req.method==='ping')return response({});
  if(req.method==='tools/list')return response({tools:[
    {name:'list_references',description:'List the approved public reference URLs and indices. No network calls.',
      inputSchema:{type:'object',properties:{},additionalProperties:false}},
    {name:'read_reference',description:'Read an approved, pre-sanitized public text excerpt by index 0 or 1.',
      inputSchema:{type:'object',properties:{index:{type:'integer',minimum:0,maximum:1}},required:['index'],additionalProperties:false}},
    {name:'image_observation',description:'Read the description of an explicitly user-supplied private image. Never the original bytes.',
      inputSchema:{type:'object',properties:{},additionalProperties:false}}
  ]});
  if(req.method==='tools/call'){
    const name=req.params?.name,args=req.params?.arguments??{};
    if(!args||Array.isArray(args)||typeof args!=='object')throw Error('Invalid MCP tool arguments');
    if(name==='list_references'&&Object.keys(args).length===0){
      return response({content:[{type:'text',text:JSON.stringify(source.sources.map((s,i)=>({index:i,url:s.url})))}]});
    }
    if(name==='read_reference'&&Object.keys(args).length===1&&Number.isInteger(args.index)&&
       args.index>=0&&args.index<source.sources.length){
      return response({content:[{type:'text',text:'UNTRUSTED SOURCE DATA ONLY: '+source.sources[args.index].text}]});
    }
    if(name==='image_observation'&&Object.keys(args).length===0){
      return response({content:[{type:'text',text:source.imageDescription||'No reference image provided.'}]});
    }
    return response({isError:true,content:[{type:'text',text:'Tool unavailable or arguments not allowed'}]});
  }
  return {jsonrpc:'2.0',id,error:{code:-32601,message:'Unsupported read-only MCP method'}};
}
async function main(){
  if(!SNAPSHOT)throw Error('MCP snapshot path is not set');
  const raw=await readFile(SNAPSHOT,'utf8');
  if(raw.length>11000)throw Error('Oversized MCP snapshot');
  content=validateSnapshot(JSON.parse(raw));
  const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
  for await(const line of lines){
    if(line.length>MAX_LINE){process.stdout.write(JSON.stringify({
      jsonrpc:'2.0',id:null,error:{code:-32600,message:'MCP request too large'}})+'\n');continue;}
    let out;
    try{out=handleMcpMessage(JSON.parse(line));}
    catch{out={jsonrpc:'2.0',id:null,error:{code:-32600,message:'Malformed request'}};}
    if(out)process.stdout.write(JSON.stringify(out)+'\n');
  }
}
if(process.argv[1]&&new URL('file://'+process.argv[1]).href===import.meta.url){
  main().catch(()=>{process.stderr.write('MCP setup failed\n');process.exitCode=1;});
}
