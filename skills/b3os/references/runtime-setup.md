# 런타임 사전준비 — OpenClaw / Hermes

`openclaw`와 `hermes_agent`는 b3os가 대신 설치·로그인해 주는 기본 경로가 아니라, 사용자가 이미 갖고 있는 런타임을 b3os 팀원으로 연결하는 BYO(Bring Your Own, 사용자가 준비해 오는) 고급 경로입니다.

먼저 `claude_channel`을 권장합니다. 그래도 OpenClaw 또는 Hermes를 고르면 아래 준비를 마친 뒤 영입/런타임 교체의 preflight를 다시 확인하세요.

공통 원칙:
- 명령은 b3os 서버가 실행되는 같은 컴퓨터에서 실행합니다.
- **★인증은 "구독 모델"(OAuth 로그인)이 기본입니다 — API 키가 아닙니다.★** 이미 쓰는 구독(예: Claude·ChatGPT 등)을 OAuth 로그인으로 그대로 재사용합니다. 이게 첫 사용자에게 가장 매끄럽고(추가 키 발급 없음), b3os 가 `claude_channel` 을 권한 것과 같은 이유입니다. **API 키 방식은 사용자가 명시적으로 원할 때만 쓰는 예외 경로**입니다.
- **★어떤 구독으로 붙일지 사용자에게 물어봅니다.★** 특정 provider 를 임의로 고르지 말고(예: 자동 발견된 환경변수 `*_API_KEY` 를 그대로 쓰지 않기), "어떤 구독을 쓰시겠어요?(Claude / ChatGPT / …)" 를 먼저 확인합니다. 환경에 `OPENAI_API_KEY` 같은 키가 이미 있어도, 사용자가 API 키를 원한다고 하지 않았으면 **구독(OAuth) 을 기본으로 안내**합니다.
- 인증 파일·토큰 값은 화면에 출력하지 않습니다. 존재 여부와 `--version`/`doctor` 결과만 확인합니다.
- Telegram 봇 토큰 발급은 `recruit.md` Step C의 BotFather 4단계와 동일합니다. 런타임이 달라도 BotFather 흐름은 바뀌지 않습니다.

## OpenClaw

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
openclaw onboard --install-daemon    # 온보딩 중 구독 계정 OAuth 로그인(브라우저)
openclaw gateway status
openclaw doctor
```

> API 키로 붙이는 건 사용자가 명시적으로 원할 때만. 기본 안내는 구독 OAuth.

b3os preflight가 보는 조건:
- `openclaw` 바이너리가 PATH 또는 일반 설치 경로에 있음
- `python3` 사용 가능
- `~/.openclaw/openclaw.json` 안에 auth profiles가 있거나, `~/.openclaw/agents/*/agent/auth-profiles.json` 중 하나가 있음

막히면:
- `openclaw CLI 미설치` → `npm install -g openclaw@latest` 후 새 터미널에서 `openclaw --version`
- `openclaw 미인증` → `openclaw onboard --install-daemon` 또는 OpenClaw 설정 흐름에서 모델/OAuth 인증 완료
- `python3 미설치` → macOS라면 Command Line Tools 또는 Homebrew Python 설치 후 재확인

## Hermes Agent

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

런타임별로 첫 응답 조건이 다릅니다: **hermes** 는 페어링 게이트가 없어 activate 성공 = 바로 답합니다. **openclaw** 는 먼저 페어링 승인이 필요합니다 — 대시보드 **[접근 승인]** 버튼(또는 `POST /team/api/ot/<ot_id>/pair-approve`)으로 승인해야 그때부터 답합니다(승인 전 무응답은 정상). 무응답이 계속되면 `troubleshooting.md` §0 의 런타임별 항목을 봅니다.
