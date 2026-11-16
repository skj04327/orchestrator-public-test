# Phase 0 조사 및 Phase 1 첫 개발 단위 — 2026-11-16

## 실제 상태

이 브랜치는 PR #8의 `ed85a925ff5081a97ca131eeafa929c794babeed`에서 시작했다. 기존 PR/브랜치 및 게임 코드는 수정·병합하지 않았다. 이 문서는 공개 가능한 구조·상태만 포함한다.

**Phase 1 전체 완료가 아니다.** 새 게시 경계와 암호화 전달을 구현하고 합성 데이터로 검증했다. 실행 runner가 exporter를 변조할 수 있는 문제가 남아 `task-intake.yml`의 `prepare-handoff`에 **상수 `false` 차단**을 두었다. 저장소 변수 변경으로도 실행할 수 없다. 다음 보안 변경과 실제 격리 검증 전에 이 차단을 제거하지 않는다. 기존 main에 병합되지 않아 설치된 휴대폰을 업데이트하지 않는다.

## Phase 0 증거

GitHub 커넥터로 PR #1~#8 메타데이터, 각 HEAD의 workflow runs, 공개 main, PR #8의 전체 파일, 비공개 인수인계 문서를 읽었다. 현재 환경의 shell git clone은 proxy 연결 실패로 사용할 수 없어 정확한 SHA의 공개 파일을 커넥터로 가져와 로컬에서 검사했다. 커밋과 브랜치 갱신도 GitHub 커넥터를 사용한다.

| PR | HEAD (앞 12자리) | 대상 | 확인한 CI |
|---|---|---|---|
| #1 | deced05e886a | main | 1개 성공 |
| #2 | ec275e393157 | main | 1개 성공 |
| #3 | 40c0c6a06e15 | feature/dynamic-control-tower-v1 | 2개 성공 |
| #4 | 5c37ecd1cd27 | feature/orchestrator-integration-v1 | 3개 성공 |
| #5 | 2016fcb8a5f4 | feature/delegated-workpacks-v1 | 1개 성공 |
| #6 | 4d95664430d9 | feature/offline-e2e-harness-v1 | **실게임 기준 검사 실패** |
| #7 | baa47b16ca2e | feature/private-baseline-preflight-v1 | 5개 성공 |
| #8 | ed85a925ff50 | feature/verified-publish-manifest-v1 | 6개 성공 |

확인 시점에 전부 open / Draft / unmerged다. 이 표는 커넥터가 반환한 각 HEAD의 PR-triggered 실행을 기록하며, 모든 이력·보호 규칙을 확인했다는 뜻은 아니다.

- 공개 main: `31380508750bcb7da4ae221191476521d4c77da0`. 새 기능은 아직 main에 없다.
- 게임 main: `832480045494c980d04e741f211d669a1bbce1f4`. task-queue 브랜치 존재 및 `docs/orchestrator/CONTINUE_ORCHESTRATOR_2026-11-15.md` 내용 확인. 게임 전체 소스는 이번 검사에 반입하지 않았다.
- #6 실행 [43721906349](https://github.com/skj04327/orchestrator-public-test/actions/runs/43721906349): install/typecheck/build 성공, **unit-tests exit 1**, tracked-source-unchanged 성공. 원본 진단은 당시 cleanup으로 삭제되어 실패한 테스트명은 확인할 수 없다. 코드 변경 전에도 실패한 기준이므로 이후 변경의 신규 실패와 구분해야 한다.
- 금지된 작업과 run 43712696201은 재실행하지 않았다. 신규 실제 게임 작업도 등록하지 않았다.
- 휴대폰에 접속하지 않았으므로 실제 `$PREFIX/bin/ai` 버전은 미확인이다. main의 `termux/ai`와 #8의 소스 차이는 확인했으며, 인수인계는 설치본이 구버전이라고 기록한다. 소스 옵션 지원과 단말 배포를 혼동하지 않는다.
- #1의 audit-ledger 파일 SHA는 #8과 다르다. #1과 #3의 중복 구현은 병합 전에 별도로 조정해야 한다.

## 이번 구현

