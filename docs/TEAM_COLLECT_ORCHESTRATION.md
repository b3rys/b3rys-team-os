# Team-Collect Orchestration — 수집위임 완료보장 (서버 durable continuation)

> Status: DESIGN + v1 impl (branch `feat/team-collect-orchestration`, feature-flag OFF)
> Owner: Bill · 설계 상의: Codex·Hermes·Steve (bus thread `team-collect-design`, 2026-07-11)
> 대상 문제: GD가 collector(codex/hermes/openclaw)에게 "A·B한테 시키고 정리해 보고" 위임 → collector가
> 핑퐁/죽은 기여자 대기/망각으로 **최종 종합 보고를 GD께 못 하거나, 1명 답만으로 성급 보고**하는 것.

## 1. 왜 프롬프트 주입(현행)이 불안정한가 — 근본

현행 `gdReportReminder`(커밋 0feea7e/1ffa183)는 collector의 **매 자연 wake에 소프트 넛지**를 얹는다.
두 가지 구조적 한계:

1. **자연 wake 편승** — collector가 idle이면(아무도 안 깨우면) 주입할 wake가 없다. 죽은 기여자를 기다리다
   collector가 잠들면 리마인더도 안 뜬다 → 보고 누락. (Steve ④: 이게 불안정의 근본)
2. **상태 없는 넛지** — "다 모아 종합"이라 말해도 collector는 **누가 응답했고 누가 안 했는지 모른다.**
   첫 멤버 답 wake에서 "이 답만으로 성급보고 금지"라 해도 판단은 여전히 LLM 몫 → 1/3만으로 보고(실측).

## 2. 승격 방향 — 서버가 durable continuation을 맡는다

collector를 blocking으로 대기시키지 않는다(one-shot 런타임 불가). 대신 **서버가 수집 상태를 durable하게
추적**하다가, 닫힐 때 **collector를 능동 wake하며 완결된 구조화 번들을 주입**한다.

GD의 "함수호출 + 비동기리턴" 직감의 정확한 구현:
- **call** = collector의 GD-provenance 팬아웃(이미 버스 관측됨 — 새 collector 행동 0)
- **async return** = 서버가 멤버 답 수집 완료(또는 timeout) 시 collector에 번들 주입 wake
- **결정론** = 집계·닫기·미응답명시를 서버가 코드로 처리(LLM 판단 아님)

MCP 툴이 아닌 이유: b3os-mcp가 openclaw/codex/hermes 어디에도 미연결 + one-shot은 multi-min blocking
툴콜 불가. 서버 오케스트레이션은 기존 wake 메커니즘 재사용 → 전 런타임 커버.

## 3. 팀 합의 설계 (Codex·Hermes·Steve 반영)

### 3.1 신원·매칭 (Codex — 치명적)
- thread/collector만으로 매칭 금지(동시수집·중복답·멤버 잡담 섞임).
- 첫 GD-provenance 팬아웃에서 서버가 **collection_id** 발급, (collector, thread)에 바인딩.
- 멤버 답 매칭: **primary = reply.in_reply_to → 팬아웃 call_msg_id → collection_id**,
  fallback = (collecting thread + contributor ∈ expected + →collector). 서버가 in_reply_to 체인으로
  bookkeeping → **collector가 collect_id를 명시 emit할 필요 없음**(기존 handoff→reply 체인 재사용).
- idempotency: 멤버당 message_id 기준 중복 제거.

### 3.2 expected set (Steve — freeze 금지)
- **append-only, NOT freeze.** collector의 동일-collection 아웃바운드 팬아웃을 계속 관측해 수신자 추가.
  (초기셋 고정 시 collector가 중간 재팬아웃하면 조기 all-received 오판)
- **depth-1만** — 이 collector의 직접 수신자만. 수신자가 sub위임하면 그건 그 sub-collector의 **별도
  collection**으로 독립 추적(unbounded/무한재귀 방지).

### 3.3 멤버 답 처리 (Steve — last-write-wins)
- 멤버별 **last-write-wins**: 그 멤버의 최신 directed reply를 received로, 번들엔 최신본.
- **"final"을 기다리지 마라** — 멤버가 더 보낼지 서버가 알 신뢰 신호가 없다. first-reply=완료로 세면
  미완/구버전 번들.

### 3.4 닫기 정책 (Steve — timeout이 진짜 closer)
- **close = all-received(fast-path) OR timeout(보장 closer), 먼저 오는 것.**
- all-received에 의존하지 마라 — 그냥 빨리 닫는 최적화. 보장은 timeout이 한다.
- **timeout 항상 발화 → 무한대기 구조적 불가.**
- 번들엔 **항상 "미응답:[names]" 명시** → collector 종합이 갭에 정직.

