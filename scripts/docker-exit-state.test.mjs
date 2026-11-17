import test from 'node:test';
import assert from 'node:assert/strict';
import * as command from './docker-command.mjs';
const completed={Status:'exited',Running:false,Paused:false,Restarting:false,OOMKilled:false,Dead:false,Pid:0,ExitCode:0,Error:'',StartedAt:'2026-11-18T00:00:00.123456789Z',FinishedAt:'2026-11-18T00:00:01.234567890Z'};
test('only a complete stopped Docker run can support a check observation',()=>{
  assert.equal(typeof command.parseExitedDockerState,'function');
  assert.equal(command.parseExitedDockerState(completed).ExitCode,0);
  assert.equal(command.parseExitedDockerState({...completed,OOMKilled:true,ExitCode:137}).OOMKilled,true);
  for(const value of [null,{}, {ExitCode:0}, {...completed,Status:'created'}, {...completed,Status:'dead'}, {...completed,Running:true}, {...completed,Running:undefined}, {...completed,Dead:true}, {...completed,Error:'PRIVATE_DAEMON_ERROR'}, {...completed,Pid:123}, {...completed,OOMKilled:undefined}, {...completed,ExitCode:-1}, {...completed,ExitCode:1.5}, {...completed,StartedAt:'0001-01-01T00:00:00Z'}, {...completed,FinishedAt:completed.StartedAt.replace('00:00:00','00:00:00').replace('123456789','023456789')}])assert.throws(()=>command.parseExitedDockerState(value),e=>e.failureKind==='invalid_state'&&!e.message.includes('PRIVATE_DAEMON_ERROR'));
});
