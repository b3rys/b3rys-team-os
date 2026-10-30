# 영입(recruit) 상세 — API·UI·페어링

첫 팀원을 실제 대화 가능한 봇으로 붙이는 전 과정. 서버가 `http://localhost:$PORT` 에 떠 있고
`.env` 에 `APPROVAL_EXECUTION_ENABLED=1`(활성화 승인)이 켜져 있어야 한다.

> ** 포트 ($PORT)** — 아래 모든 `localhost:$PORT` 는 `.env` 의 `TEAM_HTTP_PORT`(기본 **7878**)를 뜻한다. curl 을 실행하기 전에 한 셸에서 실포트를 한 번 잡고, 그 셸에서 이어 실행한다(새 셸이면 이 줄을 다시):
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

**채팅으로 물어본다** — "화면에서 넣으세요"로 미루지 않는다. 팀명·팀장ID·팀장이름 3개만 물어본다. 미션은 물어보지 않는다 — TEAM-OS.md §1 의 기본 미션을 그대로 쓴다(대시보드에도 미션 편집칸 없음).

```bash
# 팀명 + 팀장ID + 팀장이름(owner_name = 사람 이름) — /settings API 한 번.
curl -s -X PUT http://localhost:$PORT/team/api/settings \
  -H 'content-type: application/json' \
  -d '{"team_name":"acme","lead_id":"teamleader","owner_name":"Alex"}'
# team_name ≤ 20자 · lead_id = 소문자/숫자/-/_ 1~40자(팀장 식별자, 영문 slug).
# 응답에 "setup_complete": true 면 영입 가능. (미션은 안 넣는다 — 기본값 유지.)
```

Codex를 첫 팀원으로 선택하면 **팀장 Telegram chat_id**도 직접 물어 `owner_chat_id`로 저장한다. Codex는 Claude의 6자리 pairing 대신 이 값으로 발신자를 제한한다. 값이 비어 있으면 봇이 메시지를 받지 않으므로 활성화 전에 확인한다. 준비·로그인·확인 명령은 `runtime-setup.md#codex`를 따른다.

## Step B — 영입(recruit)

> **팀원 상한:** 활성 공식 팀원은 최대 **15명**이다. `team_official_member:false`인 비공식/테스트 agent와 정지(off) 팀원은 계산에서 제외한다. 15명에 도달하면 UI와 API가 신규 영입을 차단하므로, 기존 팀원을 정지하거나 퇴사 처리한 뒤 다시 시도한다. 이미 15명을 넘은 기존 팀은 강제로 삭제하지 않고 신규 영입만 막는다.

> **팀원 정보는 사용자에게 직접 물어본다.** id·표시이름·역할·**멘션 별칭**, 그리고 **`persona`(성격·말투·전문성 한두 줄 — 선택)** 를 사용자가 정하게 한다. **특정 이름을 기본값·선택지로 제시하지 않는다**(예: `1) bill 2) dev` 같은 메뉴 금지 — 헷갈림). 형식과 중립 예시만 안내한다.
> 예: *"만들 팀원의 id를 정해주세요 — 영문 소문자 slug (예: `alex`, `sam`). 표시이름·역할도요. **`@`로 부를 멘션명(별칭)** 도 정해주세요 — 안 정하면 id·표시이름으로 부를 수 있고, 짧게 더 부를 이름이 있으면 넣으면 됩니다(쉼표로 여러 개, 나중에 대시보드 Settings에서 변경 가능). 그리고 **성격·말투·전문성 같은 persona**를 한두 줄로 정해줄래요? (선택 — 지금 비워도 되고, 나중에 대시보드 Settings에서 넣을 수 있어요.)"*
> 멘션명은 항상 물어본다(질문 생략 금지). 사용자가 안 정하면 자동으로 `[id, 표시이름]` 이 별칭으로 들어가니 "안 넣어도 부를 수 있다"고 안내하되, 물음 자체는 건너뛰지 않는다.
> persona를 주면 SOUL.md 로 저장되고, 비우면 SOUL.md 없이 진행된다(나중에 대시보드에서 추가 가능). 물어는 보되 강요하지 않는다.

> **설명만 하지 말고, 아래처럼 '복사해서 값만 바꾸는' 예제 폼을 같이 보여준다** (런타임은 위 §5-1 에서 이미 정했으니 여기선 멤버 필드만 — 사용자가 이걸 복사해 채워서 주면 그대로 recruit). 값은 그럴싸한 예시:
> ```
> • 팀원 ID: lisa
> • 팀원 이름: Lisa
> • 역할: 풀스택 개발자
> • 멘션명: lisa, Lisa, 리사
> • Persona: 웹·서버·DB·클라우드까지 아우르는 시니어 풀스택. 구조 설계를 먼저 해 사이드이펙트를 줄인다.
> • 봇토큰: 8000000036:AA_example_fake_교체필요   ← BotFather 값(비밀! 채운 폼 공유 금지)
> ```
> (역할 예시는 사용자가 고른 런타임/성격에 맞춰 자연스럽게. 봇토큰은 사람이 BotFather에서 받아 넣는다 — Step C.)

