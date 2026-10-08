# b3chat 채널 플러그인

Claude Code 세션을 b3chat(팀 자체 메신저, 텔레그램 호환 봇 API)에 잇는 MCP 채널 서버다.
공식 Telegram 채널 플러그인 0.0.7 을 복사해 b3chat 에 맞게 고쳤다. 출처·바뀐 곳은 `NOTICE` 와 `server.ts` 머리말에 있다.

## 설정

상태 폴더(`B3CHAT_STATE_DIR`, 필수)에 두 파일을 둔다.

- `.env` (권한 0600)
  - `B3CHAT_BOT_TOKEN` — b3chat 봇 토큰
  - `B3CHAT_API_BASE` — b3chat 서버 주소. `https://…` 이거나 `http://127.0.0.1` / `http://localhost` 만 받는다(그 밖은 토큰 유출이라 시작하지 않는다).
- `access.json`
  - `allowFrom` — 받고 보낼 수 있는 **방 id(chat.id)** 목록. b3chat 의 1:1 방 id 는 사람 id 와 다르다.
  - `ownerChat` — 권한 요청을 받을 방 id. 없으면 권한 요청을 보내지 않는다.
  - `groups` — 그룹 방 id별 접근 정책. 런처는 등록된 `channel.allow_from` 방마다 기본 `requireMention: true`를 만들며, 기존 개별 정책은 보존한다.
  - `dmPolicy` 등 나머지 필드는 원본과 같다.

그룹에서는 정확한 `@봇username` 멘션 또는 봇 글에 대한 답장을 요구한다.
b3chat의 일반 글 멘션은 Telegram의 `entities` 메타데이터가 없어도 인식한다.

`B3CHAT_ACCESS_MODE` 는 기본 `static` 이다(페어링 없음, `access.json` 은 시작할 때 한 번 읽는다).

## 아직 안 되는 것

- 첨부 파일: `reply` 의 `files`, `download_attachment` 는 오류를 돌려준다. 받은 사진은 캡션 글만 전달한다.
- 버튼: 권한 요청은 글 답장(`yes <code>` / `no <code>`)으로 승인한다.

## 폴더 구조

공식 Telegram 플러그인과 같은 모양이다 — 이 폴더가 그대로 플러그인 루트다.

- `.claude-plugin/plugin.json` — 플러그인 이름 `b3chat`·버전·라이선스
- `.mcp.json` — MCP 서버 `b3chat` = `bun run --cwd ${CLAUDE_PLUGIN_ROOT} --shell=bun --silent start` (텔레그램과 같은 형식)
- `package.json` 의 `start` = `bun install --frozen-lockfile --no-summary 1>&2 && bun server.ts` (설치 출력은 stderr, stdout 은 MCP 전용)
- 마켓플레이스 목록(제안, 미등록)은 저장소 루트 `.claude-plugin/marketplace.json` (이름 `b3os`, 플러그인 `b3chat`)

`B3CHAT_STATE_DIR` 는 두 방식 모두 Claude 프로세스 환경변수로 넘긴다(텔레그램의 `TELEGRAM_STATE_DIR` 와 같은 방식).

## 불러오는 법 ① 개발용 채널 (지금 검증용)

세션 작업 폴더의 `.mcp.json` 에 서버 `b3chat` 을 등록한다. `${CLAUDE_PLUGIN_ROOT}` 는 플러그인으로 불릴 때만 채워지므로 여기서는 절대 경로를 쓴다.

```json
{ "mcpServers": { "b3chat": {
  "command": "bun",
  "args": ["run", "--cwd", "<이 폴더 절대 경로>", "--shell=bun", "--silent", "start"]
} } }
```

`B3CHAT_STATE_DIR=<상태 폴더> claude --dangerously-load-development-channels server:b3chat` 로 띄운다. 시작할 때 개발용 채널 경고 창이 뜨는데,
`../start-telegram-channel.sh`가 로컬 b3chat 개발용 채널 경고만 확인한다.
등록된 팀원의 `channel.kind`가 `b3chat`이면 런처는 해당 상태 폴더와 프로젝트 MCP 설정을 준비하고,
`../launch-b3chat.py`로 상속된 `TELEGRAM_*` 환경변수를 제거한 Claude 프로세스를 실행한다.
로그인·작업 폴더 신뢰·도구 권한 창은 자동으로 승인하지 않는다.

## 불러오는 법 ② 플러그인 (정식 경로, 아직 안 함)

우리 마켓플레이스 `b3os` 에 올리고, 맥미니 관리 설정(managed settings)의 `allowedChannelPlugins` 로 승인한 뒤
`B3CHAT_STATE_DIR=<상태 폴더> claude --channels plugin:b3chat@b3os` 로 띄운다(경고 창 없음). 관리 설정·설치 명령은 팀 보고서를 따른다.
설치는 공유 플러그인 캐시를 바꾸므로 실행 중인 팀원 세션과 겹치지 않게 한다(`skills/b3os/references/recruit.md` Step F 주의).

## 테스트

```sh
bun install --frozen-lockfile
bun test
```

`b3chat.test.ts` 는 접근 판단·주소 검사·첨부 오류 단위 테스트, `server.integration.test.ts` 는 가짜 b3chat 서버(127.0.0.1 임의 포트)에 대고
플러그인 `.mcp.json` 의 `b3chat` 항목 그대로(MCP stdio) 실행하는 통합 테스트다. 저장소 루트 `tsc` 대상에서는 빠져 있다(`grammy` 는 이 폴더에만 설치).

`../b3chatLifecycle.test.ts`는 별도 HOME·등록 파일·멤버 폴더에서 필수 설정, 가짜 토큰 교체와 복원,
그룹 접근 초기 설정, 페르소나의 채널별 도구 선택과 SOUL 보존을 검증한다. 실제 서비스나 자격증명은 사용하지 않는다.
