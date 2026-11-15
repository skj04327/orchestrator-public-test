// Only code/test failures qualify for Codex repair. Never retry resource failures.
export const MAX_REPAIR_ATTEMPTS=2; // Initial attempt + at most two repairs.
export function shouldAttemptRepair(failureKind,attemptsUsed){
  if(!Number.isInteger(attemptsUsed)||attemptsUsed<0)throw Error('Invalid attempt count');
  return failureKind==='nonzero_exit'&&attemptsUsed<MAX_REPAIR_ATTEMPTS;
}