> **한 명 먼저 성공한 뒤 — 여러 명 한꺼번에 (배치 영입 폼)**: 첫 팀원이 응답까지 확인되면 "런타임까지 아시면 여러 명을 한 번에 만들 수 있어요"라고 안내하고 팀원별로 아래 폼을 채우게 한다. 런타임은 구독으로 고른다: Claude 구독 → `claude_channel`, ChatGPT 구독 → `openclaw` 또는 `hermes_agent`.
> ```
> • 팀원 ID, 이름: alex, Alex
> • 멘션명: alex, Alex, 알렉스
> • Persona: 백엔드·인프라 담당 시니어 개발자. 구조 설계를 먼저 해 사이드이펙트를 줄인다.
> • 런타임, 모델: claude_channel, claude      (ChatGPT 구독이면 openclaw, chatgpt 또는 hermes_agent, chatgpt)
> • 봇토큰: 8090901234:AA-fake-example-교체필요   ← BotFather 값
> ```
> 토큰은 대화 기록에 평문으로 남는 비밀값이다. 예시는 가짜 형식이고, 실제 토큰을 채운 폼은 공유하지 않으며, 토큰은 파일(0600)로만 두고 화면에 다시 출력하지 않는다.
> 영입 순서는 claude → hermes → openclaw 를 권한다(claude 페어링이 팀장 chat_id 를 자동으로 잡고 hermes 가 그 값을 쓴다). 순서가 뒤집혀도 된다 — Step G 의 hermes 항목 참고.

```bash
# 아래 값들은 형식 예시일 뿐 — 실제로는 사용자가 정한 id·이름·역할·별칭을 넣는다.
curl -s -X POST http://localhost:$PORT/team/api/members/recruit \
  -H 'content-type: application/json' \
  -d '{"id":"alex","display_name":"Alex","nicknames":"al,알렉스","role":"백엔드 개발자","runtime":"claude_channel","persona":"backend/infra 담당"}'
```
- `id`: 소문자/숫자/-/_, 2~32자, 영문자 시작 (예시일 뿐 — **사용자가 정한 값 사용**). 멘션 라우팅 키.
- `nicknames`(선택): **`@`멘션 별칭** — 쉼표 구분 문자열(예: `"al,알렉스"`). **id·표시이름은 자동 포함**되니 그 외 추가로 불릴 이름만 넣는다(비우면 `[id, display_name]`). 셋업 후 변경은 `PATCH /members/<id>` 에 `{"nicknames":["al","알렉스"]}` **배열**로.
- `runtime`: **기본 추천은 `claude_channel`**(기존 Claude 로그인 재사용, 추가 구독 불필요). 공개 표면에서는
  `claude_channel`·`codex`(Codex (Beta))·`openclaw`·`hermes_agent`를 안내한다. `openclaw`·`hermes_agent`는 BYO 고급 런타임이라
  먼저 `runtime-setup.md`의 설치·인증 절차를 끝내야 한다.
  준비되지 않은 BYO도 목록에서 숨기지 않고 disabled+사유+연동 안내로 보여준다. `b3os_native`는 온보딩에 노출하지 않는다.
  런타임을 고른 뒤 **그 런타임만** 인증 preflight(CLI·로그인) 점검 — 구독을 미리 캐묻지 않는다.
- `persona`(선택): 능력/강점 — 페르소나 파일에 주입.
- 응답: `{ ok, ot_id, member, persona_file, persona_written }`. **이 `ot_id` 를 이후 단계에 쓴다.**
  - `persona_file`은 persona를 실제 저장했을 때만 `SOUL.md` 경로이며, persona가 비어 파일이 없으면 `null`이다.
  - 팀원 작업공간은 `$B3RYS_HOME/members/<팀원id>/` 에 생성된다(install.sh가 `B3RYS_HOME=$HOME/b3os` 세팅 → `~/b3os/members/<팀원id>/`. 페르소나 `SOUL.md` + 규칙 `CLAUDE.md`/`AGENTS.md` + `TEAM-OS.md` 심링크, **리포 밖 자체완결 루트**). 루트 결정 순서: `B3RYS_MEMBERS_ROOT` → `$B3RYS_HOME/members` → `~/b3os/members`(personaTemplates.ts `resolveMembersRoot`).
- 첫 영입 멤버는 자동으로 `coordinator` capability를 받는다(라우팅 안전망).
- 중복 id = 409, 잘못된 runtime = 400.