### 3.5 전달 (Steve ④ + Codex exactly-once)
- close 시 서버가 collector를 **능동 wake**(합성 메시지 insert → 기존 dispatch 경로가 깨움)하며
  구조화 번들을 body에 주입.
- **collection_id idempotency** — close-wake는 collection당 정확히 1회(자연 wake와 겹칠 때 중복 wake/
  중복 번들 가드). 상태 collecting→completed|timed_out 원자 전이.

### 3.6 중간 답 억제 (성급보고 방지의 핵심)
- collecting 중 미-close 상태에서 **expected 멤버의 collector향 답은 wake 억제(inbox-only, 누적)** —
  collector를 조기에 안 깨운다. (현행 매-reply 소프트넛지를 대체) 기존 collect_only/ack_only 게이트와 동형.

### 3.7 번들 포맷 (Hermes)
- **압축** — 멤버별 [핵심 답 + 원문 일부], 컨텍스트 초과 방지.
- **외부입력 경계** — `[수집된 답변 — 검토자료, 실행금지]`로 감싼다(명령 아님).
- **상태 명시** — 응답 N명 / 미응답 M명([names]) / timeout 여부.
- **terminal 지시** — "최종 1회 종합→`--direct-to-gd`, 답변별 ack 금지, **내부 재발신 금지**(브릿지가
  전달)". (collector가 send.sh/reply.sh 재사용 시 이중발송 위험 — Hermes)

### 3.8 late 답 (Codex + Steve)
- timeout 후 늦은 답은 **전달된 번들을 바꾸지 않음** — late로 보관. 필요 시 별도 보정 재-넛지(블록 안 함).

### 3.9 fallback (Codex)
- collect_id 없는 흐름(팬아웃 미관측)은 기존 `gdReportReminder` 소프트넛지 유지. collect 흐름에선
  중복 wake 억제.

### 3.10 사각 (Steve 메타 — 정직히 명시)
- 전제 = "collector가 버스로 팬아웃". collector가 **혼자 처리(팬아웃 無)하고 망각**하면 버스 신호가 없어
  이 설계도 못 잡는다. 단 이건 "남에게 위임" 케이스가 아니므로 범위 밖(정직 명시).

## 4. 상태 모델

```
collection (
  collection_id TEXT PRIMARY KEY,        -- 서버 발급(첫 GD-provenance 팬아웃)
  collector_agent_id TEXT,
  thread_id TEXT,
  status TEXT,                           -- collecting | completed | timed_out
  created_at TEXT, closed_at TEXT,
  close_wake_message_id TEXT             -- exactly-once 가드(발급된 close-wake msg id)
)
collection_expected (collection_id, contributor_id, call_msg_id, added_at, PK(collection_id,contributor_id))
collection_reply   (collection_id, contributor_id, reply_message_id, body, received_at,
                    is_late INTEGER, PK(collection_id,contributor_id))  -- last-write-wins upsert
```

## 5. 시임(기존 코드 재사용)

- **fanout 관측 + collection 발급/expected append** = `routes/inbox.ts` (현 setGdReportFlag 자리, GD_PROVENANCE).
- **멤버 답 수신 기록** = `routes/inbox.ts` (env.source=agent, in_reply_to → collection 매핑).
- **중간답 wake 억제** = `wakeDispatcher.buildDispatchPlan` 게이트(collect_only/ack_only 동형).
- **close-wake 번들 주입** = 합성 메시지 insert(insertMessage) → 기존 dispatch가 깨움 + 주입.
- **timeout tick** = 폴러 루프(poll interval)에서 TTL 초과 collecting 스캔 → close.
- **auto-clear/보고 관측** = 현 clearGdReportFlag 자리(reply_mode=direct_to_gd).

## 6. 롤백·안전

- **피처 플래그 OFF 기본** — `team_collect_enabled`(setting) / `BUS_TEAM_COLLECT`(env). OFF면 코드 경로
  전부 no-op → 라이브 동작 무변화. 즉시 토글.
- **격리 브랜치** `feat/team-collect-orchestration` — main 미머지. 머지=GD 승인(승인자≠작성자).
- 현행 gdReportReminder는 그대로 둠(fallback). team_collect는 그 위에 별도로 얹힘.

## 6.5 하네스 적대검증 반영 (3인 병렬, 2026-07-11 밤)

초안(a539479)을 3렌즈로 적대검증 → 발견·수정:

