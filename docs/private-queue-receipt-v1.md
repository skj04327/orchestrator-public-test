# Phase 1 — 비공개 큐 접수와 로컬 인수

PR #11 `d2c197d36aea2e90ab7c1bf37fd59a0e41e02d1e` 위의 다음 개발 단위다. 공개 CI에서 구독 인증을 실행하지 않는 전환의 첫 데이터 경로이며, AI 실행 backend 자체를 완성한 것은 아니다.

## 변경한 동작

소스 `termux/ai`는 자연어 요청·참고자료·이미지를 기존 **비공개** `skj04327/the-twilight-of-korea`의 `orchestrator/task-queue`에 저장한다. 공개 workflow dispatch를 제거했다. 입력을 먼저 비공개 임시 snapshot으로 고정하고 SHA-256/크기를 계산한 뒤 같은 snapshot을 업로드한다. 이미지 read는 700,001바이트로 제한한다. 로컬 임시 파일은 umask 077과 종료 trap으로 정리한다.

모든 입력 PUT이 성공한 뒤 **마지막에만** `docs/orchestrator/requests/<task-id>.json` readiness 표식을 저장한다. 표식에는 다음 정보만 있다.

- schemaVersion, taskId
- routing: auto/stable/manual 및 controller 선택
- task/reference/image별 고정 경로, 원본 byte 크기, SHA-256

이 표식은 업로드 완료·입력 식별의 근거이며 코드 검증이나 실행 성공의 증거가 아니다. 중간 업로드가 실패하면 비공개 원본 일부가 남을 수 있지만 readiness는 없으므로 수신하지 않는다. 실패한 업로드를 무조건 재실행하거나 원본을 자동 삭제하지 않는다.

접수 전 GitHub 계정과 대상 저장소의 private 여부를 확인하고 GitHub.com host를 고정한다. 큰 입력도 JSON 파일로 전송해 argv에 전체 base64를 넣지 않는다. 완료 메시지는 **worker가 아직 시작되지 않았음**을 명시한다. `ai status`는 비공개 ready ID 목록을 보여 주며 실행 현황으로 표시하지 않는다. `ai report TASK_ID`는 기존 private report 읽기를 유지한다. 기존 `ai logs`의 공개 workflow 로그 조회는 제거하고 private report를 안내한다. intake와 receiver CLI는 Actions 환경에서 거부한다.

**설치된 휴대폰의 ai는 업데이트하지 않았다.** 이번 변경은 검토할 소스이며 병합/설치 전 기존 단말 동작이 바뀌었다고 주장하지 않는다.

## 로컬 인수기

```sh
# Node와 gh가 있는 신뢰된 로컬 환경, source checkout에서 실행
node scripts/private-queue-cli.mjs receive TASK_ID /absolute/private/state-root
node scripts/private-queue-cli.mjs status TASK_ID /absolute/private/state-root
```

이 CLI는 worker 실행 명령이 아니다. 실행 장소 선택 전에도 같은 private 큐 계약을 사용할 수 있도록 분리했다. 기존 Linux host를 가정해 실제 AI를 실행하거나 새 서버를 만들지 않았다. 실제 Termux 설치·수신은 미검증이다.

1. repo metadata의 private=true 및 정확한 대상 저장소 이름을 확인한다.
2. queue ref의 commit SHA 하나를 읽고 manifest와 모든 입력 GET에 동일 SHA를 지정한다. branch가 이동해도 서로 다른 시점의 파일을 섞지 않는다.
3. schema·엄격한 kind enum·라우팅·허용 경로·개수·크기·canonical base64·UTF-8·SHA-256을 검증한다. 참고 URL과 이미지에는 기존 읽기 전용 파서를 재사용하며 웹 수집/이미지 분석은 호출하지 않는다. 이미지 원본 decode 전체를 검증했다는 뜻은 아니다.
4. readiness 표식 없는 legacy task, 미완성 표식, 변경된 입력, 금지된 이전 실패 ID는 거부한다. 이전 작업을 자동으로 새 형식으로 승격하거나 재실행하지 않는다.
5. 원문은 Git working tree 밖의 소유자 전용 0700 root/하위 디렉터리와 0600 파일에 저장한다. root와 모든 조상은 root 또는 현재 UID 소유여야 한다. 타 사용자 소유 조상과 nonsticky 공유 쓰기 경로, symlink, 실제 `.git`/gitdir 경로를 거부한다. root 소유 sticky `/tmp` 같은 표준 임시 경로는 허용한다. 현재 코드가 허용하는 소유권 체계와 다르면 안전하게 실패하며 완화하지 않는다. Android 시스템 경로와 shared storage 지원은 실제 기기에서 별도 확인한다.
6. 한 번의 exclusive hardlink로 task ID receipt index를 공개한다. 같은 로컬 root에서 경쟁 인수는 정확히 하나만 성공하며 기존 파일/symlink/receipt를 덮어쓰지 않는다. 실패한 임시 bundle은 정리한다. 상태는 **received** 하나만 인정한다. `validated` 등으로 바꾼 파일을 status 성공으로 보여 주지 않는다.