1. `prepare-handoff` / `task-execution` / `task-publish`를 다른 hosted runner job으로 분리했다. 쓰기 토큰은 신뢰된 준비·게시 단계에만 배치한다. 신뢰된 checkout은 `github.sha`에 고정하고 persistent credentials를 끈다.
2. 기존 쓰기 토큰과 작업 ID, repository, run ID, attempt, workflow SHA로 실행별 X25519 수신키를 파생한다. worker에는 공개키만 전달한다. 새 비밀값·유료 서비스·외부 암호 라이브러리가 필요하지 않다.
3. ephemeral X25519 + HKDF-SHA256 + AES-256-GCM으로 최대 800,000바이트의 JSON snapshot을 암호화한다. 작업·실행 context를 인증 데이터로 묶는다. 다른 키/context, 손상·잘림·추가 바이트는 복호화를 거부한다.
4. source snapshot에 SHA-256, base SHA, 허용 경로, 파일 크기/개수, 엄격한 base64, 코드·전체 테스트·빌드·독립 리뷰 결과를 재확인한다. 기존 검증/복구 상한을 유지한다. 90개를 넘는 audit로 늦은 실패를 숨기는 것도 차단한다.
5. 새 게시기는 게임 checkout, git/npm/모델 CLI를 실행하지 않는다. 메모리로 복호화한 정확한 파일 바이트만 GitHub에 게시한다. main 이동·기존 테스트 덮어쓰기를 branch 생성 전에 거부하고 Draft PR만 만든다. GitHub 요청에 timeout과 redirect 거부를 추가했다.
6. artifact download는 신뢰된 scripts 디렉터리 밖으로 분리한다. 설계상 업로드 대상은 `.private-handoff.enc` 하나이며 retention 1일이다. **실제 업로드는 실행하지 않았고, 현재 hard block으로 불가능하다.**
7. 파일 자체뿐 아니라 부모 디렉터리 symlink도 manifest 수집 시 거부한다. 실패 메시지는 원문을 포함하지 않는 고정 문자열이다.

## 보안 리뷰 결과와 차단 이유

독립 리뷰가 다음 중요한 결함을 확인했다: 현재 worker와 exporter가 같은 runner의 쓰기 가능한 파일시스템을 공유한다. 악성 테스트/백그라운드 프로세스는 exporter 또는 `.private-handoff.enc`를 평문 파일이나 디렉터리로 바꿀 수 있다. 나중에 게시기가 복호화를 거부해도 공개 artifact 유출을 되돌릴 수 없다. `GITHUB_OUTPUT` 같은 Actions 제어 경로와 공개 로그도 실행 코드로부터 격리가 필요하다.

따라서 변수만으로 활성화할 수 있는 상태로 제출하지 않는다. **상수 false 차단이 이 미해결 결함의 현재 방어다.** 암호화와 manifest는 transport/바이트 무결성 장치이며, 장악된 worker의 검증 주장을 증명하는 서명이 아니다. 현재 오프라인 검사만으로 보안 격리 또는 실제 운영 완주가 완료됐다고 판단하지 않는다.

다음 독립 개발 단위의 요구사항:

- AI/게임 명령을 폐기 가능한 컨테이너에서 실행하고 trusted scripts는 읽기 전용으로 둔다. host 전체 repo/home 또는 Docker socket을 노출하지 않는다.
- worker에 Actions runtime/artifact 토큰, GITHUB_ENV/OUTPUT/PATH 경로, 쓰기 토큰을 전달하지 않는다. 필요한 auth와 입력만 명시적으로 전달한다.
- stdout/stderr는 공개 로그로 보내지 않고 host의 비공개 제한 파일로 모은다. host가 허용된 상태값만 출력한다.
- 작업 컨테이너와 백그라운드 writer를 모두 종료한 뒤, 보호된 host exporter가 source를 수집·암호화한다. 출력은 worker가 쓸 수 없는 디렉터리로 만든다.
- exporter 변조, 평문 대체, artifact 디렉터리 대체, 지연된 background write 공격을 실제 격리 환경에서 시험한다. 이 세션의 Docker socket 접근은 permission denied여서 컨테이너 검증을 수행하지 않았다.
- worker 검증 결과의 신뢰 경계와 깨끗한 별도 검증 실행을 설계한다. context·해시는 악성 worker의 자체 서술을 신뢰할 근거가 아니다.

## 운영 전 미확인 조건

