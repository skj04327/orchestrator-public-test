// Temporary, local-only MCP configuration for Claude Code; no external servers.
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateSnapshot} from './reference-mcp-server.mjs';
const SERVER=fileURLToPath(new URL('./reference-mcp-server.mjs',import.meta.url));
export async function createReadonlyMcpSession(entries=[],imageDescription=''){
  const snapshot=validateSnapshot({version:1,sources:entries,imageDescription});
  const directory=await mkdtemp(join(tmpdir(),'goryeo-refs-'));
  const file=join(directory,'snapshot.json');
  const configFile=join(directory,'mcp.json');
  await writeFile(file,JSON.stringify(snapshot),{mode:0o600});
  // No arbitrary commands. Only our checked-in read-only server is executable.
  const config={mcpServers:{goryeo_refs:{
    command:process.execPath,
    args:[SERVER],
    env:{ORCHESTRATOR_REFERENCE_SNAPSHOT:file}
  }}};
  await writeFile(configFile,JSON.stringify(config),{mode:0o600});
  return {configPath:configFile,snapshotPath:file,root:directory,
    cleanup:()=>rm(directory,{recursive:true,force:true})};
}
export function readonlyClaudeToolFlags(configPath){
  if(typeof configPath!=='string'||!configPath)return [];
  return ['--mcp-config',configPath,'--strict-mcp-config'];
}
