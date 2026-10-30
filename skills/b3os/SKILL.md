---
name: b3os
description: b3rys TEAM OS(b3os, 여러 AI를 한 팀으로 운영하는 멀티런타임 AI 팀 OS)를 clone·설치하고, 팀 기본정보를 채팅으로 세팅한 뒤 첫 팀원 1명을 영입(텔레그램 연결)해 그 팀원에게 넘기는(handoff) 온보딩 스킬. 사람만 할 수 있는 것(BotFather 토큰·활성화 승인·페어링)만 요청한다. 첫 팀원이 응답하면 설치는 끝이고 이후 추가 영입·운영은 그 팀원이 이어받는다. 사용 시점 — 설치·세팅: "b3os 설치해줘", "b3os 세팅", "AI 팀 세팅해줘", "AI 팀 만들어줘", "b3rys 팀 만들어줘", "b3rys-team-os setup/install", "b3os 언인스톨/삭제"; 팀방·그룹: "b3os 팀방 세팅", "b3os 그룹방 세팅/연동", "팀 라우터(System OP) 붙여줘"; 운영·문제해결: "b3os 안 떠요", "team-os 상태/복구/재시작", "b3os 봇이 응답 안 해요", "b3os 리부팅 후 안 올라와요", "b3os 업데이트/버전 올려줘"; 런타임 교체: "팀원 런타임 바꿔줘"; 시스템 잡: "b3os가 뭘 자동으로 돌려?". macOS 권장(팀원 활성화가 launchd 기반). 각 단계 상세는 references/ 의 해당 파일을 그때 펼친다.
trigger: first-time b3os install · recruiting a member · team setup
---

# b3os — b3rys TEAM OS 온보딩

