// Real, isolated private-repository document contribution.
// All model output, game files and credentials are withheld from PUBLIC Actions logs.
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const game = join(process.cwd(), 'private-game');
const runId = process.env.GITHUB_RUN_ID;
const token = process.env.PRIVATE_GAME_WRITE_TOKEN;
const repo = 'skj04327/the-twilight-of-korea';
if (!/^\d+$/.test(runId || '') || !token) throw Error('Run ID or write credential missing');
const scratch = await mkdtemp(join(tmpdir(), 'ai-doc-smoke-'));
function safeLog(message) { console.log('STATUS: ' + message); }
async function cli(bin, args, cwd = game, limit = 180000) {
  return await new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', overflow = false;
    const timer = setTimeout(() => proc.kill('SIGKILL'), limit);
    for (const [pipe, kind] of [[proc.stdout, 'out'], [proc.stderr, 'err']]) {
      pipe.on('data', data => {
        const s = data.toString();
        if (stdout.length + stderr.length + s.length > 600000) {
          overflow = true; proc.kill('SIGKILL'); return;
        }
        if (kind === 'out') stdout += s; else stderr += s;
      });
    }
    proc.on('error', err => { clearTimeout(timer); reject(new Error(bin + ' could not start (' + err.code + ')')); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || overflow) return reject(new Error(bin + ' failed (exit ' + code + ', private details suppressed)'));
      resolve(stdout);
    });
  });
}
async function ghApi(method, path, data) {
  const response = await fetch('https://api.github.com/repos/' + repo + path, {
    method, headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: data ? JSON.stringify(data) : undefined
  });
  if (!response.ok) throw Error('GitHub API ' + method + ' returned HTTP ' + response.status);
  return await response.json();
}
async function checkTree() {
  const diff = await cli('git', ['status', '--porcelain', '--untracked-files=all']);
  if (diff.trim()) throw Error('Private checkout changed unexpectedly; refusing PR');
}
const docsPath = 'docs/orchestrator/ai-generated-smoke-' + runId + '.md';
try {
  await checkTree();
  safeLog('Claude drafting a project-specific document');
  const task = [
    'Create a short Korean markdown document (350-900 Korean/English characters minimum, 3000 max) for the Goryeo game repository.',
    'Read README.md and any applicable docs/control-tower instructions, using read-only tools.',
    'Explain a concrete, small, safe improvement proposal to the current project based on the actual files.',
    'Do not claim tests or implementations have happened. No private tokens, passwords, or user details.',
    'Output ONLY the markdown document, beginning with # . Never modify files.'
  ].join(' ');
  const planRaw = await cli('claude', ['-p', task, '--output-format', 'json', '--max-turns', '5', '--allowedTools', 'Read,Glob,Grep']);
  const planObj = JSON.parse(planRaw);
  if (planObj.is_error || typeof planObj.result !== 'string') throw Error('Claude result invalid');
  let document = planObj.result.trim();
  if (!document.startsWith('# ') || document.length < 350 || document.length > 3000) throw Error('Claude document failed safe shape checks');
  await checkTree();
  let verified = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    safeLog('Review round ' + attempt + ': Codex and Antigravity');
    const reviewPrompt = 'Review this proposed README-derived project document. Check accuracy, specific useful advice, and no unsupported completed-work claims. Output exactly PASS or FAIL on the first line, followed by short reasoning. Do not modify files. Document:\n' + document;
    const reviewPath = join(scratch, 'codex-review.txt');
    await rm(reviewPath, { force: true });
    await cli('codex', ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--output-last-message', reviewPath, reviewPrompt], scratch);
    const codexReview = (await readFile(reviewPath, 'utf8')).trim();
    const geminiReview = (await cli('agy', ['-p', reviewPrompt])).trim();
    const verdict = x => x.split(/\r?\n/)[0].trim().toUpperCase().replace(/[^A-Z]/g,'');
    if (verdict(codexReview) === 'PASS' && verdict(geminiReview) === 'PASS') {
      verified = true;
      break;
    }
    if (![verdict(codexReview), verdict(geminiReview)].every(v => ['PASS','FAIL'].includes(v))) throw Error('Reviewer returned ambiguous verdict');
    if (attempt === 3) break;
    safeLog('Review requested improvement');
    const corrected = await cli('claude', ['-p', 'Revise the markdown below in response to two reviewers; output only complete corrected markdown beginning with # . Do not modify files.\nDOC:\n' + document + '\nREVIEW1:\n' + codexReview.slice(0,1800) + '\nREVIEW2:\n' + geminiReview.slice(0,1800), '--output-format','json','--max-turns','1']);
    const correctedObj = JSON.parse(corrected);
    if (correctedObj.is_error || typeof correctedObj.result !== 'string') throw Error('Revision failed');
    document = correctedObj.result.trim();
    if (!document.startsWith('# ') || document.length < 350 || document.length > 3000) throw Error('Revised document failed shape checks');
    await checkTree();
  }
  if (!verified) throw Error('Reviewer vetoed all three attempts');
  await checkTree();
  safeLog('Both independent AI reviewers passed');
  const main = await ghApi('GET', '/git/ref/heads/main');
  const branch = 'orchestrator/ai-doc-' + runId;
  await ghApi('POST', '/git/refs', {ref:'refs/heads/' + branch, sha:main.object.sha});
  await ghApi('PUT', '/contents/' + docsPath, {
    message:'docs: AI-authored planning smoke test, reviewed by Codex and Antigravity',
    branch,
    content:Buffer.from(document + '\n').toString('base64')
  });
  const pr = await ghApi('POST', '/pulls', {
    title:'test: AI-drafted private documentation #' + runId,
    head:branch, base:'main', draft:true,
    body:'TEST ONLY: Claude drafted a new documentation file, Codex and Antigravity reviewed it. No game code changes. Do not merge without manual review.'
  });
  safeLog('Draft PR created: ' + pr.html_url);
} catch (e) {
  console.error('RESULT: FAILED: ' + String(e.message).replace(/[^a-zA-Z0-9 _.:()/-]/g,'').slice(0,180));
  process.exitCode = 1;
} finally {
  await rm(scratch, {recursive:true, force:true});
}
