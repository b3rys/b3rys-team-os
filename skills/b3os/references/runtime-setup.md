# 런타임 사전준비 — Codex (Beta) / OpenClaw / Hermes

`openclaw`와 `hermes_agent`는 b3os가 설치·로그인해 주는 기본 경로가 아니라, 사용자가 이미 가진 런타임을 팀원으로 연결하는 BYO(Bring Your Own) 고급 경로다. 온보딩은 Claude 를 기본 선택으로 두고 Hermes/OpenClaw/Codex (Beta)를 설치·인증 상태와 함께 항상 표시한다. readiness 가 부족하면 숨기지 않고 disabled 로 두고 이 문서로 연결한다. `b3os_native` 는 온보딩 대상이 아니다.

런타임은 구독으로 고른다: Claude 구독 → `claude_channel`(기존 Claude 로그인 재사용, 가장 짧다), ChatGPT 구독 → `codex`(Beta), `hermes_agent`, `openclaw`(ChatGPT 구독을 OAuth 로 재사용).

공통 원칙:
- 명령은 b3os 서버가 실행되는 같은 컴퓨터에서 실행한다.
- 인증은 구독(OAuth 로그인)이 기본이고 API 키는 사용자가 명시적으로 원할 때만 쓰는 예외다. 어떤 구독으로 붙일지 사용자에게 먼저 묻는다(Claude / ChatGPT / …). 환경에 `OPENAI_API_KEY` 같은 키가 있어도 자동 발견된 `*_API_KEY` 를 그대로 쓰지 않는다.
- 인증 파일·토큰 값은 출력하지 않는다. 존재 여부와 `--version`/`doctor` 결과만 확인한다.
- Telegram 봇 토큰 발급은 어느 런타임이든 `recruit.md` Step C 의 BotFather 4단계와 같다.

## 런타임 고르기 — 사용자에게 보여줄 목록

| # | runtime | 한 줄 설명 | 난이도 | 설치 주체 |
|---|---|---|---|---|
| 1 | `claude_channel` | 로컬 Claude Code 세션 연결(tmux 봇). 기존 Claude 로그인 재사용 | 쉬움 | **AI 자동** (사람은 CLI 로그인만) |
| 2 | `openclaw` | OpenClaw gateway/session | 고급 | **BYO** — CLI+게이트웨이+인증 에이전트 **미리 준비** |
| 4 | `codex` | Codex (Beta), 로컬 OpenAI Codex CLI + ChatGPT 로그인 | 베타 | 선택 후 CLI 준비·사람이 로그인 |
| 3 | `hermes_agent` | Hermes 프로필 게이트웨이 | 고급 | **BYO** — CLI+인증 프로필 **미리 준비** |

- 첫 팀원은 `claude_channel` 을 권장한다(AI 가 설치·인증 안내까지 가장 안정적으로 진행). 모르겠다고 하면 이걸로 안내한다.
- `openclaw`·`hermes_agent` 는 CLI·게이트웨이·구독 인증·인증된 에이전트 1개가 미리 갖춰져 있어야 하고 b3os가 대신 설치하지 않는다. 준비 안 됐으면 preflight 에서 막히니 아래 절차를 안내하거나 `claude_channel` 로 되돌린다. UI 는 disabled 사유와 CTA 를 보여주고 재확인 후 enabled 된다.
- 목록에 없는 런타임을 요청하면 공개 지원 런타임은 위 4개뿐이라고 안내하고(영입 API 가 그 외는 400), `claude_channel` 로 안내한다.
- 어떤 런타임이든 첫 영입은 Claude Code 세션에서 하는 것이 가장 매끄럽다(preflight·설치·인증 안내·API 영입을 셸로 진행할 수 있고, 대시보드는 설치·인증을 못 한다).

## 고른 순간에만 하는 preflight

**구독을 미리 캐묻지 않습니다.** 고른 런타임의 CLI·로그인만 그때 확인합니다. 있으면 바로 진행(present→proceed), 없으면 그 런타임의 설치·로그인만 안내(missing→guide) — 다른 런타임 얘기로 사용자를 헷갈리게 하지 않습니다.