stdout에는 ID·received 상태·pinned SHA·라우팅만 출력한다. gh는 고정 GitHub.com의 허용된 GET endpoint만 사용하고, timeout/출력 상한·비대화형 설정을 적용한다. raw API 오류, task, 이미지, URL 본문, token은 출력하지 않는다. `gh`가 실제 최소 read 권한 credential로 구성됐는지는 이 프로그램이 발급/변경하지 않는다. 향후 AI worker에 이 receipt/control root나 gh credential store를 쓰기 가능하게 넘기면 안 된다.

## 검증

- 변경 전 일반 검사 69/69, 변경 후 **77/77 성공**.
- 기존 실제 합성 Docker 공격 검사 **3/3 성공**.
- 실제 `termux/ai` + 가짜 gh + 실제 receiver CLI의 오프라인 흐름: task/reference/PNG → readiness 마지막 저장 → 동일 commit 입력 인수 → local status → 중복 인수 거부.
- 공개 repo 거부, 부분 업로드, hash 변경, proof 누락, 잘못된 kind/경로, CI intake/receipt 거부, 이전 실패 ID 거부, 경쟁 인수, symlink root, Git checkout, 공유 쓰기 조상 및 허위 검증 상태를 검사했다.
- JavaScript/셸 문법, workflow YAML 파싱, 기존 구독 정책/상수 false, diff 검사 성공. 새 CI가 같은 일반 검사와 기존 Docker 공격을 실행한다.
- 독립 리뷰에서 찾은 상위 경로 교체 위험과 kind 배열 허용을 실패 테스트로 재현한 뒤 수정했다. 리뷰의 기본 sandbox에는 가상 `/tmp/.git`와 UID 65534 조상 등이 있어 직접 검사가 거부됐다. 자식 프로세스와 표준 root-owned 조상이 있는 허용된 실행 환경에서 전체 검사를 통과했으며, 실제 Git 표식과 빈 가상 표식을 구분한다. 신뢰되지 않은 조상에 대한 차단은 유지한다.

모든 신규 큐/API 입력은 합성 fixture다. 실제 private 큐를 쓰거나 원문을 내려받지 않았고 실제 AI·구독 인증·게임 코드·Actions dispatch·과금 서비스·휴대폰 배포도 실행하지 않았다. 이전 실패 task/run은 재실행하지 않았다.

## 남은 범위와 다음 순서

이 receipt는 **로컬 인수 기록**이다. 분산 claim/lease, 다른 host 간 중복 실행 차단, 실행 backend, 인증 갱신, trusted validation, PR 게시/복구, 모바일 화면은 아직 아니다. SIGKILL/전원 손실 때 private orphan staging이 남을 수 있으며, index 없는 디렉터리를 실행 대상으로 보지 않는다. 디렉터리 항목의 모든 power-loss durability나 자동 정리/재개까지 보장하지 않는다.

다음은 실제 실행 환경 선택에 맞춘 worker 연결이다. 기존 Linux가 있으면 보호된 container 경계를 재사용할 수 있지만 auth/network/data 정책이 먼저다. Termux만 사용한다면 CLI/OS·저장소 권한·실행 격리를 실제 기기에서 검증해야 한다. 비공개 Actions를 선택한다면 무료 잔여 한도와 과금 중단 보장부터 확인한다. 어떤 경우든 공개 구독 CI 차단·기존 검증·Draft만 게시·사람의 최종 병합 원칙을 유지한다. 현재 handoff crypto의 GitHub context도 비공개/local 실행에 맞게 재설계해야 하며 가짜 공개 CI context를 만들어 우회하지 않는다.
