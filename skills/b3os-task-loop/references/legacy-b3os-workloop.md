---
name: b3os-workloop
description: 팀원 작업루프 기본 인프라 — b3os가 스케줄에 맞춰 코디네이터를 깨워 칸반 PM·주간 self-learning을 돌린다. 런타임 무관(claude/openclaw/hermes 공통). 깨어났을 때 한 턴에 루프를 닫는 법.
owner: maintainer (infra)
---

# b3os-workloop — 팀원 작업루프 기본 스킬

## 이게 뭔가 (런타임 무관)

팀에는 사람이 매번 시키지 않아도 도는 **작업루프** 두 개가 기본으로 있다:

- **매일 칸반 PM** (06:00 KST) — 진행 카드 점검·정리·the team lead 보고
- **주간 self-learning** (금 05:00 KST) — 팀 학습 후보 수집·리뷰·반영

이 루프는 **b3os(team-collab) 시스템이 구동**한다. 네가 openclaw든 claude든 hermes든 **상관없다.** 각 런타임 cron을 네가 직접 걸 필요 없다. b3os의 `workloop-driver`(launchd)가 스케줄 시각에 **코디네이터를 inbox 봉투로 깨워** 바운드 프롬프트를 준다. 너는 깨어나면 그 한 턴에 루프를 닫으면 된다.

> 왜 b3os가 하나: 영입되는 런타임이 무엇일지 모른다. 각 런타임 native cron(openclaw cron / hermes cron / claude launchd)에 박으면 영입이 복잡해진다. b3os가 런타임-비종속으로 깨우면 영입은 심플(코디네이터 표식만)하고 루프는 어떤 런타임에서도 돈다. (설계: `docs/WORKLOOP_INFRA_DESIGN.md`)

## 누가 도나 (작업 담당자를 깨운다)

**작업루프는 그 작업의 *담당자*를 깨운다.** 인프라를 만든 사람(maintainer)이 아니라, 그 반복작업을 맡은 팀원. 누구나 자기 반복작업 루프를 가질 수 있다.

- **칸반 PM·self-learning** = 현재 담당자가 둘 다 PM(`learning_loop_pm`, coordinator) → 둘 다 그를 깨운다. 없으면 `coordinator`(퍼블릭 솔로팀=첫 영입자) fallback.
- 팀원 0명이면 루프 no-op — 영입해서 담당자가 생기면 자동 시작.

## 깨어났을 때 (한 턴에 닫기)

봉투 본문에 `[작업루프: ...]`로 온다. 자동 스케줄 wake다.

**칸반 PM 받으면:**
1. Tasks 칸반(`/team` → Tasks, 또는 `GET /api/tasks`)에서 doing/plan 카드를 owner별로 조회·요약
2. 3일+ stale 카드, `다음 액션`/`재개 시각`/`fallback`/`stop_rule` 누락 카드 플래그
3. the team lead가 보는 채널(텔레그램 그룹)에 5줄 이내 직접 보고 — 봉투가 `reply_mode=direct_to_gd`라 네 답이 the team lead에게 간다
4. 본인 담당 카드 갱신
→ 삭제·담당자 변경은 the team lead 승인. 요약·갱신은 자율. 한 보고로 닫는다.

**self-learning은 2단계(금 05:00 kickoff → 금 10:00 report)** — TEAM-OS §9 계약 유지:
- `[... 1/2 kickoff]` 받으면: SHARED.md 후보 수집 + maintainer 공동리뷰 요청(directed) + the team lead엔 'kickoff 상태'만 1줄. **최종 분류·확정은 이때 하지 않는다.**
- `[... 2/2 report]` 받으면: maintainer 리뷰 반영 → 룰 승격/실행과제/스킬/proposal 분류 → the team lead 채널에 정리 결과 보고.
→ 정책·보안·persona·외부전송 승격은 the team lead 승인 게이트. 미응답/세션만료 팀원은 스킵. maintainer 리뷰 미도착이면 '공동리뷰 대기'로 표시하고 단독 확정 금지.

## 정직 규칙

- 데이터 조회 도구(칸반 API·SHARED.md 읽기·버스)가 세션에 없으면 **그 상태만 보고하고 멈춘다. 지어내지 않는다.**
- 진행할 게 없거나 the team lead 컨펌 대기 중이면 그 상태 한 줄만 알리고 멈춘다.

## 운영 (인프라 — 일반 팀원은 몰라도 됨)

- 드라이버: `scripts/workloop-driver.ts <kanban|learning>` (DRY_RUN 기본 ON)
- 킬: `WORKLOOP_DRIVER_ENABLED=0` 또는 `var/workloop-driver-paused` 파일
- 코디네이터는 bus-wake allowlist(`BUS_DISPATCH_AGENTS`/`var/bus-wake-extra.txt`)에 있어야 wake 도달. 드라이버가 발사 전 검증해 없으면 abort.
- launchd 등록·기존 openclaw cron 전환은 the team lead 게이트(실배포).
