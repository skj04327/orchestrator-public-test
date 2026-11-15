# Delegated workpacks v1 — controlled multimodel development (Draft)

## What changes
The selected control tower (Claude by default, Gemini for UI/test requests) must inspect the private repository and produce a **strict JSON DAG** of at most four ordered workpacks. Up to three workpacks may contain source-code work. A policy validator checks bounds, dependency order, allowed paths, and capability requirements. Each code workpack is implemented by the existing Codex CLI, sequentially on the isolated private checkout. Only the combined change then runs original TypeScript checks, the full unit suite, build, and a separate Claude or Gemini review before a private Draft PR is allowed.

Expected flow: `ai "인물 50명 추가해줘"` → controller plans P1/P2/P3 → Codex updates source in order → existing tests/build → independent reviewer → private Draft PR. **The installed phone CLI still uses main until these Draft PRs are manually merged and deployed.** No live private-game integration test is claimed.

## Image requests
Workpacks may be `kind:"image"` but image generation is **not integrated**. If the original task requests a sprite, portrait, icon, illustration, or similar image, the plan must declare an image workpack. The orchestrator blocks the **entire** job before coding when any image workpack exists; it does not quietly publish an incomplete code-only PR. The public log exposes only a generic `BLOCKED: IMAGE_BACKEND_NOT_CONFIGURED` status, not the original private prompt. The private audit stores a bounded capability-failure category.

Do not connect an image API or send private game code to an external service until: a verified zero-charge and no-card tier, output licensing, privacy handling, hard limit and explicitly approved credentials are in place. Free model weights are not a free hosted API.

## Limits / intentional omissions
- **No concurrent coding**. Sequential workpacks avoid edits colliding in the same checkout and preserve file ownership; parallel isolated worktrees and safe merge are future tasks.
- Developer backend is **Codex only**. Controller and independent reviewer are different subscription CLIs; arbitrary worker/model assignment is NOT supported.
- Maximum four workpacks including image, maximum three code workpacks, total changed-file maximum eight. Source .ts/.tsx and new .test.ts only; existing tests, assets, configs, docs and build scripts remain blocked.
- The original free subscription CLI setup is used. No added paid API, no new credentials, no automatic merge, no deployment.
- A malformed or unsupported controller plan fails closed. Failed test/validation prevents Draft PR.
- `node --test scripts/workpack-planner.test.mjs` checks parser, dependencies, file allowlist, and explicit image block without consuming model usage.

## Further work required
1. Privately dry-run a new trivial task with 2 workpacks on this branch (not previous failed task), inspect nonsecret Actions logs and verify report.
2. Add an explicitly approved, truly free image generation backend with binary file validation, size and safety constraints, and secure private storage.
3. Introduce isolated per-workpack worktrees and safe conflict detection for actual parallel execution.
4. Support richer game data/assets only after authorization-aware path policies and asset validation.
5. Resolve PR #1–#3 branch overlap before deployment; stacked PR #4 must be reviewed before merge.
