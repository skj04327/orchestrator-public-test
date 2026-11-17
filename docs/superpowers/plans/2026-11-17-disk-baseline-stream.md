# Disk-backed verified baseline implementation plan

Authority: user's instruction to keep implementing remaining work, zero new costs, Phase 1. Existing isolated worktree, local base6c3a623 / remote Draft15 dde6f4e. Native implementation and one read-only code review. No game writes, paid API/server, model authentication/calls, old task rerun or merge.

Goal: receive full eligible large Git snapshots into private disk files with bounded controller buffering and verified content, reopen/check integrity, and connect small compatible disk snapshots to the existing six-stage validator. Large validation workspace/offline dependencies remain a separate unit; never pretend receipt means game checks passed.

Architecture: share existing private-main inventory/tree verification without weakening the 32MiB memory collector. Fixed gh raw blob GET streams into exclusive 0600 files in a Git-external 0700 store, checking exact size/Git SHA1/SHA256 incrementally with backpressure. Disk-only profile: <=1GiB logical source, <=128MiB per blob, <=10k files, <=4k requests, 3 concurrent downloads, 30min overall/3min per blob, free-space preflight and fixed private paths. Whole tree is retained; no asset subset selection. Index commits last through exclusive hardlink. Wait for all writers after abort before removing owned staging; incomplete attempts never become valid caches.

Layout/interfaces:
- main-inventory.mjs: unchanged tree hashing/typed inventory and private/main checks shared by both collectors.
- gh-private-environment.mjs: existing gh credential environment allowlist; gh-blob-stream.mjs: fixed private raw GET to destination, bounded chunks, exclusive file/timeout/abort/integrity/cleanup.
- disk-baseline.mjs: collectDiskBaseline({root,get,streamBlob,...}), openDiskBaseline({root,baseSha}), materializeDiskBaseline(snapshot), getMaterializedDiskProof(baseline). Opaque frozen capabilities, private index with tree and per-blob digests, strict reopen rehash; small bridge retains existing memory limits/provenance.
- disk-baseline-cli.mjs: local capture/status only, metadata output; no run/publish/model switch. Existing main CLI/getter compatibility retained.
- local-independent-checks.mjs: runDiskIndependentChecks wrapper uses existing small validator; blocked-checker-capacity on large snapshots, no execution claim or publication permission.

Disk path policy accepts safe Unicode letters/numbers for source assets, keeps credential/cache exclusions, forbids traversal/control/shell-metacharacter paths. Raw download API addresses blobs by SHA, not source filenames. No project code runs on host. Disk source observation is historical main provenance, not a signature/publication approval. Existing source/client credentials never enter validator.

Tasks:
- [x] RED raw stream tests: >32MiB chunked transfer, exact hash/size, overflow/short/corrupt bytes, stderr bound, timeout/abort and exclusive unsafe destination. Implement streaming primitive and share unchanged inventory/env helpers.
- [x] RED disk cache tests: Git-generated fixture, dedup/modes/Unicode, caps before blobs, all writers stopped before failure cleanup, main movement, forged index/missing/tampered/symlink blob. Implement collector/index/reopen.
- [x] Small materialization/provenance compatibility and existing actual Docker integration; large bridge blocks honestly. CLI fixture tests. Actual private read-only capture only after tests/security review and capacity/policy/resource checks; no private source in Git/public CI.
- [x] Full unit/Docker/syntax/YAML/diff checks, fresh read-only review and docs.
- [ ] Commit/push and new stacked Draft targeting feature/pinned-private-baseline-v1; confirm remote blobs and public CI without reruns.

Review focus: no unbounded Buffer.concat of blob data; child/file lifecycle and cancellation; exclusive path ownership and index-last; cache tamper/reopen and no fabricated proof; duplicate SHA-size consistency; no partial tree/cap bypass; rate/disk/memory bounds; old flow unchanged; large capture != executable/game-passed.

Ledger: baseline105/105 passed. Ruling: separate bounded disk transport from the existing memory validator; old checker limits stay unchanged. Full large-game execution may still be blocked until a resource-bounded workspace and offline dependency runtime exist.

Ruling: actual metadata preflight found one sensitive-path policy match. Default checks capture stays blocked. Add explicit host data-only storage purpose for complete private source without granting execution; no automatic fallback, materialization always denied, purpose stored/validated in index and capability. User already authorizes private-project reads/local reversible development; no new provider data transfer/authentication. Public tests/docs contain no real sensitive path or bytes. Full live capture only after review, into a separate Git-external private root.


Final local evidence: general119/119, real synthetic Docker10/10, targeted disk/raw/CLI14/14, no failures/skips; JS/Bash/YAML/diff checks passed. Full private data-only capture completed; reopen rehashed the complete private cache and materialization returned blocked-input-policy/publishAuthorized=false. No actual game checks/model execution. Keep real source identities/counts/paths and cache pointer/result private; public docs use abstract smoke outcomes only.

Review disposition: no Critical/Important finding. Added requested workflow paths plus active peer-abort cleanup, cached-tree/final-main-change, hardlink/mode and purpose-binding cases. Missing-cache repair, purpose manifest binding and fsync cancellation regressions reproduced RED then fixed. Direct quota/free-space boundary coverage can be expanded in a later resource-profile unit; caps themselves remain fail-closed.

Next independent unit: design execution input policy and a bounded large-asset checker workspace/offline dependency runtime. Never upgrade a data-only handle. Keep existing memory bridge bounds and publication gate. Actual private baseline tests and approved model execution remain blocked, not completed.
