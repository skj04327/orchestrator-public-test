# AI 실행 기록 v1 — 독립 모듈

진행 중인 `task-intake.yml`을 수정하지 않기 위해 **별도 브랜치**에서 작업합니다. 아직 실운영 워크플로에 연결되지 않았습니다.

## 기록하는 것
- 작업 ID, 단계, 담당 AI(Claude/Codex/Gemini/시스템), 실행 시작 시각
- 실제 CLI에서 **확인된 경우에만** 모델 ID 및 추론 수준
- 실행 상태(시작/통과/실패/생략), 소요 시간(측정한 경우), 토큰 사용량(확인된 경우)
- 리뷰 판정(PASS/FAIL/UNKNOWN), 최종 PR 주소

## 절대 기록하지 않는 것
- 프롬프트 원문, 비공개 게임 소스, 모델 답변 전문, API 키, OAuth 토큰, 자세한 오류 로그
- 확인되지 않은 모델/추론 수준의 추정값: `null`로 남김

## 수집 흐름
1. `scripts/audit-ledger.mjs`의 `createAuditLedger(taskId)` 호출
2. 단계별로 `record({stage:'plan',actor:'claude',status:'started'})` 등을 추가
3. `snapshot({status:'passed'})`으로 구조화된 요약 생성
4. `writePrivateAuditReport(directory, report)`로 비공개 임시 위치에 JSON 저장
5. 비공개 게임 저장소의 별도 `orchestrator/audit-log` 브랜치에만 GitHub API로 저장하도록 후속 연동

GitHub Actions 공개 로그에는 `STATUS: plan started` 등의 **단계 요약**만 표시합니다. 각 작업 결과의 JSON 보고서와 모델 관련 메타데이터는 비공개 저장소에 보관합니다.

## 검증
`node --test scripts/audit-ledger.test.mjs`

## 향후 작업
- 실제 실행기·게시기에 audit ledger 연결
- 실패한 실행도 안전한 보고서를 남기기 위한 `if: always()` 수집 단계
- `ai report <task-id>` Termux 명령 추가
- CLI 모델 식별 결과와 추론 수준 명시 옵션을 검증해 `null` 필드 채우기
- 모델 변경·추가 설정을 버전별로 추적

**병합 전 확인:** 현재 진행 중인 작업이 끝난 뒤 실운영 워크플로와의 충돌 여부 확인. 자동 병합 금지.