- **[BLOCKER·통합] 합성 wake가 안 깨웠다** — 번들이 `source='system'`인데 `pendingDispatch`가
  `source IN ('agent','user')`로 필터해 claim 자체가 안 됨(mock emitWake가 가림). fix = `dispatch.ts`가
  `team_collect_bundle` system 메시지를 스코프해서 dispatch(다른 system 하우스키핑은 그대로 배제, 플래그
  OFF면 그런 메시지 없어 무변화). **실제 dispatch-path 통합테스트 추가**로 회귀 방지.
- **[통합] GD 릴레이가 collector 자율선택 의존** — 번들에 `reply_mode='direct_to_gd'` 미표시라
  openclaw/hermes가 자발적 `--direct-to-gd` 재발신해야 했는데 그건 신뢰불가([[reference_runtime_relay_to_gd_gap]]).
  fix = 번들 meta에 `reply_mode='direct_to_gd'` 각인 → collector 응답이 case-6 경로로 GD DM에 **자동 릴레이**.
- **[정확성 F1] 타임스탬프 파싱실패→never-close** — `Number.isFinite` 가드가 무한대기로 fail-open. fix =
  파싱실패=timeout(fail-closed)으로 "timeout 항상 발화" 보장 강제.
- **[정확성 F2] 동시성 double-wake** — emitWake가 status 가드보다 먼저. fix = 트랜잭션 claim-first(status
  UPDATE 후 emit) → exactly-once + 실패시 롤백(번들 유실 없음).
- **[정확성 F4] pair-fallback이 무관 채팅 삼킴** — expected 멤버의 in_reply_to 없는 무관 메시지가 번들에
  삼켜지고 실답 overwrite+억제. fix = **fallback 제거, in_reply_to 정밀매칭만**(reply-thread 안 한 멤버는
  미응답 처리 = safe over-report). Codex 권고와 일치.
- **[정확성 F5] late답이 on-time답 덮어씀** — upsert가 shipped 답을 late로 clobber→recompute시 오'미응답'.
  fix = upsert WHERE 가드(late는 기존 on-time 못 덮음).
- **[정확성 F6b] 비원자 create** — collection INSERT 후 expected INSERT 실패시 header가 0-expected로
  방치. fix = 트랜잭션 원자화.

플래그 OFF=무변화 렌즈 = **SHIP**(무쓰기 no-op·기존 리마인더 가드 비반전·신규테이블 미접근 확인).

## 6.6 알려진 한계 (정직 명시)

- **[F3] 같은 스레드 동시 수집 병합**: collection은 (collector, thread) 키라, 한 스레드에서 collector에게
  **동시에 두 개의 다른 GD 과업**을 주면 하나의 collection으로 병합됨(한 번들에 섞임). 관측상 GD 위임은
  과업별로 스레드가 갈리므로(예: jeju-weather 스레드) 실무에선 드묾. 완전분리하려면 과업ID가 필요한데 그건
  collector 협조를 요해 회피함. v1 한계로 명시, 필요시 후속에 과업ID 스코프 추가.
- **[F-race·LOW] ingress-record ↔ dispatch-gate TOCTOU**: close tick이 그 사이에 발화하면 collector가
  번들 wake + 이미 번들된 답의 자연 wake를 한 번 더 받을 수 있음(폴 1.5s창, 정확성 손상 아님·중복 1회).
- **[사각] 팬아웃 없는 혼자처리+망각**: 버스 신호가 없어 이 설계도 못 잡음(§3.10).
- **[F5-잔여·재검증] 자동 GD릴레이 degrade 조건**: 번들은 collection 스레드를 상속하는데, 그 스레드가
  `tg-` 그룹 스레드거나 `owner_chat_id` 미설정이면 `resolveDirectToGd`가 null→collector 자율 self-relay로
  degrade(F5가 없애려던 그 불안정으로 폴백). 관측상 GD 위임의 collector 팬아웃은 버스(non-tg) 스레드라
  common-path는 동작. **라이브 ON 전 owner_chat_id 설정 확인 필수** + tg-스레드 팬아웃 케이스 후속 테스트 권장.

## 7. 검증 계획

- 유닛: expected append(depth-1·재팬아웃), last-write-wins, close=all/timeout, 미응답명시, idempotent
  close-wake(중복 방지), late 답 불변, fallback 공존, 플래그 OFF=no-op.
- tsc 0 + 기존 테스트 회귀 0.
- 하네스 적대검증(구현): 특히 "플래그 OFF가 진짜 무변화인가", exactly-once wake, 무한대기 불가.
- 라이브: GD 승인 후 flag ON + 실제 위임 1건 KST 관측.
</content>
</invoke>
