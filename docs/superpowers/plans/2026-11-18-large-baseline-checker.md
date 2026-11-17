# Large baseline checker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Execute fixed baseline npm stages on a checks-purpose disk snapshot without whole-source memory serialization.

**Architecture:** One-shot verified tar stream feeds a private fresh Docker input volume. An isolated nonroot container copies regular files into bounded tmpfs and runs fixed offline npm commands. Old memory/checker/report gates stay unchanged.

**Tech Stack:** Node builtins, existing Docker/gh adapters, synthetic Git fixtures; no dependencies/services.

**Spec:** docs/superpowers/specs/2026-11-18-large-baseline-checker-design.md

## Global Constraints

- No paid resource, private public logs, actual private source execution, data-only promotion, test weakening, merges/deployments or old task rerun.
- Keep current memory bridge32MiB/file1MiB; publication false; baseline-stage observation is not full validation.
- Check resource profile3GiB memory/2GiB work tmpfs, PID128/CPU2; network-none, readonly inputs, no credentials or auto pull.

## Review Focus

- Data-only/forged handles must fail before resource creation (task1/2 tests).
- Mid-transfer mutation, truncation or aborted consumer must close readers and never run code (task1/2 tests).
- Unexpected Docker creation/cleanup/early input exit must not report pass (task2 tests).
- Unicode/executable assets and >32MiB input must reach the real isolated stage intact (task2 Docker tests).
- Missing offline dependency, timeout and excessive output must fail and remove resources (task2 Docker tests).

### Task 1: Verified streaming archive

Files: scripts/container-tar.mjs, scripts/disk-baseline.mjs, scripts/disk-baseline-archive.test.mjs.
Interfaces: createDiskBaselineArchive(snapshot,{signal}) returns frozen {inputStream,provenance}; rejects data-only/forged/Actions; generator one-shot. Header helper makeTarHeader(name,size) emits flat regular readonly file header.
- [x] Write tests asserting >32MiB streaming with bounded chunks, exact tar bytes/manifest/modes, purpose refusal, tamper and cancellation.
- [x] Run RED, implement incremental verifyBlob/yield with no collect, header helper and opaque capability access; run GREEN.

### Task 2: Isolated baseline stage

Files: scripts/docker-command.mjs, scripts/disk-baseline-check.mjs, scripts/disk-baseline-check.test.mjs, scripts/disk-baseline-check.docker-test.mjs; workflow paths/test command.
Interfaces: docker(args,{inputStream,...}) pumps async bytes with backpressure and awaits reader shutdown. runDiskBaselineStage({diskSnapshot,imageId,stage,timeoutMs,outputLimit,signal}) returns metadata observation with publishAuthorized:false; no candidate/report mutation.
- [x] Write streaming-client failure/cleanup tests and synthetic real Docker >32MiB Unicode/executable isolation test; run RED.
- [x] Implement resource-bounded seed/checker, trusted fixed entry, original npm commands, private source binding and cleanup; run GREEN.
- [x] Cover offline miss, timeout/output, data-only/Actions, all stages fresh and no credentials; verify final suite.

### Task 3: Review and delivery

Files: docs/large-baseline-checker-v1.md, this plan, spec and synthetic CI configuration.
- [x] Run full general and actual Docker checks, syntax/YAML/diff; obtain independent read-only review and fix findings.
- [ ] Document honest baseline-stage scope/runtime blockers, commit/push and new stacked Draft based on feature/disk-baseline-stream-v1. Match remote blobs and inspect CI once; preserve private checkpoints.


Ledger: Task1 RED3 missing-function assertions -> GREEN3. Task2 stream RED bytes0 instead40MiB -> GREEN; Docker RED3 missing-stage API assertions -> GREEN3 actual Docker scenarios including three fresh stages and three failure modes. Source archive rejection and generator shutdown tests pass. General suite/review/delivery still pending.

Ruling: this is a baseline-stage host API, not six-stage candidate/report integration — keep publication closed and follow-on integration separate. A false interpretation would overstate game readiness; docs/reports explicitly identify baseline-only observation.

Own regression: synchronous iterator setup failure spawned a child before handlers were installed. Test reproduced unexpected child creation, then moved iterator capture before spawn and normalized failure. Full final suite follows this fix.

Final review Important: a stopped Docker object with default ExitCode0 could be never started. Host stage regression reproduced passed instead of failed; shared strict exited-state parser now requires explicit sane flags, empty Error/Pid0 and nonzero ordered start/finish timestamps. Apply it to existing small isolated checker too, which had the same predicate; update shims to actual complete state without weakening assertions. Existing full Docker success13/13 preceded this fix; final suite must rerun.

Review coverage: deterministic tests now mutate/truncate unread bytes after first64KiB of a2MiB open blob, or abort/return there, and check /proc/self/fd reader closure. Ruling: Docker daemon/zero-exit cp extraction acknowledgement remains trusted, as with the existing worker; a malicious daemon is outside the host trust boundary. Small writes buffered by the kernel alone cannot prove receiver consumption, so documentation promises producer integrity plus Docker acknowledgement, not Byzantine transport verification.

OOM report regression: explicit resource_limit observation was rejected by the legacy report reader. Reproduced RED with a structurally complete non-publishable needs-recovery report, then added the fixed infrastructure kind; success/phase checks remain unchanged.

Independent final disposition: no additional Critical/Important findings. Important never-started false-success fixed with API RED→GREEN; reviewer did not independently rerun the suites or re-review the follow-up fixes. Final general127/127 passed. Minor deferred: synthetic package uses the same script for all three lifecycle stages; a swapped command mapping could escape that fixture. Add distinct lifecycle-event/argument assertions with next candidate/report integration; original fixed mappings are unchanged and explicit.

Final tested tree: general127/127, actual Docker13/13, no failures/skips. JS/Bash/YAML/diff passed. No actual private source/AI/subscription runtime was executed. Commit/push/Draft/remote blob+CI receipt remain the delivery gate; record it on the PR to avoid a docs-only CI rerun.
