---
name: b3os
description: b3rys TEAM OS(b3os) — 여러 AI를 한 팀으로 운영하는 멀티런타임 AI 팀 OS — 를 공개 저장소에서 clone·설치하고, 팀 기본정보를 채팅으로 세팅한 뒤 첫 팀원 1명을 영입(텔레그램 연결)해서 그 팀원에게 넘겨주는(handoff) 온보딩 스킬. clone → install.sh → 대시보드 기동 → 팀명·팀장ID·팀장이름 세팅 → 첫 팀원 런타임 추천·영입·인증·활성화까지 Claude가 몰아주고, 사람만 할 수 있는 것(BotFather 토큰·활성화 승인·페어링)만 요청한다. 첫 팀원이 응답하면 설치는 끝 — 이후 추가 영입·운영은 그 팀원이 이어받는다. 사용 시점 — 설치·세팅: "b3os 설치해줘", "b3os 세팅", "AI 팀 세팅해줘", "AI 팀 만들어줘", "b3rys 팀 만들어줘", "b3rys-team-os setup/install", "b3os 언인스톨/삭제"; 팀방·그룹 협업: "b3os 팀방 세팅 어떻게 해", "b3os 그룹방 세팅/연동", "팀 라우터(System OP) 붙여줘"; 운영·문제해결: "b3os 안 떠요", "team-os 상태/복구/재시작", "b3os 봇이 응답 안 해요", "b3os 리부팅 후 안 올라와요", "b3os 업데이트/버전 올려줘"; 런타임 교체: "팀원 런타임 바꿔줘"; 시스템 잡: "b3os가 뭘 자동으로 돌려?" 등을 언급할 때. macOS 권장(팀원 활성화가 launchd 기반). 각 단계 상세는 references/ 의 해당 파일을 그때 펼쳐 읽는다.
trigger: first-time b3os install · recruiting a member · team setup
---

# b3os — b3rys TEAM OS 온보딩 스킬

