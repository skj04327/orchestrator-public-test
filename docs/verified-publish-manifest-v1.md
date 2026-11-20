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

## 서명된 로컬 후보 게시

`publishLocalReviewedDraft()`는 신뢰된 로컬 게시 호스트의 진입점이다. 작업 상태, 실행용 디스크 스냅샷, 복호화 키, 미리 신뢰한 리뷰 공개키와 GitHub 쓰기 토큰을 받는다. 독립 검사 보고서와 서명된 통과 판정을 다시 확인하고 암호화 후보를 복호화한다. 토큰은 고정된 비공개 게임 저장소의 GitHub HTTPS 요청에만 사용한다. 검사기와 AI 작업기는 게시 토큰에서 분리된다. 공개 Actions에서는 이 진입점이 차단된다.

게시기는 현재 `main`의 커밋과 전체 트리가 검사 근거와 일치하는지 확인한다. 기존 파일과 디렉터리, 파일 모드, 실행에서 제외된 설정을 포함해 전체 트리를 유지하고 검증된 변경만 덧입힌다. 업로드한 각 Git blob을 다시 받아 후보 바이트와 직접 대조하고, GitHub가 만든 전체 트리와 새 커밋의 부모를 확인한다. 모든 변경은 커밋 하나에 담긴다.

확인한 커밋만 새 `orchestrator/local-<task-id>-<run-id>` 브랜치로 만든다. 원격 브랜치와 `main`을 다시 조회하고 `draft: true`로 PR을 생성한다. 응답의 Draft 상태, 저장소, 기준과 변경 커밋이 기대값과 일치할 때 비공개 접수 기록을 확정한다. GitHub가 같은 요청에서 `main`을 고정하는 조건을 제공하지 않으므로 조회와 생성 사이에 기준이 달라질 수 있다. 응답에서 변화가 확인되면 복구 상태에 두고 병합은 사람이 판단한다.

`readLocalDraftStatus()`는 `not-started`, `needs-recovery`, `draft-created`를 반환한다. 원격 쓰기 전 게시 시도를 한 번 기록하고 브랜치 생성 전에는 예정 커밋을 기록한다. 각 상태 파일과 상위 디렉터리를 디스크에 동기화한다. 쓰기 결과가 불확실하면 같은 작업의 새 제출을 차단한다. 복구 시 기록된 브랜치와 예정 커밋을 GitHub에서 대조한다. HTTP 요청은 최대 40개, 각 20초, 전체 180초이며 응답당 4MiB까지 읽는다.

공개 검증은 실제 Git이 만든 합성 스냅샷과 모의 GitHub 응답만 사용한다. 실운영에 앞서 읽기·쓰기 권한 범위가 확인된 토큰을 별도로 공급하고 신선한 시험 과제에서 비공개 Draft를 검증한다.
