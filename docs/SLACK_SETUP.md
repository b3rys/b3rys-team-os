# Slack 통합 셋업 (per agent)

AI team의 각 agent가 자기 Slack App + bot user를 갖는다. 모두 같은 채널에서 사용자가 `@team_<name>` 멘션하면 해당 agent만 트리거 → thread 댓글로 자동 응답.

**예상 시간**: agent 당 ~3분 (팀원 수 × 3분 + 검증).

---

## 사전 조건 (워크스페이스 1회 셋업)

1. **Slack workspace**: 대상 workspace
2. **채널 생성**: `#team-ai` (private, AI team 전용)
   - 새 채널 → Add bookmark `<dashboard-url>/team` (대시보드 빠른 진입)
3. **Cloudflare Access Bypass** — Slack webhook 이 우리 endpoint 도달해야 함
   - Zero Trust → Access → Applications → **Add an application** (Self-hosted)
     - Name: `slack-webhook-bypass`
     - Domain: `<dashboard-domain>`
     - **Path**: `/team/api/slack/events`
     - Policy: action **Bypass**, include Everyone
   - 이거 안 하면 Slack 의 verification challenge 가 CF Access 로그인 페이지로 리다이렉트되어 fail
4. **대표 App만 한 번** Event Subscriptions URL verify → 이후 모든 App은 같은 URL 그대로 즉시 통과

---

## Agent 당 등록 절차 (반복)

`<NAME>` = 소문자 agent id (agent-a / coordinator / ...)
`<Name>` = 표시명 (Agent A / Coordinator / ...)

### ① App 생성
- https://api.slack.com/apps → **Create New App** → **From scratch**
- App Name: `Team <Name>`
- Workspace: 대상 workspace

### ② Bot 권한
(좌측 메뉴) **OAuth & Permissions**
- Scopes → Bot Token Scopes → Add OAuth Scope:
  - `app_mentions:read` (멘션 수신)
  - `chat:write` (thread 댓글 / channel post)
  - `groups:history` (private 채널 메시지 읽기)
- 페이지 상단 → **Install to workspace** → 권한 승인

### ③ Event Subscriptions
(좌측 메뉴) **Event Subscriptions**
- Enable Events: **ON**
- Request URL: `<dashboard-url>/team/api/slack/events`
- "Subscribe to bot events" → **Add Bot User Event** → `app_mention`
- **Save Changes** (필수)

### ④ 토큰 두 개 추출
| 항목 | 위치 | 형태 |
|---|---|---|
| **Bot User OAuth Token** | OAuth & Permissions 상단 | `xoxb-숫자-숫자-문자열` |
| **Signing Secret** | Basic Information → "App Credentials" → Show | 32자 16진수 |

**무시할 토큰** (Slack UI 에 같이 보이지만 우리 안 씀):
- *Verification Token* — 2018 deprecated, Signing Secret 으로 대체됨
- *App-Level Token* (`xapp-...`) — Socket Mode 용, 우리는 public webhook 쓰니 불필요

→ 두 값을 아래 형식으로 안전한 곳에 기록해 둡니다(다음 "서버 측 처리" 단계에서 `slack-tokens/<name>.env` 로 저장). 토큰은 채팅·로그에 평문으로 남기지 마세요:
```
<NAME> token: xoxb-...
<NAME> secret: ...
```

### ⑤ 아이콘 업로드
- **Basic Information** → "Display Information" → App Icon
- `assets/slack-avatars/<name>.png` (repo 루트 기준) 업로드
- (Optional) Background color: `#0F172A` (대시보드 surface-2 와 일치)
- Short Description / Long Description: persona 한 줄 요약

### ⑥ 채널 초대
- Slack `#team-ai` 입력창:
  ```
  /invite @team_<name>
  ```

### ⑦ 첫 멘션 테스트
- 채널에:
  ```
  @team_<name> 안녕!
  ```
- 봇이 같은 thread 에 댓글로 응답 → 성공
- 동시에 대시보드 `<dashboard-url>/team` THREADS 패널에 새 thread 표시

---

## 서버 측 처리 (④ 에서 기록한 토큰으로 호스트에서 진행)

호스트에서 직접(또는 담당 agent 세션에서) 아래를 수행합니다:

1. `slack-tokens/<name>.env` 작성 (Write 도구, chmod 600) — `SLACK_BOT_TOKEN=xoxb-...` / `SLACK_SIGNING_SECRET=...`
2. **토큰 검증** — Slack `auth.test` API 로 team / bot_user_id 확인 (토큰은 stdout 에 노출하지 않고 파일에서 주입):
   ```bash
   # slack-tokens/<name>.env 를 로드해 Bearer 로만 넘긴다. 토큰 값은 출력하지 않는다.
   set -a; . slack-tokens/<name>.env; set +a
   curl -sS -H "Authorization: Bearer $SLACK_BOT_TOKEN" https://slack.com/api/auth.test \
     | python3 -c 'import sys,json; d=json.load(sys.stdin); print("ok=",d.get("ok"),"team=",d.get("team"),"bot_user_id=",d.get("user_id"))'
   unset SLACK_BOT_TOKEN SLACK_SIGNING_SECRET
   ```
   `ok= True` 와 함께 team / bot_user_id 가 나오면 성공. `ok= False` 면 `error` 필드(`invalid_auth` 등) 확인.