- **`claude_channel` (쉬움, 대개 이미 로그인됨)**
  ```bash
  command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code
  command -v tmux   >/dev/null || brew install tmux
  claude --version && tmux -V
  ```
  미로그인이면 활성화 preflight가 막고 안내합니다 → "터미널에서 `claude` 한 번 실행해 로그인해 주세요".
- **`openclaw` (고급)**: openclaw CLI + **인증된 에이전트 1개**(auth 복제 소스) + `python3`. 아래 OpenClaw 절을 따릅니다.
- **`hermes_agent` (고급)**: hermes CLI + **base 프로필 1개**(auth 시드) + `python3`. 아래 Hermes 절을 따릅니다.

## OpenClaw

### macOS BYO 체크리스트

1. `openclaw --version`과 `python3 --version`으로 실행 가능 여부를 확인합니다.
2. `openclaw auth list` 또는 설정 상태 명령으로 인증 프로필 **존재 여부만** 확인합니다. 토큰·키 값은 출력하거나 공유하지 않습니다.
3. `openclaw doctor`와 `openclaw gateway status`를 통과시킵니다.
4. b3os Settings의 `owner_chat_id`를 팀장 Telegram chat id로 채웁니다.
5. 팀원을 provision하고 preflight recheck를 눌러 readiness가 enabled로 바뀌는지 확인합니다.
6. 팀장 승인 후 activate하고, Telegram DM을 보낸 뒤 대시보드의 pair-approve(접근 승인)를 완료합니다.

필요한 것:
- Node.js 24.15+ 권장(또는 OpenClaw 문서가 허용하는 Node 22.22.3+ / 25.9+)
- `openclaw` CLI
- OpenClaw 인증 프로필 1개 이상
- `python3`

설치:

```bash
node --version
npm install -g openclaw@latest
openclaw --version
```

인증·게이트웨이 준비 — **구독(OAuth)이 기본**입니다:

먼저 **어떤 구독으로 붙일지 사용자에게 물어봅니다.** onboard 흐름에서 그 구독 계정으로 **OAuth 로그인**합니다(브라우저) — API 키가 아니라 기존 구독 재사용:

```bash
# ChatGPT 구독 → --auth-choice openai (브라우저 OAuth 로그인). 완료 시
#   ~/.openclaw/openclaw.json auth.profiles 에 openai:<email>(mode:oauth) 기록.
openclaw onboard --auth-choice openai --install-daemon
openclaw gateway status
openclaw doctor
```

> - 브라우저 없는 헤드리스: `--auth-choice openai-device-code`(URL+코드 페어링).
> - `--auth-choice codex` 금지 — `@openclaw/codex` 플러그인 wizard 로 라우팅되어 게이트웨이가 crash 한다(`openSyncKeyedStore` 부재 = 플러그인↔호스트 API 계약 불일치). ChatGPT 구독 OAuth 는 `openai` / `openai-device-code` 를 쓴다.
> - 둘 다 ChatGPT 구독 OAuth 이며 **API 키가 아니다**(`OPENAI_API_KEY` 불필요). API 키로 붙이는 건 사용자가 명시적으로 원할 때만.
> - **Node**: 25.9+ 허용. 위 openclaw/codex 플러그인 crash 는 플러그인↔호스트 API 문제이지 Node 버전 문제가 아니며 LTS 다운그레이드로 해결되지 않는다.

### 이름 있는 프로필·라벨로 게이트웨이를 띄웠다면 — b3os 서버에도 같은 값

OpenClaw 게이트웨이의 launchd 라벨은 `OPENCLAW_LAUNCHD_LABEL` → `OPENCLAW_PROFILE`(`ai.openclaw.<profile>`) → 기본 `ai.openclaw.gateway` 순으로 정해집니다. `openclaw.json` 에는 자기가 어느 프로필인지 적혀 있지 않아 b3os 가 거꾸로 알아낼 수 없습니다.

