// First real three-model integration test. No repository writes or PRs.
// All AI output is kept in runner memory; public logs only show stage statuses.
import { spawn } from 'node:child_process';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const request = process.env.ORCHESTRATOR_TASK || 'Design a pure JavaScript function isPalindrome(text) with three test cases.';
if (request.length > 400 || !request.trim()) throw Error('Task must be 1..400 characters');
const maxAttempts = 3;

async function run(command, args, { timeoutMs = 180000, env = {}, cwd } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    let overflow = false;
    for (const [stream, collect] of [[child.stdout, 'out'], [child.stderr, 'err']]) {
      stream.on('data', buffer => {
        const str = buffer.toString();
        if (stdout.length + stderr.length + str.length > 1_000_000) {
          overflow = true; child.kill('SIGKILL'); return;
        }
        if (collect === 'out') stdout += str; else stderr += str;
      });
    }
    child.on('error', error => { clearTimeout(timer); reject(new Error(command + ' process error: ' + error.code)); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (overflow) return reject(new Error(command + ' output too large'));
      if (code !== 0) return reject(new Error(command + ' exited ' + (code ?? signal) + ' (output withheld)'));
      resolve(stdout);
    });
  });
}

async function claude(prompt) {
  const text = await run('claude', ['-p', prompt, '--output-format', 'json', '--max-turns', '1'], { env: { ANTHROPIC_API_KEY: '' } });
  const parsed = JSON.parse(text);
  if (parsed.is_error || typeof parsed.result !== 'string' || !parsed.result.trim()) throw Error('Claude did not return a valid result');
  return parsed.result.trim().slice(0, 12000);
}

async function codex(prompt, scratch) {
  const answer = join(scratch, 'codex-answer.txt');
  await rm(answer, { force: true });
  await run('codex', ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--output-last-message', answer, prompt], {
    cwd: scratch, env: { CODEX_HOME: process.env.CODEX_HOME, OPENAI_API_KEY: '' }
  });
  const text = (await readFile(answer, 'utf8')).trim();
  if (!text) throw Error('Codex result empty');
  return text.slice(0, 16000);
}

async function agy(prompt) {
  const answer = await run('agy', ['-p', prompt], { env: { GEMINI_API_KEY: '', GOOGLE_API_KEY: '' } });
  if (!answer.trim()) throw Error('Antigravity result empty');
  return answer.trim().slice(0, 8000);
}

const scratch = await mkdtemp(join(tmpdir(), 'orchestrator-'));
try {
  console.log('STAGE: Claude planning');
  const plan = await claude('You are a software planner. For this public, non-sensitive test request, provide a compact implementation plan (max 200 words). Do not use tools or modify files. Request: ' + request);
  console.log('STAGE: Claude planning OK');
  let feedback = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log('STAGE: Codex proposal attempt ' + attempt);
    const proposal = await codex(
      'Produce a JavaScript solution as plain text (do not modify any files) for the request below. Include executable code and three tests. Plan: ' + plan + '\nRequest: ' + request + (feedback ? '\nReviewer feedback: ' + feedback : ''), scratch);
    console.log('STAGE: Codex proposal ready');
    console.log('STAGE: Antigravity independent review attempt ' + attempt);
    const review = await agy('Independently review the proposed JS solution. Check correctness, edge cases, and whether tests actually validate it. Reply on the FIRST LINE with exactly PASS if acceptable or FAIL if problems remain; then max 120 words of rationale. Do not modify files. Request:\n' + request + '\nProposal:\n' + proposal);
    const verdict = review.split(/\r?\n/, 1)[0].trim().toUpperCase().replace(/[^A-Z]/g, '');
    if (verdict === 'PASS') {
      console.log('RESULT: VERIFIED_BY_ANTIGRAVITY');
      console.log('RESULT: all three subscription-backed CLIs completed a real multi-model task');
      process.exitCode = 0;
      break;
    }
    if (verdict !== 'FAIL') throw Error('Reviewer did not produce an explicit PASS/FAIL verdict');
    console.log('STAGE: reviewer requested changes');
    feedback = review.slice(0, 3000);
    if (attempt === maxAttempts) {
      console.log('RESULT: VERIFICATION_FAILED_AFTER_3_ATTEMPTS');
      process.exitCode = 1;
    }
  }
} catch (error) {
  // Never include raw provider output in public Actions logs.
  console.error('RESULT: ORCHESTRATION_FAILED: ' + String(error.message).replace(/[^a-zA-Z0-9 _.:-]/g, '').slice(0, 160));
  process.exitCode = 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
