# Harness 파일럿 테스트 보고서

**일시** 2026-06-07 (일) · **owner** maintainer · **승인** the team lead · **범위** limited harness (sub agent 2~5개) A/B 검증
**참여** maintainer(코드 audit) · agent A(코드 audit·독립) · agent B(개념 리서치) — claude_channel 3명

---

## 1. 한 줄 결론

> **harness(sub agent 병렬)는 "공짜 품질"이 아니다.** 여러 *실제 소스*(코드 영역·파일·외부)를 나눠 읽어야 하는 작업에선 솔로가 못 보는 걸 잡아 **이긴다**. 반대로 개념 합성·단일 맥락 추론에선 **노이즈·환각·비용만 늘고 진다.** → **작업 유형으로 켠다. 켤 땐 캡·스키마·종합검증을 반드시 박는다.**

---

## 2. A/B 수치 (모드 비교)

| 참여자 | 작업 유형 | 모드 | 시간 | 토큰(추정) | 결과 품질 |
|---|---|---|---|---|---|
| **agent A** | 코드 audit (team.db write 경로) | 솔로 | 58s | ~7k | 28 fn, 빠르지만 **숨은 write 누락** |
| **agent A** | 〃 | harness(4) | 92s | ~35k (**5x**) | 33+5+호출그래프, **누락 0** |
| **maintainer** | 코드 audit (독립 baseline) | 솔로(grep) | ~3s | 극소 | 후보 12파일, **헬퍼 경유 write 못 봄** |
| **maintainer** | 〃 | harness(4) | 174s | 높음 | db/bus/lib/workers 의미맵, **숨은 write 포착** |
| **agent B** | 개념 리서치 (workflow vs 수동) | 솔로 | 35s | ~3k | 3관점 균일·근거기반·**환각 0** |
| **agent B** | 〃 | harness(4) | **7m36s** | **~95k (캡 2배 초과)** | 분량↑ but **노이즈·환각↑**, 값어치 marginal |

**시간(초)** — 초록=솔로, 주황=harness

<svg viewBox="0 0 400 165" role="img" aria-label="시간 비교"><g font-size="11" fill="#9aa7b4">
<text x="0" y="20">agent A 솔로</text><rect x="108" y="10" width="31.8" height="12" fill="#22c55e" rx="2"/><text x="144" y="20" fill="#e6edf3">58s</text>
<text x="0" y="38">agent A harness</text><rect x="108" y="28" width="50.4" height="12" fill="#f97316" rx="2"/><text x="163" y="38" fill="#e6edf3">92s</text>
<text x="0" y="62">maintainer 솔로</text><rect x="108" y="52" width="1.6" height="12" fill="#22c55e" rx="2"/><text x="114" y="62" fill="#e6edf3">~3s</text>
<text x="0" y="80">maintainer harness</text><rect x="108" y="70" width="95.4" height="12" fill="#f97316" rx="2"/><text x="208" y="80" fill="#e6edf3">174s</text>
<text x="0" y="104">agent B 솔로</text><rect x="108" y="94" width="19.2" height="12" fill="#22c55e" rx="2"/><text x="132" y="104" fill="#e6edf3">35s</text>
<text x="0" y="122">agent B harness</text><rect x="108" y="112" width="250" height="12" fill="#ef4444" rx="2"/><text x="108" y="140" fill="#ef4444">7m36s · 캡 초과·재실행</text>
</g></svg>

**토큰(k, 추정)** — 초록=솔로, 주황=harness

<svg viewBox="0 0 400 110" role="img" aria-label="토큰 비교"><g font-size="11" fill="#9aa7b4">
<text x="0" y="20">agent A 솔로</text><rect x="108" y="10" width="18.4" height="12" fill="#22c55e" rx="2"/><text x="131" y="20" fill="#e6edf3">~7k</text>
<text x="0" y="38">agent A harness</text><rect x="108" y="28" width="92.1" height="12" fill="#f97316" rx="2"/><text x="205" y="38" fill="#e6edf3">~35k (5x)</text>
<text x="0" y="62">agent B 솔로</text><rect x="108" y="52" width="7.9" height="12" fill="#22c55e" rx="2"/><text x="120" y="62" fill="#e6edf3">~3k</text>
<text x="0" y="80">agent B harness</text><rect x="108" y="70" width="250" height="12" fill="#ef4444" rx="2"/><text x="108" y="98" fill="#ef4444">~95k · 50k 캡 2배</text>
</g></svg>