공개 저장소 [`github.com/b3rys/b3rys-team-os`](https://github.com/b3rys/b3rys-team-os)를 clone → 설치 → 대시보드 기동 → 팀 기본정보 세팅 → 첫 팀원 1명 영입까지 진행하고, 그 팀원에게 넘긴다. 첫 팀원이 응답하면 추가 영입·운영은 그 팀원이 이어받는다.

원칙: 팀 기본정보도 채팅으로 묻는다. 봇 토큰·활성화 승인·페어링은 사람 몫이라 대신하거나 우회하지 않는다. 인증 점검은 런타임을 고른 순간에만 하고 구독을 미리 캐묻지 않는다. 인증은 구독(OAuth)이 기본이고 API 키는 사용자가 원할 때만 쓴다.

## 시작 전 안전 고지 (사용자에게 먼저 보여준다)

> b3os는 본인 전용 장비(personal machine)에만 설치하세요. 대시보드·API는 `127.0.0.1` 로컬 단독 사용을 전제로 하며 앱 레벨 인증이 없습니다. 공용/공개 서버에 그대로 노출하지 마세요. 외부 접근이 필요하면 Cloudflare Access 같은 엣지 인증을 앞단에 두세요.

macOS 권장(팀원 활성화가 launchd 기반이라 Linux는 대시보드까지만).

## 흐름

```
[0] 안전 고지 + 설치 위치 확인
[1] Prerequisites (brew·git)
[2] clone → bash install.sh                              ← 사람: 활성화 y/n
[3] bun run start → http://localhost:7878/team
[4] 팀 기본정보를 채팅으로 (팀명·팀장ID·팀장이름)          ※ 없으면 영입이 400
[5] 첫 팀원 영입 (런타임 선택 → preflight → recruit)      ← 사람: 봇 토큰·페어링
[6] 1:1 DM 확인 — 응답이 오면 합류 완료
[7] HANDOFF — 이 스킬의 일은 여기서 끝
[8] (선택) 팀원 추가 · 팀방 협업 · 런타임 교체
```

첫 영입 팀원은 자동으로 coordinator + full context 를 받는다(미배정·모호 메시지의 기본 담당, 팀방 최근 맥락 수신자). 그래서 [7]의 handoff 대상이 된다.

## [0]~[3] 설치

기본 위치는 홈 폴더다. clone 전에 알린다: "`~/b3rys-team-os` 에 설치합니다. 다른 위치를 원하면 알려주세요."

```bash
[[ "$(uname)" == "Darwin" ]] || echo "macOS 아님 — 대시보드까지만 됩니다."
export B3OS="$HOME/b3rys-team-os"
command -v brew >/dev/null || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
command -v git  >/dev/null || brew install git      # bun·tmux 는 install.sh 가 준비한다
if [ -d "$B3OS/.git" ]; then echo "이미 clone됨 — 재사용"; else git clone https://github.com/b3rys/b3rys-team-os.git "$B3OS"; fi
cd "$B3OS" && bash install.sh
```

`install.sh` = bun 확인/설치 → `bun install` → `bun run build` → `.env` 준비 → 활성화 스위치 프롬프트 → typecheck. 프롬프트 "이 장비에서 팀원(봇) 활성화를 허용할까요? [y/N]"는 `.env` 의 `APPROVAL_EXECUTION_ENABLED=1` 을 켜서 서버가 봇을 실제로 기동하도록 인가하는 스위치다. 본인 전용 맥일 때만 `y` 이고, 사용자 대신 임의로 넣지 않고 사용자에게 묻는다.

서버 기동:

```bash
cd "$B3OS"
bun run start >/tmp/b3os-server.log 2>&1 &   # 백그라운드 — 포그라운드면 이후 단계가 막힌다
PORT=$(grep '^TEAM_HTTP_PORT=' "$B3OS/.env" 2>/dev/null | cut -d= -f2); PORT=${PORT:-7878}
for i in $(seq 1 6); do curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1 && { echo "서버 up ($PORT)"; break; }; sleep 2; done
```

사용자에게 `http://localhost:$PORT/team` 을 열고 Settings 탭을 띄워두게 한다. `command not found: bun` 이면 `export PATH="$HOME/.bun/bin:$PATH"` 또는 새 터미널. 7878 이 사용 중이면 `.env` 의 `TEAM_HTTP_PORT` 를 바꾸고 이후 모든 URL 을 그 포트로 안내한다. 안 뜨면 `tail -30 /tmp/b3os-server.log`.

## [4] 팀 기본정보 — 채팅으로 묻는다

팀명·팀장ID·팀장이름이 먼저 있어야 영입이 열린다(없으면 recruit 가 `setup_incomplete` 400). "대시보드에서 입력하세요"로 넘기지 말고 채팅에서 묻는다.

1. 팀명 (≤20자) 2. 팀장 ID (`lead_id`, 영문 slug 1~40자) 3. 팀장 이름 (`owner_name`, ≤40자) 4. (선택) 팀장 텔레그램 chat_id (`owner_chat_id`, 숫자 — Codex 또는 BYO 런타임을 첫 팀원으로 쓸 때. claude 는 불필요)

예시는 자리표시자(`acme`/`teamleader`/`Alex`)를 그대로 보여준다. 사용자의 실명·팀명을 예시로 쓰거나 이메일·대화 맥락에서 유추해 넣지 않는다. 값은 사용자가 직접 준 것만 쓴다. 미션은 묻지 않는다(TEAM-OS 기본값).

```bash
curl -s -X PUT http://localhost:$PORT/team/api/settings -H 'content-type: application/json' \
  -d '{"team_name":"acme","lead_id":"teamleader","owner_name":"Alex"}'   # 응답 "setup_complete": true 면 영입 가능
```

필드 검증·에러 = `references/recruit.md` Step A.

## [5] 첫 팀원 영입

먼저 `references/recruit.md` 를 펼쳐 읽고 진행한다(질문 문구·복사용 폼·기본값이 거기 있다).

런타임은 네 가지를 항상 보여준다: `claude_channel`(권장·쉬움) / `codex`(Codex (Beta), ChatGPT 로그인) / `openclaw`·`hermes_agent`(ChatGPT 구독 BYO 고급). 설치+인증이 안 된 것은 숨기지 않고 disabled 와 `references/runtime-setup.md` 안내를 함께 보여준다. `b3os_native` 는 온보딩에 노출하지 않는다. 목록·권장 이유·preflight 명령 = `references/runtime-setup.md`.

사용자에게 먼저 묻는 것: id(영문 slug, display_name 과 별개) · display_name · role · 멘션명(별칭) · runtime+모델 · persona(선택).

```
POST /team/api/members/recruit  {id, display_name, role, runtime, persona?}  → ot_id
   ── 사람: BotFather 로 봇 생성 → 토큰 ──
POST /team/api/ot/<ot_id>/provision  {bot_token}   # 토큰 0600 저장 + 런타임 로그인 preflight
POST /team/api/ot/<ot_id>/activate                 # 런타임 기동 (APPROVAL 필요)
   ── 사람: 봇에 DM → 페어링 승인 (런타임별로 다름) ──
```

사람만 할 수 있는 것은 BotFather 봇 생성+토큰, 봇에 첫 DM 후 페어링 승인이다. 토큰은 사용자가 Claude Code 에 입력하면 provision 으로 넘기고, 받은 토큰을 화면에 다시 출력하지 않는다. 활성 공식 팀원은 최대 15명. 팀원 작업공간은 `~/b3os/members/<팀원id>/`. 페이로드·OT 단계·토큰 전달·런타임별 페어링 = `references/recruit.md` Step B~G.

## [6] 1:1 DM 확인 — 합류 완료

1:1 DM 은 라우터와 무관하다(라우터는 그룹 ingress 전용). 폰에서 첫 팀원 봇에게 "안녕"을 보낸다.

- 응답(또는 6자리 페어링 코드)이 오면 합류 완료. claude 첫 팀원은 코드가 오는 게 정상이고, 승인하면 대화된다.
- 대시보드 Topology 에서 팀원·런타임·채널이 초록인지 본다.
- 무응답이면 `references/troubleshooting.md` — 라우터가 아니라 페어링 승인/플러그인/poller 문제다.
- 승인 방법·완료 판정 = `references/recruit.md` Step G·H. claude 에 `pair-approve` 를 쓰지 않는다(openclaw 전용, 거짓성공).

응답을 확인했으면 "[팀원 이름], 간단한 거 하나 해줘"처럼 실제로 일을 시켜보라고 권한다. 대시보드 Tasks 칸반에 카드가 뜨는 것이 handoff 의 시작이다.

## [7] HANDOFF

> 첫 팀원 [이름]이 합류했어요. 이제부터는 팀원과 직접 대화하세요:
> - `@[이름]` 멘션으로 작업 지시 (예: "@alex 이 코드 리뷰해줘")
> - 추가 영입·운영·문제해결은 팀원에게 — "다음 팀원 어떻게 영입해?" 하면 도와줍니다.
> - 대시보드 Tasks 칸반으로 진행 추적, Topology 로 연결 상태 확인.

이 시점부터 사용자는 팀장이고, 이후는 이 스킬이 아니라 팀원이 이끈다. 팀원은 세팅·운영 질문을 받으면 그때 이 스킬을 불러 `references/*` 로 답한다(온디맨드 로딩).

## [8] 그다음 (선택)

| 하고 싶은 것 | 어디를 펴나 |
|---|---|
| 팀원 더 추가 | [5] 반복 · `references/recruit.md` |
| 팀방(그룹)에서 여러 팀원이 대화 | `references/group-room-setup.md` (System OP 봇) |
| 런타임 선택·BYO 설치·인증 | `references/runtime-setup.md` |
| 런타임 교체 · 퇴사 · 라우터 토글 · 업데이트 | `references/b3os-ops-primer.md` |
| 안 뜬다 / 봇 무응답 / 리부팅 후 복구 | `references/troubleshooting.md` · ops-primer §8 |
| 긴급 전원 정지(폭주) · 상시가동 등록 | ops-primer §10·§11 |
| 자동으로 도는 잡 · 지연 작업 예약 | `references/system-jobs.md` |

- claude 팀원 여러 명은 한 머신의 Claude 로그인 하나를 공유한다(각자 봇 토큰만 다름).
- 런타임 교체를 퇴사+재영입으로 하지 않는다 — 퇴사(DELETE)는 워크스페이스를 `.archived` 로 옮겨 메모리를 잃는다. `swap-runtime` 은 id 로 키잉된 워크스페이스를 그대로 둔다. 교체는 서비스 중단성 self-mod 라 팀장 승인 후 진행하고, `confirm_name` 이 `display_name` 과 정확히 일치해야 한다.

## 삭제 (uninstall)

```bash
cd "$B3OS" && bash uninstall.sh      # 전원 오프보드 → 서버 정지 → 데이터 삭제
#   --yes(확인 생략) · --keep-data(오프보드+정지만, team.db/.env 보존)
```

스크립트가 안내하는 `rm -rf "$B3OS"` 로 repo 폴더까지 지우면 끝. base hermes 프로필은 보존된다.

## 안전 원칙

- 받은 봇 토큰을 화면·로그·커밋에 노출하지 않는다(provision 호출에만 사용).
- 활성화 승인·페어링 코드는 사람 몫이다. 대신 승인하거나 우회하지 않는다.
- 본인 전용 장비 전제 — 엣지 인증 없이 공용/공개 노출하지 않는다.
- 로컬 `.env`·`team.db`·토큰은 커밋 대상이 아니다(gitignore).
