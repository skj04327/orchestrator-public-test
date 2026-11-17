import {fail} from './main-inventory.mjs';
// Bounded read-only host session. File writers must settle after this signal aborts.
export function privateReadSession({get,signal,timeoutMs,requestLimit=10006}){
  if(typeof get!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>1800000||
    !Number.isSafeInteger(requestLimit)||requestLimit<1||requestLimit>10006)throw fail('invalid_configuration');
  if(signal?.aborted)throw fail('cancelled');
  const controller=new AbortController(),deadline=Date.now()+timeoutMs;let reason='cancelled',calls=0;
  const abort=(kind='cancelled')=>{if(!controller.signal.aborted){reason=kind;controller.abort();}};
  const external=()=>abort(),timer=setTimeout(()=>abort('timeout'),timeoutMs);
  signal?.addEventListener('abort',external,{once:true});
  function checkStopped(){if(controller.signal.aborted)throw fail(reason);if(Date.now()>=deadline){abort('timeout');throw fail('timeout');}}
  async function request(path){
    checkStopped();if(++calls>requestLimit)throw fail('request_limit');
    let onAbort;const stopped=new Promise((_,reject)=>{onAbort=()=>reject(fail(reason));controller.signal.addEventListener('abort',onAbort,{once:true});});
    try{const value=await Promise.race([get(path,{signal:controller.signal}),stopped]);checkStopped();return value;}
    finally{controller.signal.removeEventListener('abort',onAbort);}
  }
  return {request,checkStopped,abort,signal:controller.signal,dispose(){clearTimeout(timer);signal?.removeEventListener('abort',external);}};
}
