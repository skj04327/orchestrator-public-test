# 로컬 독립 코드 검사 v1

Phase 1의 검증·게시 권한 분리 개발 단위다. PR #13의 `awaiting-independent-validation` 결과를 호스트에서 복호화한 뒤, 작업기가 쓴 감사 기록과 별개로 npm 명령의 종료 상태를 관찰한다. 게임 PR 게시 권한은 부여하지 않는다.

## 입력과 신뢰 경계

`runLocalIndependentChecks({id,stateRoot,privateKey,baseline,imageId,timeoutMs,outputLimit,signal})`는 검토된 로컬 호스트 코드에서만 호출한다. Actions에서는 거부한다. 임의 runner·명령·AI 모델을 입력받지 않는다. `privateKey`는 호스트에서만 사용하며 Docker에는 공개/개인 암호화 키, GitHub 토큰, 구독 인증정보를 전달하지 않는다.

`baseline`은 `{baseSha,files:[{path,content}]}`이며 content는 정규 base64다. 신뢰하는 호스트가 읽기 전용 커밋에서 만들어야 한다. 이 버전은 실제 비공개 main을 직접 조회하지 않으므로 `baselineBinding: caller-supplied`를 기록한다. 작업기 결과의 baseSha와 일치해야 하지만 이것만으로 main 출처를 증명하지 못한다. 자동 baseline 수집·출처 확인은 후속 작업이다.

기준 파일은 최대 10,000개, 합계 32MiB, 파일당 1MiB다. 직렬화 입력도 46,000,000바이트 이하다. package.json과 package-lock.json이 필요하며 `.git`, node_modules, `.env*`, `.npmrc`, `.codex`·`.claude`·`.gemini`·`.aws`·`.ssh`·`.config`·`.docker`·`.azure`·`.kube`·`.gnupg`, `.npm`·`.cache`·`.local` 경로와 경로 탈출·충돌·중복·비정규 base64를 거부한다. 일반 파일 바이트만 표현하며 실제 스냅샷 어댑터는 링크와 특수 파일을 따르지 않아야 한다. 이 목록은 모든 파일 내용에 대한 비밀 탐지기가 아니다. 신뢰하는 스냅샷 제공자는 인증정보를 포함하지 않아야 한다. 변경 파일은 기존 1~8개 src TypeScript/새 테스트 제한을 유지하고 tests/test/__tests__ 디렉터리 및 .test/.spec 이름의 기존 테스트 교체를 거부한다. 다른 테스트 배치는 향후 기준 어댑터의 명시적 테스트 목록과 리뷰로 확인해야 한다.

호스트는 암호문 SHA-256·local-v2 문맥·구조·후보 파일 지문을 재확인하고, 모든 기준 파일 바이트도 별도 SHA-256으로 묶는다. 비동기 실행 전 원본 객체에서 바이트를 캡처한다. 컨테이너에는 이 캡처의 직렬화된 읽기 전용 복사본만 보낸다. 작업기 감사 자료의 `passed`는 독립 코드 검사를 대체하지 못한다.

## 실제 검사

기준 코드와 변경 코드 각각에 대해 아래 세 명령을 별도 컨테이너에서 실행한다. 각 컨테이너는 같은 캡처에서 새 프로젝트 디렉터리를 만든 뒤 `npm ci --offline --no-audit --no-fund`를 먼저 실행한다. 설치 스크립트를 무시하지 않는다.

1. `npm run typecheck`
2. `npm test -- --reporter=dot`
3. `npm run build`

한 단계가 작업 디렉터리나 package 스크립트를 바꿔도 다음 컨테이너에는 전달되지 않는다. 기준 테스트가 실패해도 변경 코드 검사는 계속해 비교할 수 있지만, 하나라도 실패하면 전체를 통과시키지 않는다. 타임아웃·출력 한도·Docker 통신 문제는 이후 실행을 중단한다.

검토한 고정 이미지 ID만 허용하고 자동 pull은 금지한다. 네트워크 없음, UID/GID 1000, 읽기 전용 root/input, capability 없음, no-new-privileges, 1GiB 메모리, 128 PID, 2 CPU다. 작업 공간은 512MiB tmpfs이고 임시 디렉터리는 128MiB다. 각 검사 실행은 최대 420초, 출력은 최대 240,000바이트다. 컨테이너·입력 볼륨 정리를 확인한 결과만 수용한다. 중단 신호 뒤 정리는 별도 비중단 요청으로 수행한다.

현재 합성 이미지에는 실제 게임 의존성 캐시가 없다. 의존성이 필요한 프로젝트는 고정 런타임에 검증된 오프라인 캐시가 없으면 실패한다. 네트워크 설치로 우회하거나 검사 스크립트를 줄이지 않는다. 합성 fixture의 typecheck는 Node 문법 검사이고, 실제 게임의 TypeScript 검사나 실제 AI 리뷰를 실행한 증거가 아니다. 보고서가 증명하는 것은 캡처된 입력으로 격리 실행한 npm 명령의 관찰 결과다. 악성 코드가 자신의 검사 의미를 속이는 문제까지 해결하지 않으므로 실제 독립 코드 리뷰도 필요하다.

