// Narrow-scope real code contribution: add exactly one utility and its tests.
// Public Actions logs never print private source files, model output, or credentials.
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
const root = join(process.cwd(), 'private-game');
const runId = process.env.GITHUB_RUN_ID;
const repo = 'skj04327/the-twilight-of-korea';
const token = process.env.PRIVATE_GAME_WRITE_TOKEN;
if (!/^\d+$/.test(runId || '') || !token) throw Error('Missing safe execution context');
const filename = 'orchestrator-smoke-' + runId;
const implementationPath = 'src/utils/' + filename + '.ts';
const testPath = 'tests/' + filename + '.test.ts';
const scratch = await mkdtemp(join(tmpdir(), 'orchestrator-code-'));
const log = s => console.log('STATUS: ' + s);
async function cmd(bin, args, { cwd = root, maxMs = 300000, env = {} } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: {...process.env, ...env}, stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '', killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, maxMs);
    for (const [pipe, kind] of [[child.stdout, 'out'], [child.stderr, 'err']]) {
      pipe.on('data', data => {
        const part = data.toString();
        if (stdout.length + stderr.length + part.length > 750000) {
          killed = true; child.kill('SIGKILL'); return;
        }
        if (kind === 'out') stdout += part; else stderr += part;
      });
    }
    child.on('error', e => {clearTimeout(timer); reject(Error(bin + ' could not start: ' + e.code));});
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || killed) {
        const e = Error(bin + ' failed (' + (killed ? 'timeout/output limit' : 'exit ' + code) + ')');
        e.details = (stdout + '\n' + stderr).slice(-30000);
        reject(e);
      } else resolve(stdout);
    });
  });
}
async function api(method, route, payload) {
  const resp = await fetch('https://api.github.com/repos/' + repo + route, {
    method, headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  if (!resp.ok) throw Error('GitHub API HTTP ' + resp.status + ' at ' + method + ' ' + route.split('?')[0]);
  return resp.json();
}
async function ensureClean(paths = []) {
  const out = await cmd('git', ['status','--porcelain','--untracked-files=all']);
  const lines = out.trim() ? out.trim().split('\n') : [];
  for (const line of lines) {
    const path = line.slice(3).trim();
    if (!paths.includes(path)) throw Error('Unexpected working-tree modification; refusing to continue');
  }
}
const jsonFromModel = text => {
  const value = text.trim().replace(/^\`\`\`(?:json)?\s*/i,'').replace(/\s*\`\`\`$/,'');
  const obj = JSON.parse(value);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || typeof obj.implementation !== 'string' || typeof obj.test !== 'string') throw Error('Malformed AI JSON');
  if (obj.implementation.length < 60 || obj.implementation.length > 5000 || obj.test.length < 100 || obj.test.length > 6000) throw Error('Generated file size out of bounds');
  if (!obj.test.includes('vitest') || !obj.test.includes(filename)) throw Error('Test lacks expected target');
  for (const value of [obj.implementation, obj.test]) {
    if (/\b(?:child_process|fs\/promises|process\.env|eval\s*\(|fetch\s*\(|import\s*\()/i.test(value)) throw Error('Generated code contains prohibited operation');
  }
  return obj;
};
async function makeCandidate(previous, feedback) {
  const spec = [
    'Write two TypeScript code files as STRICT JSON only, no backticks and no prose.',
    'JSON keys exactly "implementation" and "test" with string values, encoded with JSON.stringify.',
    'Implementation file path ' + implementationPath,
    'Test file path ' + testPath + ' (Vitest). Import relative module ../src/utils/' + filename + '.',
    'Implement a pure function called normalizeHistoricalText(text: string): string.',
    'It must normalize CRLF line endings to LF, normalize repeated ASCII spaces to single spaces within each line, and trim leading/trailing spaces of each line, preserving line breaks.',
    'Write at least 4 meaningful test assertions, including Korean text, line breaks, and empty input.',
    'No network, filesystem access, process environment access, execution, dynamic imports, dependencies beyond vitest, or changes to other files.',
    'Do not use existing private project content; this isolated utility is only a test contribution.',
    previous ? 'Prior implementation JSON: ' + JSON.stringify(previous).slice(0,9000) : '',
    feedback ? 'Reviewer/compiler feedback (may be incomplete): ' + feedback.slice(0,2200) : ''
  ].filter(Boolean).join('\n');
  const out = await cmd('claude', ['-p',spec,'--output-format','json','--max-turns','1'], {maxMs:120000});
  const result = JSON.parse(out);
  if (result.is_error || typeof result.result !== 'string') throw Error('Claude generated invalid response');
  return jsonFromModel(result.result);
}
const decision = value => {
  const head = value.trim().split(/\r?\n/)[0].replace(/[^a-z]/gi,'').toUpperCase();
  if (head !== 'PASS' && head !== 'FAIL') throw Error('Review verdict not PASS/FAIL');
  return head;
};
async function independentReview(impl, test) {
  const question = [
    'Review this pure TypeScript utility and Vitest tests. Check exactly the requested behavior and tests.',
    'Reply FIRST LINE exactly PASS or FAIL. Follow with a brief concrete reason.',
    'Do not modify files or use any tools. Implementation:', impl, 'Test:', test
  ].join('\n');
  const codexOutput = join(scratch, 'codex-review.txt');
  await rm(codexOutput, {force: true});
  await cmd('codex',['exec','--skip-git-repo-check','--sandbox','read-only','--output-last-message',codexOutput,question],{cwd:scratch,maxMs:180000});
  const codex = (await readFile(codexOutput,'utf8')).trim();
  const gemini = (await cmd('agy',['-p',question],{cwd:scratch,maxMs:180000})).trim();
  const a = decision(codex), b = decision(gemini);
  log('Codex review ' + a + ', Gemini review ' + b);
  return {ok: a === 'PASS' && b === 'PASS', feedback: (a === 'FAIL' ? 'Codex: ' + codex : '') + '\n' + (b === 'FAIL' ? 'Gemini: ' + gemini : '')};
}
let source = null, lastFeedback = '';
try {
  await ensureClean();
  // Only these two new files may be written in the runner checkout.
  for (const path of [implementationPath, testPath]) {
    try { await readFile(join(root,path)); throw Error('Test path already exists'); }
    catch (e) {if (e.code !== 'ENOENT') throw e;}
  }
  log('Install project dependencies');
  await cmd('npm',['ci','--no-audit','--no-fund'],{maxMs:360000});
  for (let attempt=1;attempt<=3;attempt++) {
    log('Generate real TypeScript files, attempt ' + attempt);
    source = await makeCandidate(source,lastFeedback);
    await mkdir(dirname(join(root,implementationPath)),{recursive:true});
    await writeFile(join(root,implementationPath),source.implementation+'\n');
    await writeFile(join(root,testPath),source.test+'\n');
    await ensureClean([implementationPath,testPath]);
    let localOk = false;
    try {
      log('Run TypeScript typecheck and new Vitest spec');
      await cmd('npm',['run','typecheck'],{maxMs:240000});
      await cmd('npx',['vitest','run',testPath],{maxMs:240000});
      localOk = true;
    } catch (error) {
      log('Local checks failed on attempt ' + attempt);
      // Model gets a narrow local diagnostic privately; never emit to public logs.
      lastFeedback = (error.details || '').slice(-2200);
    }
    if (!localOk) continue;
    const verdict = await independentReview(source.implementation,source.test);
    if (!verdict.ok) { lastFeedback = verdict.feedback; continue; }
    log('Run full build gate');
    try { await cmd('npm',['run','build'],{maxMs:360000}); }
    catch (e) {lastFeedback=(e.details||'Build failed').slice(-2200);continue;}
    await ensureClean([implementationPath,testPath]);
    log('Code, targeted tests, typecheck, build and independent reviews passed');
    const main = await api('GET','/git/ref/heads/main');
    const branch = 'orchestrator/code-smoke-' + runId;
    await api('POST','/git/refs',{ref:'refs/heads/'+branch,sha:main.object.sha});
    for (const [path,text] of [[implementationPath,source.implementation],[testPath,source.test]]) {
      await api('PUT','/contents/'+path,{
        message:'test: add AI-authored TypeScript utility and Vitest coverage',
        branch, content:Buffer.from(text+'\n').toString('base64')
      });
    }
    const pr=await api('POST','/pulls',{
      title:'test: AI-coded TypeScript utility '+runId,head:branch,base:'main',draft:true,
      body:'Isolated test-only code contribution: Claude writes a new utility and its Vitest tests; Codex + Gemini review. On-runner typecheck, targeted test and build passed. No existing game files modified. Human review required; do not merge automatically.'
    });
    log('DRAFT_PR_CREATED '+pr.html_url);
    process.exitCode=0;
    break;
  }
  if (process.exitCode !== 0) throw Error('AI code failed all three rounds');
} catch(error) {
  console.error('RESULT: FAILED '+String(error.message).replace(/[^a-zA-Z0-9 _.:()/-]/g,'').slice(0,170));
  process.exitCode=1;
} finally {
  await rm(scratch,{recursive:true,force:true});
}
