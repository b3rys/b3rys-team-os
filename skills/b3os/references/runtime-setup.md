# 런타임 사전준비 — OpenClaw / Hermes

`openclaw`와 `hermes_agent`는 b3os가 대신 설치·로그인해 주는 기본 경로가 아니라, 사용자가 이미 갖고 있는 런타임을 b3os 팀원으로 연결하는 BYO(Bring Your Own, 사용자가 준비해 오는) 고급 경로입니다.

온보딩은 Claude를 기본 선택하고 Hermes/OpenClaw를 동등한 ChatGPT BYO 옵션으로 항상 표시합니다. readiness가 부족하면 옵션은 숨지 않고 disabled되며 이 문서로 연결됩니다. 이 세 가지 외 내부 런타임은 온보딩 대상이 아닙니다.

**런타임은 구독으로 고릅니다:** **Claude 구독 → `claude_channel`**(기존 Claude 로그인 재사용), **ChatGPT 구독 → `hermes_agent` 또는 `openclaw`**(ChatGPT 구독을 OAuth로 재사용). Claude 구독자라면 `claude_channel`이 가장 짧습니다. ChatGPT 구독자거나 BYO 고급 런타임을 원하면 아래 준비를 마친 뒤 영입/런타임 교체의 preflight를 다시 확인하세요.

공통 원칙:
- 명령은 b3os 서버가 실행되는 같은 컴퓨터에서 실행합니다.
- **★인증은 "구독 모델"(OAuth 로그인)이 기본입니다 — API 키가 아닙니다.★** 이미 쓰는 구독(예: Claude·ChatGPT 등)을 OAuth 로그인으로 그대로 재사용합니다. 이게 첫 사용자에게 가장 매끄럽고(추가 키 발급 없음), b3os 가 `claude_channel` 을 권한 것과 같은 이유입니다. **API 키 방식은 사용자가 명시적으로 원할 때만 쓰는 예외 경로**입니다.
- **★어떤 구독으로 붙일지 사용자에게 물어봅니다.★** 특정 provider 를 임의로 고르지 말고(예: 자동 발견된 환경변수 `*_API_KEY` 를 그대로 쓰지 않기), "어떤 구독을 쓰시겠어요?(Claude / ChatGPT / …)" 를 먼저 확인합니다. 환경에 `OPENAI_API_KEY` 같은 키가 이미 있어도, 사용자가 API 키를 원한다고 하지 않았으면 **구독(OAuth) 을 기본으로 안내**합니다.
- 인증 파일·토큰 값은 화면에 출력하지 않습니다. 존재 여부와 `--version`/`doctor` 결과만 확인합니다.
- Telegram 봇 토큰 발급은 `recruit.md` Step C의 BotFather 4단계와 동일합니다. 런타임이 달라도 BotFather 흐름은 바뀌지 않습니다.

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
> - ★`--auth-choice codex` 금지★ — `@openclaw/codex` 플러그인 wizard 로 라우팅되어 게이트웨이가 crash 한다(`openSyncKeyedStore` 부재 = 플러그인↔호스트 API 계약 불일치). ChatGPT 구독 OAuth 는 `openai` / `openai-device-code` 를 쓴다.
> - 둘 다 ChatGPT 구독 OAuth 이며 **API 키가 아니다**(`OPENAI_API_KEY` 불필요). API 키로 붙이는 건 사용자가 명시적으로 원할 때만.
> - **Node**: 25.9+ 허용. 위 openclaw/codex 플러그인 crash 는 플러그인↔호스트 API 문제이지 Node 버전 문제가 아니며 LTS 다운그레이드로 해결되지 않는다.

### ⚠️ Node 격리 — 런타임 간 node 얽힘 방지 (Hermes+OpenClaw 병행 시 필수)

`openclaw onboard --install-daemon` 은 **그 순간 PATH에서 잡힌 node의 절대경로를 openclaw LaunchAgent(plist)에 그대로 박습니다.** 그 node가 다른 런타임 소유(예: Hermes 가 번들한 `~/.hermes/node/bin/node`)면, 나중에 그 런타임을 지울 때(`hermes uninstall --full` → `~/.hermes` 통째 삭제) **openclaw 게이트웨이가 다음 기동부터 죽습니다.** 실측: openclaw plist가 `~/.hermes/node/bin/node` 를 물고 있어 hermes 제거가 openclaw 를 깨뜨림(2026-07-24). 원칙 — **각 런타임 daemon 은 런타임-독립 시스템 node 로 돌려라.**

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
- `openclaw 미인증` → `openclaw onboard --auth-choice openai --install-daemon`(ChatGPT 구독 OAuth). ★`--auth-choice codex` 는 crash 하니 쓰지 않는다.★
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

> **API 키 방식은 예외** — 사용자가 명시적으로 원할 때만 `hermes auth add <provider> --type api-key`. ★환경변수 `OPENAI_API_KEY` 등이 이미 있으면 hermes 가 `openai-api` 로 **자동 발견**해 auth.json 에 넣지만, 이건 API 키 방식이다.★ 사용자가 구독을 원하면 그 자동발견 항목을 쓰지 말고(`hermes auth remove` 로 정리), 위 OAuth 로 다시 붙인다.

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

준비가 끝나면 대시보드 Settings의 OT 패널에서 `다시 확인`을 누르거나, API를 쓰는 경우 아래를 호출합니다.

```bash
curl -s -X POST http://localhost:${PORT:-7878}/team/api/ot/<ot_id>/preflight-recheck   # 포트 바꿨으면 TEAM_HTTP_PORT 값
```

preflight가 통과하면 활성화 버튼이 열립니다. 합류 완료 후에는 Telegram에서 새 팀원 봇(`@<bot_username>`)에게 DM으로 “안녕”처럼 짧게 인사해 보세요. 답이 오면 연동 성공입니다.

런타임별로 첫 응답 조건이 다릅니다: **hermes**(v0.18) 는 ★DM 페어링 게이트가 있습니다★ — 단 b3os activate 가 팀장 chat_id(`owner_chat_id`)를 게이트웨이 allowlist(`TELEGRAM_ALLOWED_USERS`)에 자동 시드하므로 **팀장은 코드 없이 바로 답합니다**(팀장 chat_id 를 못 잡으면 팀장에게도 코드가 오니 `owner_chat_id` 를 채우고 재activate; 팀장 외 사용자는 `hermes pairing approve` 로 승인). **openclaw** 는 먼저 페어링 승인이 필요합니다 — 대시보드 **[접근 승인]** 버튼(또는 `POST /team/api/ot/<ot_id>/pair-approve`)으로 승인해야 그때부터 답합니다(승인 전 무응답은 정상). 무응답이 계속되면 `troubleshooting.md` §0 의 런타임별 항목을 봅니다.
