# Large disk validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native implementation.

**Goal:** Full eligible disk baseline plus bounded candidate overlay reaches six independent stages and private non-publishable reports.

**Architecture:** Opaque frozen overlay captured from validated bundle, unchanged verified baseline archive plus separately copied bounded candidate tar, shared isolated runner and private completion engine. Strict schema2 disk-v1 coexists with original schema1 on the same claim/report paths.

**Tech Stack:** Node builtins, existing Docker/private queue/crypto modules and synthetic Git fixtures. No dependencies or model/network use.

**Spec:** docs/superpowers/specs/2026-11-18-large-disk-validation-design.md

## Global Constraints

No paid services, private-source execution/public logs, data-only promotion, old failed-task/run replay, test weakening, game writes, merge/deploy. Old memory bridge32MiB/file1MiB; candidate8files/65000bytes each. Disk combined1GiB/10000files. Fixed network-none resource profile inherited; publication false and review not-run.

## Review Focus

- Data-only/forged/mismatched source or ciphertext cannot create claim/containers.
- Overlay cannot replace existing tests, package/config, collide with dirs or exceed combined caps.
- Input captured before async reads, no mutable caller bytes across stages.
- Schema confusion, report tamper, concurrent profile claims and final abort/artifact changes fail closed.
- Full six commands/lifecycle/arguments/freshness observed, no partial passes or model-review claims.

### Task1: Opaque disk candidate and stage

Files: scripts/disk-check-input.mjs + tests; disk-baseline.mjs execution metadata getter; independent-check-input.mjs shared overlay path guard; disk-baseline-check.mjs fixed baseline/candidate runner.
- [x] RED tests for immutable snapshot/overlay limits/collisions/test refusal and real candidate bytes; implement and GREEN.
- [x] Preserve baseline-only API; export runDiskCheckStage({checkInput,variant,stage,imageId,...}) with no arbitrary runner, commands or mounts. Verify lifecycle and full test args.

### Task2: Six-stage private completion

Files: local-independent-checks.mjs shared completion engine/new runLargeDiskIndependentChecks; strict schema2 reader and tests; scripts/large-disk-validation.docker-test.mjs and fixtures.
- [x] RED schema2 profile/report/claim and gate tests. Implement same atomic independent claim/report paths with old schema1 compatibility.
- [x] New disk report binds pinned manifest and candidate SHA. Recheck local source artifact after six stages, preserve command-failure/infrastructure semantics; GREEN actual Docker success, baseline/candidate failures, single claim and final cancel.

### Task3: Review/delivery

Files: docs/large-disk-validation-v1.md, plan/spec, synthetic CI paths/command.
- [x] Full general/Docker/syntax/YAML/diff; fresh read-only review, RED→GREEN important fixes.
- [ ] Commit/push stacked Draft targeting feature/large-baseline-checker-v1; byte-match remote files, verify CI without reruns; private checkpoint and honest remaining runtime/policy blockers.

Ledger: remote Draft17 a4b6890, local ba92cca, clean tree; prior general127/Docker13 and publicCI passed. Ruling: integrate candidate/report before dependency-cache preparation so candidate safety can be tested independently; no actual private source execution or data-only bootstrap. Baseline manifest hash is a separate source fingerprint, never relabeled as the old content hash.

Progress: input RED2 missing-function assertions -> GREEN6 with existing small policy; actual stage RED missing API -> GREEN1 actual Docker. Report RED unsupported schema2/missing runner -> GREEN7. Full10000-file boundary test passed: replace allowed,10001st file denied. Six-stage actual success/double-claim test passed; baseline/candidate failure and final cancel/full suite/review still active.

Review fix pass: candidate canonical-path bypass reproduced (single-dot existing test alias, restricted directory, excessive length/depth); now reuse exact checks-purpose diskPath predicate before collisions/caps. Transfer corruption reproduced unreadable terminal observation; normalize unknown transport failure kinds to invalid_output before storing. Array-valued image/variant/stage metadata reproduced accepted; strict string capture/claim and individual observation field comparisons added. After those fixes, impossible schema2 recovery history still reproduced accepted; require first observed infrastructure failure last and matching terminal cause. Schema1 acceptance behavior remains unchanged. Final suites follow.

Lifecycle coverage correction: prior stage fixture derived expected event from the script actually invoked, so could miss typecheck/build swaps. Assert fixture stage against trusted PID1 entry argv as an independent expectation. Temporary swapped-mapping mutation test must fail and restores original code in finally; final actual Docker must then pass.

Review disposition: three Important issue families (canonical paths; unreadable transfer-failure reports; strict types/recovery history) reproduced and fixed in one pass. Targeted16/16 and final general136/136 passed. Lifecycle mapping gap now has independent PID1 expectation; temporary typecheck/build swap produced checks-failed, original mapping restored in finally. Reviewer did not rerun final suites/re-review fixes. Final Docker16 still running; delivery remains pending.

Final-code actual Docker progress: large source/candidate archive and six-stage success tests pass with restored mapping and independent PID1 lifecycle assertions. Remaining full-suite completion and delivery receipt are pending; do not infer full success from this intermediate entry.

Final local evidence: full general136/136 and actual Docker16/16 passed on fixed code, no failures/skips. Syntax/Bash/YAML/diff passed. All review Important findings and lifecycle gap are addressed by tests; no deferred minor from this review. Only final docs/comment changed after tests. Commit/push/Draft/remote byte+CI receipt remain the delivery gate; record receipt on PR to avoid docs-only CI rerun.