그래서 기본 프로필이 아니면 **b3os 서버 프로세스 env 에도 같은 `OPENCLAW_PROFILE`(또는 `OPENCLAW_LAUNCHD_LABEL`)을 둡니다**(team-os 저장소 `.env` 또는 서버 LaunchAgent 의 env). 서버가 띄우는 `openclaw` CLI 자식도 이 env 를 물려받으므로 메시지 전달과 health 점검(게이트웨이 생존 확인)이 같은 게이트웨이를 봅니다. 값이 다르면 health 점검이 '게이트웨이 launchd 미로드' 를 잘못 알립니다.

### ⚠️ Node 격리 — 런타임 간 node 얽힘 방지 (Hermes+OpenClaw 병행 시 필수)

`openclaw onboard --install-daemon` 은 **그 순간 PATH에서 잡힌 node의 절대경로를 openclaw LaunchAgent(plist)에 그대로 박습니다.** 그 node가 다른 런타임 소유(예: Hermes 가 번들한 `~/.hermes/node/bin/node`)면, 나중에 그 런타임을 지울 때(`hermes uninstall --full` → `~/.hermes` 통째 삭제) **openclaw 게이트웨이가 다음 기동부터 죽습니다.** 원칙 — **각 런타임 daemon 은 런타임-독립 시스템 node 로 돌려라.**

**① 설치 전 — 시스템 node 가 먼저 잡히는지 확인**(daemon 설치 직전):
```bash
command -v node                        # 이게 ~/.hermes/node/... 등 특정 런타임 경로면 위험
export PATH="$HOME/.local/bin:$PATH"   # 시스템 node 를 앞에(또는 Homebrew: /opt/homebrew/bin)
command -v node                        # 이제 ~/.local/bin/node (또는 homebrew) 여야 함
openclaw onboard --auth-choice openai --install-daemon
```

**② 설치 후 — plist 가 어떤 node 를 박았는지 검증**(경로만 봄, 시크릿 아님):
```bash
PLIST=$(ls "$HOME"/Library/LaunchAgents/*openclaw* 2>/dev/null | head -1)
grep -i 'node' "$PLIST"                # ~/.hermes/node 등 런타임 경로면 ③으로 repoint
```

**③ 다른 런타임 node 를 물고 있으면 — 시스템 node 로 repoint(영구 수정)**:
```bash
SYS_NODE="$HOME/.local/bin/node"; [ -x "$SYS_NODE" ] || SYS_NODE="$(command -v node)"
cp "$PLIST" "$PLIST.bak"               # 백업 먼저
/usr/bin/sed -i '' "s#<string>[^<]*/bin/node</string>#<string>$SYS_NODE</string>#" "$PLIST"
launchctl bootout "gui/$(id -u)/$(basename "$PLIST" .plist)" 2>/dev/null
launchctl bootstrap "gui/$(id -u)" "$PLIST"
openclaw gateway status                # RUNNING 확인
```

**④ 런타임 은퇴/삭제 순서 — 지우기 전에 의존성 먼저 확인**:
```bash
# hermes 등 런타임을 지우기 전, 다른 도구 plist 가 그 node 를 참조하는지 검사 → 걸리면 ③ 먼저
grep -rl '\.hermes/node' "$HOME"/Library/LaunchAgents/*.plist 2>/dev/null
```
> 한 런타임의 번들 node 에 다른 런타임 daemon 이 의존하면, 은퇴 한 번이 연쇄로 다른 팀원을 깨뜨린다. 항상 시스템 node 로 격리해 두면 어느 런타임을 지워도 나머지가 안전하다.

b3os preflight가 보는 조건:
- `openclaw` 바이너리가 PATH 또는 일반 설치 경로에 있음
- `python3` 사용 가능
- `~/.openclaw/openclaw.json` 안에 auth profiles가 있거나, `~/.openclaw/agents/*/agent/auth-profiles.json` 중 하나가 있음

막히면:
- `openclaw CLI 미설치` → `npm install -g openclaw@latest` 후 새 터미널에서 `openclaw --version`
- `openclaw 미인증` → `openclaw onboard --auth-choice openai --install-daemon`(ChatGPT 구독 OAuth). `--auth-choice codex` 는 crash 하니 쓰지 않는다.
- `python3 미설치` → macOS라면 Command Line Tools 또는 Homebrew Python 설치 후 재확인

## Hermes Agent

### macOS BYO 체크리스트

