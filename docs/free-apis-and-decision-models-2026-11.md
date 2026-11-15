# 무과금 AI 라우팅 및 Jev 계열 의사결정 모델 조사 (2026-11-15)

목표: 신규 결제 없이 `skj04327/orchestrator-public-test`에서 AI 역할 배정을 확장한다. **외부 유료 API 호출은 구현하지 않는다.**

## 1. 결정 모델과 비용

| 후보 | 형태 | 무료 접근 여부 | 고려사항 |
| --- | --- | --- | --- |
| TypeSafe AI Jev | 호스팅 결정 API | 아니오, 신규 무료 체험 크레딧 없음 | $0.042 / 100만 입력 토큰 |
| Laya (Convai Innovations) | 공개 가중치, Apache-2.0 | 가중치 무료 | 421M 및 다국어 322M; 자체 실행 컴퓨팅 필요 |
| GLiNER2.5-Decide (Fastino) | 공개 가중치, Apache-2.0 | 가중치 무료 | 340M급 구조화 선택과 제약 기반 판정, CPU 추론 가능 |
| Liquid AI d1-3B | 공개 가중치 | 가중치 무료 | Liquid API는 신규 계정 $2 체험 크레딧, 소진 후 유료 |
| Nimble (Bespoke Labs) | 공개 가중치 | 가중치 무료 | 로컬 모델 실행 자원과 라이선스 확인 필요 |
| Kev-4B | 공개 가중치 | 가중치 무료, OpenRouter 호스팅은 유료 | $0.042 / 100만 입력 토큰 |
| Respan Span-01 Lite | 호스팅 API | 무료 경로 존재 | 무료 모델/요청 한도 및 장기 제공 보장 없음; 주로 행동 스코어링 |
| Solar Decide / d1-ultra / GLiDE / pplx-decider | 호스팅 API | 호스팅 유료 | 성능 대비 모델별 요금·속도 점검 필요 |

출처: https://help.typesafe.ai/articles/5187202169-how-much-does-jev-cost
- https://decisionmodels.ai/
- https://systemonemodels.org/guides/jev-alternatives/
- https://fastino.ai/blog/gliner-2-5-decide-open-weight-decision-model
- https://www.liquid.ai/blog/d1-open
- https://www.liquid.ai/faq
- https://www.respan.ai/models/span-01-lite
- https://openrouter.ai/jaredpalmer/kev-4b/providers

**선택:** 지금은 별도의 제어 모델 호출을 하지 않고 코드 기반 라우터(0원)부터 검증한다. 공개 가중치의 무료 호스팅이 상시 제공되는 것은 아니며, 무료 GitHub Actions CPU에서 모든 모델을 현실적으로 돌릴 수 있는 것은 아니다.

## 2. 다른 무료 API 후보

| 제공자 | 무료 조건 | 비용 사고 방지 |
| --- | --- | --- |
| OpenRouter | `:free` 모델은 모델 비용 $0, 기본 50 requests/day·20 requests/min | `:free` 또는 명시적 $0 모델만 허용, 자동 유료 fallback 금지 |
| Cloudflare Workers AI | 10,000 Neurons/day 무료; 무료 플랜 초과 시 차단 | 일부 고급 모델은 유료 플랜 필수, 사전 허용목록 필수 |
| Google Gemini Developer API | 일부 모델만 무료, 무료 티어는 요청/분·토큰/분·일 한도 | API 키 별도; 무료 티어의 데이터 활용 정책 확인 |
| Groq | 무료 개발자 한도, 모델별 RPM/TPM/RPD | 제공자 정책 확인, 유료 전환 및 카드 연결 금지 |
| Cerebras | 무료 개발자 이용 가능 여부·모델별 한도 재검증 필요 | 가격·프로젝트 구독 상태 검증 후만 연결 |
| Respan Span-01 Lite | 무료로 제공되는 라우팅 경로 존재 | 주간 한도 및 정책변경 주의 |
| GitHub Models | **2026-07-30 서비스 종료** | 더는 무료 제공처로 계산하지 않기 |

공식 자료:
- https://openrouter.ai/collections/free-models/
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://ai.google.dev/gemini-api/docs/pricing
- https://ai.google.dev/gemini-api/docs/rate-limits
- https://console.groq.com/docs/rate-limits
- https://docs.github.com/en/github-models

### FreeLLMAPI 적용 판단

https://github.com/valorisa/FreeLLMAPI 는 여러 무료 티어를 묶는 오픈소스 라우터. 광고의 수십억 tokens/month는 **개별 공급자 무료 한도를 합산한 이론치**이고, SLA나 개인별 실보장량이 아니다. 문서에 종료된 GitHub Models가 공급자로 포함되어 있어 실사용 직전 카탈로그 최신성을 검증해야 한다. 호스팅 사이트의 유료 서비스와 오픈소스 자체 설치를 구분한다.

현재 무료 AI 구독 CLI 3종의 인증을 FreeLLMAPI API 키로 자동 변환할 수 있다고 가정하면 안 된다. 구독 인증과 API 키는 별개이다.

## 3. 제안 아키텍처

- `scripts/dynamic-router.mjs`: 정규식으로 작업군/위험 수준을 분류, 안전한 AI 역할 선정
- 기본: Claude 컨트롤타워 → Codex 구현 → Gemini 독립 리뷰
- 화면/문서/테스트: Gemini 컨트롤타워 → Codex 구현 → Claude 독립 리뷰
- 인증/보안 관련: Claude 컨트롤타워 + 독립 리뷰, 기존 테스트 완화 불가
- `stable` 모드: 기존 배정 고정
- `manual` 모드: 컨트롤타워를 CLI 제공자(Claude/Gemini/Codex) 중 선택
- 확인되지 않은 실제 모델 ID 및 추론 수준: `null`로 기록
- 결제 API 연동 금지, 자동 PR 병합 금지, 사용자 승인 필수
- 기본 단위 검증은 `node --test scripts/dynamic-router.test.mjs scripts/agent-backends.test.mjs`

이 정책은 실험 단계. 새 모델이 객관적으로 기존 3종보다 더 정확하게 역할을 배정한다는 실증은 아직 없다.

## 4. 운영 주의사항

공개 GitHub Actions는 로그와 작업 이름이 공개된다. 비공개 게임 작업 프롬프트, 원본 소스, 토큰, 인증 파일 내용을 공개 로그로 출력하지 않는다. GitHub Actions 워크플로는 신뢰된 브랜치에서만 수동 실행시키고, 개인용 쓰기 토큰을 모델·테스트를 실행하는 단계와 분리하는 구조를 우선한다.

작업이 완료된 후에만 신규 라우터 PR을 병합한다. 진행 중인 실행을 변경하거나 재실행하지 않는다.
