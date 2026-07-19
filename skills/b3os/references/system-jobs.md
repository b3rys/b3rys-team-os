# b3os 기본 시스템 잡 목록 (기본 운영 서비스)

`bun run start` 로 b3os 를 띄우면, 팀원(에이전트)과 별개로 **서버가 백그라운드에서 돌리는 시스템 서비스**들이 있다.
이 문서가 그 ★단일 인벤토리★다 — 사용자에게 "무엇이 자동으로 돌고 있는지" 안내하고, 새 잡을 추가할 때 여기에 등록한다.

> 원칙: **새 시스템 잡(워커·스케줄 잡)을 추가하면 반드시 이 표에 한 줄 넣는다.** 그래야 "뭐가 도는지" 한곳에서 보인다.

## 1) 항상 켜짐 (부팅 시 무조건 시작)

| 잡 | 하는 일 | 주기 | 상태 로그 |
|---|---|---|---|
| **status probe** | 각 팀원의 런타임·채널 연결 상태를 프로브해 대시보드 **Topology** 갱신 | ~5s | — |
| **metrics probe** | 팀 활동 메트릭 수집(대시보드 표시용) | ~30s | — |
| **message maintenance** | 오래된 메시지/레코드 정리(GC) | 주기 | — |
| **tmux tail** | claude 봇 tmux 세션 로그를 tail 해 상태·출력 스트림 | 상시 | — |
| **telegram capture** | 팀 텔레그램 **그룹**의 입구(ingress) — 그룹 메시지를 담당 팀원에게 라우팅. ★주입(라우팅)은 `router_enabled` 로 게이트★: 라우터 OFF(기본)면 결정만 shadow 로깅하고 실제 주입 안 함 | 상시 | `[capture] started` |
| **dm sync** | 각 런타임 저장소의 **팀장 1:1 DM**을 `dm_message` 로 동기화(재시작 후 맥락 recall용) | ~10s | `[dm_sync]` |
| **health check** | `agent_status` 를 주기 분류해 위험 전이 감지 — **관측 전용(observe-only Phase 1)**, 자동 조치는 안 함 | ~30s | `[health] started` |
| **proposal sweeper** | proposal(개선 제안) 파이프라인이 담당자 무응답으로 정체되면 복구하는 안전망 | 주기 | — |
| **followup worker** | pending follow-up 을 재기동 — one-shot 재알림(예: 팀장 응답 리마인더/`expect-report`) | ~60s | — |
| **wake dispatcher** | 팀 버스 wake 디스패치 — 팀원을 실제로 깨우는 주체. ★기본 ON★(OWNER 2026-07-19): 명시적 `BUS_DISPATCH_ENABLED=false` 일 때만 shadow(결정만 로깅). | ~1.5s | `[bus_dispatcher] started — enabled=true poll=1500ms` |
| **teamos render** | 부팅 시 1회 — 팀 페르소나·핵심룰을 템플릿에서 각 팀원 파일(`CLAUDE.md`/`AGENTS.md`/`SOUL.md`)로 렌더 | 부팅 1회 | `[teamos-render]` |

## 2) 조건부 (설정이 있어야 실제 동작)

| 잡 | 켜지는 조건 | 하는 일 |
|---|---|---|
| **scheduler** | `B3OS_SCHEDULER_ENABLED=true` (그리고 `B3OS_SCHEDULER_DRY_RUN=0`) — 없으면 꺼짐/드라이런 | 예약 리마인더 잡을 예정 시각에 실행(`POST /team/api/schedules/reminder` 로 등록) · 로그 `[scheduler_worker] started dry_run=…` |
| **slack poll / socket** | 슬랙 토큰이 설정됐을 때만 | 슬랙 채널 수신(Socket Mode) |

## 3) 온디맨드 (스케줄 잡 아님 — System OP 봇 명령)

그룹/DM 에서 물으면 그때 답하는 명령(팀방 협업 셋업 시): `/status`(팀 상태) · `/board`(칸반) · `/digest`(요약) · `/approve`(민감 실행 승인) · `/onoff`(라우터/기능 토글).

## 관리 방법 (권장)

시스템 잡이 늘수록 "뭐가 도는지" 관리가 어려워진다. 세 축으로 관리한다:

1. **인벤토리 = 이 문서.** 모든 시스템 잡의 단일 목록. 새 잡을 추가하면 여기에 등록한다(코드에만 있고 목록에 없으면 "그림자 잡"이 된다).
2. **런타임 상태 확인.** 지금 실제로 뭐가 켜졌는지는 ★부팅 로그★가 정본이다 — 각 워커가 `[name] started …`(또는 `disabled`)를 찍는다. `router_enabled`·scheduler 활성은 `GET /team/api/system-op` 로 실시간 확인.
   ```bash
   # 라우터/스케줄러 등 토글 상태
   curl -s http://localhost:$PORT/team/api/system-op
   # 켜진 워커(이 부팅에서 뭐가 떴나)
   grep -E "started|disabled|SHADOW" <서버 로그>
   ```
3. **게이트는 env 로.** 위험하거나 실행부가 무거운 잡은 env 플래그로 켠다(예: scheduler 는 기본 OFF). 반대로 협업 필수 잡(wake dispatcher)은 기본 ON — 명시적 `=false` 로만 끈다.

> 개선 후보(팀 리드 검토): 대시보드에 **"System Jobs" 패널**을 추가해 각 워커의 켜짐/주기/마지막 tick 을 한 화면에 노출하면, 로그를 grep 하지 않고도 "뭐가 도는지"를 볼 수 있다. (신규 엔드포인트 `GET /team/api/system/jobs` + 패널 — 승인 후 구현.)