## 상태·조회·게시 차단

비공개 작업 디렉터리에 0600 `independent-claim.json`을 배타적으로 만들고, 마지막에 `independent-report.json`을 한 번만 쓴다. 원시 npm 출력·작업 원문·키를 보고서나 공개 로그에 쓰지 않는다. 실패 종류와 실제 종료 코드·시간, 문맥·암호문·기준·변경 지문, 이미지 ID를 기록한다. 원시 비공개 진단의 안전한 보관·조회는 남아 있다.

```sh
node scripts/independent-check-cli.mjs status <task-id> <job-root>
```

| 상태 | 의미 |
| --- | --- |
| not-started | 독립 claim 없음 |
| running-or-needs-recovery | claim은 있으나 완료 기록 없음. 실행 중인지 중단됐는지 자동 추정하지 않음 |
| checks-passed-awaiting-review | 여섯 명령 통과. 실제 독립 리뷰·main 출처 확인·게시 미완료 |
| checks-failed | 기준 또는 변경 코드 명령 실패 |
| needs-recovery | 취소·제한 초과·인프라 오류·정리 불확실 등으로 중단 |

모든 상태의 `publishAuthorized`는 반드시 false이며 `review`는 not-run이다. 기존 작업기 상태도 검증 대기로 남긴다. 이 보고서는 게시용 서명·승인 증명서가 아니다. 잘못된/부분 보고서, true로 바꾼 게시 플래그와 암호문 변경을 거부한다. 완료 보고서 추가가 완료 확정 시점이며 이후 취소는 소급하지 않는다. claim은 자동 만료·재시도되지 않는다. 분산 잠금·전원 장애 복구·사용자 복구 명령은 제공하지 않는다.

CLI는 조회만 지원하고 실행·키 전달·Actions 조회는 거부한다. 기존 공개 Actions 실행 차단과 구독 정책 검사는 유지한다. 기존 GitHub 문맥 게시기는 로컬 암호문을 게시하지 못한다. 새 게시기·게임 저장소 쓰기·실제 AI 호출·휴대폰 설치·병합은 이번 범위에 없다.

## 다음 우선 작업

비공개 main의 읽기 전용 고정 스냅샷 수집 및 출처 확인, 실제 게임 기준 검사, 무료 오프라인 의존성 런타임, 허용된 구독 인증·실행 장소의 확인, 별도 AI 리뷰와 검증 증거, 키가 분리된 Draft 게시기 순으로 연결한다. 그 전까지 코드를 검사한 결과를 게시 가능으로 표시하지 않는다.

검토에서 남긴 경미한 보완: 수동으로 만든 실패 보고서의 exitCode/failureKind/phase 간 모순을 더 엄격히 거부할 수 있다. 현재 실제 실행기가 만드는 관찰값은 일관되며, 이런 보고서도 게시를 승인하지 못한다. 호스트 상태를 임의 수정하는 동일 사용자 프로세스는 신뢰 경계 밖이다.

## 재현과 검토 기록

최초 일반 기준은 88/88 통과했다. 실제 npm 시험은 사용자·전역 설정에 같은 /dev/null을 지정해 전 단계가 실패했고, Docker 안의 npm --version에서도 double-loading config 오류를 재현했다. 전역 설정을 별도의 읽기 전용 입력 경로로 바꾸자 오류가 사라졌으며 전체 합성 npm 검사 시나리오가 통과했다.

독립 읽기 전용 리뷰의 중요 지적 네 개를 수정했다. 공개 호스트 API가 첫 await 전에 기준 바이트를 캡처하도록 고쳤고, 호출 직후 기준을 바꾸는 실제 Docker 회귀의 실패→통과를 확인한다. src 안의 기존 test/spec 교체와 알려진 인증·캐시 경로는 입력 테스트로 실패를 재현했다. 최종 실제 파일 무결성 읽기 도중 취소는 Docker 외부 의존성만 fault simulator로 대체하고 실제 파일 읽기를 유지해 실패를 재현했다. 읽기가 끝난 직후 취소를 다시 확인하도록 고쳤다. 합성 감사 기록의 PASS는 실제 AI 리뷰 증거로 사용하지 않는다.

2026-11-17 최종 로컬 증거: 일반 **97/97**, 기존 Docker 5개 + 신규 독립 검사 시나리오 3개 **8/8** 통과, 생략 0. JavaScript·Bash 구문, YAML 파싱, diff 검사 통과. 실제로 사용한 것은 기존 고정 로컬 이미지와 합성 데이터이며 유료 API·인증된 모델·게임 작업·휴대폰은 사용하지 않았다.

```sh
GITHUB_ACTIONS=true node --test scripts/*.test.mjs
# ORCHESTRATOR_TEST_IMAGE는 검토한 기존 이미지의 sha256 ID로 미리 지정한다.
node --test --test-concurrency=1 scripts/protected-worker.docker-test.mjs scripts/local-worker-bridge.docker-test.mjs scripts/independent-checks.docker-test.mjs
```
