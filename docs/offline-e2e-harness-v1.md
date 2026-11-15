# No-secret offline end-to-end contract test (v1)

Purpose: exercise the REAL \`execute-private-task.mjs\`, \`publish-private-task.mjs\`, and \`persist-private-audit.mjs\` in one integration harness without invoking real Claude/Codex/Gemini, private game files, GitHub tokens, billable APIs, or network requests.

- Synthetic miniature Git repository at a disposable temp location, not \`skj04327/the-twilight-of-korea\`.
- Fake CLI executables for Claude, Codex, Gemini, and npm. Fake \`npm ci/typecheck/test/build\` always succeed in the happy path or simulate a failing unit test when requested. **This does NOT establish that the actual game compiles or passes its unit tests.**
- Executes two workpacks against synthetic \`src/generated-one.ts\` and \`src/generated-two.ts\`; checks order, audit IDs, review status and final manifest.
- Publisher is executed with \`PRIVATE_GAME_WRITE_TOKEN=FIXTURE_TOKEN\`. A local Node preload intercepts \`fetch\` and responds to expected GitHub routes; it never connects to api.github.com. Asserts only a Draft PR is requested and private audit targets task queue branch.
- Negative tests: unit tests fail all three allowed attempts; image requests stop before Codex and do not create PR manifest.
- All temporary content is deleted after each test.
- Public CI runs \`node --test scripts/orchestrator-offline-e2e.test.mjs\` with secrets explicitly unset.

**Limitations:** Does not test actual subscriber CLI authentication, workload latency, real Vitest/TypeScript/Build runtime, external image generation, private-repo authorizations, or a live PR. Those require separately controlled integration checks. No existing failed task is replayed. The 999999 PR URL returned by the mock is synthetic and not a real PR.

**Do not merge this stacked PR until PR #2–#4 dependencies are reconciled.** No auto-merge, deploy or payment.