**여러 AI를 한 명씩 따로 쓰지 말고, 한 팀으로.** 공개 저장소
[`github.com/b3rys/b3rys-team-os`](https://github.com/b3rys/b3rys-team-os)를 clone → 설치 → 대시보드 기동 →
팀 기본정보 세팅 → **첫 팀원 1명 영입** 까지 몰아주고, 그 팀원에게 넘긴다.

> **이 스킬의 목표 = 사용자를 "첫 팀원"까지 데려다주고 손을 뗀다(handoff).**
> 첫 팀원이 응답하면 **추가 영입·운영은 그 팀원이 이어받는다.**

**핵심 디자인** — ①**대화로 진행**: 팀 기본정보도 화면에 미루지 않고 채팅으로 묻는다 ②**사람 게이트 존중**: 봇 토큰·활성화 승인·페어링은 사람 몫, 대신 만들거나 우회하지 않는다 ③**인증은 런타임을 고른 그 순간에만** 점검하고 구독을 미리 캐묻지 않는다 ④**인증은 구독(OAuth)이 기본** — API 키는 사용자가 명시적으로 원할 때만.

## ⚠️ 시작 전 안전 고지 (사용자에게 먼저 보여줄 것)

> b3os는 **본인 전용 장비(personal machine)에만** 설치하세요. 대시보드·API는 `127.0.0.1` 로컬 단독 사용을
> 전제로 하며 **앱 레벨 인증이 없습니다.** 공용/공개 서버에 그대로 노출하지 마세요. 외부 접근이 필요하면
> Cloudflare Access 같은 **엣지 인증을 반드시 앞단에** 두세요.

macOS 권장(팀원 활성화가 launchd 기반이라 현재 macOS 전용, Linux는 대시보드까지만).

## 전체 흐름 (위에서 아래로 실행)

```
[0] 안전 고지 + 설치 위치 확인
[1] Prerequisites (brew·git — 공통만. 런타임별 인증은 [5]에서)
[2] clone → bash install.sh                                  ← 사람: 활성화 y/n
[3] bun run start → http://localhost:7878/team
[4] 팀 기본정보 = 채팅으로 물어봄 (팀명·팀장ID·팀장이름)      ※ 안 하면 영입이 400
[5] 첫 팀원 영입 (런타임 선택 → preflight → recruit)          ← 사람: 봇 토큰·페어링
[6] 1:1 DM 확인 — 응답 오면 합류 완료
[7] ★HANDOFF — "이제 팀원과 대화하세요"                        ← 여기서 이 스킬의 일은 끝
[8] (선택) 팀원 더 추가 · 팀방(그룹) 협업 · 런타임 교체
```

> ⭐ **첫 영입 팀원은 자동으로 팀 coordinator + full context 를 받는다** — 담당 미배정·모호 메시지의 기본 담당(라우팅 fallback·PM 조율)이자 팀방 최근 맥락 수신자다. 그래서 [7] handoff 대상이 된다. (이후 팀원엔 기본 미부여, 첫 리드 퇴사 시 자동 승계.)

## [0] 설치 위치

기본은 홈 폴더다. **클론 전에 먼저 알린다** — "📁 `~/b3rys-team-os` 에 설치합니다. 다른 위치를 원하면 알려주세요."

```bash
[[ "$(uname)" == "Darwin" ]] || echo "⚠ macOS 아님 — 대시보드까지만 됩니다."
export B3OS="$HOME/b3rys-team-os"
```

## [1] Prerequisites — 공통만

```bash
command -v brew >/dev/null || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
command -v git  >/dev/null || brew install git
# bun·tmux 는 install.sh 가 자동 준비. 수동이 필요하면: curl -fsSL https://bun.sh/install | bash
```

## [2] Clone + 설치

```bash
: "${B3OS:=$HOME/b3rys-team-os}"
if [ -d "$B3OS/.git" ]; then echo "이미 clone됨 — 재사용"; else git clone https://github.com/b3rys/b3rys-team-os.git "$B3OS"; fi
cd "$B3OS" && bash install.sh
```

`install.sh` = bun 확인/설치 → `bun install` → `bun run build` → `.env` 준비 → **활성화 스위치 프롬프트** → typecheck.

> **★ 사람 승인 (활성화 스위치)** — *"이 장비에서 팀원(봇) 활성화를 허용할까요? [y/N]"* 은 `.env` 의
> `APPROVAL_EXECUTION_ENABLED=1` 을 켜서 **서버가 봇을 실제로 기동**하도록 인가하는 스위치다.
> **본인 전용 맥일 때만 `y`.** 이 값을 사용자 대신 임의로 넣지 말고 사용자에게 묻는다.

## [3] 대시보드 기동 + 확인

```bash
cd "$B3OS"
bun run start >/tmp/b3os-server.log 2>&1 &   # ★백그라운드로★ — 포그라운드면 이후 단계가 막힌다
PORT=$(grep '^TEAM_HTTP_PORT=' "$B3OS/.env" 2>/dev/null | cut -d= -f2); PORT=${PORT:-7878}
for i in $(seq 1 6); do curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1 && { echo "✅ 서버 up ($PORT)"; break; }; sleep 2; done
```

사용자에게 **http://localhost:$PORT/team** 을 열고 **Settings 탭**을 띄워두게 한다.

> **★ bun PATH** — `command not found: bun` 이면 `export PATH="$HOME/.bun/bin:$PATH"` 또는 새 터미널.
> **★ 포트** — `7878 이미 사용 중` 이면 `.env` 의 `TEAM_HTTP_PORT` 를 바꾸고, **이후 모든 URL 의 포트를 그 값으로** 안내한다.
> 안 뜨면 `tail -30 /tmp/b3os-server.log`.

## [4] 팀 기본정보 — 채팅으로 물어본다

**팀명·팀장ID·팀장이름 세 가지가 먼저 있어야 영입이 열린다**(없으면 recruit 가 `setup_incomplete` 400 — 하드 선행조건). "대시보드 가서 입력하세요"로 넘기지 말고 채팅에서 직접 묻는다.

1. **팀명** (≤20자) 2. **팀장 ID** (`lead_id`, 영문 slug 1~40자) 3. **팀장 이름** (`owner_name`, ≤40자) 4. (선택) **팀장 텔레그램 chat_id** (`owner_chat_id`, 숫자 — BYO 런타임을 첫 팀원으로 쓸 때만. claude 는 불필요)

> ★예시는 제네릭 자리표시자(`acme`/`teamleader`/`Alex`)를 **그대로** 보여준다. 사용자의 실명·팀명을 예시로 쓰거나 이메일·대화 맥락에서 **유추해 넣지 마라.** 실제 값은 사용자가 직접 준 것만 쓴다. **미션은 묻지 않는다**(TEAM-OS 기본값).

```bash
curl -s -X PUT http://localhost:$PORT/team/api/settings -H 'content-type: application/json' \
  -d '{"team_name":"acme","lead_id":"teamleader","owner_name":"Alex"}'
#   응답 "setup_complete": true 면 영입 가능
```

필드 검증·에러 상세 = `references/recruit.md` Step A.

## [5] 첫 팀원 영입

> ★★이 단계에 들어오면 **먼저 `references/recruit.md` 를 펼쳐 읽고** 진행한다★★ — 물어볼 필드·질문 문구·복사용 폼·기본값이 거기 다 있다. "이름·역할" 몇 개만 묻고 넘어가지 말 것.

**① 런타임 선택** — `claude_channel`(권장·쉬움) / `openclaw`·`hermes_agent`(ChatGPT 구독 BYO 고급). 목록·권장 이유·고른 순간의 preflight 명령 = `references/runtime-setup.md`.

**② 사용자에게 먼저 다 묻는다** — **id**(영문 slug, ★display_name 과 별개이며 빠뜨리기 쉽다★) · **display_name** · **role** · **멘션명(별칭)** · **runtime+모델** · **persona**(선택).

**③ API 순서**

```
POST /team/api/members/recruit  {id, display_name, role, runtime, persona?}  → ot_id
   ── 사람: BotFather 로 봇 생성 → 토큰 ──
POST /team/api/ot/<ot_id>/provision  {bot_token}   # 토큰 0600 저장 + 런타임 로그인 preflight
POST /team/api/ot/<ot_id>/activate                 # 런타임 기동 (APPROVAL 필요)
   ── 사람: 봇에 DM → 페어링 승인 (런타임별로 다름) ──
```

> **★ 사람만 할 수 있는 것**: ①BotFather 봇 생성+토큰 ②봇에 첫 DM 보내고 페어링 승인. 토큰은 사용자가 Claude Code 에 입력하면 provision 으로 넘긴다. **받은 토큰을 화면에 다시 출력하지 않는다.**

- 활성 공식 팀원은 최대 **15명**.
- 팀원 작업공간 = `~/b3os/members/<팀원id>/` (repo 밖 자체완결 루트).
- **페이로드·OT 단계·토큰 안전전달·런타임별 페어링 게이트 = `references/recruit.md` (Step B~G) 필수 참조.**

## [6] 1:1 DM 확인 — 합류 완료

★1:1 DM 은 라우터와 무관하다★(라우터는 그룹 ingress 전용). 폰에서 첫 팀원 봇에게 "안녕"을 보낸다.

- **응답(또는 6자리 페어링 코드)이 오면 합류 완료.** claude 첫 팀원은 코드가 오는 게 정상 — 승인하면 대화된다.
- 대시보드 **Topology** 에서 팀원·런타임·채널이 초록인지 확인.
- 무응답이면 → `references/troubleshooting.md` (라우터가 아니라 **페어링 승인/플러그인/poller** 문제다).
- 런타임별 승인 방법·완료 판정 = `references/recruit.md` Step G·H. ★claude 에 `pair-approve` 를 쓰면 안 된다(openclaw 전용, 거짓성공)★

**첫 작업 시켜보기** — 응답을 확인했으면 "[팀원 이름], 간단한 거 하나 해줘"처럼 **실제로 일을 시켜보라고 권한다.** 대시보드 **Tasks 칸반**에 카드가 뜨는 걸 보면 팀의 가치가 바로 전달된다. 이 체험이 곧 handoff 의 시작이다.

## [7] ★HANDOFF — 첫 팀원에게 넘긴다 (여기서 이 스킬의 일은 끝)

> 🎉 **첫 팀원 [이름]이 합류했어요! 이제부터는 팀원과 직접 대화하세요:**
> - **`@[이름]` 멘션으로 작업 지시** (예: "@alex 이 코드 리뷰해줘")
> - **추가 영입·운영·문제해결은 팀원에게** — "다음 팀원 어떻게 영입해?" 하면 팀원이 도와줍니다.
> - 대시보드 **Tasks 칸반**으로 진행 추적, **Topology**로 연결 상태 확인.

b3os는 "설치하면 끝"이 아니라 **"첫 팀원을 세워서 그 팀원에게 넘기는 것"** 이다. 이 시점부터 사용자는 자기 AI 팀의 팀장이 되고, 이 스킬이 아니라 **팀원**이 이후를 이끈다.

**핸드오프가 작동하는 이유** — b3os 는 팀 스킬 인덱스(`docs/B3OS_SKILLS.md`)에 등록된 팀 스킬이고, 이 스킬의 `references/*` 자체가 운영 지식이다. 첫 팀원은 세팅·운영 질문을 받으면 **그때 이 스킬을 불러서** 답한다 — 페르소나에 운영 절차를 미리 밀어 넣을 필요가 없다(온디맨드 로딩).

## [8] 그다음 — 전부 선택

| 하고 싶은 것 | 어디를 편다 |
|---|---|
| 팀원 더 추가 | [5] 를 그대로 반복 · `references/recruit.md` |
| 팀방(그룹)에서 여러 팀원이 함께 대화 | `references/group-room-setup.md` (System OP 봇) |
| 기존 팀원의 런타임만 교체 (메모리 보존) | `references/b3os-ops-primer.md` §2 |
| 안 뜬다 / 봇 무응답 / 리부팅 후 복구 | `references/troubleshooting.md` · ops-primer §10 |
| 긴급 전원 정지(폭주) · 상시가동 등록 | `references/b3os-ops-primer.md` §12·§13 |
| 뭐가 자동으로 도는지 · 지연 작업 예약 | `references/system-jobs.md` |
| 업데이트 · 퇴사 · 라우터 토글 | `references/b3os-ops-primer.md` |

- **claude 팀원 여러 명** — 한 머신의 Claude 로그인 **하나를 공유**한다(각자 봇 토큰만 다름).
- **런타임 교체는 퇴사+재영입으로 하지 않는다** — 퇴사(DELETE)는 워크스페이스를 `.archived` 로 옮겨 **메모리를 잃는다.** `swap-runtime` 은 팀원 id 로 키잉된 워크스페이스를 그대로 둔다. 교체는 서비스 중단성 self-mod 라 **팀장 승인 후** 진행하고, `confirm_name` 이 `display_name` 과 정확히 일치해야 한다.

## 삭제 (uninstall)

```bash
cd "$B3OS" && bash uninstall.sh      # 전원 오프보드 → 서버 정지 → 데이터 삭제
#   --yes(확인 생략) · --keep-data(오프보드+정지만, team.db/.env 보존)
```

마지막에 스크립트가 안내하는 `rm -rf "$B3OS"` 로 repo 폴더까지 지우면 끝. base hermes 프로필은 보존된다.

## 참고 파일

| 파일 | 언제 편다 |
|---|---|
| `references/recruit.md` | 영입 상세 — API 페이로드·OT 단계·토큰 전달·런타임별 페어링 |
| `references/runtime-setup.md` | 런타임 고르기·preflight·OpenClaw/Hermes BYO 설치·인증 |
| `references/group-room-setup.md` | 팀방(그룹) 협업 — System OP 봇 셋업 |
| `references/b3os-ops-primer.md` | 운영 전반 — 추가 영입·퇴사·런타임 교체·라우터·복구·ALL-STOP·상시가동·업데이트 |
| `references/troubleshooting.md` | 봇 무응답·활성화 실패·bun PATH |
| `references/system-jobs.md` | 기본 시스템 잡 목록·지연 작업 예약 |

## 안전 원칙 (항상)

- **토큰 값 다시 출력 금지** — 받은 봇 토큰을 화면·로그·커밋에 노출하지 않는다(provision 호출에만 사용).
- **활성화 승인·페어링 코드는 사람 몫** — 대신 승인하거나 우회하지 않는다.
- **본인 전용 장비 전제** — 엣지 인증 없이 공용/공개 노출 금지.
- 공개 repo 이므로 로컬 `.env`·`team.db`·토큰은 커밋 대상이 아니다(이미 gitignore).