1. `hermes --version`과 `python3 --version`으로 실행 가능 여부를 확인합니다.
2. `hermes auth list`로 인증 프로필 **존재 여부만** 확인합니다. 토큰·키 값은 출력하거나 공유하지 않습니다.
3. `hermes doctor`와 `hermes gateway status`(지원 버전의 동등 명령 포함)를 확인합니다.
4. b3os Settings의 `owner_chat_id`를 팀장 Telegram chat id로 채워 activate 시 allowlist가 시드되게 합니다.
5. 팀원을 provision하고 preflight recheck를 눌러 readiness가 enabled로 바뀌는지 확인합니다.
6. 팀장 승인 후 activate하고 Telegram DM을 보내 첫 응답을 확인합니다. 팀장 외 사용자는 필요 시 pairing approve를 수행합니다.

필요한 것:
- `hermes` CLI
- 인증된 Hermes base 프로필 1개 이상
- `python3`

설치:

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
hermes --version
```

인증·프로필 준비 — **구독(OAuth)이 기본**입니다:

먼저 **어떤 구독으로 붙일지 사용자에게 물어봅니다**(Claude / ChatGPT / …). 그 구독에 맞는 provider 를 **OAuth** 로 붙입니다 — 브라우저 로그인이라 사용자가 직접 실행합니다:

```bash
# 구독 OAuth (기본) — provider 는 사용자의 구독에 맞춰:
#   Claude 구독  → anthropic
#   ChatGPT 구독 → openai-codex   (OpenAI 를 '구독'으로 붙이는 경로. 'openai-api' 가 아님)
hermes auth add <provider> --type oauth      # 브라우저 열림 → 구독 계정 로그인·승인
hermes auth list                             # 프로필 잡혔는지 확인(값은 안 보임)
```

> **API 키 방식은 예외** — 사용자가 명시적으로 원할 때만 `hermes auth add <provider> --type api-key`. 환경변수 `OPENAI_API_KEY` 등이 이미 있으면 hermes 가 `openai-api` 로 **자동 발견**해 auth.json 에 넣지만, 이건 API 키 방식이다. 사용자가 구독을 원하면 그 자동발견 항목을 쓰지 말고(`hermes auth remove` 로 정리), 위 OAuth 로 다시 붙인다.

세부 설정 마법사(모델·툴 등)는 `hermes setup`, 상태 점검은 `hermes doctor`.

b3os preflight가 보는 조건:
- `hermes` 바이너리가 PATH 또는 일반 설치 경로에 있음
- `python3` 사용 가능
- `~/.hermes/auth.json` 또는 `~/.hermes/profiles/*/auth.json` 중 하나가 있음

막히면:
- `hermes CLI 미설치` → 위 설치 명령 실행 후 새 터미널에서 `hermes --version`
- `hermes 미인증` → **구독 OAuth 로 인증**: `hermes auth add <provider> --type oauth`(provider = 사용자 구독에 맞춰). API 키는 사용자가 원할 때만.
- `python3 미설치` → macOS라면 Command Line Tools 또는 Homebrew Python 설치 후 재확인

## 다음 확인

준비가 끝나면 대시보드 Settings OT 패널의 `다시 확인`을 누르거나 아래를 호출한다. 통과하면 활성화 버튼이 열린다.

```bash
curl -s -X POST http://localhost:${PORT:-7878}/team/api/ot/<ot_id>/preflight-recheck   # 포트 바꿨으면 TEAM_HTTP_PORT 값
```

합류 후 팀원 봇 `@<bot_username>` 에 "안녕"을 보내 답이 오면 연동 성공이다. 런타임별 첫 응답 조건(hermes 는 팀장 allowlist 시드, openclaw 는 pair-approve, 승인 전 무응답은 정상)은 `recruit.md` Step G·H, 무응답이 계속되면 `troubleshooting.md` §0.

## Codex

**Codex (Beta)**는 OpenAI Codex CLI를 팀원으로 연결합니다. Claude 기본 권장은 유지합니다.

영입할 때 권한을 선택하며 팀원 화면에서 바꾸면 다음 메시지부터 적용됩니다. 기존 설치는 전체 권한을 유지합니다.

- **전체 권한(기본): 이 팀원은 이 맥의 파일·명령을 전부 쓸 수 있어요.** `never` + `danger-full-access`이며 승인창 없이 실행합니다.
- **작업 폴더만:** `on-request` + `workspace-write`이며 폴더 밖 쓰기는 해당 팀원 봇의 텔레그램 허락 버튼으로 묻습니다. 네트워크는 허용합니다. 한 번·이 세션·거절을 고를 수 있고 무응답은 거절합니다. CLI가 세션 승인을 제공하지 않는 명령은 동일한 요청만 같은 대화에서 기억하며 영구 실행 규칙을 만들지 않습니다.

아래 명령은 설치를 진행하는 AI가 실행하고, 사용자는 브라우저에서 본인 ChatGPT 계정으로 로그인합니다.

```bash
brew install --cask codex
codex login
codex --version
codex login status
```

`codex login`에서 ChatGPT 로그인을 선택합니다. 로그인 확인 명령이 성공한 뒤 대시보드 영입 목록을 새로 열거나 OT의 **인증 다시 확인(preflight recheck)**을 실행합니다. 미설치·미로그인이면 선택이 disabled되고 API도 `runtime_not_ready`와 설치/로그인 방법을 반환합니다. 서버 preflight는 Codex CLI **0.147.0 이상**과 `codex login status` 성공을 검사합니다. 상태 확인 시간 초과는 미로그인과 구분해 재확인을 안내합니다. 활성화 직후에는 실제 답장과 같은 `app-server` 경로로 첫 모델 호출을 확인하며, 실패하면 브리지를 정지하고 재활성화를 안내합니다. 사용량 제한·모델 접근 권한과 실제 Telegram 왕복은 별도로 확인합니다.

공식 안내: [Codex CLI](https://learn.chatgpt.com/docs/codex/cli), [인증 명령](https://learn.chatgpt.com/docs/cli/reference).

### 새 맥에서 확인할 것

- `install.sh`는 bun·tmux와 b3os를 준비하며 **Codex CLI 설치나 ChatGPT 로그인은 자동으로 하지 않습니다.** 위 준비를 선택한 시점에 진행합니다.
- Codex를 첫 팀원으로 쓰면 팀장의 Telegram 숫자 chat_id를 직접 물어 Settings의 `owner_chat_id`에 저장합니다. 기존 Claude 팀원이 없는 새 맥에는 자동으로 가져올 값이 없으며, 비어 있고 기존 설정에서도 가져올 수 없으면 브리지를 시작하기 전에 활성화를 막고 설정 방법을 안내합니다.
- provision이 봇 토큰을 `<repo>/var/secrets/<id>.bot-token`에 권한 `0600`으로 저장합니다. 값은 출력하지 않습니다.
- 활성화가 `~/b3os/members/<id>/`, `~/.codex-agents/<id>/config.toml`, bridge wrapper와 LaunchAgent를 생성합니다. 호스트 설정이 없어도 해당 팀원 작업 폴더의 trust 항목이 있는 config가 생성됩니다. 인증은 호스트 `~/.codex/auth.json`을 참조하므로 같은 OS 계정으로 로그인해야 합니다.
- bridge가 필요할 때 `codex app-server`를 시작하므로 별도 app-server 서비스·포트 설정은 필요 없습니다. 기본 Homebrew 경로(Apple Silicon·Intel)를 찾으며, 사용자 지정 경로라면 서버의 `CODEX_BIN`에 실행 파일의 절대경로를 지정합니다. 서버가 찾은 실행파일의 절대경로는 항상 활성화 wrapper에 기록하며, npm/nvm 설치 경로도 PATH에 포함합니다. `TEAM_BASE_URL`을 따로 지정하지 않으면 `TEAM_HTTP_PORT`의 설치 포트를 사용합니다.
- `APPROVAL_EXECUTION_ENABLED=1`은 기존 사람 승인 절차를 따릅니다. 활성화 후 봇에 DM을 보내 답을 받고 다시 한 번 답장해 메시지 왕복을 확인합니다. Codex에는 OpenClaw의 `pair-approve`를 쓰지 않습니다.