## Step C — 봇 만들고 토큰 받기 ( 사람만)

Claude가 사용자에게 안내한다. 이 BotFather 4단계는 `claude_channel`·`codex`·`openclaw`·`hermes_agent` 모두 동일하다:
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
- 저장 전에 텔레그램 `getMe` 로 토큰이 살아 있는지 확인한다. 죽은 토큰(오타·폐기·재발급)이면 `bot_token_dead` 400 → BotFather 토큰을 다시 받아 넣는다. 텔레그램 연결 자체가 실패하면 `getme_failed` 503 → 토큰은 그대로 두고 잠시 뒤 재시도.
- provision 직후 **preflight**(런타임 oauth 로그인 점검)를 돌린다. 미로그인이면 `preflight: blocked` +
  fixHint(예: "터미널에서 `claude` 로그인") 이 온다 → 사용자에게 로그인 요청 후 Step E 재확인.

## Step E — activate (런타임 기동)

```bash
curl -s -X POST http://localhost:$PORT/team/api/ot/<ot_id>/activate
```
- **`APPROVAL_EXECUTION_ENABLED=1` 필요.** 없으면 `runtime: 실행 OFF` 로 막힌다(활성화 스위치 안 켬).
- 미로그인이면 `runtime_auth_required` 400 + fixHint → 로그인 후 재시도.
- claude_channel: 토큰을 채널 `.env`(`~/.claude/channels/telegram-<id>/.env`)에 배치 → LaunchAgent plist 생성 → tmux 봇 기동 → poller 헬스게이트(봇이 `bot.pid` 를 써야 '진짜 대화됨', 기본 30s 대기, `TEAMOS_POLLER_WAIT_MS` 로 조정). `bot.pid` 가 안 생기면 telegram MCP 가 부팅 열거에서 빠진 것이고, 활성화가 `/mcp reconnect` 를 최대 2회 자동 주입해 복구한다.
- 활성화 응답의 `ok` 는 poller 를 빼고 판정한다. `ok: true` 만 보고 끝내지 말고 `steps` 의 `step: "poller"` 항목 `ok`·`detail` 을 본다. `ok: false` 면 사용자에게 봇에 DM 을 보내 답이 오는지 확인시킨다.
- 성공하면 OT `bundle=done`. claude/hermes 는 첫 모델 호출 또는 게이트웨이 확인 시 `join=done`(합류 완료).

## Step F — telegram 플러그인 (claude 런타임 — 자동)

활성화(Step E) 런처가 플러그인 enable(`~/.claude/settings.json` 의 `enabledPlugins` 에 머신당 1회 기록)과 첫부팅 poller 복구를 모두 처리한다. 수동으로 깔 것이 없다. `claude plugin install` / `/plugin install` 은 돌리지 않는다 — 공유 플러그인 캐시를 inode 째 스왑해 같은 캐시를 쓰는 다른 팀원 봇 세션을 깨뜨린다. 재영입 에이전트가 수동 설치를 하려 하면 재활성화만 한다.

## Step G — 페어링 / 접근 승인 ( 사람, 런타임별)

- **openclaw**: 새 에이전트가 "이 봇에 말할 수 있는 사람"을 모르면 팀장에게 페어링을 요구한다.
  사용자가 봇에 DM 1번 → 대시보드 **[접근 승인]** 또는
  `POST /team/api/ot/<ot_id>/pair-approve` → 서버가 pending 요청을 읽어 executor로 승인(터미널 0).
- **claude_channel** (openclaw 와 승인법이 다르다): 봇 DM 접근은 access.json allowlist. 첫 claude 팀원 = 봇에 첫 메시지 → 6자리 코드 응답 → 승인. 승인법(항상 작동): **Claude Code 가 `~/.claude/channels/telegram-<id>/access.json` 의 `allowFrom` 에 본인 DM chat_id 를 추가하고 `dmPolicy` 를 `allowlist` 로** 바꾼다(activate 가 출력하는 [F] 안내와 동일). `setup-claude-telegram-bot` 스킬이 있으면 `promote-pending.sh <id> <code>` 도 가능. `pair-approve`/대시보드 [접근 승인] 은 openclaw 전용이라 claude 엔 no-op(`skipped:true` 거짓성공) — claude 에 쓰면 안 된다. 2번째부터의 claude 팀원은 첫 팀원의 `allowFrom` 을 **자동 승계**(seedClaudeAccess = 기존 claude 멤버 access.json 참조)해 페어링 불필요(첫 멤버는 참조할 게 없어 `dmPolicy:pairing` 시드 = 수동 승인이 정상).
- **hermes**(v0.18): DM 페어링 게이트가 있다. activate 가 팀장 chat_id(설정 `owner_chat_id`/도출)를 게이트웨이 allowlist(`TELEGRAM_ALLOWED_USERS`)에 시드하므로 팀장은 코드 없이 대화한다. 팀장 외 사용자는 `hermes pairing approve <platform> <code>` 가 필요하고, `owner_chat_id` 를 못 잡았으면 시드를 건너뛰어 팀장도 수동 pairing 이 필요하다.
  hermes 를 먼저(claude 없이) 영입하면 `owner_chat_id` 가 비어 있을 수 있다(claude 페어링이 자동으로 채운다):
  - 권장: activate 전에 팀장 chat_id 를 묻는다("@userinfobot 에게 DM하면 숫자로 나옵니다") → `curl -s -X PUT http://localhost:$PORT/team/api/settings -H 'content-type: application/json' -d '{"owner_chat_id":"<숫자>"}'` → activate. 대시보드/영입 API 로 activate 하면 서버가 이 값을 자동으로 넘긴다.
  - 폴백: 팀장이 hermes 봇 DM 에서 받은 코드를 `hermes pairing approve telegram <코드>` 로 승인하고, 이후 `owner_chat_id` 를 세팅해 두면 재activate 때 자동 반영된다.
  - openclaw 를 먼저 영입하는 건 문제없다(게이트가 pair-approve 라 순서 무관).

