# 영입(recruit) 상세 — API·UI·페어링

첫 팀원을 실제 대화 가능한 봇으로 붙이는 전 과정. 서버가 `http://localhost:$PORT` 에 떠 있고
`.env` 에 `APPROVAL_EXECUTION_ENABLED=1`(활성화 승인)이 켜져 있어야 한다.

> **★ 포트 ($PORT)** — 아래 모든 `localhost:$PORT` 는 `.env` 의 `TEAM_HTTP_PORT`(기본 **7878**)를 뜻한다. curl 을 실행하기 전에 한 셸에서 실포트를 한 번 잡고, 그 셸에서 이어 실행한다(새 셸이면 이 줄을 다시):
> ```bash
> PORT=$(grep '^TEAM_HTTP_PORT=' "${B3OS:-$HOME/b3rys-team-os}/.env" 2>/dev/null | cut -d= -f2); PORT=${PORT:-7878}   # 커스텀 설치 위치면 B3OS 를 먼저 export
> ```

> API base = `http://localhost:$PORT/team/api` (대시보드 `app`는 `/team`, 그 아래 REST는 `/api`).
> 상태 조회 = `GET /team/api/ot/<ot_id>` · `GET /team/api/settings` · `GET /team/api/members`.

## 두 갈래 — 결과는 동일

- **대시보드 UI (권장)**: `http://localhost:$PORT/team` ▸ **Settings** 의 영입 마법사(스테퍼)가
  아래 단계를 화면에서 순서대로 안내한다(팀 기본정보 → 팀원정보 → 봇토큰 → 활성화 → 페어링). 사용자가
  직접 눌러도 되고 Claude가 코치해도 된다. 화면의 스테퍼가 각 단계 상태(대기/완료/막힘)를 그대로 보여준다.
- **API (Claude 자동화)**: 아래 순서로 Claude가 `curl` 로 호출. UI와 같은 엔드포인트를 쓴다.

## OT(오리엔테이션) 단계 모델

영입 = 등록(register) + OT. OT 단계는:
`register → provision(봇 토큰) → preflight(런타임 로그인 점검) → bundle(활성화+팀지식 주입) → join(첫 응답)`.
recruit 시 register=done, 나머지 pending. 각 API 호출이 다음 단계를 진행시킨다.

> **OT 중단 → 재개** — 세션이 끊겨 `ot_id` 를 잃어도 재개할 수 있다:
> - 진행 중 OT 목록: `GET /team/api/ot/active` → `ot_id`·member·현재 단계 확인 후 그 `ot_id` 로 이어간다.
> - 이미 등록된 id 로 다시 recruit 하면 `409 id_exists` 응답에 그 팀원의 `ot_id` 가 실려 온다(재영입 말고 그 id 로 이어가기).
> - 정 안 되면 offboard(`DELETE /team/api/members/<id>`) 후 처음부터 재영입.

## Step A — 팀 기본정보 (1회, 안 하면 recruit가 400)

**채팅으로 물어본다** — "화면에서 넣으세요"로 미루지 않는다. 팀명·팀장ID·팀장이름은 필수, 미션은 선택(비면 기본값).
**팀명·팀장ID는 `/settings`, 미션은 별도 `/mission` 엔드포인트**로 나뉘어 있다(실제 백엔드 구조).

```bash
# ① 팀명 + 팀장ID + 팀장이름(owner_name = 사람 이름)
curl -s -X PUT http://localhost:$PORT/team/api/settings \
  -H 'content-type: application/json' \
  -d '{"team_name":"acme","lead_id":"teamleader","owner_name":"Alex"}'
# team_name ≤ 20자 · lead_id = 소문자/숫자/-/_ 1~40자(팀장 식별자, 영문 slug).
# 응답에 "setup_complete": true 면 영입 가능.

# ② 미션 (선택) — 사용자가 준 값. 비었으면 아래 기본 미션 문자열을 넣는다(대시보드에서 나중에 편집 가능).
curl -s -X PUT http://localhost:$PORT/team/api/mission \
  -H 'content-type: application/json' \
  -d '{"mission":"우리 팀은 각 팀원의 전문성을 살려, 팀장의 과제와 프로젝트를 최고의 팀워크로 수행합니다."}'
# PUT /mission 은 TEAM-OS §1 미션 블록을 갱신한다. non-empty string 필수(빈 값은 400) → 그래서 기본값을 넣음.
```

