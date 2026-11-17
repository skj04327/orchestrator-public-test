// Read-only status. No decryption key, baseline source or live execution CLI.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readIndependentCheckStatus} from './local-independent-checks.mjs';
async function main(){
  const [command,id,stateRoot]=process.argv.slice(2);
  if(process.env.GITHUB_ACTIONS==='true'||command!=='status'||process.argv.length!==5)throw Error('Local status only');
  console.log(JSON.stringify(await readIndependentCheckStatus({id,stateRoot})));
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)
  main().catch(()=>{console.error('RESULT: INDEPENDENT_CHECK_STATUS_FAILED');process.exitCode=1;});
