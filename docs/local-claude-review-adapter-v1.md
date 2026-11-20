# 로컬 Claude 독립 리뷰 어댑터 v1

PR #29(`feature/local-developer-input-v1`, `40091923`) 위의 개발 단위다. 여섯 단계 검사를 통과한 후보를 Claude에게 **도구 없이** 보여 주고, 제한된 형식의 답을 받아 기존 서명·검증 경계에 넘기는 신뢰된 로컬 호스트 코드다. 실제 모델 호출은 하지 않았고, 게시 권한(`publishAuthorized`)은 계속 `false`다. 기존 게임 브랜치·PR·게시기와 기존 검증 코드는 수정하지 않았다.

## 흐름

`scripts/local-claude-review.mjs`

1. `inspectLocalClaudeReviewScope()`가 `prepareLocalIndependentReview()`의 검증된 요청과 변경 파일을 받아 **승인 범위**를 만든다: 작업 ID, 실행 ID, 기준 스냅샷 지문, 후보 지문, 파일별 SHA-256. 사람이 이 범위를 보고 승인한다.
2. `runLocalClaudeReview({approvedScope, runner, signer, ...})`가 후보를 다시 준비해 승인 범위와 **정확히 일치**하는지 확인한다. 후보 바이트가 요청의 `candidateContentSha256`과 다르거나, 실행 ID·파일 목록·지문이 하나라도 다르면 Claude를 부르지 않는다.
3. 러너의 `preflight()`가 `claude auth status --json`으로 구독 로그인을 확인한다.
4. 작업 폴더에 `claude-review-claim.json`을 배타적으로(0600, O_EXCL) 만든다. 이 파일은 자동 삭제하지 않는다. 같은 작업의 두 번째 호출은 모델을 부르기 전에 `ALREADY_CLAIMED`로 끝난다.
5. Claude 호출 → 응답 파싱 → **별도 서명자**가 서명 → `submitLocalIndependentReview()`가 기존 방식으로 서명을 검증하고, 확정 직전 검사 보고서와 암호화 후보의 무결성을 다시 읽은 뒤 `independent-review.json`을 한 번만 기록한다. 어댑터는 이 재확인을 따로 구현하지 않고 기존 경계에 맡긴다(호출 도중 보고서나 암호문이 바뀌면 기록되지 않는 것을 시험했다).

서명자는 `signer({request, verdict, files:[{path,sha256}], message})`를 받아 서명 64바이트를 돌려준다. 파일 내용과 개인키는 어댑터 쪽에 없다. 어댑터는 개인키도 GitHub 토큰도 갖지 않고 자식 프로세스에도 넘기지 않는다.

## Claude로 나가는 데이터

프롬프트에는 고정 지시문, **실행 ID, 후보 지문, 변경 파일 경로·내용**만 들어간다(UTF-8이고 NUL이 없는 텍스트, 전체 512,000바이트 이하). 작업 ID, 작업 원문, 기준 파일, 기준 커밋, 리뷰 공개키 지문, 키, 토큰은 넣지 않는다. 변경 파일만으로는 기준과의 차이를 볼 수 없다는 한계가 있다. 기준 파일이나 작업 원문을 더 보내려면 승인 범위 스키마를 늘리는 별도 결정이 필요하다.

자식 프로세스는 매번 새로 만든 **빈 작업 디렉터리**에서 실행되고 끝나면 지운다. 환경 변수는 허용 목록만 넘긴다(`PATH`, `HOME`, 로케일·`TMPDIR`·`PREFIX`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, 프록시·CA 설정). `GITHUB_*`, `GH_TOKEN`, `ORCHESTRATOR_*`, SSH·클라우드 자격은 넘기지 않는다. 호스트 환경에 `ANTHROPIC_*`나 `CLAUDE_CODE_USE_*`가 하나라도 있으면(API 키·베이스 URL·프로필·Bedrock/Vertex/Foundry) 호출하지 않는다. 공식 문서상 `-p`에서는 API 키가 있으면 항상 그 키를 쓰기 때문이다.

## 응답 형식과 실패 처리

`--output-format json --json-schema`의 `structured_output`만 받는다. 자유 문장(`result`)은 받지 않는다. 정확한 필드(`schemaVersion`, `runId`, `candidateContentSha256`, `verdict`, `findings`)만 허용하고, 실행 ID와 후보 지문이 요청과 같아야 한다. 지적은 8개 이하, 보낸 파일 경로만, 요약 300자 이하·제어문자 없음. `pass`인데 `blocking` 지적이 있으면 거부한다.