3. `agents.json` 에 `slack_bot_user_id` 필드 추가 (위 `bot_user_id` 값)
4. registry watch (`fs.watch`) 가 자동 reload → in-memory agents 갱신
5. 이어서 ⑤⑥⑦ (아이콘 업로드 · 채널 초대 · 첫 멘션 테스트) 를 진행

---

## 전체 흐름 (멘션 → 자동 응답)

```
사용자: "@team_agent_a 안녕"
   │
   ▼
Slack Events API
   │
   ▼
CF Tunnel → CF Access Bypass(/team/api/slack/events) → localhost:7878
   │
   ▼
POST /api/slack/events
   ├─ Signing Secret 으로 HMAC 검증 (위조 차단)
   ├─ payload.api_app_id 로 어느 agent 의 webhook 인지 식별
   ├─ event.text 안의 <@U...> → registry 의 slack_bot_user_id 매칭 → target = agent-a
   ├─ envelope 저장 (DB message + meta.slack = {channel, thread_ts})
   ├─ WS broadcast (대시보드 실시간 갱신)
   └─ tmux send-keys 로 claude-agent-a 세션에 <external_message> wrapper 주입
   │
   ▼
claude-agent-a 의 Claude Code 세션
   ├─ wrapper 보고 외부 메시지로 인식
   ├─ 응답 작성
   └─ skills/b3os-team-inbox/scripts/send.sh --to user --thread X --in-reply-to Y --body "..."
   │
   ▼
POST /api/inbox
   ├─ envelope 저장
   ├─ thread 의 첫 메시지 meta_json 에서 slack 정보 추출
   ├─ slack-tokens/agent-a.env 의 bot token 으로 chat.postMessage(thread_ts) 호출
   └─ audit: slack_relay_sent {ok:true, ts:...}
   │
   ▼
Slack thread 에 agent A 답글 표시
```

---

## 자발적 channel post (멘션 없이)

스킬 헬퍼:
```bash
skills/b3os-team-inbox/scripts/slack-post.sh \
  --channel <channel-id> \
  --text "공지 내용"
```

- `<channel-id>` = 대상 Slack 채널 id (채널 이름 우클릭 → "채널 세부정보 보기" 하단, 또는 채널 URL 끝 `C...` 문자열)
- `--thread <ts>` 있으면 thread 댓글, 없으면 채널 최상위 글
- `--as <agent>` 명시 안 하면 tmux 세션명에서 자동 감지

활용:
- 주간 미팅 안건 던지기 ("@channel 이번 주 진행상황 thread 댓글 부탁")
- 시스템 알림
- briefing agent 일일 뉴스 요약

---

## 트러블슈팅

| 증상 | 원인 | 해결 |
|---|---|---|
| "Your URL didn't respond with the value of the challenge parameter" | CF Access 가 Slack webhook 차단 (Email OTP 로그인 페이지로 리다이렉트) | 사전 조건 #3 (Bypass app) 추가 |
| 멘션해도 봇 응답 없음 | (1) 채널에 봇 초대 안 됨 (2) Event Subscriptions Save 안 함 (3) `app_mention` scope 누락 | 위 ② ③ ⑥ 재확인 |
| signature mismatch 로그 | Signing Secret 잘못 저장 | 위 "토큰 검증"(`auth.test`) 으로 bot token 확인 + `slack-tokens/<name>.env` 의 `SLACK_SIGNING_SECRET` 이 Basic Information 값과 일치하는지 대조, 안 되면 Slack 에서 Regenerate |
| bot 끼리 무한 응답 | echo prevention bug | `routes/slack.ts` 의 `if (ev.bot_id) return;` 확인 (현재 적용됨) |
| token leak 우려 | 메시지/로그 검색 | BotFather/Slack 에서 Revoke → 새 토큰 → `slack-tokens/<name>.env` 갱신 → LaunchAgent kickstart |

---

## 보안

- `slack-tokens/` 디렉토리: chmod 700, `.env` 파일: chmod 600
- `.gitignore` 에 `slack-tokens/` 포함 (커밋 금지)
- 토큰을 stdout 으로 echo 금지 (Claude Code .jsonl 세션 로그에 영구 기록 위험)
- 검증은 위 "토큰 검증"(`auth.test`) 처럼 `.env` 에서 Bearer 로만 주입해 team/user_id 만 출력하고, 끝나면 `unset` — 토큰 값 자체는 절대 출력하지 않는다

---

## 향후 (사이드 목표)

`team-collab-skill` (외부 공개용 playbook) 의 일부로 이 절차 그대로 가져감. 다른 조직이 fork 해서 자기 팀 구성할 때 동일하게 적용 가능.
