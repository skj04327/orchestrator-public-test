# Local worker bridge implementation plan

Authority: continuing user instruction, Phase 1 interruption/state/security roadmap. Base PR #12 e11af0e. Hardware preference is unanswered; no server/private Actions/account setup or live provider invocation is assumed.

Goal: connect a verified private receipt to the existing protected worker through a local run identity and single-host durable state, proven with a synthetic Docker backend.

Design: re-capture receipt/manifest/input bytes into a fresh host-owned job snapshot; bind local-v2 crypto context to task ID, random run UUID, queue commit and receipt SHA256. Keep existing GitHub-v1 context byte-compatible and reject cross-context replay. Prepare one exclusive job directory per task/root, append fixed phase events, acquire a one-use worker claim, then pass only snapshot queue/routing/context/public key to a trusted backend callback. Store only the encrypted result after confirmed backend cleanup; success means awaiting-independent-validation, never validated/published. Errors with uncertain cleanup mean needs-recovery; no automatic claim expiry/retry.

Public CLI supports prepare/status only and rejects Actions. No arbitrary executor/command/prompt flags or live run switch. Actual provider policy remains blocked; host API integration is for reviewed backends, tested with no-auth network-none Docker fixture. Private publication keys are not handed to the backend.

Steps: failing local crypto/receipt-tamper tests → tagged context and bounded private-state capture helpers; failing preparation/claim/journal tests → local job coordinator and metadata-only CLI; actual receipt→snapshot→Docker fixture→encrypted result/state integration; full regressions, independent review, new Draft and explicit remaining limitations.

Review focus: changed receipt inputs and symlink/file bounds; v1 compatibility and v2 replay; duplicate/concurrent starts; state/artifact writes stay outside worker; private key/token separation; failure/abort/crash do not become success or automatic reexecution; no inference/runtime/billing approval from fixture success.