*maintainer 런은 토큰 정밀 미측정(시간·완성도 위주). 토큰 모두 추정치.*

---

## 3. 작업 유형별 결론 (핵심)

### ✅ harness가 이기는 곳 — "병렬 실소스 커버"
- 코드베이스 audit·전수 스캔, 다파일/다영역 검색, 마이그레이션, 다PR 리뷰
- **근거**: agent A·maintainer 둘 다 솔로가 놓친 **숨은 write**를 harness가 포착.
  - `massWakeBackfill` — '마이그레이션'에 숨은 런타임 데이터 UPDATE (audit상 치명적)
  - `searchQueries` 재구축 오케스트레이터, worker/route→helper **호출 그래프**
- 비용: 토큰 ~5x, 시간 ~1.5x (병렬이라 wall-clock은 선형 증가 아님)

### ❌ harness가 지는 곳 — "개념 합성·단일 맥락"
- 개념 리서치, 단발 추론, 한 파일 섬세 수정, 요구 모호
- **근거**(agent B): fan-out이 커버리지를 자동 보장 안 함(agent 1개가 엉뚱한 컨텍스트 물고 산출 0→재실행). **환각**(근거없는 정밀수치 '40~60% 절감' 등) 다수. 솔로는 추측을 추측이라 표시, 환각 0.

### ⚠️ 공통 교훈 (3명 모두)
1. **종합·dedup·검증은 owner 필수** — 병렬 agent는 경계에서 중복 카운트 + 환각. 종합자가 정규화·필터링 안 하면 결과 오염.
2. **캡·스키마 없으면 폭주** — agent B 수동 harness가 50k 캡 2배(95k) 초과 + 포맷 이탈. **실제 Workflow 툴(budget 하드캡 + schema 강제)로 돌렸으면 둘 다 차단**됐을 것 → A/B가 곧 "수동 말고 Workflow 툴" 결론을 자기입증.

---

## 4. 우리팀 적용안 (the team lead 요청)

**기본값 = 솔로.** 아래 조건일 때만 harness, 그리고 이렇게 켠다:

| 항목 | 권고 |
|---|---|
| **언제 켜나** | 작업이 분해 가능 **AND** 각 agent가 *서로 다른 실제 소스*를 읽을 때 (audit·다영역 검색·마이그레이션·다PR 리뷰) |
| **언제 끄나** | 개념 합성·단발 추론·한 파일 섬세 수정·요구 모호 → 솔로 |
| **어떻게** | 수동 subagent보다 **네이티브 Workflow 툴 우선** (budget 하드캡 + schema + /workflows 관측). 가벼우면 인라인 Agent 2~4개 |
| **항상** | owner가 **종합·dedup·검증** 패스 1회. 카드에 `harness·subagents(N)·budget·scope·verify` 명시 |
| **N** | 2~5 (파일럿 검증치). 시작은 2~3 권장 |
| **비용 게이트** | 큰 fan-out·full workflow는 실행 전 the team lead 고지 + stop_rule |

→ 이는 2026-06-07 TEAM-OS §10에 반영한 doctrine을 **파일럿으로 검증·정련**한 것. 추가 정련: *"limited harness = 병렬 실소스 커버 전용, Workflow 툴(캡+스키마)로."*

---

## 5. 운영 메모
- 캡 준수: agent A(4 agent, ~35k, <10분) ✓ / agent B(4 agent, 95k **초과**, 7m36s) — **하드 budget 캡 부재가 원인** → Workflow 툴 도입 근거.
- 파일럿 자체가 **2명 팀원 핸드오프(ack→실행→directed 회신)** 가 정상 작동함을 확인 (bus·ownership 검증 부수효과).

*소스: 이 MD. 렌더: harness-pilot-report.html (아이폰 반응형 HTML+SVG).*