## Step B — 영입(recruit)

> **팀원 정보는 사용자에게 직접 물어본다.** id·표시이름·역할·**멘션 별칭**, 그리고 **`persona`(성격·말투·전문성 한두 줄 — 선택)** 를 사용자가 정하게 한다. **특정 이름을 기본값·선택지로 제시하지 않는다**(예: `1) bill 2) dev` 같은 메뉴 금지 — 헷갈림). 형식과 중립 예시만 안내한다.
> 예: *"만들 팀원의 id를 정해주세요 — 영문 소문자 slug (예: `alex`, `sam`). 표시이름·역할도요. **`@`로 부를 멘션명(별칭)** 도 정해주세요 — ★안 정하면 id·표시이름으로 부를 수 있고, 짧게 더 부를 이름이 있으면 넣으면 됩니다★(쉼표로 여러 개, 나중에 대시보드 Settings에서 변경 가능). 그리고 **성격·말투·전문성 같은 persona**를 한두 줄로 정해줄래요? (선택 — 지금 비워도 되고, 나중에 대시보드 Settings에서 넣을 수 있어요.)"*
> ★멘션명은 항상 물어본다(질문 생략 금지). 사용자가 안 정하면 자동으로 `[id, 표시이름]` 이 별칭으로 들어가니 "안 넣어도 부를 수 있다"고 안내하되, 물음 자체는 건너뛰지 않는다.★
> ★persona를 주면 SOUL.md 로 저장되고, 비우면 SOUL.md 없이 진행된다(나중에 대시보드에서 추가 가능). 물어는 보되 강요하지 않는다.★

```bash
# 아래 값들은 형식 예시일 뿐 — 실제로는 사용자가 정한 id·이름·역할·별칭을 넣는다.
curl -s -X POST http://localhost:$PORT/team/api/members/recruit \
  -H 'content-type: application/json' \
  -d '{"id":"alex","display_name":"Alex","nicknames":"al,알렉스","role":"백엔드 개발자","runtime":"claude_channel","persona":"backend/infra 담당"}'
```
- `id`: 소문자/숫자/-/_, 2~32자, 영문자 시작 (예시일 뿐 — **사용자가 정한 값 사용**). 멘션 라우팅 키.
- `nicknames`(선택): **`@`멘션 별칭** — 쉼표 구분 문자열(예: `"al,알렉스"`). **id·표시이름은 자동 포함**되니 그 외 추가로 불릴 이름만 넣는다(비우면 `[id, display_name]`). 셋업 후 변경은 `PATCH /members/<id>` 에 `{"nicknames":["al","알렉스"]}` **배열**로.
- `runtime`: **기본 추천은 `claude_channel`**(기존 Claude 로그인 재사용, 추가 구독 불필요). 공개 표면에서는
  `claude_channel`·`openclaw`·`hermes_agent`만 안내한다. `openclaw`·`hermes_agent`는 BYO 고급 런타임이라
  먼저 `runtime-setup.md`의 설치·인증 절차를 끝내야 한다.
  런타임을 고른 뒤 **그 런타임만** 인증 preflight(CLI·로그인) 점검 — 구독을 미리 캐묻지 않는다.
- `persona`(선택): 능력/강점 — 페르소나 파일에 주입.
- 응답: `{ ok, ot_id, member, persona_file }`. **이 `ot_id` 를 이후 단계에 쓴다.**
  - 팀원 작업공간은 `$B3RYS_HOME/members/<팀원id>/` 에 생성된다(install.sh가 `B3RYS_HOME=$HOME/b3os` 세팅 → `~/b3os/members/<팀원id>/`. 페르소나 `SOUL.md` + 규칙 `CLAUDE.md`/`AGENTS.md` + `TEAM-OS.md` 심링크, **리포 밖 자체완결 루트**). B3RYS_HOME 미설정 시에만 `~/Development/<팀원id>` fallback(개발 머신).
