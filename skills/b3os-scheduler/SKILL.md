---
name: b3os-scheduler
description: "b3os durable 스케줄러로 반복(cron)·간격(interval)·1회성(reminder) 잡을 등록하는 팀 스킬. 시·분·요일·월 cron + 잡별 휴일정책(run/skip/shift, KST)을 잡 등록 시 받아 team.db에 durable 저장하고, 서버 내 워커가 시각 맞춰 발화(인박스 wake). 세션 cron(런타임별 CronCreate)은 세션 죽으면 유실되므로, 팀 정본 반복작업은 이 스케줄러를 쓴다."
---

# b3os-scheduler — b3os durable 스케줄러

팀원이 **세션과 무관하게(durable) 시각에 맞춰 발화하는 반복/예약 잡**을 등록하는 절차 스킬이다. 런타임별 세션 cron(claude `CronCreate`, openclaw/hermes 자체 예약)은 **그 세션이 죽으면 유실**된다. 팀 정본 반복작업(야간 사이클·주기 리마인드·정기 점검)은 이 스케줄러에 등록해 `team.db`에 durable 저장하고, b3os 서버 안의 워커가 발화한다.

## 언제 쓰나
- "매일 03:04에 X 해라", "평일 09시에 Y 깨워라", "매월 1일 리포트" 같은 **반복 잡**을 durable하게 걸 때
- "N분 뒤 나한테 알려줘" 같은 **1회성 리마인드**를 턴에서 sleep 없이 예약할 때 (dex/에이전트 in-turn sleep 금지)
- 세션 죽어도 살아남아야 하는 팀 정본 스케줄을 등록/이관할 때
- launchd per-job 플리스트를 durable 스케줄러 잡으로 이관할 때

세션 한정 임시 점검(몇 분 뒤 한 번 확인)은 런타임 세션 cron으로도 충분하다 — 이 스킬은 **유실되면 안 되는** 잡에 쓴다.

**`b3os-task-loop`(작업루프)과 구분**: workloop = 정해진 코디네이터 루프(매일 칸반 PM·주간 self-learning 등 고정 프로그램)를 깨우는 기본 인프라. scheduler(이 스킬) = **임의의 durable 반복·예약 잡**을 자유롭게 등록하는 범용 도구. workloop의 스케줄 자체도 이 스케줄러로 이관 가능(launchd per-job → scheduled_job).

## 개념 (실제 구현)
- **정본 저장**: `team.db`의 `scheduled_job` 테이블 (id·kind·schedule_kind·next_run_at(UTC)·schedule_expr·payload_json·enabled·lock_until…). 실행 이력=`scheduled_job_run`.
- **워커**: b3os 서버가 `startSchedulerWorker`로 틱마다(기본 60초, env `B3OS_SCHEDULER_INTERVAL_MS`로 조정·최소 5초) `next_run_at<=now`인 잡을 lease-claim → 발화 → 재계산. 코드=`src/server/scheduler/core.ts`(`runDueSchedulerJobsOnce`)·`workers/schedulerWorker.ts`.
- **발화 = 2종 페이로드**: ①`inbox` — `payload_json`의 인박스 봉투를 `acceptInbound`로 삽입(실제 wake/라우팅은 wakeDispatcher, 신규 라우팅 0). ②`exec` — allowlist된 ops 스크립트를 spawn(에이전트 안 깨우고 결정적 작업 직접 수행, 옛 launchd 대체). inbox는 emit+재계산이 단일 트랜잭션(at-most-once), exec는 async라 실행 후 재계산(at-least-once).
- **잡 종류(kind × schedule_kind)**: `recurring`×`cron`(시·분·요일·월) / `recurring`×`interval`(N분 간격) / `oneshot`×`once`(1회 리마인드).
- **안전**: claim은 원자적 조건부 UPDATE(lease)로 이중발화 차단. `dedupe_key=job_id+scheduled_for` + `acceptInbound` 창으로 크래시 재발화 시에도 이중게시 0. 한 잡 throw가 워커 안 죽임(격리) — 잘못된 cron 잡은 `failed`로 파킹돼 재발화 루프 없음.

## cron 문법 (표준 5필드, KST)
`분 시 일(月) 월 요일` — 예 `4 3 * * *` = 매일 03:04.
- 필드: `*` / `a` / `a,b,c` / `a-b` / `*/n` / `a-b/n` / `N/n`(N..최대 step n, Vixie)
- 요일: 0-7 (0·7=일요일)
- 일(dom)·요일(dow) 둘 다 지정 시 = **둘 중 하나 맞으면 발화**(Vixie 시맨틱)
- **타임존 = 잡의 `timezone`(기본 Asia/Seoul)**. 고정 오프셋 존만 지원 — DST 존(America/New_York 등)은 등록 시 throw(오발화 방지). KST는 DST 없어 정확.

예: `*/15 * * * *`(15분마다) · `0 9 * * 1-5`(평일 09시) · `0 0 1 * *`(매월 1일 자정) · `30 8 * * 6`(토 08:30)

## 휴일 정책 (잡 등록 시 받음)
잡별로 `holidayPolicy`를 cron과 같이 받는다:
- `run`(기본): 휴일이어도 그냥 발화
- `skip`: 발화일이 휴일이면 건너뛰고 다음 cron 매치로
- `shift`: 휴일이면 다음 영업일(비휴일) 같은 시각으로 밀기 (※단순 영업일 밀기 — 월/요일 패턴 재검증 안 함. 패턴 유지 필요하면 `skip` 사용)

