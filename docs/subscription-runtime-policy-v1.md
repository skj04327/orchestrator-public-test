# Phase 1 — 구독 CLI 정책 게이트와 무인증 실행 진단

PR #10 `a8f7e98b48b9b672e16c5190ac8e094453e2ad08` 위의 다음 개발 단위다. 기존 branch/PR/main/게임 코드를 변경하거나 병합하지 않는다.

## 가장 중요한 조사 결과

공식 Codex [Non-interactive mode](https://developers.openai.com/codex/noninteractive)의 “Use ChatGPT-managed auth in CI/CD (advanced)”는 **“Do not use this workflow for public or open-source repositories.”**라고 명시한다. 조회된 문서는 `https://learn.chatgpt.com/docs/non-interactive-mode`로 redirect됐다. 이는 현재 공개 `orchestrator-public-test`에서 ChatGPT 계정 인증을 사용하는 CI 설계를 그대로 활성화하지 말아야 할 근거다. 비공개 게임 코드를 가져온다는 사실만으로 실행 workflow 저장소가 비공개로 바뀌지는 않는다. 이 결론을 모든 CLI 사용에 대한 법률적 금지로 확대하지 않는다.

- Claude 공식 [action setup](https://github.com/anthropics/claude-code-action/blob/main/docs/setup.md)은 Pro/Max 사용자의 `claude setup-token` OAuth 경로를 문서화한다. 반면 이 오케스트레이터의 계정별 추가 사용량 설정·전송 범위·임의 runtime 전체가 승인됐다는 증거는 아니다. `code.claude.com`의 GitHub Actions/auth/legal 페이지는 HTTP 403이어서 본문을 읽었다고 주장하지 않는다.
- 공식 [Gemini CLI 인증 문서](https://geminicli.com/docs/get-started/authentication/)는 Google AI Pro/Ultra 계정 로그인 및 저장된 인증을 쓰는 headless 실행을 설명한다. 공식 GitHub Action은 별도의 API key/WIF 경로도 문서화한다. 새 키·카드·유료 fallback을 연결하지 않았다.
- **Antigravity `agy`와 Google Gemini CLI `gemini`는 별도 도구다.** [공식 agy 설치 스크립트](https://antigravity.google/cli/install.sh)와 release manifest는 실제 존재한다. 다만 Google AI Pro 구독 OAuth를 이 도구의 CI에서 재사용하는 허용 범위는 이번 자료로 확인하지 못했다. Gemini 문서의 설명을 agy에 그대로 적용하지 않는다.

출처 URL·조회 시각·본문 hash 또는 GitHub blob SHA·짧은 인용은 [정책 근거 JSON](evidence/subscription-policy-2026-11-16.json)에 기록했다. Firecrawl은 유료 조회 가능성이 있어 사용하지 않았으며 공개 공식 HTTP/GitHub 자료만 읽었다.

## 실제 구현

`subscription-policy.mjs`는 인증정보 없이 현재 CI 실행 준비 상태를 판단한다. 공개 Codex 계정 인증, 미확인 agy/Gemini 구독 CI 범위, Claude runtime 범위, private CI 인증 갱신·보관 미검증을 서로 다른 고정 reason code로 반환한다. 현재 검증된 live 조합은 없어 전부 fail closed다. 이 모듈은 범용 허용 정책 엔진을 완성한 것이 아니다.

- workflow의 **무비밀 `subscription-policy` job → prepare-handoff** 필수 의존성을 추가했다. 기존 상수 false도 유지한다. approval/free-storage 변수가 문서상 제한이나 근거 부재를 덮어쓰지 못한다.
- 실제 host 진입점도 **credential decode와 Docker 호출 전에** 같은 검사를 수행한다. 현재 공개 저장소 이름은 잘못된 `visibility=private` 입력으로 우회할 수 없다. 알 수 없는 저장소 상태·공급자도 거부한다.
- 거부 시 Docker 호출과 artifact-ready 출력이 전혀 없는지를 합성 인증정보로 시험한다. 새 API 키·OAuth·계정 설정·GitHub Secrets 값은 만들거나 변경하지 않았다.

## 실제 CLI 관측

`cli-runtime-probe.mjs`는 고정된 version/help 명령만 허용한다. immutable base image, network=none, 비root, read-only rootfs/공개 패키지 volume, capability 제거, no-new-privileges, 메모리·PID·CPU·출력·30초 timeout을 적용한다. SIGINT/SIGTERM을 취소 신호로 전달하고 취소되지 않은 별도 요청으로 컨테이너를 제거한다. 임의 prompt나 추가 CLI 인자를 받지 않는다.

| 도구 | 실제 출력 버전 | 확인 내용 |
|---|---|---|
| Codex | `codex-cli 0.169.0` | exec help의 sandbox/image/output-last-message |
| Claude Code | `2.1.325 (Claude Code)` | output-format/allowedTools/MCP 옵션; `--max-turns 1 --help` 파싱 성공 |
| Antigravity | `1.5.9` | `-p`/print/output-format/sandbox; help가 stderr로 출력됨 |
| Gemini CLI | `0.68.0` | prompt/output-format/sandbox |

Claude 기본 help에는 max-turns가 표시되지 않았다. JSON의 `flags`는 **help에 나타난 여부**이고, `optionParsingVerified`는 추가 고정 명령 파싱의 성공 여부다. 표시되지 않는 옵션을 미지원이라고 단정하지 않는다. CLI 버전은 모델 ID가 아니다. 인증·모델 호출은 하지 않았고 modelId/tokenUsage/cost는 null, authenticated/inferenceAttempted/subscriptionCiApproved는 false다.

[실제 관측 JSON](evidence/cli-version-help-2026-11-16.json)에 시각, 이미지 ID, 패키지 integrity, 공식 agy release SHA-512, 각 결과를 기록했다. Codex/Claude/Gemini는 고정 버전 npm 공개 배포물과 native optional dependency를 받았다. lifecycle script는 실행하지 않았다. Claude는 placeholder 대신 받은 공식 Linux native 바이너리를 직접 선택했다. agy는 공식 manifest SHA-512를 검증했다. 공개 패키지 volume 전체를 probe가 별도로 hash 검증한 것은 아니므로 `contentDigestVerified=false`로 남긴다. Base image ID만으로 mount된 CLI 파일 전체를 암호학적으로 식별한다고 주장하지 않는다.

## 이미지·환경의 실제 한계

통합 진단 이미지 빌드는 환경 CA 신뢰 문제와 7.9GB 디스크 상한으로 실패했다. TLS 검증을 끄지 않았고 신뢰 CA 묶음을 명시한 host에서 익명 다운로드한 뒤, 도구별 임시 공개 패키지 volume으로 실제 version/help를 검사했다. 이 작업의 중복 context/cache만 정리했다. **통합 production 이미지의 성공을 주장하지 않는다.** `docker/cli-probe/Dockerfile`은 Linux amd64 진단용 조립 recipe이며 최종 조립본은 검증되지 않았다. Linux 관측을 Android/Termux 설치 검증으로 확대하지 않는다.

이미 적재된 진단 이미지에 CLI가 있으면 다음 명령으로 검사할 수 있다. 공개 패키지를 별도 준비한 경우 `ORCHESTRATOR_PUBLIC_CLI_VOLUME=orch-cli-public-...`을 지정한다. volume에는 공개 배포 파일만 넣고 host home/auth/game을 넣지 않는다. 부분 검사 결과는 `allProvidersChecked=false`로 구분한다.

```sh
ORCHESTRATOR_PROBE_IMAGE_ID=sha256:... ORCHESTRATOR_PROBE_CLIS=agy node scripts/cli-runtime-probe.mjs
node --test scripts/*.test.mjs
```

CI는 익명 배포물 수백 MB를 매번 다운로드하지 않고 정책/진단 계약 검사와 기존 합성 Docker 공격 회귀만 실행한다. version/help 관측을 CI에서 다시 실행했다고 혼동하지 않는다.

2026-11-19 개발 호스트의 설치된 `codex-cli 0.167.0-alpha.4`에서 `codex exec --help`로 표준 입력 안내, `--output-schema`, `--output-last-message`, `--sandbox` 옵션의 표시 여부를 확인했다. 이 관찰은 실제 스키마 적용, 사용자 구독 인증, 비공개 자료 전송, Termux 설치 검증을 포함하지 않는다.

## 검증 및 다음 우선순위

일반 검사 **69/69**, 기존 실제 Docker 공격 검사 **3/3**, JavaScript·셸·YAML·diff 검사가 성공했다. 실제 version/help 4종과 Claude 추가 옵션 파싱도 성공했다. 독립 리뷰의 probe 취소 시 정리 누락 지적을 반영해 취소 전파와 uncancelled 제거를 구현했고, stderr help/취소 회귀 검사도 통과했다. 실제 구독·모델·게임·Termux·GitHub artifact 게시 시험은 미실시다.

다음은 **비공개 신뢰 실행 경로와 무료 한도 확인**이다. 공개 Actions는 비밀 없는 검사에 한정하고, Codex 계정 인증을 실행하는 위치를 공식 지침에 맞게 재설계해야 한다. 기존 비공개 저장소 기반 CI를 선택한다면 무료 잔여 한도와 과금 중단 보장을 먼저 검증한다. 로컬 실행을 선택한다면 실제 Termux 지원·인증 보관·실행 격리를 검증한다. 새 저장소/서버/유료 API를 자동 생성하지 않는다. agy의 구독 CI 범위, 공급자별 네트워크 제한, auth 갱신, 독립 검증 경계도 미완료이며 live 차단을 유지한다.
