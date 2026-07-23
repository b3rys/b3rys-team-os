# 팀 루프 워크플로우 — Team Self-Loop Governance

> Status: Bill+Codex 1차 설계 (2026-06-12), GD 확인 대기
> Owner: Bill (메인 PM) · Codex (co-PM) · 큰 그림/방향 = GD (GD's Step으로 빌·코덱스 보조)
> GD 비전: GD가 없어도 빌(메인 PM)+코덱스가 **정해진 시스템 안에서** 팀이 b3os를 계속 advance하게. 공백을 생산적으로 채우되 **폭주 절대 방지.**

## 0. 핵심 정의 (가장 중요)

**이건 '공백을 작업 생산으로 채우는 자동 실행 루프'가 아니다.** **다음 작업을 더 안전하고 좋게 만들기 위한 '제한된 점검 루프'다.** (Codex reframe)

- **북극성(방향)** = **b3os가 나아가야 할 방향** (GD가 큰 그림으로 계속 제시). 상용화는 그 방향의 일부지 전부 아님.
- **루프의 대상(working pool)** = 그 방향을 향한 **현재의 구체적 일감 = 상용화 과제(B3OS_ROADMAP)부터.** 방향이 넓어지면 대상도 따라 넓어진다.
- 목적 = **산출물 생산이 아니라 방향을 향한 제안·검토·개선**: 리뷰·정리·리스크 발견·다음 제안까지. **실행 착수는 별도 GD 승인 또는 기존 명확 지시가 있을 때만.**
- **no-op이 정상 상태**: 방향에 기여할 제안이 없으면 안 한다. (폭주 방지의 핵심 — 일을 만들어내려 하지 않음)

### 0.1 계보 (왜 지금 루프가 가능한가 — GD 통찰 2026-06-12)

오늘까지 쌓은 것이 다 이 루프를 **안전하게 돌리기 위한 토대**였다. 루프는 새 발명이 아니라 그 culmination:
- **팀 커뮤니케이션 + 협업룰(V1.0)** → 루프의 Proposal 파이프라인이 그 위에서 돎(봉투·ack·owner 라우팅).
- **conti-guard** → 루프 산출물(제안/일)이 조용히 안 사라지게.
- **폭주 방지(핵심룰 멈춤장치·confirm-first)** → 루프가 '실행'으로 안 넘어가게 하는 가드레일의 뿌리. (루프 원칙 "실행X·제안만"이 곧 이것)
- **스킬 거버넌스(proposal gate)** → 루프 제안의 검토 게이트로 일반화.
> 토대 없이 루프부터 만들었으면 forin 같은 폭주가 시스템 전체로 번졌을 것. 토대가 있어 지금 안전.

### 0.2 진화 단계 (GD 통찰 2026-06-12 — 한 번에 X, 단계적으로)

이건 완성품이 아니라 **계속 단계를 늘려가는 진화**다. 각 단계가 팀의 **협업 능력 천장**을 올리고, 천장이 오르면 서로 더 잘 맡겨 **일의 범위가 커진다.**

```
토대(컴·협업·conti·폭주방지) → 루프(제안 생성+검토) → 팀원 피드백 장치 → 협업능력↑ → 더 큰·유기적 일을 끝까지·고완성도 → (다음 단계)
```

- **다음 단계 후보 = 팀원 피드백 장치.** Proposal의 2차 동료 리뷰가 그 씨앗. 확장하면 서로의 **일·결과물·협업 자체에 피드백** → 협업능력 compound(누적 성장) → 일이 더 유기적·끝까지·고완성도로. = 팀의 **협업 학습 루프.**
- 원칙: 한 단계씩, 가드레일 안에서, 협업 능력을 키우며 안전하게 범위 확대. 방향은 GD(큰 그림), 빌·코덱스는 GD's Step으로 단계를 같이 밟는다.

## 1. 활동 allowlist (이 메뉴 밖은 안 함)

각 사이클에 아래 중 '있으면' 한다. 없으면 no-op.
1. **리뷰/정리**: 칸반 위생(미닫힘·stale), SHARED/문서 정리(초안 수준), 미결 추적.
2. **리스크 발견**: 운영 이상·미검증 항목·반복 실패 패턴 식별 → 제안.
3. **부족분 리서치**: 정해진 주제의 1차 조사(보고서 X, 메모).
4. **다음 계획 제안**: 우선순위·다음 액션 초안.
5. **dreaming(탐색)**: 개선 아이디어·실험 후보 — 제안까지만, 실행 X.
6. **브리프 주간 LLM 업데이트 검토 → 정책 반영안**(초안).

## 2. 필수 가드레일 (폭주 방지 — GD 1순위)

- **hard budget**: 사이클당 시간·토큰·파일변경수·외부조회수 상한. 초과 시 중단.
- **write gate (초안 vs 반영 분리)**: allowlist 안이어도 — low-risk 문서 정리만 자동 반영. **정책·룰·config 변경은 초안만 만들고 GD 승인 대기.**
- **escalation = 금지/승인대기**: 삭제·결제·외부전송·권한/설정 변경·self-mod·**팀원에게 새 작업 배정**은 루프가 직접 안 함(GD 승인).
- **cool-down**: 최근 N회 사이클에서 다룬 주제 재진입 제한(같은 이슈 반복 제기 방지).
- **kill switch**: GD가 한 문장("루프 멈춰")으로 전체 중지/축소.
- **decision log**: 매 사이클 결정/보류/근거 기록(감사·되돌리기).

### 2.1 팀 얼라인 — 합의 가드레일 + 리스크 reframe (5명 피드백 2026-06-12)

GD 지시로 설계를 전 팀원(steve·demis·devon·hermes·dbak)에 전파→피드백→얼라인. **5명 독립적으로 같은 통찰에 수렴:**

> **★ 진짜 폭주 리스크는 '실행'이 아니라(이미 막힘) "조용한 누적"이다** — 제안 인플레이션(노이즈)·echo chamber(같은 LLM끼리 동의 증폭)·북극성 drift(미세 이탈 누적)·의사결정 피로·누적 비용.
> **→ 성공 기준 = "많이 제안"이 아니라 "적게·근거 있게·바로 판단 가능·채택률 높게".** (루프에 P&L을 붙인다 — dbak)

**합의 추가 가드레일 (budget과 동급 1급):**
- **제안 품질 하한선**: 문제·근거·예상효과·리스크·다음 확인 없으면 폐기.
- **dedup + 거부된 제안 재제출 금지** (무한 순환·노이즈 차단).
- **수렴/종료 조건**: 신규 제안 0개 N라운드면 정지. 같은 전제 2회+ 막히면 auto-no-op.
- **반대(adversarial) 리뷰어 1명 의무 + 외부모델 교차검증**(echo chamber 깨기) — '무조건 동료 리뷰'가 거수기/합의편향 되는 것 방지.
- **북극성 정렬 게이트**: 제안마다 ROADMAP/비전 대비 정렬 라벨 → drift 조기감지.
- **누적 budget**(회당+일/주) + 소진 가시성. (회당만 막으면 반복으로 샘 — dbak)
- **채택률(adoption rate) 로깅 → 낮으면 auto-cooldown** / 주간 P&L(채택×가치 vs 누적비용).
- **권한 상승 금지**: 루프가 예산·범위·담당자·실행권한을 스스로 넓히지 못함.
- **provenance + 롤백** / **auto-kill 트리거**(budget X%·N회 반복·가드 위반 → 자동정지+GD알림) / **Dead-man's switch**(GD 부재 N일 → auto-pause, 불확실=STOP).
- **인간/외부 체크포인트 고정**: GD·외부모델의 이질적 신호가 주기적으로 안 들어오면 품질이 조용히 정체·열화 → 루프에 고정 박는다.

**역할 (각자 제안):** Steve=구현 타당성·회귀 리뷰+가드 코드 / Demis=eval·품질측정 하니스(adoption·중복·할루시·정렬 지표)+AI 리뷰어+외부모델 교차검증 / Devon=bounded engineering 실행·리뷰 / Hermes=Service·Strategy 리뷰어 / Dbak=루프 비용·P&L·상용화 unit economics 게이트 / Bill=메인 PM / Codex=co-PM·가드레일.

> **주행모드 = 작은 루프(GD)**: GD 부재 시 Bill이 바운디드하게 제안·빌드·코덱스 상의·체크포인트 보고하는 것 자체가 이 루프의 살아있는 첫 테스트. 시스템화 = 이걸 형식화.

## 3. idle('작업 공백') 감지 — 보수적

- **cron tick + 상태 확인 조합**(cron 단독 X).
- idle 조건(전부 충족 시에만): 활성 TaskFlow/위임/대기 실행 없음 · 최근 사용자 지시 처리 완료 · 미처리 directed 버스 없음 · 최근 X분 사람 대화 흐름 없음.
- **애매하면 idle로 보지 않는다** — heartbeat 수준 관찰만.

## 4. 기존 루프와 통합 (중복 제거)

- **5am task-review** = daily ops audit(오늘/어제 작업·미닫힘·칸반 위생) — 유지.
- **learning-loop(주간)** = weekly policy/meta review(반복 실수·LLM 업데이트·운영 규칙 개선) — 유지.
- **팀 루프(이 문서)** = 그 사이의 **idle micro-cycle.** daily/weekly에 흡수될 재료를 남기되 **중복 보고 안 함.**

## 5. Bill + Codex 분담 (PM 구조)

- **Bill (메인 PM)**: 팀 우선순위·작업 배분·Claude/infra 흐름·최종 GD 보고안 소유.
- **Codex (co-PM)**: OpenClaw 런타임·정책·가드레일·도구 사용 경계·폭주 방지 리뷰 소유.
- **충돌 시**: Bill이 운영 결론 초안 → Codex가 반대 의견·리스크·정책 위반 가능성을 **별도 섹션**으로 붙임. (Claude+OpenClaw 두 관점 항상 교차)

## 6. 매 사이클 산출 + GD 가시성

- 산출물: 칸반/SHARED/문서(초안)에 남김.
- **매 사이클 끝 GD-facing 요약 1회**(돌아오면 한눈에): 뭘 봤고·뭘 제안하고·뭘 보류했나. no-op이면 "이상 없음, no-op."

## 7. 구현 단계 (GD 확인 후)

1. idle 감지 + 사이클 러너(가드레일·budget·decision log 내장) — 작게.
2. 활동 allowlist 핸들러(리뷰/정리부터, 안전한 것 먼저).
3. write gate(초안 vs 반영) + escalation 차단 + kill switch.
4. 5am/learning-loop와 연결.
5. 파일럿(좁은 범위·짧은 budget) → 관찰 → 확대.

→ **핵심 문장: 공백을 작업 생산으로 채우는 시스템이 아니라, 다음 작업을 더 안전하게 만들기 위한 제한된 점검 시스템.**

---

# Part 2 — Proposal 시스템 (팀 루프와 한 몸)

> GD 2026-06-12: 팀 루프가 '제안'을 생성하고, Proposal 시스템이 그 제안을 거른다. Bill+Codex 공동설계.
> 통칭(GD 확정): **Team Self-Loop Governance** — 팀이 스스로(루프로) 제안·검토하되 **실행은 통제되는** 체계. b3os 상용 핵심 기능(B3OS_ROADMAP 일부, 별개 프로젝트 아님).

## 8. 핵심 원칙 (Codex, 데이터 모델에 박는다)

1. **루프는 실행하지 않고 제안만 만든다.** (제안↔실행 경계를 데이터 모델에 강제)
2. **모든 상태 전이는 기록된다.** (decision_log)
3. **GD에게 올라가는 건 팀장보고 전 필수 review 1단계를 통과한 압축본뿐이다.**
4. **리뷰어는 owner와 독립이어야 한다 (owner=reviewer, 구현자=리뷰어 금지).** 리뷰의 가치는 독립성(owner가 못 본 결함을 제3자가 잡음)이다. 기본 패턴: Bill이 owner/실행 → Codex가 pm-review(독립). Codex가 owner(예: media-bridge) → Bill 또는 다른 팀원이 review로 **flip**. 같은 사람이 구현하고 자기 걸 리뷰하면 독립성이 깨진다. (GD 2026-06-13 채택 — media-bridge 케이스가 이 규칙을 도출. loop 거버넌스가 케이스로 규칙을 발견하는 예.)

## 9. 파이프라인 + 데이터 모델

**파이프라인**: 1차 각 팀원 제안 → 팀 규모에 맞춘 review 1단계 → 팀장보고 → 팀장 최종 결정.
**상태기계**: `draft → peer_review → gd_report → accepted/rejected` (+ `peer_review → revise_requested → draft`, `archived_duplicate`). `gd_report`에서 나가는 길은 `accepted`/`rejected` 뿐이다(수정요청 없음). `pm_review`는 기존 DB row가 빠져나가기 위한 legacy drain 상태로만 유지한다. `accepted`·`rejected`·`archived_duplicate`는 terminal(재제출 금지 → 무한순환 차단; 재도전은 supersedes 링크 단 새 proposal).

**트리거/담당**
- `proposal create`: 팀원이 업무 중 또는 금요일 self-learning 세션 중 제안한다. 생성자는 `proposer_agent`가 된다.
- `draft → peer_review`: 제안자만 올릴 수 있다. 전이되면 시스템이 팀 규모에 맞춰 reviewer 1명을 자동선정한다. 후보는 현재 운영 가능한 팀원 중 비대화/비운영/제안자를 제외한다. 팀장 actor/lead id는 리뷰 후보 계산에 관여하지 않는다.
- 팀 규모 1명: review 후보가 없으므로 `gd_report`로 직행한다.
- 팀 규모 2명 이상: review는 1회만 둔다. 선정된 1명이 `stage=peer` 리뷰를 남기면 `gd_report`로 넘어간다.
- `peer_review`: 선정된 reviewer가 `stage=peer` 리뷰를 남긴다. `gd_report` 전이는 팀 규모 기준 review 1건이 있어야 통과한다.
- `peer_review → gd_report`: review 1건 등록 시 자동 전이한다. 반대/비판 리뷰는 권장 신호지만 별도 필수 단계는 아니다.
- `pm_review`: legacy drain 상태다. 기존 row는 `stage=pm` 리뷰 1건을 채운 뒤 `gd_report`/`revise_requested`/`rejected`로 빠져나간다.
- `gd_report`: 팀장 결정 요청이 팀장 전용 surface로 올라간다. 팀장은 대시보드 Proposal 상세와 리뷰 요약을 보고 `accepted/rejected` 2택으로 결정한다. **수정요청은 팀장 단계에 없다**(GD 2026-07-10) — 고칠 게 있으면 반려하고 새 proposal로 다시 올리게 한다. `revise_requested`는 리뷰어 단계(`peer_review`)에서만 발생한다.
- `revise_requested → draft`: 제안자가 수정해 다시 draft로 돌린다. 이후 같은 루프를 반복한다.

**3 테이블**:
- `proposal`: id, title, summary, source, proposer_agent, status, priority, effort_minutes, expected_value, risk_level, evidence_refs, north_star_alignment, duplicate_of, created_at, updated_at
- `proposal_review`: id, proposal_id, reviewer_agent, stage(peer/pm/gd), verdict, **is_adversarial**, comments, required_changes, created_at
- `proposal_decision_log`: id, proposal_id, actor, action, from_status, to_status, reason, created_at

**입력원**: 팀 루프(dreaming/리스크 발견/리서치) + 팀원 자기 제안. (※ 브리프 주간 LLM 동향은 루프 입력이 아님 — 그냥 도는 cron 잡으로 Tasks 탭에 표시만, 필요 시 LLM 정책 작업에서 참고. GD 2026-06-12 정정.)

## 9.1 구현 현황 (as-built — Phase 1 완료 2026-06-12)

DB 3테이블 + follow-up 링크 테이블 + API(`src/server/db/proposal.ts`, `routes/proposals.ts`) 빌드+엔드투엔드 검증 완료. **가드를 데이터/로직에 강제**(운영규칙 아님):
- **품질 하한선**: `evidence_refs`(근거)+`expected_value`(예상효과) 없으면 생성 거부(노이즈 차단).
- **전이 상태기계**: 표 밖 전이 차단(예: draft→accepted 건너뛰기 불가).
- **제안자 전이 가드(Guard P)**: `draft→peer_review`, `revise_requested→draft`는 `proposer_agent`만 가능.
- **팀장보고 전 review 의무(Guard A)**: `peer_review→gd_report`는 팀 규모 기준 review 1건 이상 필수. 정당한 예외만 `emergency_override=true`(사유 decision_log 기록).
- **legacy PM review drain 가드(Guard C)**: 기존 `pm_review` row가 남아 있으면 `pm_review→gd_report`는 팀 규모 기준 PM review 수를 채워야 한다.
- **GD 전용 최종승인(Guard B, Codex 교차검토)**: `gd_report→accepted/rejected`는 `actor='gd'`만. PM은 pm-stage 리뷰로 recommend만. ※ 현재 actor는 API body 값(구조적 가드) — 실제 authz 바인딩(GD 인증 세션=대시보드 탭/PIN)은 Phase 2에서.
- **follow-up task/wake**: 상태 전이 시 다음 담당자 task와 directed wake를 자동 생성한다. `peer_review`는 팀 규모 기준 reviewer 1명, `gd_report`는 coordinator에게 준비/추적용으로 생성된다. 팀장 결정 요청 visible 알림은 그룹방이 아니라 팀장 전용 surface로 보낸다. `revise_requested`/`draft`는 제안자에게 생성된다. 상태를 떠나면 관련 follow-up은 자동 close된다.
- **decision_log 전수 기록**: 생성·전이·리뷰 모든 액션 자동 기록(감사·되돌리기).

검증(실제 b3os 과제 1건 한 바퀴): '런타임 버전 노출' 제안 → draft→peer review→gd_report→(gd)accepted. 노이즈 거부·invalid전이 차단·팀장보고 전 review 가드·GD전용 승인 전부 동작 확인. 커밋: Phase1-1(migration)+9f01800(API)+가드강화.

API: `GET/POST /team/api/proposals`, `GET /proposals/:id`(+reviews+decision_log), `POST /proposals/:id/transition`{to,actor,reason,emergency_override?}, `POST /proposals/:id/reviews`{reviewer_agent,stage,verdict,is_adversarial,comments,required_changes}.

## 10. 대시보드 Proposal 탭

- 컬럼: Inbox / In Review / GD Report / Accepted / Rejected.
- 카드: 제목·출처·제안자·effort(10/20분)·가치·리스크·다음담당자·마지막리뷰.
- 상세: evidence·리뷰 타임라인·decision log.

## 11. 작업 분해 (10분 단위, Codex — 안전·기반 먼저)

MVP 순서 = 안전성·감사 가능성 우선: **Proposal DB/API → Dashboard read → Review pipeline → Loop dry-run → Job controls → Brief integrations.**

1. proposal 상태/필드 확정 + migration 초안
2. Proposal CRUD API 최소
3. status transition API + invalid transition 방지
4. review 생성 API
5. decision_log 자동 기록
6. 대시보드 Proposal 목록 탭
7. 상세 화면 리뷰/로그 표시
8. GD Report 큐 필터
9. Tasks 탭에 cron/job 목록 읽기전용 표시
10. job 변경/취소 별도 confirm 흐름
11. 루프 러너 dry-run(실행 없이 후보 생성)
12. 루프 러너 time budget(10/20분) 제한
13. proposal 생성 시 source/evidence 필수화
14. duplicate 후보 탐지 최소
15. peer review 라우팅
16. pm_review 라우팅(팀 규모 기준 PM reviewer)
17. GD 보고 묶음 생성
18. 운영 로그/실패 복구
19. e2e 한 바퀴 리허설

→ 총 19개(brief 연동 작업 삭제 — GD 정정). 각 항목 10~20분 단위. 1~8(Proposal 기반·read)부터, 9~10(잡 탭) → 11~12(루프 dry-run·budget) → 13~17(필수화·파이프라인) → 18~19(로그·리허설).

> **2026-06-13 리프레임(GD)**: 9~10(Jobs/잡 탭)은 SLG 단계에서 분리한다. Jobs는 SLG의 한 단계가 아니라 공용 **운영 가시성** 기능이고, SLG(Phase 4 루프 러너)가 이를 *이용*하는 관계다(러너가 하나의 job으로 등록돼 돎). 따라서 **SLG 핵심 = Proposal 기반(1~8) → 루프 러너(11~12) → 필수화·파이프라인(13~19)**. 읽기전용 Jobs 뷰어는 운영 기능으로 done 처리(보드: `[운영] Jobs 탭`). cron 변경/취소 confirm은 필요 시 별도 운영 카드.

**진행(2026-06-12)**: ✅ 1~5 완료(migration·CRUD·전이·리뷰·decision_log + 코덱스 교차검토 가드강화). 13(source/evidence 필수화)도 품질 하한선으로 선반영. 다음 Phase 2(6~8 대시보드)는 **GD 리뷰 후** — 지금은 제한범위 테스트 단계라 기계만 세우고 운영범위는 GD와 같이 정함.

## 12. 운영 관찰 로그 (cycle별 학습 — GD "몇 번 돌려보고 어느 범위가 안전한지 감 잡기")

> 목적: 루프를 어느 범위/자율도로 돌려야 안전+고완성도인지는 실제 cycle을 돌려보고 학습한다. 매 시범 cycle의 관찰을 여기 append.

- **Cycle 1 (2026-06-12, 기계 검증 + 첫 시범)** — 제안 '런타임 버전 노출'(리서치 1번). 관찰:
  - ✅ 가드 전부 의도대로 동작(노이즈 거부·전이·반대리뷰 의무·GD전용 승인·전수기록).
  - 💡 **핵심 학습**: 반대 리뷰어(demis)가 제안 자체의 약점을 잡음 — "버전 노출만으론 사고 못 막음, 스모크테스트 게이트가 본질". 즉 루프가 *약한 제안을 통과시키지 않고 더 강한 방향(스모크테스트 게이트)을 끌어냄.* echo chamber 방지 장치가 첫 바퀴에서 실효 입증.
  - ⚠️ 한계: 이번 cycle은 Bill이 스크립트로 단계를 돈 *기계 검증*. 진짜 테스트(팀원이 자발적으로 제안 생성→상호 리뷰)는 아직. 운영범위 판단엔 자발적 cycle 2~3회 필요.
  - ➡️ 다음: GD와 cycle 1 리뷰 → "제한범위에서 자발적 제안 1~2건 받아볼지" 결정.

### 12.1 첫 실범위(real cycle) 후보 — GD 선택 대기 (2026-06-12)

GD 질문("검색품질 말고 SLG 첫 과제 후보가 뭐냐, 하나 골라 진행")에 빌이 B3OS_ROADMAP 근거로 추린 후보. *빌·코덱스 정식 브레인스토밍은 아직 — GD 선택 후 코덱스와 확정.* 검색품질 루프는 이미 도는 거라 그대로 두고, 새 후보로 한 바퀴가 더 깨끗한 테스트.

- **A. 보이는 ack 루프 — topology 빨강(stuck) 정리 + ack-close** ⭐빌 추천. 신뢰 뼈대 P0, 실제 버그(DM 응답돼도 원본 미완료), 데이터 근거([[reference_topology_red_wake_dispatched]]), 작고 관측가능, 반대리뷰가 엣지케이스 후비기 좋음. + 2026-06-13 dbak 카드유실로 드러난 'task 삭제 audit 갭'과 같은 audit/신뢰 테마.
- **B. 기본 4화면 중 Inbox(받은편지함)·Audit(기록) 화면 만들기** — 4화면(Inbox/Tasks/Agents/Audit) 중 Tasks·Agents만 있고 2개 미흡. 신뢰=무슨 일이 있었는지 다 보임. 중간.
- **C. empty-state / 복구성 UI** — pending·blocked·fallback 고객 눈에 보이게. 작음.
- **D. 능력 카탈로그 = 실행 계약(입출력·권한·승인)** — Phase 2급, 더 큼.

선택되면 → 코덱스랑 "Proposal 파이프라인에 어떻게 태울지" 정리 → draft→peer→pm(코덱스)→gd_report 첫 유기적 cycle.

- **Cycle 2 (2026-06-13, 첫 유기적 cycle — GD "a,b 다 해봐")** — A·B를 실제 팀원 리뷰로 한 바퀴. **루프 검증 성공.**
  - A(ack-close)·B(Inbox·Audit) proposal 등록 → peer_review. peer = Steve·Demis(directed bus로 요청 — 봇끼리 텔레그램 못 봐서 그룹 @멘션은 GD 가시성용일 뿐, 실제 engage는 bus. = wiring 학습).
  - 💡 **핵심 성과**: Steve·Demis가 *독립적으로 같은 결함* 발견 — A의 "reply 오면 원본 completed 닫기"가 **reply≠done(가짜완료)**. ack-only(네/이모지)에도 미완 과제가 조용히 완료 = 가짜빨강 끄려다 가짜초록(더 위험). **코드 짜기 전에 설계 결함을 잡음.**
  - pm(Codex) (a) 판단: revise 말고 peer 수렴 반영한 **refined A**로 gd_report. 5 required change(close 2단계 ack/done·task상태 정본·multi수신자 독립close·in_reply_to 매칭·wiring+audit 안전망). A → **gd_report**(GD accept 대기, actor=gd Guard B). B는 A의 close schema 확정 후 pm_review 대기.
  - ✅ 결론: 루프가 '맹목 close'(유해) 제안을 'safe close'로 끌어올림. echo chamber 방지 가드(반대리뷰 의무)·품질 하한선 실효 입증. GD 보고=가치 가시화("원안 approve" 아니라 "fake-green 막은 refined A").
  - ➡️ 다음: GD가 refined A accept → 구현 owner 배정. 운영 관찰 누적해 안전 범위 계속 학습.

## 13. 킵 (future) — SLG 타임머신 / 버저닝·롤백 (GD 2026-06-13, 일단 킵)

> 다수 루프가 동시에 돌며 꼬이면 known-good로 돌아갈 안전장치가 필수. 루프 1~2개일 땐 cycle마다 커밋으로 충분하나, 다수 동시 루프엔 명시적 stable 복귀점이 필요.

**원리**: 항상 stable 복귀점(버저닝) + 플래그를 둬서 언제든 known-good 상태로 롤백.

**구현 (git이 이미 제공)**:
1. **stable tag**: 검증 통과한 안정 지점마다 git tag(예: `slg-stable-N`). 꼬이면 그 tag로 롤백.
2. **feature flag**: 새 루프 산출물은 flag로 감싸 롤백 없이 토글 off 가능(이미 `ROUTER_ENABLED`·`BUS_DISPATCH_ENABLED`·`APPROVAL_EXECUTION_ENABLED` 패턴 사용 중 — shadow/off로 안전 도입).
3. **롤백 절차**: 어느 루프의 변경이 깨면 tag 복원 or flag off + 재배포 — 명확한 한 줄 절차로.

**상태**: 킵. 실제 도입은 동시 루프가 많아질 때(지금은 cycle별 커밋으로 충분). 적용 시 SLG 가드레일(§2)에 승격.