휴일 달력=`holiday` 테이블((country,date) PK). KR 공휴일 시드됨(연도별 확장 필요). **커버리지 절벽 주의**: 시드된 마지막 연도 이후는 `isHolidayOn`이 false → skip/shift가 조용히 `run`처럼 동작. `createCronJob`이 skip/shift 잡을 커버리지 밖에 걸면 경고 로그. 연말에 다음 해 공휴일 시드 추가할 것(`seedKrHolidays` in `migrate.ts`).

## 등록 방법
API = `src/server/scheduler/core.ts`. 서버 프로세스 안이나 team.db를 여는 스크립트에서 호출.

**반복 cron 잡:**
```ts
import { createCronJob } from "src/server/scheduler/core";
createCronJob(db, {
  id: "sched_my_job",            // 고정 id면 재실행 멱등(중복 등록 방지)
  title: "매일 03:04 X",
  cron: "4 3 * * *",
  timezone: "Asia/Seoul",
  targetAgentId: "demis",        // 이 에이전트를 인박스 wake
  createdBy: "demis",
  holidayPolicy: "run",          // run|skip|shift
  payload: { type: "inbox", envelope: {
    thread_id: "my-thread", from_agent_id: "system", to_agent_id: "demis",
    type: "dm", body: "[스케줄 wake] ...", source: "agent", hop_count: 0, priority: "normal",
  }},
});
```
`createCronJob`이 cron식으로 첫 `next_run_at`을 계산해 저장. 이후 발화할 때마다 다음 슬롯 재계산(recurring).

**스크립트 실행 잡(exec):** 에이전트를 깨우는 게 아니라 ops 스크립트를 스케줄에 돌린다(옛 per-job launchd 대체). 페이로드 `{ type:"exec", execKey }` — execKey는 ★반드시 `core.ts`의 `EXEC_ALLOWLIST`에 등록된 키★(명령은 코드에 정의, DB에서 임의 명령 못 옴). 워커가 argv 배열로 spawn(shell 없음=injection 0) + 잡별 타임아웃 + 출력 truncate + non-zero exit=failed. cron과 조합해 반복.
```ts
createCronJob(db, { id:"sched_task_review_ping", title:"05:00 리뷰핑", cron:"0 5 * * *",
  createdBy:"system", payload: { type:"exec", execKey:"task-review-ping" } });
```
새 ops 스크립트를 돌리려면 `EXEC_ALLOWLIST`에 `{ command:["bun","run","scripts/x.ts"], timeoutMs, label }` 항목 추가(코드 변경+리뷰). ★멱등성 주의: exec는 at-least-once(크래시 시 재실행 가능) — 비멱등 side effect는 자체 dedupe 없이 allowlist 금지.★

**1회성 리마인드:** `scheduleReminder(db, { targetAgentId, body, runAt, createdBy, directToGd? })` — 턴에서 sleep 금지, 즉시 반환하고 워커가 나중에 발화.

**간격 잡:** `createScheduledJob(db, { kind:"recurring", scheduleKind:"interval", nextRunAt: new Date(Date.now()+30*60_000), scheduleExpr:{minutes:30}, ... })`. ※interval은 첫 `nextRunAt`(Date)를 **직접** 지정해야 함(cron/reminder는 자동계산).

등록 전용 스크립트 패턴 = `scripts/seed-metrics-nightly-job.ts`(예시: 고정 id·존재 시 no-op·`--commit` 게이트). 라이브 team.db 대상은 `TEAM_DB_PATH` 지정, dry-run 기본. 실시간 스모크 = `scripts/scheduler-live-smoke.ts`.

## 게이트 / 안전 (팀 규칙)
- **라이브 발사**: 서버 워커가 `B3OS_SCHEDULER_ENABLED=true` + `B3OS_SCHEDULER_DRY_RUN=0`일 때만 실제 발화. 이 env 플립·라이브 team.db 잡 등록은 **공유 인프라 변경 → OWNER 승인 게이트**.
- **launchd 이관**: per-job launchd를 스케줄러 잡으로 옮길 땐 ①새 잡 등록 ②발화 검증 ③그 다음 옛 launchd 제거(운영자) 순서. 순서 어기면 이중발화. launchd 제거=운영자 권한(OWNER 터미널/Bill).
- **검증**: 시간 코드는 유닛테스트(주입 now)만으로 부족 — 실제 벽시계로 라이브 스모크(별도 temp DB + 진짜 워커)까지 돌린다. 유닛테스트엔 ms 붙은 non-round 시각 포함(정각만 쓰면 조기발화 버그 놓침). 참고 `scripts/scheduler-live-smoke.ts`.
- AI 코드면 `b3os-ai-code-safety` + 하네스 검토 후 머지.

## 한계 (명시)
- 고정 오프셋 타임존만(KST OK / DST 존 미지원, 등록 시 throw).
- 휴일 달력은 연도별 수동 시드(커버리지 절벽 경고 있음).
- `misfire_policy`는 현재 `coalesce`만 실동작(밀린 슬롯=복구 시 1회, catch_up_once/skip 분기 미구현).
- 발화 = 인박스 메시지 삽입까지. 실제 작업은 wake된 에이전트가 자기 턴에서 수행.