- 첫 영입 멤버는 자동으로 `coordinator` capability를 받는다(라우팅 안전망).
- 중복 id = 409, 잘못된 runtime = 400.

## Step C — 봇 만들고 토큰 받기 (★ 사람만)

Claude가 사용자에게 안내한다. 이 BotFather 4단계는 `claude_channel`·`openclaw`·`hermes_agent` 모두 동일하다:
```
텔레그램 앱에서 @BotFather 열고:
  ① /newbot
  ② Bot name 입력 (사람이 볼 이름, 예: "Alex Bot")
  ③ Bot username 입력 (반드시 'bot' 또는 '_bot' 으로 끝, 예: my_alex_bot)
  ④ BotFather가 준 토큰(예: 1234567:ABC...) 을 받으세요.
```

> **토큰 입력 — 여러분의 Claude Code에 바로 붙여넣으면 됩니다.** 공개 설치는 **본인 머신·본인 Claude Code·본인 봇 토큰**이라(팀 공유 환경이 아님), 토큰을 Claude Code에 입력하고 Claude가 provision API로 넘기면 됩니다. 봇 토큰은 revocable(재발급 가능)·저위험이라 실용적으로 안전합니다. Claude는 받은 토큰을 provision 호출에만 쓰고 화면에 다시 출력하지 않습니다.
>
> **더 조심하고 싶다면(로컬 대화 로그에도 안 남기려면 · 선택):** `http://localhost:$PORT/team` ▸ **Settings** 영입 마법사의 **봇 토큰** 보안 입력칸(`secret`)에 사용자가 **직접** 붙여넣으세요 — 값이 브라우저→로컬 서버로만 가고 AI 대화창을 거치지 않습니다. 이 경우 Claude는 "그 칸에 넣어 주세요"라고 코치만 합니다.

## Step D — provision (토큰 안전저장)

provision 은 토큰을 받아 서버 로컬(`var/secrets/<id>.bot-token`, 0600)에만 안전저장한다. 기본은 **사용자가 Claude Code에 준 토큰을 Claude가 provision 호출로 넘기는 것**(본인 머신이라 실용적으로 안전). 대시보드 보안입력칸을 쓰면 UI가 이 호출을 대신 한다.

```bash
# 토큰은 파일에서 읽어 넘긴다(리터럴 금지). 대시보드 UI로 넣으면 이 호출은 UI가 대신 함.
curl -s -X POST http://localhost:$PORT/team/api/ot/<ot_id>/provision \
  -H 'content-type: application/json' \
  -d "{\"bot_token\":\"$(cat <토큰파일경로>)\"}"
```
- 서버가 토큰을 `var/secrets/<id>.bot-token` 에 **0600** 으로 저장(값은 로그/응답에 안 나옴).
- 형식 검증: `<숫자6+>:<30자+>`. 안 맞으면 `bot_token_invalid` 400.
- provision 직후 **preflight**(런타임 oauth 로그인 점검)를 돌린다. 미로그인이면 `preflight: blocked` +
  fixHint(예: "터미널에서 `claude` 로그인") 이 온다 → 사용자에게 로그인 요청 후 Step E 재확인.

## Step E — activate (런타임 기동)

