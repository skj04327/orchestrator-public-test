# Pinned private baseline implementation plan

Authority: user explicitly says continue without stopping; Phase 1 provenance and baseline roadmap. Native implementation, existing isolated worktree, local base 018007e / remote Draft14 a26d15a. No paid resources, private Actions, provider authentication, old-task rerun, merge or game write.

Goal: replace caller-claimed baseline provenance with a bounded, authenticated read-only main snapshot, when the full tree fits the existing limits. Preserve the caller-supplied route and permanently false publish authority.

Design: fixed private repo GET only → pin main commit → commit root tree → complete recursive tree. Reconstruct Git tree SHA1s and validate all parent/child/type/mode/size entries before any blobs. Refuse links/submodules, partial trees and unsafe paths. If full tree exceeds 10k files/32MiB/1MiB each, return metadata-only blocked-capacity without downloading any blobs. Never omit large assets and call the result full. Fetch eligible blobs by SHA, verify canonical base64/size/Git blob SHA1; recheck privacy/main after all reads. Freeze baseline objects and associate host-only provenance with a WeakMap, so arbitrary copied JSON cannot label itself pinned. Bind tree/commit/repo/content digest into optional private independent-check claim/report, retaining legacy caller-supplied schema compatibility. No publication approval.

Files: scripts/pinned-private-baseline.mjs (collector/proof validation), pinned-baseline-cli.mjs (fixed gh GET + metadata-only inspect CLI), independent-check-input.mjs (shared path/hash validation), local-independent-checks.mjs (live read-only wrapper + pinned provenance). Tests: Git-object synthetic fixture, malicious trees/blobs/moving main/capacity/abort, actual CLI with fake gh, pinned provenance integration in existing actual Docker suite. CI paths only; same synthetic public job.

Tasks:
- [x] RED collector tree/blob/provenance/capacity tests, then bounded implementation. Deadline/call/response limits, no retries or arbitrary endpoints.
- [x] RED CLI and independent-report compatibility/provenance tests, then connect guarded read-only host path. Freeze inputs before awaits. Caller-provided fake get is trusted test/host adapter, never a model-provided endpoint.
- [x] Actual private read-only metadata smoke. Actual game tree is larger than existing caps: confirm blocked before blobs; do not run partial game tests. Keep private metadata/source outside Git/public reports.
- [ ] Full general and existing8 actual Docker regressions; independent read-only review; docs/evidence; new commit/push/Draft targeting feature/independent-local-checks-v1.

Review focus: omitted or forged tree nodes, Git basename sorting and modes; capacity rejection before any blob; credential paths before network content read; main moving/repo becoming public; forged proof flag/JSON copy; old report compatibility; timeout/abort between reads and proof creation; private output and arbitrary CLI GET denial.

Ledger: baseline97/97 passed. Actual private repo metadata/ref/commit/tree read through connected GitHub. Entire tree exceeds current bounded validator capacities; private detailed metadata remains outside public repository. Ruling: preserve bounds and explicit blocked status rather than silently selecting a partial asset set. Large-asset streaming/offline runtime is a separate next unit; claiming actual baseline tests passed would be false.

Read-only whole-branch review: no Critical/Important issues; two Minor test gaps (executable mode and gh overflow/abort) covered. Deferred PR14 report coherence issue reproduced RED and fixed, preserving valid old schemas. Additional deadline-starvation regression reproduced RED and fixed with elapsed-time checks. All public fixtures use synthetic Git/API data; no real private response/source/commit/path is committed. Publication step4 is recorded in the final Draft PR metadata after push.

Verification: final full general105/105 and actual Docker9/9 passed, zero skips. JS/Bash/YAML/diff checks passed. Actual private inspect blocked-capacity before blobs/checks, raw metadata retained privately outside Git. No paid service, subscription model, private game write, old task rerun or merge.
