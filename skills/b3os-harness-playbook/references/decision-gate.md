# harness 사전 게이트 — 결정 트리 (무분별 사용 방지)

harness(sub agent 병렬)를 켜기 전 이 트리를 통과한다. **하나라도 NO면 솔로.** 단순작업·단일파일·개념합성·요구 모호는 먼저 솔로 후보로 본다.

```
작업 받음
  │
  ├─ Q1. 독립 조각으로 분해 가능?
  │     NO → 솔로 (단일 에이전트)
  │     YES ↓
  ├─ Q2. 각 조각이 서로 다른 *실제 소스*를 읽는가?
  │     (코드 영역·파일 세트·외부 페이지 등 진짜 다른 입력)
  │     NO → 솔로  ← 개념 합성·단일 맥락 추론이면 여기서 걸림
  │     YES ↓
  ├─ Q3. 솔로 대비 이득 > 비용(토큰 5~30x)?
  │     빠른 지도만 필요 → 솔로 (80% 커버·20% 비용)
  │     누락 0·전수 audit 필요 → harness ↓
  └─ Q4. N·budget·verify 정해졌나?
        NO → 정하고 시작
        YES → harness 실행 (Workflow 툴 우선)
```

N은 목표가 아니라 cap(상한) 안에서 정한다. 기본은 2~3으로 시작하고, limited harness는 보통 6 이하(필요시 8), full harness는 `min(16, logical CPU core - 2)` 머신캡(절대 상한 16, host override 가능)을 넘지 않는다. manual runtime(OpenClaw/Hermes 등)은 `max_agents`, `budget`, `stop_rule`, `return_schema`가 모두 있어야 하며, 하나라도 없으면 harness 금지다. `max_agents` 미기재 지시는 fallback 6으로 해석하고 무캡 실행하지 않는다.

## ✅ harness가 이기는 작업 (파일럿 검증)
- 코드베이스 audit·전수 스캔 (예: "DB write 경로 전수 수집" — 솔로가 놓친 숨은 write를 harness가 포착)
- 다영역/다파일 검색, 대규모 마이그레이션, 다PR·다차원 리뷰
- 멀티소스 리서치 (각 agent가 다른 출처를 병렬로 읽음)

## ❌ harness가 지는 작업 (솔로가 더 정확·저렴)
- 개념 합성·아이디어 정리 (fan-out이 환각·노이즈만 늘림 — 파일럿서 실측)
- 단발 추론·짧은 판단
- 한 파일 섬세 수정·리팩터링 (맥락 분할이 오히려 해)
- 요구사항 모호 (먼저 명확화가 우선)

## 무분별 사용 안티패턴 (하지 말 것)
- "빠르니까 일단 4개 띄워" — 분해 안 되는 일에 fan-out (Q1·Q2 위반)
- 개념 질문에 harness — 환각·비용만 증가 (Q2 위반)
- 캡·budget·stop_rule·return_schema 없이 수동 subagent — 토큰 폭주 (파일럿서 50k 캡 2배)
- 종합·검증 생략하고 agent 출력 그대로 채택 — 중복·환각 오염
- 솔로로 5분이면 될 일에 harness — 오버헤드 > 이득 (Q3 위반)