```bash
curl -s -X POST http://localhost:$PORT/team/api/ot/<ot_id>/activate
```
- **`APPROVAL_EXECUTION_ENABLED=1` 필요.** 없으면 `runtime: 실행 OFF` 로 막힌다(활성화 스위치 안 켬).
- 미로그인이면 `runtime_auth_required` 400 + fixHint → 로그인 후 재시도.
- claude_channel: 토큰을 채널 `.env`(`~/.claude/channels/telegram-<id>/.env`)에 배치 → LaunchAgent plist 생성
  → tmux 봇 기동 → **poller 헬스게이트**(봇이 `bot.pid` 를 써야 '진짜 대화됨', 기본 28s 대기). `bot.pid`
  미출현이면 `poller 미기동` = 귀머거리 봇 → 재활성화 필요(대개 Step F 플러그인 미설치가 원인). ★첫 activate 는 플러그인(Step F) 설치 전이라 poller 미기동이 나오는 게 정상 — 실패가 아니다. Step F 설치 후 재활성화하면 통과한다.★
- 성공하면 OT `bundle=done`. claude/hermes 는 첫 모델 호출 또는 게이트웨이 확인 시 `join=done`(합류 완료).

## Step F — telegram 플러그인 설치 (claude 런타임, user scope 1회)

> ★순서: 이 단계는 **Step E(activate) 다음**에 한다 — activate 로 tmux 세션 `claude-<id>` 가 떠야 그 안에서 플러그인을 깔 수 있다. 설치 후엔 봇이 메시지를 받도록 재활성화(또는 세션에서 `/reload-plugins`).★

claude 봇이 텔레그램 메시지를 받으려면 telegram 플러그인이 **user scope로 한 번** 설치돼 있어야 한다
(그 머신의 모든 Claude 봇이 공유). 이미 다른 Claude 봇 세팅으로 설치했으면 건너뛴다.

> ★비개발 사용자도 tmux 를 직접 만지지 않는다 — 아래 명령은 **Claude Code(b3os 스킬)가 사용자 대신 실행**한다.★ 사용자는 지켜만 보면 된다.

- **가장 쉬운 길**: `setup-claude-telegram-bot` 스킬이 있으면 Claude 가 거기에 맡겨 자동 설치한다.
- **그 스킬이 없으면(공개 릴리스 기본)**: Claude 가 아래를 대신 실행한다 — 활성화(Step E)로 뜬 tmux 세션 `claude-<id>` 안에서:
  ```bash
  tmux attach -t claude-<id>
  # 세션 안에서:
  /plugin install telegram@claude-plugins-official    # → user scope 선택
  /reload-plugins
  # detach: Ctrl-b 다음 d
  ```

## Step G — 페어링 / 접근 승인 (★ 사람, 런타임별)

- **openclaw**: 새 에이전트가 "이 봇에 말할 수 있는 사람"을 모르면 OWNER에게 페어링을 요구한다.
  사용자가 봇에 DM 1번 → 대시보드 **[접근 승인]** 또는
  `POST /team/api/ot/<ot_id>/pair-approve` → 서버가 pending 요청을 읽어 executor로 승인(터미널 0).
- **claude_channel** (★openclaw 와 승인법이 다르다★): 봇 DM 접근은 access.json allowlist. 첫 claude 팀원 = 봇에 첫 메시지 → 6자리 코드 응답 → 승인. ★승인법(항상 작동): **Claude Code 가 `~/.claude/channels/telegram-<id>/access.json` 의 `allowFrom` 에 본인 DM chat_id 를 추가하고 `dmPolicy` 를 `allowlist` 로** 바꾼다★(activate 가 출력하는 [F] 안내와 동일). `setup-claude-telegram-bot` 스킬이 있으면 `promote-pending.sh <id> <code>` 도 가능. ★`pair-approve`/대시보드 [접근 승인] 은 openclaw 전용이라 claude 엔 no-op(`skipped:true` 거짓성공)★ — claude 에 쓰면 안 된다. 2번째부터의 claude 팀원은 첫 팀원의 `allowFrom` 을 **자동 승계**(seedClaudeAccess = 기존 claude 멤버 access.json 참조)해 페어링 불필요(첫 멤버는 참조할 게 없어 `dmPolicy:pairing` 시드 = 수동 승인이 정상).
- **hermes**: 별도 pairing 게이트 없음 — activate 성공 = 양방향 가능.

