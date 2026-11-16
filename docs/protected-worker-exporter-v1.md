# Phase 1 — worker/exporter 격리, 2026-11-16

PR #9의 `6ae6475711c6262d5e57bcfb8b6b5b0fe952a13f`를 기반으로 한 다음 개발 단위다. 기존 PR/게임 브랜치는 수정·병합하지 않는다. 이전 상태와 전체 백로그는 [Phase 0/1 인수인계](phase-0-1-handoff-2026-11-16.md)를 참조한다.

## 해결한 경계

이전 실행 runner에서는 게임 테스트나 남아 있는 프로세스가 exporter 또는 `.private-handoff.enc`를 평문으로 바꿀 수 있었다. 새 경로는 **host가 Docker worker를 감독하고, worker 종료·자원 제거가 확인된 후에만 host 메모리에서 암호화**한다.

1. host는 작업별 무작위 이름의 컨테이너와 Docker named volume 세 개를 만든다. host 경로를 bind mount하지 않는다. Docker socket, host home/repo, Actions runtime/artifact 토큰, GITHUB_ENV/OUTPUT/PATH, 쓰기 토큰, 수신 공개키를 worker에 전달하지 않는다.
2. 실행하지 않는 준비 컨테이너로 공개 제어 코드와 비공개 입력을 서로 다른 volume에 복사한다. 실제 worker는 두 volume을 **읽기 전용**, 작업 volume 하나를 쓰기 가능으로 받는다. 준비 컨테이너는 worker 시작 전에 제거한다. 비공개 입력이나 인증정보를 이미지 레이어/build cache에 넣지 않는다.
3. worker는 UID/GID 1000, 읽기 전용 rootfs, 모든 capability 제거, no-new-privileges로 실행한다. CPU 2개, 메모리·swap 합계 1GiB, PID 128개, 임시 메모리 파일시스템 128MiB, attach 출력 240,000바이트, 실행 50분 상한을 둔다. Docker 명령에도 개별 timeout과 출력 상한을 둔다. 현재 상한이 실제 게임/CLI에 충분한지는 별도 측정해야 하며 실패 시 기존 검사를 우회하지 않는다.
4. 명시적으로 허용한 작업 ID·라우팅 설정·컨테이너 내부 경로만 환경에 넣는다. 구독 인증은 host 메모리에서 별도 입력 파일로 전달하며 public 로그/CLI 인자에 값을 넣지 않는다. provider API 키는 빈 값이다. 구독 인증을 worker가 읽을 수 있다는 사실은 변하지 않으며 전송 정책 검증이 필요하다.
5. stdout/stderr를 host가 제한된 버퍼로 받고 원문은 공개 로그나 Docker log driver에 저장하지 않는다. host 진입점은 고정된 성공/실패 문자열만 출력한다. 비공개 상세 진단의 영구 저장은 아직 후속 과제다.
6. 종료 후 Docker 상태에서 Running/Paused/Restarting을 거부한다. 필요한 manifest·audit·최대 8개 파일만 `docker cp ... -`로 읽는다. archive를 host 파일시스템에 풀지 않는다. checksum·정확한 파일명·크기·단일 regular file을 검사하고 symlink/hardlink/directory/PAX/경로 이탈/추가 entry를 거부한다. 수집한 source의 기존 SHA-256·검증 결과 확인도 유지한다.
7. worker와 모든 작업 volume 제거를 시도한다. 생성 요청이 성공하고 응답만 유실될 수 있어 요청 전에 이름을 등록한다. 삭제 하나가 실패해도 나머지 삭제를 시도하며, 정리가 완결되지 않으면 **암호화 결과조차 반환하지 않는다**. 취소는 준비·실행·수집에 전파하고 정리는 취소되지 않은 별도 요청으로 수행한다.
8. 모든 제거가 끝난 뒤 host 코드가 검증한 snapshot을 암호화한다. host 진입점은 전용 0700 디렉터리에 0600 `bundle.enc`를 exclusive 생성한다. 업로드 대상은 `${runner.temp}/protected-handoff/bundle.enc` 하나이며 worker는 이 경로를 볼 수 없다. 게시 job은 기존처럼 다른 runner에서 복호화·재검증한다.

## 실제 시험

기본 sandbox에서는 Docker socket 접근이 제한됐지만 허용된 실행 환경에서는 로컬 Docker **29.9.2**, rootless/seccomp/cgroupns 환경을 사용할 수 있었다. 공개 Node 이미지를 받아 계정/결제 없이 로컬 fixture 이미지를 만들었다.

