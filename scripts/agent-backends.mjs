// Subscription CLI adapters for the dynamic control tower.
// Existing run(bin,args,opts) function captures outputs without printing private text.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readonlyClaudeToolFlags } from './reference-mcp-config.mjs';
const MAX_PLAN=12000;
const MAX_REVIEW=18000;
function bounded(v,max){if(typeof v!=='string'||!v.trim()||v.length>max)throw Error('Model result is absent or too long');return v.trim();}
function parseClaude(raw){
  const parsed=JSON.parse(raw);
  if(parsed.is_error||typeof parsed.result!=='string')throw Error('Claude CLI reported invalid result');
  return parsed.result;
}
export async function runPlanner({provider,prompt,run,cwd,mcpConfig=null}){
  if(provider==='claude'){
    const raw=await run('claude',['-p',prompt,'--output-format','json','--max-turns','5',...readonlyClaudeToolFlags(mcpConfig),'--allowedTools',mcpConfig?'Read,Glob,Grep,mcp__goryeo_refs__list_references,mcp__goryeo_refs__read_reference,mcp__goryeo_refs__image_observation':'Read,Glob,Grep'],{cwd,timeout:180000});
    return bounded(parseClaude(raw),MAX_PLAN);
  }
  if(provider==='gemini')return bounded(await run('agy',['-p',prompt+'\nDo not modify any files.'],{cwd,timeout:180000}),MAX_PLAN);
  if(provider==='codex'){
    const dir=await mkdtemp(join(tmpdir(),'orchestrator-plan-'));
    try{
      const target=join(dir,'plan.txt');
      await run('codex',['exec','--sandbox','read-only','--output-last-message',target,prompt+'\nNo modifications.'],{cwd,timeout:180000});
      return bounded(await readFile(target,'utf8'),MAX_PLAN);
    }finally{await rm(dir,{recursive:true,force:true});}
  }
  throw Error('Unsupported planning provider');
}
export async function runReviewer({provider,prompt,run,cwd,mcpConfig=null}){
  if(provider==='gemini')return bounded(await run('agy',['-p',prompt],{cwd,timeout:240000}),MAX_REVIEW);
  if(provider==='claude'){
    const raw=await run('claude',['-p',prompt,'--output-format','json','--max-turns','3',...readonlyClaudeToolFlags(mcpConfig),'--allowedTools',mcpConfig?'Read,Glob,Grep,mcp__goryeo_refs__list_references,mcp__goryeo_refs__read_reference,mcp__goryeo_refs__image_observation':'Read,Glob,Grep'],{cwd,timeout:240000});
    return bounded(parseClaude(raw),MAX_REVIEW);
  }
  if(provider==='codex')throw Error('Codex reviewer would not be independent of Codex developer');
  throw Error('Unsupported reviewer provider');
}
export function parseReviewVerdict(response){
  const head=bounded(response,MAX_REVIEW).split(/\r?\n/)[0].trim().toUpperCase();
  if(head==='PASS'||head==='FAIL')return head;
  // Some CLI clients prepend superficial bullets; anything else must fail closed.
  throw Error('Ambiguous review verdict');
}
