# `[작업루프: …]` wake 세부

b3os 의 `workloop-driver`(launchd)가 스케줄 시각에 담당자(PM `learning_loop_pm`, 없으면 `coordinator`)를 inbox 봉투로 깨운다. 런타임 cron 을 직접 걸지 않는다. 팀원이 0명이면 no-op.

## 칸반 PM (매일 06:00 KST)
1. `/team` → Tasks 또는 `GET /api/tasks` 로 doing/plan 카드를 owner 별로 조회·요약.
2. 3일 넘게 갱신 없는 카드, `다음 액션`·`재개 시각`·`fallback`·`stop_rule` 이 빈 카드를 표시.
3. 팀장이 보는 채널에 5줄 이내로 보고. 봉투가 `reply_mode=direct_to_gd` 라 내 답이 팀장에게 간다.
4. 내 카드를 갱신한다. 삭제·담당자 변경은 팀장 승인, 요약·갱신은 자율.

## 주간 self-learning (금 05:00 kickoff → 금 10:00 report)
- `1/2 kickoff`: SHARED.md 후보 수집 + maintainer 공동리뷰 요청(directed), 팀장께는 kickoff 상태 1줄. 최종 분류·확정은 하지 않는다.
- `2/2 report`: maintainer 리뷰 반영 → 룰 승격/실행과제/스킬/proposal 분류 → 팀장 채널에 결과 보고. 정책·보안·persona·외부 발송 승격은 팀장 승인. 미응답 팀원은 건너뛰고, maintainer 리뷰가 안 왔으면 "공동리뷰 대기" 로 표시하며 단독 확정하지 않는다.

## 공통
- 조회 도구(칸반 API·SHARED.md·버스)가 세션에 없으면 그 상태만 보고하고 멈춘다. 지어내지 않는다.
- 진행할 것이 없거나 팀장 확인 대기면 그 상태 한 줄만 알리고 멈춘다.

## 운영(인프라)
- 드라이버: `scripts/workloop-driver.ts <kanban|learning>` (DRY_RUN 기본 ON). 끄기: `WORKLOOP_DRIVER_ENABLED=0` 또는 `var/workloop-driver-paused`.
- 담당자는 bus-wake allowlist(`BUS_DISPATCH_AGENTS`/`var/bus-wake-extra.txt`)에 있어야 wake 가 닿는다. 드라이버가 발사 전에 검증하고 없으면 abort.
- launchd 등록·기존 openclaw cron 전환은 팀장 게이트.
