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

## 왜 내용을 바꿨나

예전에는 Event URL 방식(공개 HTTPS 주소 + Cloudflare Access Bypass + Event Subscriptions Request URL)을
설명했습니다. 지금은 **Socket Mode 가 정본**이고 서버도 Socket 매니페스트만 내보냅니다.

옛 설명을 남겨두면 **도메인을 사고 Cloudflare 를 설정해도 끝나지 않는 막다른 길**로 사용자를 보내게 됩니다.
그래서 지웠습니다.