> **페어링 코드 vs 민감 실행 승인 (헷갈리지 말 것)** — 둘은 별개다:
> - **페어링 코드** — 위 claude_channel 영입에서 봇이 응답하는 **6자리 텔레그램 페어링 코드**. 봇에 말 걸
>   사람을 허용(allowlist)하는 용도. **사람이 직접** 승인한다.
> - **민감 실행 승인** — 외부 전송·삭제·결제 같은 민감 실행을 대시보드에서 **사람이 승인**하는 버튼.
>   **PIN 입력은 필요 없다** — 승인 버튼을 누르면 바로 실행된다(별도 PIN을 켜지 않은 기본 구성).
>
> 어느 쪽이든 **사람 몫**이며, Claude가 페어링 코드나 승인을 대신 만들거나 우회하지 않는다.

## Step H — 검증 (첫 팀원 1:1 DM — 라우터 무관)

새 팀원 봇 `@<bot_username>` 에게 "안녕"을 보낸다. 1:1 DM 은 라우터 ON/OFF 와 무관하다(라우터는 그룹 ingress 전용).
- claude_channel 첫 팀원: 답 대신 6자리 페어링 코드가 오는 게 정상이다. 사람이 승인(Step G)하면 그때부터 대화되고, 이게 완료 신호다. 2번째부터는 첫 팀원 allowlist 승계로 바로 답한다.
- openclaw 첫 팀원: 먼저 pair-approve(Step G)가 필요하다. 승인 후 "안녕"에 답이 오면 완료.
- hermes 첫 팀원: 팀장은 allowlist 시드로 바로 답이 온다 = 완료. 코드가 오면 `owner_chat_id` 를 채우고 재activate.
- 안 오면 `troubleshooting.md`. 완료 검증은 봇 DM 에 답/코드가 오는지로 하고 `owner_chat_id` 로 보지 않는다.

라우터 ON 은 여러 팀원을 한 텔레그램 그룹에 모을 때만 필요하다(`group-room-setup.md`).
```bash
curl -s -X PATCH http://localhost:$PORT/team/api/system-op \
  -H 'content-type: application/json' -d '{"router_enabled":true}'   # 즉시 반영
```

## Step I — (선택) 팀원 아이콘

영입 후 사용자에게 안내: **대시보드에서 팀원 아이콘을 세팅·저장하면 텔레그램/슬랙 아이콘도 자동 생성**된다(대시보드 Settings ▸ 팀원). 선택 사항이라 안 해도 동작에는 지장 없다.

## 런타임 요약

| runtime | 난이도 | 페어링 | 준비물 |
|---|---|---|---|
| `claude_channel` | 쉬움 | telegram 플러그인 페어링 | claude CLI·tmux |
| `codex` (Beta) | 베타 | 팀장 `owner_chat_id` 로 발신자 제한 | codex CLI + ChatGPT 로그인 |
| `openclaw` | 고급 | pair-approve | openclaw CLI + auth 시드·python3 |
| `hermes_agent` | 고급 | DM 게이트(팀장은 allowlist 시드) | hermes CLI + base 프로필·python3 |

> **추가 영입 시 런타임별 구독 재사용** — claude 팀원 여러 명 = 한 머신의 Claude 로그인 하나 공유(봇 토큰만 다름).
> openclaw = 공유 게이트웨이(에이전트마다 pair-approve). hermes = 프로필별(`HERMES_BASE_PROFILE`, 기본 `b3os`는 auth 소스라 퇴사 대상 아님).