| 상황 | 결과 |
|---|---|
| 형식 오류, 출력 256KiB 초과, `is_error`≠false | `FORMAT` — 기록 없음 |
| 실행 ID·후보 지문 불일치 | `TARGET_MISMATCH` — 기록 없음 |
| 타임아웃(기본 240초) | `TIMEOUT` — 프로세스 그룹 종료, 기록 없음 |
| 취소(AbortSignal) | `CANCELLED` — 프로세스 그룹 종료, 기록 없음 |
| 종료 코드≠0, 미설치, 구독 로그인 아님, Actions 안 | `UNAVAILABLE` — 기록 없음 |
| 승인 범위 불일치, 서명자·러너 누락 | `NOT_APPROVED` — claim 전에 중단 |

**오류는 `pass`도 `fail`도 아니다.** `fail`은 서명되면 그 후보에서 확정되는 기록이므로 오류를 `fail`로 바꿔 쓰지 않는다. claim 뒤의 실패(타임아웃·형식 오류 등)는 이미 사용량이 쓰였을 수 있으므로 자동 재시도하지 않는다. 운영자가 상태를 확인한 뒤 `claude-review-claim.json`을 직접 지워야 다시 시도할 수 있다.

## 실제 CLI 확인 (`claude 2.1.329`)

공식 문서 출처와 관측은 [증거 JSON](evidence/claude-cli-observation-2026-11-20.json)에 있다. 세 단계를 구분한다.

| 옵션 | 공식 문서 | `--help` 표시 | 실제 옵션 수락(파서) | 실제 동작 확인 |
|---|---|---|---|---|
| `-p`, `--output-format json` | 있음 | 표시 | 잘못된 값 거부 확인 | 아니오 |
| `--json-schema` | 있음 | 표시 | 잘못된 스키마를 로컬에서 거부 | 아니오 |
| `--permission-prompts none` | 있음 | 표시 | 잘못된 값 거부 확인 | 아니오 |
| `--tools ""`, `--safe-mode`, `--strict-mcp-config`, `--disable-slash-commands`, `--no-session-persistence` | 있음 | 표시 | unknown-option 오류 없음 | 아니오 |
| `--max-turns` | 있음 | **표시 안 됨** | unknown-option 오류 없음 | 아니오 |

`--help`는 존재하지 않는 옵션에도 exit 0이므로 옵션 수락의 증거가 아니다(`--totally-bogus-flag --help`로 확인). 옵션 수락은 자격 증명을 제거하고 `ANTHROPIC_BASE_URL`을 루프백으로 돌린 환경에서 잘못된 값 오류와 unknown-option 오류를 구분해 확인했다. **도구가 실제로 꺼지는지, `--safe-mode`가 사용자 설정(`apiKeyHelper` 등)을 무시하는지, 3턴이면 스키마 답이 나오는지, 표준 입력이 프롬프트로 읽히는지는 모델을 부르지 않고는 확인할 수 없어 미확인이다.**

`--bare`는 쓰지 않는다. 공식 문서상 OAuth·키체인을 읽지 않고 API 키만 인정하므로 구독 로그인과 맞지 않는다. `--max-budget-usd`도 쓰지 않는다. API 지출 상한이며 구독 사용량 보호를 확인하지 못했다.

## 구독 인증과 추가 과금

- 공식 문서의 우선순위상 구독 OAuth(`/login`)는 가장 낮고, `CLAUDE_CODE_OAUTH_TOKEN`(`claude setup-token`)도 구독 토큰이다. 위 환경 변수 차단으로 API 키·클라우드 경로가 끼어들 수 없게 한다.
- `claude auth status --json`은 로컬 조회이며 `loggedIn`, `authMethod`, `apiProvider`를 낸다. 어댑터는 `loggedIn: true`, `apiProvider: firstParty`, `authMethod`가 `claude.ai` 또는 `oauth_token`일 때만 통과시킨다. 이번에 관측한 값은 클라우드 개발 컨테이너의 `oauth_token`뿐이다. Termux의 `/login` 세션에서 `claude.ai`가 나오는지는 미관측이다.
- 추가 사용량(extra usage) 설정은 계정 설정이어서 CLI로 확인할 수 없다. 읽은 공식 문서에도 확인·차단 방법이 없었다. 그래서 `createClaudeCliRunner`는 운영자가 `{subscriptionLoginOnly:true, extraUsageDisabled:true}`를 명시해야만 만들어진다. 이것은 확인이 아니라 **운영자의 선언**이다.
- 법적 범위: 공식 문서는 OAuth를 구독 구매자의 일반적 사용용으로, Agent SDK로 제품을 만드는 개발자에게는 API 키를 안내한다. 계정 소유자 본인의 로컬 스크립트 사용이 약관 안인지는 이 자료로 결정하지 못했다. 이 조사로 허용된다고 결론 내리지 않는다.

