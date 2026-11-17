# Independent local checks implementation plan

**Authority:** User's continuing Phase 1 instructions and explicit request to keep implementing and submit new Draft PRs. No extra approval, hardware, provider authentication or private Actions quota is assumed. Native implementation in the existing isolated worktree; base local 4f33085, remote PR13 7ae14f4.

**Goal:** Recheck a local encrypted result independently of worker-authored audit claims, without credentials or publication authority.

**Design / chosen approach:** A host-only API decrypts an awaiting local job and validates its exact artifact/context. A trusted caller supplies a bounded regular-file baseline snapshot and expected commit (the private GitHub baseline-fetch adapter is deferred, so the commit binding is explicitly caller supplied). The host verifies candidate base/hash/path constraints and refuses existing-test replacement. For both baseline and candidate, run full typecheck, unit tests and build in six separate disposable network-none Docker containers. Each gets only read-only serialized source and a fixed trusted entrypoint; writable workspace/cache are tmpfs, fresh per stage. Use npm ci --offline, without disabling lifecycle scripts. Missing offline dependencies fail closed. Observe exit status, limits and resource cleanup from the host, never a game-authored audit file.

**Alternatives:** Trusting the worker's audit leaves verification forgeable. Running npm on the host exposes its keys. Running one mutable validator workspace permits an earlier check to change later commands/files. Separate disposable checks cost more local CPU, but give an independently observed result. Production reviewer/runtime and Draft publication stay blocked; even all code checks passing is checks-passed-awaiting-review, publishAuthorized=false.

**Files / interfaces:** scripts/independent-check-input.mjs: captureCheckSnapshot({context,bundle,baseline}) -> bounded captured payload and digests. scripts/docker-command.mjs: extract unchanged bounded Docker subprocess helper from protected-worker.mjs for both supervisors. scripts/isolated-check.mjs: runIsolatedCheck({imageId,payload,variant,stage,timeoutMs,outputLimit,signal}) -> host-observed status/exit/failure/removed. scripts/local-independent-checks.mjs: runLocalIndependentChecks({id,stateRoot,privateKey,baseline,imageId,...limits}) and readIndependentCheckStatus({id,stateRoot}); one-shot host claim, strict private metadata report, no raw diagnostics. scripts/independent-check-cli.mjs: status only, no live execution command. Tests and public fixture CI integration beside these files.

## Global constraints

- Zero new paid resources/API calls, no actual AI authentication/inference/game task, no private data/public log exposure.
- Never run project code on the host or provide provider/GitHub credentials/private key to containers.
- Preserve existing full typecheck/test/build commands; no test rewrites, baseline failures or missing dependencies counted as success.
- Pinned local image ID only, pull never, network none, nonroot, readonly root/input, no capabilities, 1GiB memory, 128 PID, 2 CPU, bounded output/time, cleanup on every path.
- Baseline max 10,000 files / 32MiB total / 1MiB per file; reject unsafe paths, collisions, credential/cache/Git metadata and noncanonical base64. Snapshot adapter must exclude links and identify the real main commit before live publication can exist.

## Review focus

- A forged passed audit or changed task/artifact must not imply an independent pass.
- A source file that rewrites scripts/previous validation output cannot influence another fresh stage.
- Timeouts, output exhaustion, cancellation and ambiguous Docker cleanup must block completion and automatic retries.
- Mutable baseline/candidate objects must be captured before async execution; reports must bind both snapshots.
- Even six passing commands cannot authorize publication without real independent review and verified main binding.

## Tasks

- [x] 1. RED strict snapshot tests (hash/path/base/test overwrite/limits/caller mutation), then implement bounded capture and unchanged Docker-helper extraction. Verify existing suite.
- [x] 2. RED isolated supervisor/host gate tests, then implement credential-free Docker checks, one-use private claim/report and status-only CLI. Test malformed/tampered/cancelled/duplicate states.
- [x] 3. Real Docker synthetic tests: receipt→encrypted job→six genuine npm checks; failing candidate despite forged passed audit; baseline failure, script mutation isolation and no auth/host access; timeout/output exhaustion cleanup. Existing containment5 stays required.
- [ ] 4. Full general/Docker/syntax/YAML/diff checks, fresh read-only independent review, docs, local commit + GitHub push on new branch + stacked Draft PR targeting feature/local-worker-bridge-v1. No merge.

## Execution ledger

- Baseline 88/88 passed; worktree clean at start. Existing linked worktree reused, no prior branch modified.
- Ruling: the host snapshot producer is trusted and main provenance is not independently fetched in this unit; label it caller-supplied and prohibit publication. This avoids inventing authorization while live runtime/host choice remains unresolved.
- Final review: four Important findings (async baseline capture, colocated-test overwrite, known credential/cache paths, cancellation during final integrity read) reproduced RED and fixed in one pass. Snapshot mutation uses actual Docker; cancellation fault simulator replaces Docker only and retains real filesystem reads. Full final suite and actual Docker regression evidence below when complete.
- Final: minor (deferred): strict coherence of manually forged failed metadata (check_failed/exitCode0 or infrastructure failures labelled checks-failed). Generated reports are coherent, publishAuthorized stays false, and no publisher consumes this report.
- Final: Ruling: actual AI/runtime/main provenance, semantic test evasion, distributed claims and power-loss recovery are outside this unit — retain explicit blocked publication and next-work list — treating this as complete operational authorization would be unsafe.
- Final verification: GITHUB_ACTIONS=true node --test scripts/*.test.mjs = 97/97 passed, zero skips; three Docker files sequentially = 8/8 passed, zero skips. All JS/Bash/YAML/diff checks passed. No live API/provider/game/phone or paid resources used. Docs and Draft publication remain task4.
