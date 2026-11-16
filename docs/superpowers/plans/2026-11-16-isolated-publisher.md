# Isolated private publisher implementation plan

Goal: remove the private write credential from every runner that executes generated code.

Authority: the user's Phase 0/1 handoff and explicit implementation/push/Draft PR instruction. Continue on a new branch based on PR #8; no merge, live subscription call or old-task replay.

Design: trusted key preparation → untrusted execution/sealed bundle → fresh trusted publisher. Derive a run-specific X25519 recipient key from the existing write secret in trusted jobs only. Encrypt a bounded JSON snapshot with ephemeral X25519, HKDF-SHA256 and AES-256-GCM. Only ciphertext crosses public artifact storage. The publisher checks context, schema, base SHA, manifest and captured bytes without checking out or executing the private game. Encryption is confidentiality/integrity of transport, not attestation of a compromised worker's validation claims.

Alternatives: plaintext public artifacts violate confidentiality; giving workers a private-queue write credential defeats isolation; disabling all publication gives no usable handoff. Use encrypted transfer with default-disabled live dispatch pending policy/free storage confirmation. Standard public no-secret CI may run once on the Draft PR; never dispatch live workflows.

1. Write failing transport tests (round trip, wrong key/context, corruption, oversized data). Implement strict bounded encrypted transport and exact manifest validation; no new dependencies.
2. Write failing process contract tests with synthetic source: seal in worker, decrypt/publish in a different directory with no game checkout or CLI, reject tampering before API, failed execution cannot publish. Implement bundle producer and refactor publisher to accept only the bundle. Retain full existing test/build/review requirements and report persistence.
3. Separate workflow jobs, pin trusted checkouts to github.sha, transfer only one encrypted file with one-day retention, and require explicit live-policy/free-storage configuration. Add no-secret CI coverage and workflow isolation assertions. No raw private artifact/logs.
4. Record Phase 0 evidence, risks, ordered backlog, operational prerequisites and exact test results; review, commit via GitHub connector and open a Draft against feature/safe-reference-tools-v1.

Validation: node --test scripts/*.test.mjs; node --check every scripts/**/*.mjs; bash -n termux/ai; YAML parse and workflow contract tests. No game source, account secrets, remote subscription CLIs or billing resources in tests.

Review focus: worker code mutation, context/replay substitution, artifact corruption and size, stale base, failed/missing validation, accidental public plaintext, inherited write credentials, existing-test overwrite. Residual worker attestation, AI auth exposure and CLI policy are documented blockers, not silently declared solved.

Execution record: tasks 1–4 implemented in this session. Baseline 50/50, final local suite 60/60; syntax, shell and YAML checks passed. Independent review found exporter/output mutation could leak plaintext before publisher rejection. Scope decision: keep live dispatch unconditionally blocked by constant false until protected execution/exporter isolation is implemented and verified. Repository policy/free-storage variables cannot bypass it. Also reject audit arrays over 90 to prevent normalization from dropping later failure events. No real private-game/LLM run, container test or phone installation claimed. Detailed findings and next acceptance criteria: docs/phase-0-1-handoff-2026-11-16.md.
