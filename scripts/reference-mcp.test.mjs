import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {handleMcpMessage,validateSnapshot} from './reference-mcp-server.mjs';
import {createReadonlyMcpSession,readonlyClaudeToolFlags} from './reference-mcp-config.mjs';

test('only three read-only tools and bounded pre-sanitized outputs are exposed',()=>{
  const source=validateSnapshot({version:1,sources:[{url:'https://ko.wikipedia.org/wiki/Test',text:'Historical site'}],
    imageDescription:'Houses by a river'});
  const r=handleMcpMessage({jsonrpc:'2.0',id:1,method:'tools/list'},source);
  assert.deepEqual(r.result.tools.map(x=>x.name),['list_references','read_reference','image_observation']);
  const read=handleMcpMessage({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'read_reference',arguments:{index:0}}},source);
  assert.match(read.result.content[0].text,/UNTRUSTED SOURCE DATA/);
  assert.match(read.result.content[0].text,/Historical site/);
  const blocked=handleMcpMessage({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'write_file',arguments:{path:'/etc/passwd'}}},source);
  assert.equal(blocked.result.isError,true);
  const bad=handleMcpMessage({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'read_reference',arguments:{index:99}}},source);
  assert.equal(bad.result.isError,true);
  assert.throws(()=>validateSnapshot({version:1,sources:[],imageDescription:'x'.repeat(3000)}));
});
test('temporary local MCP manifest contains only our Node entrypoint and no remote URLs',async()=>{
 const session=await createReadonlyMcpSession([{url:'https://en.wikipedia.org/wiki/Goryeo',text:'History'}],'No private image');
 try{
   const data=JSON.parse(await readFile(session.configPath,'utf8'));
   assert.deepEqual(Object.keys(data.mcpServers),['goryeo_refs']);
   assert.equal(data.mcpServers.goryeo_refs.command,process.execPath);
   assert.ok(!JSON.stringify(data).includes('api_key'));
   assert.deepEqual(readonlyClaudeToolFlags(session.configPath),['--mcp-config',session.configPath,'--strict-mcp-config']);
 }finally{await session.cleanup();}
});
test('stdio MCP initialize/list/call are usable without network',async()=>{
 const session=await createReadonlyMcpSession([{url:'https://en.wikipedia.org/wiki/Goryeo',text:'The kingdom'}]);
 try{
   const script=new URL('./reference-mcp-server.mjs',import.meta.url).pathname;
   const child=spawn(process.execPath,[script],{env:{PATH:process.env.PATH,ORCHESTRATOR_REFERENCE_SNAPSHOT:session.snapshotPath},
     stdio:['pipe','pipe','pipe']});
   let out='';
   child.stdout.on('data',b=>out+=b.toString('utf8'));
   child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}}})+'\n');
   child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})+'\n');
   child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'read_reference',arguments:{index:0}}})+'\n');
   child.stdin.end();
   const code=await new Promise((resolve,reject)=>{
     const tm=setTimeout(()=>{child.kill();reject(Error('MCP process timed out'));},5000);
     child.on('close',c=>{clearTimeout(tm);resolve(c)});
     child.on('error',e=>{clearTimeout(tm);reject(e)});
   });
   assert.equal(code,0);
   const msgs=out.trim().split('\n').map(JSON.parse);
   assert.equal(msgs.length,3);
   assert.equal(msgs[0].result.serverInfo.name,'goryeo-readonly-references');
   assert.equal(msgs[1].result.tools.length,3);
   assert.match(msgs[2].result.content[0].text,/The kingdom/);
 }finally{await session.cleanup();}
});
