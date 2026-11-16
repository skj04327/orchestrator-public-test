import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('write secrets occur only in fresh trusted jobs; public artifacts have one encrypted path',async()=>{
  const text=await readFile('.github/workflows/task-intake.yml','utf8');
  const worker=text.split('  task-execution:')[1]?.split('  task-publish:')[0];
  const publisher=text.split('  task-publish:')[1];
  assert.ok(publisher,'Missing isolated publishing job');
  assert.ok(!worker.includes('PRIVATE_GAME_WRITE_TOKEN'));
  assert.ok(!worker.includes('publish-private-task.mjs'));
  assert.ok(!publisher.includes('repository: skj04327/the-twilight-of-korea'));
  assert.ok(!publisher.includes('npm ')&&!publisher.includes('execute-private-task.mjs'));
  assert.match(publisher,/ref: \$\{\{ github.sha \}\}/);
  assert.match(publisher,/path: \$\{\{ runner.temp \}\}\/incoming-handoff/);
  assert.match(text,/ORCHESTRATOR_LIVE_POLICY_CONFIRMED/);
  assert.match(text,/ORCHESTRATOR_FREE_STORAGE_CONFIRMED/);
  // A mutable exporter cannot guarantee public-artifact confidentiality yet.
  // No repository variable may enable this staged implementation.
  assert.match(text,/prepare-handoff:[\s\S]*?if: >-\n\s+false &&/);
  assert.match(worker,/path: \.private-handoff.enc\n/);
  assert.match(worker,/retention-days: 1/);
  assert.match(worker,/include-hidden-files: true/);
  assert.match(publisher,/EXECUTION_OUTCOME: \$\{\{ needs.task-execution.result \}\}/);
});
