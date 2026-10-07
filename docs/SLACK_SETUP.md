# Slack 통합 셋업

> **옛 방식(Event URL + 공개 도메인 + Cloudflare Access)을 설명하던 문서라 내용을 교체했습니다.**
> **정본은 대시보드의 Slack 위저드입니다** — `Settings → 팀원 → Slack`.

## 지금 방식: Socket Mode

Slack 연결은 **선택**입니다(텔레그램만으로 충분합니다).

붙일 때는 **Socket Mode** 를 씁니다. **공개 도메인도, 웹훅 엔드포인트도, Cloudflare 설정도 필요 없습니다.**
대시보드 위저드가 매니페스트를 만들어 주고 각 단계를 안내합니다.

1. 대시보드 **Settings → 팀원 → Slack** 위저드를 엽니다.
2. 안내되는 **매니페스트로 앱 생성**(*From a manifest*, Socket Mode 켜진 상태) → 워크스페이스 선택.
3. **Event Subscriptions** → `Enable Events` **ON** → 아래로 내려 `Subscribe to bot events`
   → `Add Bot User Event` → `app_mention` 추가 → **Save Changes**.
   매니페스트에 이미 들어 있어도 **실제로 켜져 있는지 확인하세요** — 꺼져 있으면
   봇이 멘션에 반응하지 않고 **오류도 나지 않습니다.**
4. **Install to Workspace** → 권한 승인.
   필요한 scope: `app_mentions:read` · `chat:write` · `groups:history` · `channels:history`
5. **App-Level Token**(`xapp-…`, scope `connections:write`)과
   **Bot User OAuth Token**(`xoxb-…`)을 위저드에 붙여넣습니다.
6. 봇을 대상 채널에 초대합니다: `/invite @봇이름`

## 알아둘 것

- **`@멘션` 이 없으면 봇에게 전달되지 않습니다.** 서버는 `app_mention` 이벤트만 받습니다.
  멘션 없이 쓴 글은 아예 안 들어가고 오류도 나지 않으므로, 답이 없을 때는
  "무시" 가 아니라 **"안 들어간 것"** 일 수 있습니다.
  부를 때는 Slack 의 멘션 자동완성을 쓰세요 — 이름을 글자로 적는 건 멘션이 아닙니다.
- 토큰은 채팅·로그에 평문으로 남기지 마세요. 위저드에 붙여넣으면 서버가 권한 0600 파일로 보관합니다.
- 팀원이 Slack 에 글을 올릴 때는 `skills/b3os-team-inbox` 의 `scripts/slack-post.sh` 를 씁니다.
  `--mention <U…>` 으로 받을 사람을 지정하세요. 멘션이 없으면 게시 후 경고가 나옵니다.

## 멘션에 쓸 멤버 ID 를 어디서 얻나

위 규칙("이름을 글자로 적는 건 멘션이 아닙니다")을 지키려면 **member ID 가 필요합니다.**
ID 없이 이름만 적어 올리면 **채널에는 보이지만 알림이 아무에게도 가지 않습니다** — 그리고 게시는
성공하므로 보낸 쪽은 전달된 줄 압니다. `slack-post.sh` 는 이 경우 게시 후 경고를 냅니다.

**ID 얻는 방법** (워크스페이스마다 값이 다릅니다):

1. Slack 앱에서 대상 프로필 열기 → `⋯` → **"멤버 ID 복사"** (Copy member ID) → `U…` 형태
2. 또는 채널에서 그 사람이 올린 메시지의 `bot_profile.name` / `user` 필드로 확인
3. `users.list`·`users.info` API 는 **기본 스코프로는 막혀 있습니다.** 멘션만 하려고 스코프를
   늘리는 것은 노출면을 넓히므로 권하지 않습니다 — 위 1번이 가장 간단합니다

**ID 를 어디에 두나 — 저장소에 넣지 마세요.**
member ID 는 워크스페이스 고유 값이고 공개 저장소에 둘 값이 아닙니다.
### 이름 사전 만들기 — `bash bin/slack-members-sync.sh --apply`

`--mention <이름>` 을 쓰려면 이름→ID 사전이 있어야 합니다. **손으로 만들지 마세요** —
슬랙 UI 에서 멤버 ID 를 찾는 건 메뉴 위치가 앱이 아니라 `api.slack.com` 이라 실제로 못 찾습니다.

```bash
bash bin/slack-members-sync.sh          # 미리보기
bash bin/slack-members-sync.sh --apply  # slack-tokens/members.env 갱신
```

`users.list` API 로 워크스페이스 전원을 받아 씁니다. 봇 접두사를 뗀 짧은 이름(`lisa`)과
원본 이름(`gdlisa`) 을 **둘 다** 넣으므로 어느 쪽으로 불러도 됩니다.
사람이 늘거나 이름이 바뀌면 다시 돌리면 됩니다.

> `missing_scope` 가 나오면 봇에 `users:read` 가 없는 것입니다 —
> `https://api.slack.com/apps` → 앱 → **OAuth & Permissions** → Bot Token Scopes →
> `users:read` 추가 → 페이지 위 **Reinstall**.

`slack-post.sh` 는 `slack-tokens/members.env` 에서 이름→ID 를 읽습니다(이 폴더는 `.gitignore` 에
있어 커밋되지 않습니다):

```
# slack-tokens/members.env  — 워크스페이스 전용, 커밋되지 않습니다
maintainer=U01234567
teammate-a=U89ABCDEF
```

