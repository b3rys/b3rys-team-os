# b3os 그룹방 라우팅·리액션 아키텍처 (단일 입구 3층 구조)

> 팀 텔레그램 단톡방에서 "GD가 메시지 1개 보내면 무슨 일이 나는가" — 수신·라우팅·응답·리액션을 런타임별로 정리한 정본.
> 2026-07-22 규명 (3 런타임 owner 실측 + 코드 검증 + 하네스 교차검증). codex 네이티브(dex)는 테스트 중이라 별도 검증 예정.

## 한 줄 요약

**"받는 것 ≠ 처리하는 것."** 텔레그램은 관리자인 봇 전부에 메시지를 배달하지만, 실제로 "누가 답하는가"는 **전용 캡처봇 → 서버 라우터**가 담당자 1명(들)만 골라 깨우는 **단일 입구(single ingress)**로 수렴한다. 그래서 팀원이 N명이어도 그룹 메시지 1건은 서버에 1번만 처리되고, LLM 턴도 담당자만 돈다. **N배 폭주는 구조적으로 없다.**

## 3층 구조

### 1층 — 텔레그램 (수신)
- 봇이 그룹 **관리자**(privacy off)이면 자기 @멘션이 아닌 일반 메시지도 받는다(`can_read_all_group_messages=true`).
- 단 이건 **raw 수신**일 뿐. 소비·처리는 별개.
- ⚠️ 텔레그램은 **봇↔봇 메시지를 절대 전달하지 않는다**(관리자여도). → 팀원 답변은 반드시 서버 릴레이(`send.sh`)로 버스에 기록돼야 하며, 봇이 그룹에 직접 게시하면 캡처봇에 안 보여 기록 0건으로 유실된다.

### 2층 — 서버 (핵심 게이트)
- **전용 캡처봇**(별도 토큰, `CAPTURE_BOT_TOKEN`)이 그룹을 한 번 폴링해 읽는다.
- 서버 라우터(`routeTeamMessageHybrid`)가 주인을 정한다: **`@멘션 > 답장 작성자 > sticky owner(직전 담당자)`**.
- 선택된 대상(들)에게만 버스 recipient 행을 만들어 런타임별로 주입한다. 다른 관리자 봇은 raw는 받아도 **서버가 깨우지 않는다.**
- 예: `route.reason=active_assignee_followup, targets=[demis,devon,ames]` → 셋만 깨움.

### 3층 — 런타임 (추가 방어선)
- 각 런타임도 자기 룰로 무관한 메시지를 거른다: claude=`requireMention:true`, hermes=`require_mention:true` + `observe_unmentioned_group_messages:false`, 공통 TEAM-OS "비주인 침묵".
- 서버 게이트가 1차, 런타임 설정·팀 룰이 2·3차.

## 👀 리액션 플로우 (공통 원리)

```
캡처봇 수신 → 라우터 대상 선정 → 대상 wake 시작(LLM 턴 열리기 前)
  → 대상 봇 토큰으로 원본 메시지에 setMessageReaction(👀)
  → 그다음 턴 열림 → 대상이 send.sh 로 응답 게시
```

- ★리액션은 **"답변 완료" 신호가 아니라 "받았어요 / 대상 선정·호출 시작" 신호**★ — wake 순간에 붙는다(응답 생성 전).
- 붙이는 **주체**는 런타임마다 다르지만, 항상 **대상 멤버 자기 봇 토큰**으로 찍는다.
- **관리자(can_read_all=true) 필수:** 봇이 원본 메시지를 "볼 수 있어야" 리액션이 붙는다. 참가자(member)면 `Bad Request: message to react not found`로 조용히 실패한다.

## 런타임별 상세 (claude / hermes / openclaw)

| 런타임 | 그룹 수신 | 응답 대상 | 👀 붙이는 주체 | 발신 |
|---|---|---|---|---|
| **claude** | 자기 플러그인이 폴링하나 `requireMention:true`라 **자기 @username 멘션만** 처리. 무-멘션 owned는 캡처가 tmux 주입 | 자기 담당(@멘션/sticky/reply) | **자기 플러그인**(UserPromptSubmit 훅, `ackReaction`) | claude 세션이 `send.sh` 직접 |
| **hermes** | 게이트웨이는 그룹 폴러 없음(one-shot `hermes -z` spawn). 오직 캡처가 구동 | 캡처가 owner일 때만 `runHermesTeamTurn` | **서버**(`reactTelegramAsHermes`, hermes 봇 토큰) | hermes가 `send.sh` 직접 (turn stdout 자동게시 안 함) |
| **openclaw** | 런타임이 그룹 폴링 안 함(groupPolicy `open→disabled`). 캡처만 구동(게이트웨이 세션) | 캡처가 owner일 때만 `injectOpenclawTelegramTurn` | **서버**(`reactTelegramAsOpenclaw`, openclaw 봇 토큰) | openclaw agent가 `send.sh` 직접 |

**결론:** claude·openclaw·hermes는 **같은 서버-주도 단일 입구 패턴**이라 이중응답·이중리액션이 없다. 리액션을 붙이는 코드 위치만 런타임별로 다르다(claude=자기 훅 / hermes·openclaw=서버 브리지).

## 봇 초대 규칙 (운영·온보딩)

- **Team OP(캡처봇)** = 그룹 **관리자 필수** (그룹 모든 메시지를 읽어 라우팅해야 하므로).
- **팀원 봇(claude/hermes/openclaw)** = **그룹 관리자로 초대해야 👀 리액션이 붙는다.**
  - 이유: 리액션(`setMessageReaction`)은 봇이 그 메시지를 "볼 수 있어야" 가능하고, 참가자(member)는 `can_read_all_group_messages=false`라 원본을 못 봐 `message to react not found`로 실패한다.
  - 텍스트 응답 자체는 참가자여도 되지만(캡처→서버가 주입, 응답은 자기 봇 토큰으로 발신), **네이티브 리액션은 관리자 필요.**
  - 위험 권한(삭제/사용자 관리)은 불필요 — 메시지 접근 권한(관리자)만 있으면 된다.
- **"다 관리자면 시끄럽지 않나?"** → 안 시끄럽다. `requireMention:true`(claude)와 서버 owner-gate가 자기 담당 아닌 메시지를 LLM 전에 버린다. 관리자여도 **잡담엔 LLM이 안 돈다.**

## 자주 하는 오해

- ❌ "봇 10명이 관리자면 메시지 1건이 서버에 10번 온다" → 실제로 그룹 라우팅은 **캡처봇 하나**가 소비한다. 서버 처리 1번.
- ❌ "멘션 안 된 팀원이 조용한 건 버그" → 정상. 서버가 안 깨우고(1차), 룰이 응답 금지(2차).
- ❌ "답변에 👀 이모지를 넣으면 리액션" → 아니다. 네이티브 리액션은 GD 원본 메시지에 붙는 별도 배지이며, 봇이 관리자여야 붙는다.

---
_규명: 2026-07-22 · Devon(openclaw)·Ames(hermes)·Demis(claude) 런타임 실측 + 코드 검증 + 하네스 교차검증. codex 네이티브(dex)는 테스트 중 — 별도 검증 예정._