- Claude/Codex/Gemini 계열의 최신 실제 CLI 옵션, 구독 인증의 CI 허용 정책, 데이터 전송 범위를 공식 문서와 실제 환경에서 검증해야 한다. 이번 세션은 기존 어댑터를 재사용했으며 새 지원 사실을 주장하지 않는다.
- 무료 standard runner 이외의 runner를 선택하지 않는다. artifact 저장이 무료 한도 안인지 보장되지 않으면 실행하지 않는다. `ORCHESTRATOR_LIVE_POLICY_CONFIRMED`와 `ORCHESTRATOR_FREE_STORAGE_CONFIRMED`는 조건을 추적하는 추가 게이트이며 현재 hard block을 우회하지 못한다. 이 변수/비밀값을 변경하지 않았다.
- 토큰이 두 trusted job 사이에서 바뀌면 안전하게 복호화 실패한다. 파생 키 방식은 토큰 자체가 유출된 뒤의 과거 ciphertext 복호화까지 막는 forward secrecy를 제공하지 않는다. 보관 기간/삭제/키 회전 정책은 운영 전 검토한다.
- trusted job 자체의 손상, 외부 전송/network 제한, subscription auth의 worker 노출, 메모리/CPU/process 수 제한은 아직 완성되지 않았다.
- 여러 Contents API PUT 도중 실패하면 전용 미완성 branch가 남을 수 있다. 자동 재시도로 덮어쓰지 않으며 상태 복구·원자적 Git tree 게시를 후속 구현한다.

## 검증과 재현

공개 코드의 합성 fixture만 사용했다. 실제 LLM, 유료 API, 실제 게임 테스트/PR, Termux 단말은 호출하지 않았다.

```sh
node --test scripts/*.test.mjs
for script in scripts/*.mjs scripts/test-fixtures/*.mjs; do node --check "$script" || exit; done
bash -n termux/ai
git diff --check
```

- 변경 전 기존 검사: **50/50 성공**.
- 변경 후 전체 검사: **60/60 성공**, Node **v24.22.1**. CI는 Node 22로 설정돼 있으므로 원격 결과를 별도로 확인한다.
- 전체 workflow YAML을 PyYAML로 파싱하고 상수 false 게이트와 job 의존관계를 검사했다. GitHub Actions runtime 전체 검증 또는 actionlint 실행 증거는 아니다.
- 기본 sandbox는 subprocess 실행을 EPERM으로 제한해 E2E/MCP 검사가 실패했다. subprocess가 허용된 환경에서 네트워크 mock을 유지한 채 위 전체 검사를 통과했다. 테스트 자체를 건너뛰거나 약화하지 않았다.
- 새 모듈 부재, 별도 게시 job 부재, audit 잘림 문제, 상수 차단 부재에 대한 실패를 먼저 관찰하고 수정 후 전체 검사를 통과했다.
- 퍼블리셔는 별도 임시 디렉터리에서 게임 checkout 없이 실행했다. 손상된 암호문·실패한 worker·job 결과 불일치·검증 후 변조·stale main·기존 테스트 덮어쓰기의 차단을 검사했다. 모든 GitHub 호출은 mock이다.

## 우선순위 백로그

| 우선순위 | 다음 작업 | 완료 증거 |
|---|---|---|
| P0 | 보호된 worker/exporter 실행 경계 | 실제 컨테이너 공격 회귀 시험 및 공개 평문/제어 토큰 차단 |
| P0 | 구독 CI 정책·무료 한도·외부 전송 범위 확인 | 공식 문서/인증 경로/차단 조건 기록; 비용 보장 전 실행 불가 |
| P1 | 실패 진단의 비공개 제한 저장 및 기준 테스트 비교 | 실패 테스트명·분류를 비공개 보고서에서 확인, 전체 기존 검사 유지 |
| P1 | 깨끗한 독립 검증과 검증 결과 신뢰 경계 | generated source가 검증 runner/보고서/게시 코드를 변조하지 못함 |
| P1 | 취소/부분 실패/게시 재개 상태 관리 및 원자적 게시 | token/network/API 중단 시험에서 중복 PR·부분 성공 오보고 없음 |
| P2 | Phase 2~3 조사·이미지·도구 권한 검증 | 실제 지원 CLI와 출처 추적, 승인된 전송 범위 검증 |
| P3 | Phase 4~7 병렬 AI·이미지 생성·대시보드·Termux | 무료 조건과 보안 경계가 검증된 뒤 단계별 실제 E2E |

현재 위치: **Phase 0 현황 보고 완료(단말 설치본은 미확인), Phase 1의 오프라인 게시 경계 구현 완료, 실제 실행 격리·운영 검증 미완료**. 기존 PR 병합이나 live hard block 제거는 이 문서의 완료 판정에 포함되지 않는다.