그러면 ID 를 외울 필요 없이 이름으로 부를 수 있습니다:

```
slack-post.sh --channel C… --text-file note.md --mention maintainer
slack-post.sh --channel C… --text-file note.md --mention U01234567   # 원시 ID 도 그대로 받습니다
```

- 채널 전체 알림은 본문에 `<!here>` 또는 `<!channel>` 을 넣으면 됩니다(멘션으로 인정됩니다).
- `agents.json` 에는 두지 않습니다 — 그건 런타임 팀 registry 이고, 이 파일이 다루는 대상(다른
  머신·다른 팀의 사람)은 거기에 들어갈 자리가 없습니다.

## 왜 내용을 바꿨나

예전에는 Event URL 방식(공개 HTTPS 주소 + Cloudflare Access Bypass + Event Subscriptions Request URL)을
설명했습니다. 지금은 **Socket Mode 가 정본**이고 서버도 Socket 매니페스트만 내보냅니다.

옛 설명을 남겨두면 **도메인을 사고 Cloudflare 를 설정해도 끝나지 않는 막다른 길**로 사용자를 보내게 됩니다.
그래서 지웠습니다.

## 오래된 스레드의 멘션 폴링

부모 글의 작성 시각과 답글 활동 시각을 구분한다. `conversations.history`는 부모 작성 시각 순이므로 부모는 더 넓게 읽고, `latest_reply`가 활동 범위 안인 부모만 답글 조회 후보로 삼는다.

### 범위와 비용

| 설정/상한 | 기본값 | 역할 |
|---|---|---|
| `TEAM_SLACK_POLL_THREAD_PARENT_LOOKBACK_SEC` | 90일(7,776,000초) | 부모 탐색 범위. 답글 활동 범위보다 짧으면 활동 범위까지 확장 |
| `TEAM_SLACK_POLL_THREAD_WINDOW_SEC` | 7일(604,800초) | 마지막 답글의 활동 범위 |
| `TEAM_SLACK_POLL_THREAD_MAX_PAGES` | 5 | 채널당 부모 탐색 페이지 수, 페이지당 200개 |
| 답글 조회 상한 | 10 | 채널당 tick에서 읽는 스레드 수. 미조회 후보 우선 |
| 호출 예산 | 메서드별 40회/60초 | 이 폴러의 모든 채널 합계, HTTP 429의 `Retry-After`도 준수 |

기본값에서 채널당 tick은 history 최대 6회(최상위 1회 + 부모 5회), replies 최대 10회다. 기본 20초 간격에서는 채널 하나의 최대 호출이 history 18회/분, replies 30회/분이며, 여러 채널도 메서드별 공유 예산으로 제한한다. 다른 Slack 호출 경로는 이 예산에 포함하지 않는다.

새 답글이 있는 스레드만 replies를 호출한다. 처리한 답글 시각을 커서에 저장한다. 시작 기준 시각(floor = 시작 시각 - lookback) 이전 답글은 조회/처리하지 않는다. 재시작 직전 lookback 안의 멘션까지 영구 중복 방지하는 변경은 아니다.

90일 밖 부모와 5페이지 뒤 부모는 이 기본값으로 찾지 못한다. 페이지 상한 뒤에 더 있으면 `slack_poll_thread_scan_capped` 감사 기록을 남긴다. 답글 조회 상한은 `slack_poll_thread_replies_capped`, 예산/429 실패는 `slack_poll_failed`로 기록한다. 페이지 탐색은 다음 tick에서 첫 페이지부터 다시 시작한다.

[Slack history 문서](https://docs.slack.dev/reference/methods/conversations.history/)는 내부 앱에 Tier 3(50+/분)을 명시한다. [호출 제한 문서](https://docs.slack.dev/apis/web-api/rate-limits/)의 HTTP 429 재시도 규칙을 따른다.

### 기능 ↔ 검증

소스: `src/server/workers/slackPoll.ts` · 시험: `src/server/workers/slackPoll.test.ts`

| 기능/조건 | 자동 시험 | 결함 주입 증명 |
|---|---|---|
| 65일 전 부모 + 최근 답글 멘션 → 멘션 처리 함수 호출 | 가짜 Slack 응답에 oldest 필터 적용, 두 번째 페이지에 오래된 부모 배치 | 부모 탐색을 7일로 되돌리면 실패 |
| 오래된 답글만 존재 → 조회/배달 제외 | 오래된 활동 범위와 floor 이전 답글, 반복 tick/재시작 | 위 결함 주입 시험과 함께 실행 |
| 5페이지 상한 → 감사 기록 | cursor가 계속 있는 응답을 5회로 제한 | 감사 내용과 호출 수 단언 |
| 답글 상한/호출 예산/429 → 제한 및 재시도 | 11스레드, 다채널 40회, 120초 backoff, 실패 시 커서 유지 | 경계값 직접 단언 |

제어 결함(멘션 처리 함수 호출을 제거)에서도 배달 시험이 실패한다.

### 검증 실행

```sh
bun test src/server/workers/slackPoll.test.ts
bun test src/server/workers/slackSocket.test.ts
bun run typecheck
```

실제 Slack 네트워크 호출·버스 저장·팀원 깨우기·실서버 반영은 이 모의 시험 범위 밖이다. 머지 및 재시작 뒤 별도 확인한다. 되돌리기는 변경 커밋을 revert한다.