- 기반 이미지: `node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee`.
- 컨테이너에서 직접 확인한 Node: **v22.23.5**. host Node: **v24.22.1**.
- 기존 검사: 60/60. 변경 후 `node --test scripts/*.test.mjs`: **63/63 성공**.
- 별도 실제 Docker 공격 검사: **3/3 성공**, skip 없음. 여러 공격 변형을 각 테스트에서 실행한다.
- 실제 공격: exporter/평문 artifact 파일·디렉터리 변조, read-only 입력 변경, host/socket/control 경로 및 host 환경 토큰 접근, delayed background writer, 결과 symlink/directory 대체, 출력 폭주, 시간 초과. 비root·NoNewPrivs·CapEff 0도 컨테이너 내부에서 확인한다.
- fault simulator: 사전 취소, 준비·수집 중 취소, 생성 응답 유실, 첫 삭제 실패 때 전체 정리 시도와 handoff 차단을 검증한다. 이는 실제 Docker 장애를 일으킨 시험이 아니라 고장 응답 시뮬레이션이다.
- 실제 시험 후 Docker 엔진의 container/volume 목록을 독립적으로 조회해 작업용 자원이 0개임을 확인한다. 단순히 반환값 `removed`를 믿지 않는다.
- JavaScript 문법·Termux 셸 문법·workflow YAML 파싱·`git diff --check` 성공. GitHub runtime 결과는 새 PR CI에서 별도로 확인한다.
- 최초 실제 시험은 read-only rootfs에 `docker cp`할 수 없어 실패했다. 읽기 전용 입력/제어 volume을 별도 준비하는 구조로 수정한 뒤 동일 공격 시험을 통과했다. 독립 리뷰에서 찾은 취소/정리 문제도 재현 후 수정했다.

재현 명령:

```sh
node --test scripts/*.test.mjs
docker build --tag orchestrator-containment-fixture:local docker/worker
ORCHESTRATOR_TEST_IMAGE="$(docker image inspect orchestrator-containment-fixture:local --format '{{.Id}}')" node --test scripts/protected-worker.docker-test.mjs
```

공개 CI는 기존 비밀 없는 E2E job에서 전체 일반 검사와 같은 실제 Docker 공격 검사를 한 번 수행한다. 실제 게임, 계정 인증, 구독 CLI, 유료 API 또는 실제 artifact 업로드를 사용하지 않는다. Docker/이미지가 없으면 해당 시험은 성공으로 건너뛰지 않고 실패한다.

## 실제 실행은 계속 차단됨

`prepare-handoff`의 **상수 false**와 정책/무료 저장소 게이트를 유지했다. 새 경로를 실제 게임 작업으로 실행하거나 휴대폰에 배포하지 않았다. 기존 실패 작업/run은 재실행하지 않았다. 실제 `bundle.enc`의 GitHub artifact 업로드도 하지 않았다.

`docker/worker/Dockerfile`은 **격리 시험용 기반 이미지**다. 구독 CLI나 git을 설치하지 않으며 게임 개발에 바로 사용할 완성된 runtime이 아니다. staged workflow의 `ORCHESTRATOR_WORKER_IMAGE_ID`는 신뢰된 준비 과정에서 이미 적재된 immutable `sha256:<64 hex>` image ID를 요구한다. 자동 pull, 임의 태그 fallback, 최신 설치 스크립트 실행을 추가하지 않았다. 승인된 runtime의 공급·옵션·구독 정책을 검증하기 전에는 실제 실행이 불가능하다.

## 남은 위험과 다음 순서

1. **승인된 실제 runtime과 인증·CI 정책 확인**: 공식 문서로 Claude/Codex/Gemini 계열 구독 인증의 CI 사용·데이터 처리 허용 범위를 확인하고, 비용 없는 환경에서 CLI 옵션/인증을 검증한다. 유료 API·카드 연결·종량제 fallback 금지.
2. **네트워크 및 auth 전송 제한**: 현재 실제 공격 시험은 network=none이다. staged live 경로는 bridge를 지정하지만 공급자별 egress 제한·host gateway 차단을 검증하지 않았다. 그래서 live를 활성화하지 않는다. worker에 준 구독 인증은 worker가 읽을 수 있다.
3. **깨끗한 독립 검증 경계**: worker는 자기 작업 volume의 manifest/audit를 작성할 수 있다. 이번 변경은 host exporter/토큰/공개 artifact의 로컬 보호이며, 악성 worker의 검증 주장에 대한 attestation이 아니다. 별도 신뢰 검증을 설계해야 한다.
4. **자원·중단·진단 강화**: named volume의 host disk quota는 아직 없다. SIGKILL·Docker daemon 불능에서는 즉시 정리를 보장할 수 없다. 이때 handoff를 반환하지 않고 폐기 가능한 runner를 종료해야 한다. 기존 작업 재개/원자적 PR 게시, 제한된 비공개 진단 저장, 기존 게임 기준 실패 비교도 남아 있다.
5. **실제 운영 완주**: 무료 artifact 한도·보관/키 회전, 실제 구독 CLI, 실제 게임, Termux, Draft PR까지 검증한 다음에만 상수 false 제거를 검토한다. 이번 fixture 성공은 이 항목의 완료 증거가 아니다.

현재 위치: **Phase 1의 worker/exporter 로컬 격리 구현 및 실제 합성 공격 검증 완료. 실제 구독·게임 운영은 미완료이며 차단 유지.**
