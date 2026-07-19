# 트러블슈팅

> **★ 변수 먼저** — 아래 명령의 `$B3OS`(clone 한 저장소 경로)와 `$PORT`(`.env` 의 `TEAM_HTTP_PORT`, 기본 7878)는 셸에서 먼저 잡는다. 새 셸이면 다시 실행:
> ```bash
> B3OS=~/b3rys-team-os   # ← clone 위치로(기본 디렉토리명)
> PORT=$(grep '^TEAM_HTTP_PORT=' "$B3OS/.env" 2>/dev/null | cut -d= -f2); PORT=${PORT:-7878}
> ```

막히면 아래를 **순서대로** 확인·조치한다. 봇 무응답의 원인은 경로에 따라 다르다 — **1:1 DM = 페어링 승인/플러그인/poller** (라우터 무관), **그룹 = 라우터/capture/플러그인**. 먼저 어느 경로인지 가른다.

## 0) 첫 팀원 1:1 DM 봇이 6자리 코드만 보내거나 응답이 없어요 (런타임별)

★1:1 DM 은 라우터와 무관하다★ — 라우터 ON/OFF 는 여기서 원인이 아니다(라우터는 그룹 ingress 전용).

> **런타임별로 페어링 방식이 다르다** — claude = 아래 1~4. **openclaw·hermes(BYO)** 는 페어링 게이트가 달라 → **5번** 을 본다.

claude 순서:

1. **6자리 페어링 코드 승인** — claude 첫 팀원 봇에 첫 메시지를 보내면 봇이 **6자리 코드**로 답한다. 승인(DM 허용) = ★Claude Code 가 `~/.claude/channels/telegram-<id>/access.json` 의 `allowFrom` 에 본인 DM chat_id 를 추가하고 `dmPolicy` 를 `allowlist` 로 바꾼다★(activate 안내 [F]와 동일, 항상 작동). **본인 DM chat_id 는** 봇에 DM 하면 그 `access.json` 의 `pending` 에 senderId 로 남으니 거기서 읽거나, 텔레그램 **@userinfobot** 으로 확인한다(6자리 코드 자체를 넣는 게 아니다). `setup-claude-telegram-bot` 스킬이 있으면 `promote-pending.sh <id> <code>` 도 가능. ★대시보드 [접근 승인]·`pair-approve` 는 **openclaw 전용** — claude 엔 `skipped:true` 거짓성공만 반환하니 쓰지 말 것.★ 승인 전 "코드만 옴/무응답"은 정상이니 라우터 문제로 오진하지 말 것.
2. **telegram 플러그인 설치됐나?** (claude) — user scope 설치 확인(`tmux attach -t claude-<id>` → `/plugin`). 없으면 `setup-claude-telegram-bot` 스킬 또는 `recruit.md` Step F.
3. **poller 살아있나?** — 첫 activate 는 플러그인 설치 전이라 poller 미기동(`bot.pid` 없음)이 정상일 수 있다 → 플러그인 설치 후 **재활성화**.
4. **2번째+ 팀원인데 무응답** — 첫 팀원 allowlist 승계가 안 된 것 → 그 팀원 봇 DM 의 6자리 페어링도 승인.
5. **openclaw·hermes(BYO) 첫 팀원인데 무응답** — 이들은 claude 의 6자리코드/access.json 방식이 ★아니다★:
   - **openclaw**: 페어링 승인이 필요하다 → 대시보드 **[접근 승인]** 버튼(또는 `POST /team/api/ot/<ot_id>/pair-approve`; 상세는 `recruit.md` Step G). 승인 전 무응답은 정상. 승인했는데도 무응답이면 openclaw 게이트웨이 기동 여부 확인(`recruit.md` Step E activate 재실행).
   - **hermes**: ★페어링 게이트가 없다★ — activate 성공 = 양방향 가능이므로, 무응답이면 페어링이 아니라 **activate/게이트웨이(hermes 프로필 봇) 기동**을 의심한다(`recruit.md` Step E, activate 재실행).
   - 공통: `pair-approve` 를 claude 에 쓰면 no-op(위 1번 참고) — 런타임을 먼저 확인하고 맞는 승인법을 쓴다.

## 1) 봇이 팀 대화방(그룹)에 들어왔는데 응답이 없어요

가장 흔한 케이스. 아래 순서로:

1. **라우터 ON?** — Settings ▸ 시스템 OP에서 라우터가 ON인지 확인. OFF면 라우팅 결정만 로그에 남고
   응답하지 않는다.
   ```bash
   curl -s http://localhost:$PORT/team/api/system-op   # "router_enabled": true 인지
   # OFF면: curl -s -X PATCH http://localhost:$PORT/team/api/system-op -H 'content-type: application/json' -d '{"router_enabled":true}'
   ```
2. **telegram 플러그인 설치됐나?** (claude 런타임) — Claude 봇은 telegram 플러그인이 **user scope**로
   설치돼야 응답한다.
   ```bash
   tmux attach -t claude-<id>          # 세션 안에서 /plugin 으로 확인. detach = Ctrl-b 다음 d
   ```
   없으면 `setup-claude-telegram-bot` 스킬로 설치하거나 `recruit.md` Step F 수동 설치.
3. **봇 프로세스(poller)가 살아있나?** — 대시보드 **Topology**에서 봇/채널 연결 상태 확인.
   ```bash
   ls ~/.claude/channels/telegram-<id>/bot.pid   # 있으면 poller 폴링 중(= 진짜 대화됨)
   ```
   죽어 있으면(bot.pid 없음) 대시보드에서 해당 팀원을 **재활성화**(activate 다시)하면 poller가 다시 뜬다.
   재활성화 전 stale 세션/마커가 남아 거짓통과하지 않도록 서버가 tmux kill + bot.pid 제거 후 fresh 기동한다.

## 2) 팀원 활성화(영입)가 실패해요

- 활성화 preflight가 출력하는 **에러 메시지를 그대로 읽는다** — 원인별 조치를 안내한다:
  - `claude`/`openclaw`/`hermes` CLI 미설치 → `npm install -g @anthropic-ai/claude-code` / `npm install -g openclaw@latest` / Hermes 설치 스크립트(`runtime-setup.md` 참고)
  - 선택한 런타임 미로그인 → 터미널에서 `claude` 실행, `openclaw onboard --install-daemon`, 또는 `hermes setup`/`hermes auth`
  - `tmux`·`python3` 미설치 → `brew install tmux` / `brew install python3`
  - OpenClaw/Hermes 인증 시드(auth) 부재 → 해당 런타임 CLI로 인증된 에이전트/프로필 1개 준비
- 로그인 직후 즉시 재점검: `POST /team/api/ot/<ot_id>/preflight-recheck` (또는 대시보드 preflight 재확인).
  통과하면 활성화 버튼이 다시 열린다.
- `subscription_needed` 로 막히면 = 첫 모델 호출이 구독/사용 한도로 실패. 결제·구독 상태 확인 후 재활성화.

## 3) 민감 실행이 안 돼요 / "활성화 비허용" 에러

- `.env` 에 `APPROVAL_EXECUTION_ENABLED=1` 이 있는지 확인.
  ```bash
  grep -q '^APPROVAL_EXECUTION_ENABLED=1' "$B3OS/.env" && echo "켜짐" || echo "꺼짐"
  ```
- 꺼져 있으면: `install.sh` 를 다시 실행해 프롬프트에 `y` 입력, 또는 `.env` 에
  `APPROVAL_EXECUTION_ENABLED=1` 을 추가하고 **서버 재시작**. (본인 전용 맥일 때만.)

## 4) `bun run start` 에서 `command not found: bun`

- `install.sh`가 방금 설치한 bun이 아직 현재 셸 PATH에 없어서다.
  ```bash
  export PATH="$HOME/.bun/bin:$PATH"      # 즉시 해결
  # 또는 새 터미널 열기 / source ~/.zshrc (bash면 ~/.bashrc)
  bun --version && bun run start
  ```

## 그 밖에

- **대시보드가 안 뜸(`/health` 무응답)** — 서버가 안 떠 있거나 포트 충돌. `bun run start` 로그 확인.
  포트 변경은 `TEAM_HTTP_PORT` env(기본 7878).
- **저장소 clone 실패** — 네트워크/깃 설치 확인(`command -v git`). URL = `https://github.com/b3rys/b3rys-team-os.git`.
- **설치/빌드 실패(`install.sh` 또는 `bun run build` 중단)** — 대개 `bun` 미설치/구버전 또는 의존성 문제. `bun --version`(없으면 위 "bun 없음" 항목) → `bun install` 재실행 → `bun run build` 순으로 확인한다. 로그 마지막 에러 줄이 원인을 가리킨다.
- 위로 안 풀리면 — 서버 로그(`bun run start` 출력)와 이 문서 위 항목들을 다시 확인하고, 재현되면 GitHub Issues(`github.com/b3rys/b3rys-team-os/issues`)에 로그와 함께 올린다.
