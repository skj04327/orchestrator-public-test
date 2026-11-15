import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_REPAIR_ATTEMPTS,shouldAttemptRepair} from './retry-policy.mjs';

test('at most two code-error repairs for three total validations',()=>{
  assert.equal(MAX_REPAIR_ATTEMPTS,2);
  assert.equal(shouldAttemptRepair('nonzero_exit',0),true);
  assert.equal(shouldAttemptRepair('nonzero_exit',1),true);
  assert.equal(shouldAttemptRepair('nonzero_exit',2),false);
});
test('never repair timeout, output exhaustion, spawn failure or interruption',()=>{
  for(const kind of ['timeout','output_limit','spawn_error','signal','operation_failed',undefined])
    assert.equal(shouldAttemptRepair(kind,0),false);
});
test('invalid attempt count fails closed',()=>{
  assert.throws(()=>shouldAttemptRepair('nonzero_exit',-1));
  assert.throws(()=>shouldAttemptRepair('nonzero_exit',1.5));
});