> **페어링 코드 vs 민감 실행 승인 (헷갈리지 말 것)** — 둘은 별개다:
> - **페어링 코드** — 위 claude_channel 영입에서 봇이 응답하는 **6자리 텔레그램 페어링 코드**. 봇에 말 걸
>   사람을 허용(allowlist)하는 용도. **사람이 직접** 승인한다.
> - **민감 실행 승인** — 외부 전송·삭제·결제 같은 민감 실행을 대시보드에서 **사람이 승인**하는 버튼.
>   **PIN 입력은 필요 없다** — 승인 버튼을 누르면 바로 실행된다(별도 PIN을 켜지 않은 기본 구성).
>
> 어느 쪽이든 **사람 몫**이며, Claude가 페어링 코드나 승인을 대신 만들거나 우회하지 않는다.

## Step H — 검증 (첫 팀원 1:1 DM — ★라우터 무관★)

새 팀원 봇 `@<bot_username>`에게 텔레그램 DM으로 "안녕"처럼 짧게 인사한다. ★1:1 DM 은 라우터 ON/OFF 와 무관하다★(라우터는 그룹 ingress 전용):
- **claude_channel 첫 팀원**: 답 대신 **6자리 페어링 코드**가 오는 게 정상 — 사람이 승인(Step G 방식)하면 그때부터 대화된다(이게 완료 신호). 2번째 팀원부터는 첫 팀원 allowlist 승계로 페어링 없이 바로 답한다.
- **openclaw 첫 팀원**: ★곧바로 답이 안 오는 게 정상★ — 먼저 **pair-approve**(Step G, 대시보드 [접근 승인])로 승인해야 한다. 승인 후 "안녕"에 답이 오면 완료.
- **hermes 첫 팀원**: 페어링 게이트가 없어 activate 성공 시 "안녕"에 바로 답이 온다 = 완료.
- 2번째+ 팀원(claude): 첫 팀원 allowlist 승계로 바로 답한다.
- 그래도 안 오면 `troubleshooting.md` (완료 검증은 **봇 DM에 답/코드가 오는지**로 보고, `owner_chat_id` 로 보지 않는다).

> **(선택) 라우터 ON 은 그룹(팀방) 협업용** — 여러 팀원을 한 텔레그램 그룹에 모아 System OP 봇으로 라우팅할 때만 켠다. **1:1 DM 검증엔 필요 없다.** 그룹 셋업 상세는 SKILL 의 "System OP 봇" 절 참고.
> ```bash
> curl -s -X PATCH http://localhost:$PORT/team/api/system-op \
>   -H 'content-type: application/json' -d '{"router_enabled":true}'   # 토글=즉시 반영
> ```

## Step I — (선택) 팀원 아이콘

영입 후 사용자에게 안내: **대시보드에서 팀원 아이콘을 세팅·저장하면 텔레그램/슬랙 아이콘도 자동 생성**된다(대시보드 Settings ▸ 팀원). 선택 사항이라 안 해도 동작에는 지장 없다.

## 런타임 요약

| runtime | 난이도 | 특징 | 페어링 | 준비물 |
|---|---|---|---|---|
| `claude_channel` | 쉬움 | 로컬 Claude Code 세션 연결, tmux 봇. 기존 Claude 로그인 재사용(추가 구독 X) | telegram 플러그인 페어링 | claude CLI·tmux·플러그인(user scope) |
| `openclaw` | 고급 | OpenClaw gateway/session | pair-approve 필요 | openclaw CLI + auth 시드·python3 |
| `hermes_agent` | 고급 | Hermes 프로필 게이트웨이 | 없음 | hermes CLI + base 프로필·python3 |

> **추가 영입 시 런타임별 구독 재사용** — claude 팀원 여러 명 = 한 머신의 Claude 로그인 하나 공유(봇 토큰만 다름).
> openclaw = 공유 게이트웨이(에이전트마다 pair-approve). hermes = 프로필별(base 프로필 b3ryshermes는 auth 소스라 퇴사 대상 아님).
