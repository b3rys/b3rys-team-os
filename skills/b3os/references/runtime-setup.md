# 런타임 사전준비 — OpenClaw / Hermes

`openclaw`와 `hermes_agent`는 b3os가 대신 설치·로그인해 주는 기본 경로가 아니라, 사용자가 이미 갖고 있는 런타임을 b3os 팀원으로 연결하는 BYO(Bring Your Own, 사용자가 준비해 오는) 고급 경로입니다.

먼저 `claude_channel`을 권장합니다. 그래도 OpenClaw 또는 Hermes를 고르면 아래 준비를 마친 뒤 영입/런타임 교체의 preflight를 다시 확인하세요.

공통 원칙:
- 명령은 b3os 서버가 실행되는 같은 컴퓨터에서 실행합니다.
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

인증·게이트웨이 준비:

```bash
openclaw onboard --install-daemon
openclaw gateway status
openclaw doctor
```

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

인증·프로필 준비:

```bash
hermes setup
hermes auth
hermes auth list
hermes doctor
```

b3os preflight가 보는 조건:
- `hermes` 바이너리가 PATH 또는 일반 설치 경로에 있음
- `python3` 사용 가능
- `~/.hermes/auth.json` 또는 `~/.hermes/profiles/*/auth.json` 중 하나가 있음

막히면:
- `hermes CLI 미설치` → 위 설치 명령 실행 후 새 터미널에서 `hermes --version`
- `hermes 미인증` → `hermes setup` 또는 `hermes auth`로 모델 provider 인증 완료
- `python3 미설치` → macOS라면 Command Line Tools 또는 Homebrew Python 설치 후 재확인

## 다음 확인

준비가 끝나면 대시보드 Settings의 OT 패널에서 `다시 확인`을 누르거나, API를 쓰는 경우 아래를 호출합니다.

```bash
curl -s -X POST http://localhost:7878/team/api/ot/<ot_id>/preflight-recheck
```

preflight가 통과하면 활성화 버튼이 열립니다. 합류 완료 후에는 Telegram에서 새 팀원 봇(`@<bot_username>`)에게 DM으로 “안녕”처럼 짧게 인사해 보세요. 답이 오면 연동 성공입니다.
