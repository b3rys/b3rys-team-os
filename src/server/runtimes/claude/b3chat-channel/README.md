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
  - `dmPolicy`·`groups` 등 나머지 필드는 원본과 같다.

`B3CHAT_ACCESS_MODE` 는 기본 `static` 이다(페어링 없음, `access.json` 은 시작할 때 한 번 읽는다).

## 아직 안 되는 것

- 첨부 파일: `reply` 의 `files`, `download_attachment` 는 오류를 돌려준다. 받은 사진은 캡션 글만 전달한다.
- 버튼: 권한 요청은 글 답장(`yes <code>` / `no <code>`)으로 승인한다.

## 불러오는 법

세션 작업 폴더의 `.mcp.json` 에 서버 `b3chat` 을 등록하고(`command: bun`, `args: ["<이 폴더>/server.ts"]`, `env: {"B3CHAT_STATE_DIR": "…"}`),
`claude --dangerously-load-development-channels server:b3chat` 로 띄운다. 이 연결(런처 배선)은 다음 단계에서 한다.

## 테스트

```sh
bun install --frozen-lockfile
bun test
```

`b3chat.test.ts` 는 접근 판단·주소 검사·첨부 오류 단위 테스트, `server.integration.test.ts` 는 가짜 b3chat 서버(127.0.0.1 임의 포트)에 대고
이 서버를 MCP stdio 로 실행하는 통합 테스트다. 저장소 루트 `tsc` 대상에서는 빠져 있다(`grammy` 는 이 폴더에만 설치).
