# Private queue intake/receipt implementation plan

Authority: user's free/mobile/private orchestrator handoff and continuing instruction. Base PR #11 d2c197d. Existing stack/game remains untouched; no real LLM, paid resource, live task replay, merge or deployment.

Goal: make private task submission consumable outside public Actions without silently claiming an AI worker ran.

Design: Termux submits original inputs to existing private queue, then writes a bounded readiness manifest LAST, binding exact bytes with SHA-256 and recording routing. A read-only receiver checks repository privacy, pins one queue commit, reads only allowlisted manifest paths, verifies hashes and input formats, and atomically records a local private receipt. No workflow dispatch or provider request. Status is received only, never running/validated/published. Old tasks without readiness proof and the prohibited failed ID cannot execute via this path.

Alternatives: new private Actions jobs require quota/billing/auth checks and would consume unverified free minutes; new paid server is forbidden. Choose a runtime-independent private queue protocol first, reusable by Termux/local Linux/private trusted runner. User execution-place preference is asked asynchronously; no setup/access is assumed.

Steps: (1) failing manifest/receiver tests; implement strict schema, exact task/reference/media digest binding, pinned read-only API and exclusive local receipt; (2) test actual Termux script with fake gh then remove public dispatch, stage private payload snapshots, upload readiness last and retain routing; (3) add receiver CLI with bounded gh transport and fixed error output, replay/partial/conflict/path/symlink tests; (4) full suite and required CI, independent review, evidence/limitations docs and new Draft stacked on #11.

Review focus: mutable inputs during upload, partial submissions, public/non-private repository confusion, branch movement, digest mismatch, old failed task replay, duplicate/colliding local receipts, restrictive filesystem modes and symlinks, raw task/token leakage, zero provider or public Actions calls. This is local receipt, not a distributed claim/lease or runnable AI backend.

Execution record: intake/receipt protocol and CLI implemented; baseline69 → general77/77, existing Docker3/3, syntax/shell/YAML checks passed. Actual intake and receiver scripts tested through fake gh only; no real queue or AI calls. Independent review findings (ancestor replacement, kind-array coercion) reproduced RED and fixed GREEN. Root ancestry trust is enforced, and sandbox virtual .git markers are distinguished from Git HEAD/gitdir metadata. Execution-place preference asked asynchronously; no hardware/CI quota availability assumed and no worker started. Details: docs/private-queue-receipt-v1.md.
