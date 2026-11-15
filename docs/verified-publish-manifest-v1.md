# Publish-time verified file snapshot

## Threat
A validated private-game source file could change after independent review and before publication. The prior publisher checked only modified path names, not reviewed file bytes. A background subprocess could mutate the same path without changing the path list, or files could drift accidentally.

## Mitigation
- The runner calculates a SHA-256 digest from a deterministic sorted list of allowed paths, lengths and exact bytes, after the independent review.
- The manifest contains \`verifiedContentSha256\`. It never includes private content in the public repository.
- The publisher recomputes the digest and **fails closed** if any file differs from the reviewed snapshot.
- The publisher uses the captured immutable byte buffers to construct GitHub \`PUT /contents\` requests; it does not re-read modified files after the digest check.
- The source allowlist, size checks, symlink detection, original test suite, Draft PR state and human approval remain enforced.

## Tests
\`node --test scripts/verified-manifest.test.mjs scripts/orchestrator-offline-e2e.test.mjs\` confirms a happy path, immediate refusal for a modified post-review source file before any GitHub API call, rejection of unsafe paths and symlinks, and isolated source-buffer immutability.

## Scope and remaining hazards
This mitigates unreviewed code publication, but **does not solve credentials isolation**: the publisher still runs after untrusted code on the same GitHub Actions runner. A distinct publish job with a secure private transport boundary is the next security architecture step, not something this change claims to have solved.

Stacked Draft PR #7 is based on PR #6, which is based on PR #5 and preceding drafts. No branches are merged, no game PR is created or modified, and no phone CLI is deployed.