위 세 조건(구독 인증·추가 과금 차단·전송 범위)이 모두 확인되지 않았으므로 **합성 스모크 시험은 실행하지 않았다.**

## 시험

`scripts/local-claude-review.test.mjs`는 기존 리뷰 시험과 같은 합성 후보 위에서 리뷰 준비부터 기존 서명 검증·기록까지 간다. 모의 Claude는 실제 자식 프로세스(Node 스크립트)여서 인자, 환경 변수 이름, 작업 디렉터리, 표준 입력을 실제로 관측한다.

- 승인 범위 변조(실행 ID·공급자·지문·파일 추가/삭제/다이제스트 변경·여분 필드)와 후보 바이트 변조 거부, 프롬프트에 작업 ID·기준 커밋·키 문자열 없음.
- 응답 파서: 형식 오류 25종(`pass`+`blocking` 모순 포함), 대상 불일치 2종.
- 환경 변수 차단·옵션 고정, 구독 로그인 판정, 타임아웃·취소·실패 종료·출력 초과, 타임아웃·취소된 자식의 실제 종료 확인.
- 통과·거부 경로, 오류 후 기록 없음과 claim 유지(재시도 시 모델 미호출), 서명 오류·검사 보고서 변경·선행 판정, Actions 안 차단.
- 변이 시험: 대상 대조, `pass`+`blocking` 모순 검사, 프롬프트의 작업 ID 유출, 환경 변수 허용 목록, 결제 변수 차단, claim, API 키 인증 수락, 자유 문장 수락, 승인 범위 대조를 하나씩 바꾸면 시험이 실패한다. 타임아웃 시 자식 종료를 제거하면 시험이 멈춘다(자식이 남아 종료되지 않음). 처음에 넣었던 호출 후 재확인은 제거해도 시험이 통과했고, 기존 제출 경계가 같은 확인을 하므로 중복 코드로 보고 삭제했다.

## 미확인 운영 조건

- 실제 모델 호출 전체: 구조화 출력의 실제 형태, `--tools ""`·`--safe-mode`의 실제 효과, 표준 입력 프롬프트, 3턴 충분성, 실제 지연·사용량.
- Termux 설치본의 Claude CLI 버전·옵션·`auth status` 값. 이번 관측은 Linux 클라우드 컨테이너다.
- 계정의 추가 사용량 설정과 구독 한도 영향, 약관 범위.
- 리뷰 키의 운영 배치와 실제 서명자 프로세스 분리(이 PR의 서명자는 주입 함수다).
- 변경 파일만 보는 리뷰의 판정 품질.

## Codex가 이어받을 연결 지점

- 작업기 쪽은 `prepareLocalIndependentReview()` 결과를 승인 UI에 넘기는 `inspectLocalClaudeReviewScope()`와 `runLocalClaudeReview()`만 호출하면 된다. 입력은 기존 `{id,stateRoot,privateKey,diskSnapshot,reviewerPublicKey,signal}`에 `approvedScope`, `runner`, `signer`가 더해진다.
- 중복 실행 방지는 작업 단위 claim(`claude-review-claim.json`)이 맡는다. 이 파일이 있어도 기존 검사 상태·리뷰 조회·판정 제출이 정상 동작함은 시험했다. Codex 작업기가 같은 작업 폴더에 쓰는 파일과 이름이 겹치는지는 통합 시 확인해야 한다.
- `runner`는 `{preflight, run}` 객체이면 되므로 `createClaudeCliRunner()` 대신 다른 로컬 러너로 바꿀 수 있다. 실제 호출 전 운영자 선언과 승인 범위가 필요하다는 규칙은 이 함수 밖으로 옮기지 않는다.
