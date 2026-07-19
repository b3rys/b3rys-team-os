---
name: b3os
description: b3rys TEAM OS(b3os) — 여러 AI를 한 팀으로 운영하는 멀티런타임 AI 팀 OS — 를 공개 저장소에서 clone·설치하고, 팀 기본정보를 채팅으로 세팅한 뒤 첫 팀원 1명을 영입(텔레그램 연결)해서 그 팀원에게 넘겨주는(handoff) 온보딩 스킬. Claude가 clone → install.sh → 대시보드 기동 → (채팅으로) 팀명·팀장ID·미션 세팅 → 첫 팀원 런타임 추천·영입·인증·활성화 → 라우터 ON 까지 대신 몰아주고, 사람만 할 수 있는 것(BotFather 토큰·활성화 승인·페어링)만 직접 요청한다. 첫 팀원이 응답하면 설치는 끝 — 이후 추가 영입·운영은 그 팀원이 이어받는다. 사용 시점 — 설치·세팅: "b3os 설치해줘", "b3os 세팅", "AI 팀 세팅해줘", "AI 팀 만들어줘", "b3rys 팀 만들어줘", "b3rys-team-os setup/install", "이 repo 설치하고 팀 세팅해줘(github.com/b3rys/b3rys-team-os)", "b3os 언인스톨/삭제"; 팀방·그룹 협업 세팅: "b3os 팀방 세팅 어떻게 해", "b3os 그룹방 세팅/연동", "팀 라우터(System OP) 붙여줘", "그룹방에서 팀 협업되게 해줘"; 운영·문제해결(트러블슈팅): "b3os 안 떠요/안 돼요", "team-os 상태/복구/재시작", "b3os 봇이 응답 안 해요", "b3os 리부팅 후 안 올라와요", "b3os 문제/에러/트러블슈팅", "b3os 업데이트/버전 올려줘"; 기본 시스템 잡·서비스 안내: "b3os 시스템 잡 목록", "b3os가 뭘 자동으로 돌려?", "b3os 백그라운드 서비스 뭐 있어", "b3os 기본 운영 서비스" 등을 언급할 때. macOS 권장(팀원 활성화가 launchd 기반). 운영·복구 상세는 references/b3os-ops-primer.md 참조.
---

# b3os — b3rys TEAM OS 온보딩 스킬

**여러 AI를 한 명씩 따로 쓰지 말고, 한 팀으로.** 이 스킬은 공개 저장소
[`github.com/b3rys/b3rys-team-os`](https://github.com/b3rys/b3rys-team-os)를 clone → 설치 → 대시보드 기동 →
팀 기본정보 세팅 → **첫 팀원 1명 영입(텔레그램 연결)** 까지 몰아주고, 그 팀원에게 넘긴다.

> **이 스킬의 목표 = 사용자를 "첫 팀원"까지 데려다주고 손을 뗀다(handoff).**
> 모든 운영을 이 스킬이 계속 떠안지 않는다. 첫 팀원이 응답하면 **추가 영입·운영은 그 팀원이 이어받는다.**
> 이 스킬은 **self-contained** — 저장소를 직접 clone 하므로 로컬에 미리 받아둘 필요가 없다.

## 핵심 디자인

- **Conversational** — 사용자가 "b3os 설치해줘" 하면 Claude가 아래 단계를 셸/API로 직접 실행. 팀 기본정보도
  **화면에 가서 입력하라고 미루지 않고 채팅으로 물어본다.** 사용자는 **사람만 할 수 있는 것**(BotFather 토큰,
  활성화 y/n 승인, 페어링)만 답한다.
- **런타임은 `claude_channel`을 기본 추천** — 기존 Claude 로그인 재사용, 추가 구독 불필요라 첫 사용자 경로가 가장 짧다.
  공개 표면에서는 `claude_channel`·`openclaw`·`hermes_agent`만 안내하고, OpenClaw/Hermes는 BYO 고급 런타임으로 설치 문서를 연결한다.
- **인증은 런타임을 고른 그 순간에만 점검** — 구독 여부를 미리 캐묻지 않는다. 고른 런타임의 CLI·로그인만 그때 확인.
- **사람 게이트 존중** — 봇 토큰·활성화 승인·페어링 코드는 사람 몫. Claude가 대신 만들거나 우회하지 않는다.

## ⚠️ 시작 전 안전 고지 (사용자에게 먼저 보여줄 것)

> b3os는 **본인 전용 장비(personal machine)에만** 설치하세요. 대시보드·API는 `127.0.0.1` 로컬 단독 사용을
> 전제로 하며 **앱 레벨 인증이 없습니다.** 공용/공개 서버에 그대로 노출하지 마세요. 외부 접근이 필요하면
> Cloudflare Access 같은 **엣지 인증을 반드시 앞단에** 두세요.

macOS 권장(팀원 활성화가 launchd 기반이라 현재 macOS 전용, Linux는 대시보드까지만).

## 전체 흐름 (Claude가 위에서 아래로 실행)

```
[0] 안전 고지 + 설치 위치 확인
     ↓
[1] Prerequisites 확인·설치 (brew·git·bun — 공통만. 런타임별 인증은 [5]에서 그때)
     ↓
[2] clone → bash install.sh (bun·의존성·빌드·.env + 활성화 승인 y/n)          ← 사람: y/n 답
     ↓
[3] bun run start → http://localhost:7878/team ▸ Settings 페이지가 열림       (bun PATH 주의)
     ↓
[4] 팀 기본정보 세팅 = 채팅으로 물어봄  (팀명·팀장ID·팀장이름 필수 / 미션 선택+기본값)
       └ PUT /team/api/settings {team_name, lead_id, owner_name}  +  PUT /team/api/mission
         ※ 이거 안 하면 영입이 setup_incomplete(400)으로 막힘 — 하드 선행조건
     ↓
[5] 첫 팀원 영입 = claude_channel 추천 + BYO 런타임 선택 → 고른 런타임만 인증 preflight
       ├─ 런타임 선택 → 그 런타임 CLI·로그인 점검 (present→진행 / missing→설치·로그인 안내)
       ├─ BotFather로 봇 생성 → 토큰                                        ← 사람: 토큰(Claude Code 입력 OK)
       ├─ recruit → provision(토큰) → activate → (페어링 승인)             ← 사람: 봇에 DM/승인
       └─ telegram 플러그인 user-scope 1회 설치 (claude 런타임)
     ↓
[6] 첫 팀원 1:1 DM 확인: 봇에 메시지 → 응답(또는 6자리 코드) 오면 합류 완료  ← 라우터 무관(그룹은 선택 단계)
     ↓
[7] ★HANDOFF — "이제 팀원 [이름]과 대화하세요." 추가 영입·운영은 팀원이 이어받음
     ↓
[8] (선택) 팀원 더 추가 = [5] 루프 반복 (각 런타임은 자기 구독 재사용)
```

각 상세는 아래. 영입(5)의 세부 API/UI/페어링은 `references/recruit.md`, 첫 팀원이 이어받을 운영 지식은
`references/b3os-ops-primer.md`, 막히면 `references/troubleshooting.md`, **b3os 가 백그라운드에서 돌리는 기본 시스템 잡·서비스 목록은 `references/system-jobs.md`**("무엇이 자동으로 도는지" 물으면 이걸로 안내).

## 스케줄/리마인더 운영 메모

턴기반 팀원(openclaw·hermes 등 wake 로만 움직이는 런타임)이 "5분 뒤 알려줘" 같은 지연 작업을 받으면 현재 턴에서 기다리면 안 된다. 정규 동작은
b3os 스케줄러 API로 예약 row를 만들고 즉시 답하는 것이다 (릴리즈에 실린 서버 엔드포인트 — 별도 스크립트 불필요):

```bash
curl -s -X POST http://localhost:$PORT/team/api/schedules/reminder \
  -H 'content-type: application/json' \
  -H "x-actor-id: <your_agent_id>" \
  -d '{"target_agent_id":"<your_agent_id>","body":"[예약 알림] ...","delay_seconds":300}'
```

스케줄러가 수락 가능 상태가 아니면 이 명령/API는 실패해야 한다. 그 경우 "예약했습니다"라고 말하지 말고,
현재 one-shot 예약 기능이 아직 활성화되지 않았다고 짧게 보고한다.

> `direct_to_gd`(내부 라우팅 플래그명): 예약 payload 에 true면 리마인더 결과를 **팀 리드(팀장)의 대화창으로 직접 보고**한다는 뜻. 필드명은 내부 규약이라 그대로 두되, 동작은 "리드에게 직접"으로 이해하면 된다.

예약 owner는 body가 아니라 인증 actor(`x-actor-id` 헤더, 환경에 `OP_MESSAGE_TOKEN` 있으면 `x-op-token`도)로 결정된다.
일반 팀원은 자기 agent id만 target 으로 예약·조회·취소할 수 있고(다른 agent 대상은 lead 경로만), `created_by` 위조는 거부된다.
`run_at`(ISO 시각) 또는 `delay_seconds` 중 ★정확히 하나★. `direct_to_gd:true` 면 결과를 팀 리드에게 직접 보고(비리드 actor엔 quota 적용).
취소 = `POST /team/api/schedules/<id>/cancel`. 스케줄러가 수락 불가 상태면 이 API는 실패한다 — 그땐 "예약했다"고 말하지 말고 짧게 보고.

---

## 🔌 서버가 안 떠 있을 때 (복구) + 상시가동 — **전부 선택**

> **먼저 알아둘 것: 아무것도 안 해도 된다.** b3os 는 `bun run start` 로 띄워 쓰는 게 기본이고,
> 아래 등록을 **하지 않아도 모든 기능이 정상 동작한다.** 설치·영입 단계에서 이걸 묻지도, 강요하지도 않는다.
> macOS 전용이다(Windows 미지원).

### 서버가 안 떠 있다 (대시보드가 안 열린다 / 맥앱이 "b3os 스킬로 복구하세요"라고 안내한다)

맥앱은 서버가 죽으면 대시보드를 띄울 수 없다(서버가 화면을 내려주기 때문). 그래서 앱은 여기로 안내한다.

```bash
cd "$B3OS"
bun run service status     # 상시가동으로 등록돼 있는지 확인
```

- **등록 안 됨(기본)** → 그냥 다시 띄우면 된다: `bun run start`
- **등록됨** → `bun run service restart`

### (선택) 재부팅해도 계속 돌게 하기

사용자가 **원할 때만** 안내한다. 먼저 권하지 않는다.

```bash
cd "$B3OS"
bun run service install     # 등록 + 즉시 기동
bun run service status      # 확인
bun run service uninstall   # 되돌리기(등록 해제)
```

등록하면 얻는 것: **재부팅 자동복구** · **터미널/앱을 닫아도 서버 생존** · 맥앱의 **[서버 재시작] 버튼 활성화**.

> **알아둘 점** — macOS 는 사용자 서비스(LaunchAgent)를 **부팅이 아니라 로그인 시점**에 올린다.
> 그래서 등록해 두더라도 **재부팅 후 로그인을 한 번 해야** 뜬다(자동 로그인을 켜두면 그마저 불필요).
>
> 라벨은 `com.$USER.team-collab` 이다(`TEAMOS_LAUNCHD_PREFIX` 로 변경 가능). 멤버 봇 라벨과 같은 규칙이라,
> 서버·멤버가 한 벌로 관리된다.

---

## 🛑 긴급 ALL-STOP (에이전트 폭주·이상 시)

에이전트가 폭주하거나(대량 메시지·외부 API 무한호출·통제 불능) 이상이면, **전부 즉시 중지**하고 이 스킬/CLI로 복구한다. 긴급 시 **Claude Code + `team-os`/`/b3os` 가 최후의 통제 지점** — 봇·런타임이 다 죽어도 CLI·스킬로 되살린다.

**정지 (셋 중 하나 · 같은 메커니즘)**:
- **CLI(권장)**: `team-os emergency-stop` (별칭 `allstop`·`panic`)
- **대시보드 team op 메뉴**: All-Stop (준비 중)
- **개별**: 대시보드 멤버 Settings → 정지(서킷브레이커)

**emergency-stop 이 하는 일**: ① `router_enabled=false` (team.db 직접 설정 — 서버가 폭주해도 동작하는 ingress 킬스위치) ② claude 봇 poller/tmux 정지 ③ openclaw·hermes 게이트웨이 정지. → 에이전트가 새 메시지를 **못 받고 못 보냄**. collab 서버(대시보드·API)는 유지 = 복구 surface (`--server` 로 서버까지 정지).

**복구**:
- `team-os resume` — router 재개 + `team-os up all`(런타임 기동).
- 또는 Claude Code에서 이 스킬로 상태 진단(`team-os status`·`doctor`) 후 선별 기동.
- 폭주 원인이 특정 멤버면 그 멤버만 Settings에서 정지 유지 + 나머지 `resume`.

## [0] 설치 위치 안내 + 확인

**클론 전에 설치 위치를 먼저 사용자에게 알린다** (기본 = 홈 폴더 `$HOME/b3rys-team-os`). 다음을 그대로 보여준다:

> 📁 **~/(home)에 `b3rys-team-os` 를 설치합니다. 다른 위치를 원하면 알려주세요.**

```bash
[[ "$(uname)" == "Darwin" ]] || echo "⚠ macOS 아님 — 대시보드까지만 됩니다(팀원 활성화는 launchd/macOS 전용)."
export B3OS="$HOME/b3rys-team-os"     # 기본 설치 위치(홈). 사용자가 다른 위치를 원하면 이 값만 바꾼다.
echo "설치 위치: $B3OS"
```

사용자 전용 맥인지 한 번 확인한다(위 안전 고지). 이후 이 폴더를 `$B3OS` 로 부른다.

## [1] Prerequisites — 공통만 (런타임별 인증은 [5]에서)

여기선 **어떤 런타임을 고르든 공통으로 필요한 것**만 확인·설치한다. 런타임별 CLI·로그인은 **[5]에서 런타임을
고른 그 순간에** 점검한다(구독을 미리 캐묻지 않기 위해).

```bash
# Homebrew (macOS 패키지 매니저) · git · bun 은 install.sh 가 자동 설치
command -v brew >/dev/null || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
command -v git  >/dev/null || brew install git
# bun 수동 설치가 필요하면: curl -fsSL https://bun.sh/install | bash
```

빠진 게 있으면 위 명령으로 설치하고, 설치가 안 되면 무엇이 막혔는지 사용자에게 정확히 알린다.

## [2] Clone + 설치

```bash
: "${B3OS:=$HOME/b3rys-team-os}"     # [0]에서 안내한 기본 위치(홈). 다른 위치면 [0]에서 이미 바뀜.
# 멱등: 사용자가 이미 직접 clone 하고 스킬을 부른 경우 첫 명령에서 막히지 않게 가드.
if [ -d "$B3OS/.git" ]; then echo "이미 clone됨 — 재사용: $B3OS"; else git clone https://github.com/b3rys/b3rys-team-os.git "$B3OS"; fi
cd "$B3OS"
bash install.sh
```

`install.sh`가 하는 일: ① bun 확인/설치 ② `bun install` ③ `bun run build`(대시보드) ④ `.env` 준비
(`.env.example` 복사) ⑤ **활성화 스위치 프롬프트** ⑥ typecheck.

> **★ 사람 승인 (활성화 스위치)** — `install.sh`가
> *"이 장비에서 팀원(봇) 활성화를 허용할까요? 본인 전용 맥이면 y. [y/N]"* 를 묻는다.
> 이건 `.env` 에 `APPROVAL_EXECUTION_ENABLED=1` 을 켜서 **서버가 봇 런타임을 실제로 기동**하도록 인가하는
> 스위치다. **본인 전용 맥일 때만 `y`.** Claude는 이 값을 사용자 대신 임의로 넣지 말고 사용자에게 y/n을
> 물어라. (헤드리스로 프롬프트에 답할 수 없으면, 사용자에게 `y` 입력을 요청하거나 설치 후
> `.env` 에 `APPROVAL_EXECUTION_ENABLED=1` 을 추가하고 서버 재시작하도록 안내.)

## [3] 대시보드 기동 + 확인

```bash
cd "$B3OS"
bun run start >/tmp/b3os-server.log 2>&1 &   # 서버 기동 (DB 자동 생성). ★백그라운드로★ — 포그라운드로 띄우면 이후 단계가 막힌다. 로그는 /tmp/b3os-server.log.
```

> **★ bun PATH 주의** — `install.sh`가 방금 bun을 새로 깔았다면 현재 셸 PATH에 아직 없다.
> `command not found: bun` 이면 새 터미널을 열거나 `source ~/.zshrc`(bash면 `~/.bashrc`) 후 재실행,
> 또는 `export PATH="$HOME/.bun/bin:$PATH"` 로 즉시 해결.

> **★ 포트 주의 (기본 7878, 이 문서 URL 은 전부 예시)** — 서버가 `포트 7878 이미 사용 중` 이라고 종료하면,
> `.env` 의 `TEAM_HTTP_PORT` 를 다른 값(예: 7900)으로 바꾸고 다시 `bun run start` 한다. ★그 뒤로는 아래 모든
> `localhost:7878` URL 의 포트를 그 값으로 바꿔서 안내·호출한다★ (실포트 = `grep '^TEAM_HTTP_PORT=' "$B3OS/.env" | cut -d= -f2`, 없으면 7878).

기동 확인(응답 오면 OK):
```bash
PORT=$(grep '^TEAM_HTTP_PORT=' "$B3OS/.env" 2>/dev/null | cut -d= -f2); PORT=${PORT:-7878}
# 콜드 부팅 여유로 ~12s 재시도
for i in $(seq 1 6); do
  curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1 && { echo "  ✅ 서버 up (포트 $PORT)"; ok=1; break; }
  sleep 2
done
[ -z "${ok:-}" ] && echo "  ⚠ 서버가 안 뜸 — 로그 확인: tail -30 /tmp/b3os-server.log  (포트 충돌이면 .env 의 TEAM_HTTP_PORT 를 다른 값으로 바꾸고 재시작)"
```

사용자에게 브라우저로 **http://localhost:$PORT/team** (실포트, 기본 7878)을 열라고 안내한다. 이 페이지가 뜨면 **Settings(설정)
탭**을 열어 두게 한다 — 다음 단계(팀 기본정보·미션)를 화면에서 눈으로 확인하며 진행할 수 있다.

> 이대로 쓰면 된다. (재부팅해도 계속 돌게 하는 **선택** 옵션은 위 「🔌 서버가 안 떠 있을 때 + 상시가동」 참고 —
> **안 해도 되고, 여기서 묻지 않는다.**)

## [4] 팀 기본정보 세팅 — **채팅으로 물어본다** (화면에 미루지 않음)

**영입을 열려면 팀명·팀장ID·팀장이름(owner_name) 세 가지가 먼저 있어야 한다** — 하나라도 없으면 recruit가 `setup_incomplete`(400, missing 맵에 빠진 필드 표시)으로 막힌다(하드 선행조건).
"대시보드 가서 입력하세요"라고 넘기지 말고, **Claude가 채팅에서 직접 물어본다:**

> ★예시는 제네릭 자리표시자다 — 사용자에게 실제 값을 **물어보기만** 하고, 예시로는 아래 제네릭(`acme`/`teamleader`/`Alex`)을 **그대로** 보여준다. ★사용자의 실명·팀명·chat_id 등 개인정보를 예시로 쓰지 말고, 이메일·계정·대화 컨텍스트에서 실명을 **유추해서 넣지도 마라.**★ 실제 값은 사용자가 직접 준 것만 쓴다.

1. **팀명** (필수, ≤20자) — 예: "acme"
2. **팀장 ID** (필수, `lead_id`) — 영문 slug(소문자/숫자/`-`/`_`, 1~40자). 멘션·라우팅에서 팀장을 가리키는 식별자. 예: `teamleader`
3. **미션** (선택) — 팀의 한 줄 미션. **비우면 아래 기본값을 넣는다**(나중에 대시보드에서 편집 가능):
   > ★기본 미션: **우리 팀은 각 팀원의 전문성을 살려, 팀장의 과제와 프로젝트를 최고의 팀워크로 수행합니다.**★
4. **팀장 이름** (필수, `owner_name`, ≤40자, 사람 이름) — 페르소나/미션의 `{{OWNER}}` 자리표시자를 채운다. 반드시 물어본다(사용자가 준 이름을 넣되, 예시로는 실명 대신 `Alex` 같은 제네릭을 보여준다). 예: `Alex`
5. (선택) **팀장 텔레그램 chat_id**(`owner_chat_id`, 숫자) — 그룹 캡처·라우팅용. ★인바운드 DM 게이트는 런타임별로 다르다★(openclaw=pair-approve 페어링, hermes=인바운드 게이트 없음 — 아래 🔐 참조). owner_chat_id 자체가 openclaw/hermes DM을 막지는 않는다.
   - **claude_channel 은 이 값이 필요 없다** — claude 는 봇 DM 접근을 access.json 페어링(6자리 코드 승인)으로 관리한다(owner_chat_id 로 안 채워짐). claude 만 쓸 거면 생략.
   - **외부/BYO 런타임을 첫 팀원으로 영입할 땐** 이 값을 받아 넣는다. 팀장이 모르면 "텔레그램 @userinfobot 에게 DM하면 알려준다"고 안내.

받은 값으로 **두 API를 호출한다** (팀명·팀장ID는 `/settings`, 미션은 별도 `/mission` 엔드포인트 — 실제 백엔드가 이렇게 분리돼 있다):

```bash
# ① 팀명 + 팀장ID (owner_name·owner_chat_id는 선택)
curl -s -X PUT http://localhost:$PORT/team/api/settings \
  -H 'content-type: application/json' \
  -d '{"team_name":"acme","lead_id":"teamleader","owner_name":"Alex"}'
#   응답에 "setup_complete": true 면 영입 가능 — 팀명·팀장ID·팀장이름 셋 다 채워져야 true. (team_name>20자·lead_id 형식오류면 400)
#   외부/BYO 런타임을 첫 팀원으로 영입할 거면 owner_chat_id도 같이. claude 는 access.json 페어링으로 접근을 관리하므로 owner_chat_id 불필요(생략):
#   -d '{"team_name":"acme","lead_id":"teamleader","owner_name":"Alex","owner_chat_id":"123456789"}'  # 숫자만, 빈값 허용

# ② 미션 — 사용자가 준 값, 비었으면 기본 미션 문자열을 넣는다
curl -s -X PUT http://localhost:$PORT/team/api/mission \
  -H 'content-type: application/json' \
  -d '{"mission":"우리 팀은 각 팀원의 전문성을 살려, 팀장의 과제와 프로젝트를 최고의 팀워크로 수행합니다."}'
```

> **왜 채팅으로?** 팀명·팀장ID·미션은 사용자가 이미 머릿속에 답을 아는 짧은 질문이다. 화면 이동 없이
> 대화에서 받아 API로 넣으면 마찰이 적다. 사용자가 "직접 화면에서 넣을게" 하면 Settings 탭에서 넣도록 코치만 한다.

## [5] 첫 팀원 영입 — 런타임 추천 + 나열 + 런타임별 인증 preflight

> **첫 팀원은 자동으로 "팀 리드"가 됩니다 — 사용자에게 한 줄로 알려준다.**
>
> "첫 팀원은 **팀 리드**가 되어, 팀원들의 메시지 맥락을 함께 봅니다. (담당자가 정해지지 않은 일도 이 팀원이 맡습니다)"
>
> 내부적으로는 첫 영입 멤버에게 `coordinator`(기본 담당자) + `full_context`(팀방 대화 맥락 수신)가 자동 부여된다.
> 이후 영입되는 팀원은 자기에게 온 메시지만 본다. 팀 리드가 팀을 나가면 남은 팀원 중 한 명이 같은 역할을 승계한다.

### 5-1. 런타임 추천 + 나열

**런타임은 "어떤 구독을 쓰는지"로 추천한다 — 먼저 물어본다("Claude 구독이세요, ChatGPT 구독이세요?"):**

- **Claude 구독자 → `claude_channel`** — 기존 Claude 로그인을 그대로 재사용(추가 구독·키 없이 바로). Claude Code에서 이 스킬을 실행 중이면 특히 매끄럽다.
- **ChatGPT 구독자 → `hermes_agent` 또는 `openclaw`** — ChatGPT/Codex 구독을 **OAuth**로 재사용(API 키 아님). 둘 다 BYO 고급 런타임이라 CLI·인증을 먼저 갖춘다(`references/runtime-setup.md`; hermes 는 `hermes auth add openai-codex --type oauth`).
- **모르거나 첫 팀원이면 → `claude_channel`** 이 가장 짧은 경로(AI가 설치·인증까지 몰아줄 수 있음).

> ★인증은 항상 **구독(OAuth) 기본, API 키 아님**. 자동발견된 `*_API_KEY` 는 사용자가 명시적으로 원할 때만.★

그리고 공개 표면의 목록을 보여준다:

| # | runtime | 한 줄 설명 | 난이도 | 설치 주체 |
|---|---|---|---|---|
| 1 | `claude_channel` | 로컬 Claude Code 세션 연결(tmux 봇). 기존 Claude 로그인 재사용 | 쉬움 | **AI 자동** (사람은 CLI 로그인만) |
| 2 | `openclaw` | OpenClaw gateway/session | 고급 | **BYO** — CLI+게이트웨이+인증 에이전트 **미리 준비** |
| 3 | `hermes_agent` | Hermes 프로필 게이트웨이 | 고급 | **BYO** — CLI+인증 프로필 **미리 준비** |

> **첫 팀원은 `claude_channel` 권장.** AI가 설치·인증 안내까지 가장 안정적으로 몰아줄 수 있는 공개 기본 경로다.
> **`openclaw`·`hermes_agent` 는 "BYO(bring-your-own) 고급 런타임"** — 각자 CLI·게이트웨이·구독 인증·인증된 에이전트 1개가 **미리 갖춰져 있어야** 하며 b3os가 대신 설치하지 않는다. 준비 안 됐으면 preflight에서 막히니, **그럴 땐 `references/runtime-setup.md`의 설치·인증 절차를 안내하거나 `claude_channel`로 되돌린다.**
> **사용자가 위 3개 목록에 없는 런타임(예: 다른 AI 앱·CLI)을 요청하면** — 공개 지원 런타임은 `claude_channel`·`openclaw`·`hermes_agent` 3개뿐이라고 정직히 안내한다(영입 API가 그 외 런타임은 400으로 거부). 목록에 없는 것을 영입 선택지로 제시하지 말고, `claude_channel`(권장)로 안내한다.

> 💡 **어떤 런타임이든 '첫 영입'은 Claude Code 세션에서 진행하는 걸 권장한다.** Claude Code는 preflight·준비물 설치·인증 안내·(고급 런타임은) API 영입까지 셸로 직접 몰아줄 수 있어(대시보드는 설치·인증을 못 함), openclaw·hermes 팀원도 **Claude Code에서 이 스킬로 영입**하는 게 가장 매끄럽다. 영입이 끝나 그 팀원이 응답하기 시작하면, 이후 추가 영입·운영은 그 팀원이 이어받는다.

> 🔐 **발신자 게이트 — claude 와 외부/BYO 런타임은 다르다:**
> - **claude_channel (기본축)**: 봇 DM 접근 허용은 access.json allowlist 로 관리된다. ★첫 claude 팀원은 봇 DM의 6자리 페어링 코드를 사람이 승인하는 게 **정상 경로**★ — 활성화로 봇이 뜨면 봇에 "안녕" → 봇이 6자리 코드로 응답 → 사람이 승인하면 이후 대화된다. 2번째부터의 claude 팀원은 첫 팀원의 allowlist(`allowFrom`)를 **자동 승계**(seedClaudeAccess가 기존 claude 멤버 access.json을 참조)해 페어링 없이 바로 대화된다. **완료 검증 = 봇 DM에 답(또는 6자리 코드)이 오는지**로 본다 — `owner_chat_id`로 검증하지 않는다(페어링은 access.json에 쓰고 owner_chat_id를 채우지 않는다).
> - **openclaw**: 인바운드 DM 게이트 = ★pair-approve 페어링★(대시보드 [접근 승인]). 승인 전에는 응답 안 함 = 그게 게이트다. `owner_chat_id`가 openclaw DM을 막는 값이 아니다.
> - **hermes**: ★인바운드 DM 발신자 게이트가 없다(현재 한계)★ — activate 성공하면 아무 사람의 DM에도 응답할 수 있다. `owner_chat_id`를 넣어도 hermes DM은 제한되지 않으니, 신뢰할 수 있는 환경이나 그룹 위주로 쓴다.
> - **`owner_chat_id`(팀장 chat_id)**: 그룹 캡처·라우팅 등에 쓰는 값이며 ★openclaw/hermes 인바운드 DM을 막는 게이트가 아니다★(위 두 항목이 실제 게이트). claude 페어링(access.json)과도 별개다.

### 5-2. 런타임을 고른 순간 → 그 런타임만 인증 preflight

**구독을 미리 캐묻지 않는다.** 고른 런타임의 CLI·로그인만 그때 확인한다.

> **★인증은 "구독 모델"(OAuth)이 기본 — API 키가 아니다.★** claude/openclaw/hermes 모두 **이미 쓰는 구독을 OAuth 로그인으로 재사용**하는 게 기본 경로다(claude_channel 을 권한 이유와 동일). 어떤 구독으로 붙일지는 **사용자에게 물어본다**("Claude / ChatGPT / … 중 어느 구독?"). 환경에 `OPENAI_API_KEY` 같은 키가 이미 있어도, 사용자가 API 키를 원한다고 하지 않았으면 **구독(OAuth)으로 안내**하고 자동발견된 API 키 항목은 쓰지 않는다. API 키 방식은 **사용자가 명시적으로 원할 때만**의 예외 경로다. (BYO 런타임 인증 상세 = `references/runtime-setup.md`)

- **`claude_channel` (쉬움, 대개 이미 로그인됨)**
  ```bash
  command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code
  command -v tmux   >/dev/null || brew install tmux
  claude --version && tmux -V
  ```
  미로그인이면 활성화 preflight가 막고 안내한다 → "터미널에서 `claude` 한 번 실행해 로그인해 주세요".
- **`openclaw` (고급)**: openclaw CLI + **인증된 에이전트 1개**(auth 복제 소스) + `python3`. 게이트웨이/세션
  세팅이 필요 — 사용자에게 **고급**임을 알리고 `references/runtime-setup.md`를 따른다.
- **`hermes_agent` (고급)**: hermes CLI + **base 프로필 1개**(auth 시드) + `python3`. 프로필 게이트웨이
  세팅이 필요 — **고급**임을 알리고 `references/runtime-setup.md`를 따른다.

> 있으면 바로 진행(present→proceed), 없으면 그 런타임의 설치·로그인만 안내(missing→guide). 다른 런타임 얘기로
> 사용자를 헷갈리게 하지 않는다.

### 5-3. 영입 API 순서 (요약)

```
POST /team/api/members/recruit  {id, display_name, role, runtime, persona?}   → ot_id
   ── 사람: BotFather에서 봇 생성 → 토큰을 Claude Code에 입력(본인 머신이라 OK) ──
POST /team/api/ot/<ot_id>/provision  {bot_token}          # 토큰 0600 저장 + 런타임 로그인 preflight
POST /team/api/ot/<ot_id>/activate                        # 런타임 기동(APPROVAL 필요)
   ── claude 런타임: telegram 플러그인 user-scope 1회 설치 ──
   ── 사람: 봇에 DM → 페어링 코드 승인 (claude_channel/openclaw만) ──
```

> **★ 사람만 할 수 있는 것**: ① BotFather 봇 생성 + 토큰(@BotFather → `/newbot`) ② 봇에 첫 DM 보내고
> 페어링 코드 승인. 토큰은 **사용자가 Claude Code에 입력**하면 Claude가 provision 호출로 넘긴다(본인 머신·본인
> 봇·revocable이라 실용적으로 안전). 더 조심하려면 대시보드 보안입력칸에 직접. Claude는 받은 토큰을 화면에 다시 출력하지 않는다.

> **팀원 작업공간 위치** — 영입된 팀원의 작업공간(페르소나 `SOUL.md` + 규칙 `CLAUDE.md`/`AGENTS.md` + `TEAM-OS.md` 심링크)은
> `$B3RYS_HOME/members/<팀원id>/` 에 생성됩니다(install.sh가 `B3RYS_HOME=$HOME/b3os` 세팅 → `~/b3os/members/<팀원id>/`, **repo 밖 자체완결 루트**).

**상세 페이로드·OT 단계·토큰 안전전달·런타임별 페어링 = `references/recruit.md` 반드시 참조.**

## [6] 첫 팀원과 1:1 DM 확인 (합류 완료 — 라우터와 무관)

★1:1 DM 은 라우터와 무관하다★(라우터는 그룹 ingress 전용). 폰에서 첫 팀원 봇에게 **1:1 DM**으로 "안녕" 보낸다:
- **claude 첫 팀원**이면 봇이 **6자리 페어링 코드**로 응답한다. 승인(DM 허용)은 ★Claude Code 가 `~/.claude/channels/telegram-<id>/access.json` 의 `allowFrom` 에 본인 텔레그램 DM chat_id 를 추가하고 `dmPolicy` 를 `allowlist` 로 바꾸면★ 된다(activate 가 출력하는 안내 [F]와 동일 — 항상 작동, 외부 스킬 불필요). `setup-claude-telegram-bot` 스킬이 설치돼 있으면 `promote-pending.sh <id> <code>` 도 가능. ★주의: 대시보드 [접근 승인]·`pair-approve` 는 **openclaw 전용**이라 claude 엔 no-op(`skipped:true` 거짓성공)이다 — claude 페어링엔 쓰지 말 것.★ 승인하면 합류 완료. ★6자리 코드가 오는 것 자체가 봇이 살아있다는 신호★. (2번째 팀원부터는 첫 팀원 allowlist 를 승계해 페어링 없이 바로 답한다.)
- **응답(또는 6자리 코드)이 오면 첫 팀원 합류 완료** — 첫 팀원은 DM만으로 충분하다.
- 대시보드 **Topology** 에서 팀원·런타임·채널이 초록인지 확인.
- 아무 응답도 없으면 → `references/troubleshooting.md` (1:1 무응답은 라우터가 아니라 **페어링 승인/플러그인/poller** 문제다).

> **라우터 ON 은 여기서 필요 없다.** 라우터는 여러 팀원을 한 텔레그램 **그룹**에 모아 System OP 봇으로 라우팅하는 ★그룹(팀방) 협업용★이다(아래 선택 단계 "System OP 봇"). 1:1 DM만 쓸 거면 건너뛴다.

### ★ 첫 작업 시켜보기 (팀의 가치를 바로 체험 — handoff 로 이어짐)

응답을 확인했으면, 사용자에게 **첫 팀원에게 실제로 일 하나를 시켜보라고 권한다:**

> 💬 **팀원에게 첫 작업을 시켜보세요** — 예: "@[팀원] 간단한 거 하나 해줘".
> 팀원이 응답하고, 대시보드 **Tasks 칸반**에 카드로 뜨는 걸 확인하면
> **'AI 팀에게 일 맡기고 추적하는' 느낌**이 옵니다.

특정 작업 API를 만들 필요 없다 — 그냥 팀원에게 **자연스럽게 말을 걸도록** 안내하면 된다. 이 체험이 곧
아래 handoff(§7)의 시작이다.

---

## [7] ★HANDOFF — 첫 팀원에게 넘긴다 (여기서 이 스킬의 일은 끝)

첫 팀원이 응답하면 **설치는 끝이고, 이제 그 팀원과 일하는 단계**다. 사용자에게 이렇게 안내하고 **손을 뗀다:**

> 🎉 **AI 팀의 첫 팀원 [이름]이 합류했어요! 이제부터는 팀원과 직접 대화하세요:**
> - **텔레그램/대시보드에서 `@[이름]` 멘션으로 작업 지시** (예: "@alex 이 코드 리뷰해줘")
> - **추가 영입·운영·문제해결은 팀원 [이름]에게 물어보세요** — "다음 팀원 어떻게 영입해?" 하면 팀원이 도와줍니다.
> - 대시보드 **Tasks 칸반**으로 진행 추적, **Topology**로 연결 상태 확인.

즉 b3os는 "설치하면 끝"이 아니라 **"첫 팀원을 세워서 그 팀원에게 넘기는 것"** — 이 시점부터 사용자는 자기 AI
팀의 팀장이 되고, 이 스킬이 아니라 **팀원**이 이후를 이끈다.

### ★ 핸드오프가 실제로 작동하려면 — b3os 자체가 팀 스킬이다

첫 팀원이 "다음 팀원 어떻게 영입해?" 같은 **세팅·운영 질문**을 받으면, **b3os 스킬을 그때 불러서** 답한다.
b3os는 팀 스킬 인덱스(`docs/B3OS_SKILLS.md`)에 등록된 **팀 스킬**이고, 이 스킬의
`references/recruit.md`·`references/b3os-ops-primer.md`·`references/troubleshooting.md` **자체가 운영
지식**이다. 팀원 페르소나에 운영 절차를 미리 밀어 넣을(주입) 필요가 없다 — **필요할 때만 온디맨드로
로드**하는 progressive disclosure(점진적 노출)라 페르소나가 비대해지지 않는다.

> **왜 코드 주입이 아니라 스킬인가** — 예전엔 ops-primer를 `bundle` 응답이나 `buildPersona`로 팀원
> 워크스페이스에 자동 주입하는 **저장소 코드 변경**을 고려했으나, 설계상 **b3os를 팀 스킬로 두는 쪽**으로
> 정했다. 팀원은 설치·운영 질문이 올 때 이 스킬(recruit.md / b3os-ops-primer.md / troubleshooting.md)을
> 참조하면 되고(온디맨드), b3rys-team-os 저장소 코드는 건드리지 않는다. 영입 시
> `GET /team/api/ot/<ot_id>/bundle` 이 **TEAM-OS 미션·현재상태·능력 카탈로그·팀 스킬 목록·persona**를
> 첫 팀원에게 전달하는 자동 주입은 그대로 두고, **"어떻게 영입/퇴사/라우터/삭제하나" 같은 운영 절차만
> 스킬로 분리**해 그때그때 로드한다.

## [8] (선택) 팀원 더 추가 — 영입 루프 반복

첫 팀원 이후 "팀원 더 추가할까요?" 물어보고, 원하면 **[5]를 그대로 반복**한다(런타임 선택 → 그 런타임 preflight
→ recruit → provision → activate → 페어링). 런타임별 참고:

- **claude 팀원 여러 명** — 한 머신의 Claude 로그인 **하나를 공유**한다(각자 봇 토큰만 다름). telegram 플러그인은 user-scope 1회면 끝.
- **openclaw 팀원** — 공유 게이트웨이. 새 에이전트마다 페어링(pair-approve) 필요.
- **hermes 팀원** — 프로필별 게이트웨이. base 프로필(`b3ryshermes`)은 auth 소스라 퇴사/삭제 대상이 아님.

> 다만 **추가 영입도 첫 팀원이 이어받는 게 이상적**이다(§7 handoff). 이 스킬은 "첫 팀원까지"가 기본 임무이고,
> [8]은 사용자가 스킬에게 계속 맡기고 싶을 때의 편의 경로다.

---

## [9] 런타임 교체(runtime swap) — 기존 팀원의 런타임만 바꾸기 (메모리 보존)

이미 합류한 팀원을 **퇴사 없이** 다른 공개 런타임(`claude_channel`/`openclaw`/`hermes_agent`)으로 옮긴다.
워크스페이스(`MEMORY.md`·`memory/*.md`·`TODO.md`·git)는 **팀원 id로 키잉**돼 있어 런타임이 바뀌어도 그대로
남는다 — **퇴사(DELETE)와 달리 워크스페이스를 `.archived`로 옮기지 않는다.** 그러니 "런타임만 바꾸고 싶다"는
요청에 절대 퇴사(DELETE)+재영입(recruit) 경로를 쓰지 않는다(그 경로는 메모리를 archive로 이동시켜버린다).

```
STEP A. 요청 파싱 — "[팀원]을 [런타임]으로 바꿔줘" → target을 claude_channel/openclaw/hermes_agent 로 정규화.
        별칭·오타면(예: "오픈클로"→openclaw, "클로드"→claude) 확인 질문.
        ↓
STEP B. ★preflight — 대상 런타임의 CLI·인증을 실제로 확인 (present→진행 / missing→안내, 아래 참조)
        ↓
STEP C. present → POST /team/api/members/<id>/swap-runtime {target_runtime, confirm_name} 호출
        → 단계별 진행(teardown→registry→persona→activate) 관찰 → poller 정상까지 확인
        ↓
STEP D. missing → 무리하게 설치 시도하지 말고 안내 (claude=설치 가능 / openclaw·hermes=BYO 사전준비)
        ↓
STEP E. "교체 완료 + 메모리 보존됨" 보고 (auto-memory 소실 경고는 아래 참조)
```

- **preflight가 스킬의 강한 부분** — 대상 런타임의 CLI·인증을 그 자리에서 직접 확인한다(바이너리
  `which`/고정경로, 인증 파일은 **존재 여부만**([ -s ] 또는 `ls`) — **값은 절대 열람하지 않는다**). [5-2]와
  같은 present→proceed / missing→guide 원칙. `claude_channel`은 CLI 설치가 쉬우니 설치·로그인
  명령을 **팀장이 이 서버 Mac 터미널에서 직접 실행**하도록 구체적으로 안내한다(경로만 안내, 토큰·키 값은
  화면에 출력하지 않는다). `openclaw`/`hermes_agent`는 게이트웨이·인증 에이전트가 **미리 준비**돼 있어야
  하는 BYO 고급 런타임이라 — 준비 안 됐으면 [5-1]과 동일하게 **무리해서 설치 시도하지 말고**(할루시 위험)
  `claude_channel` 대안을 권하거나 팀장에게 사전 준비를 요청한다. 재확인 후 재시도.
- **`confirm_name`은 필수** — 팀원의 `display_name`과 정확히 일치해야 한다(퇴사의 오발 방지 안전장치와
  동일 패턴). 이 안전장치 없이는 서버가 거부한다.
- **파괴적 self-mod — 반드시 팀장 승인 후 진행.** 런타임 교체는 봇 프로세스 재시작·브리지 파일 교체를
  동반하는 서비스 중단성 작업이다(TEAM-OS §4). **dry-run(preflight 결과 + 계획 표시)을 먼저 보여주고,
  팀장이 "가" 또는 터미널/`/approve`로 승인한 뒤에만** 실제 `swap-runtime` 호출을 실행한다. 서버도
  `APPROVAL_EXECUTION_ENABLED=1`(활성화 스위치, [2] 참조)가 아니면 교체를 거부한다.
- **메모리 보존 범위를 사용자에게 명시**: 워크스페이스(`MEMORY.md`·`memory/*.md`·`TODO.md`·`README.md`·git)는
  그대로 유지된다. 단 **auto-memory(Claude 전용, `~/.claude/projects/.../memory/`)는 워크스페이스 밖에
  있고 Claude 런타임에서만 주입된다** — `claude_channel`에서 다른 런타임으로 바꾸면 이 자동 기억은 **파일은
  디스크에 남지만 다음 세션에 주입되지 않는다.** 교체 전 이 점을 미리 경고한다.
- 상세 절차(엔드포인트 계약·단계별 로그·에러 코드·롤백 동작)는 `references/b3os-ops-primer.md`
  **"팀원 런타임 교체(runtime swap)"** 절 참조.

---

## (선택) 팀방(그룹) 협업 셋업 — System OP 봇

> **이름 정리** — 이 봇은 문서·UI 곳곳에서 **System OP 봇 = 팀 라우터 = capture 봇**으로 불린다(같은 하나). 대시보드 라벨은 **"시스템 OP"**, 토큰 입력칸은 **"capture 봇 토큰"**. 아래는 전부 이 한 봇 얘기다.

첫 팀원은 **1:1 DM**으로 충분하다(그룹·System OP 봇 불필요). 하지만 **여러 팀원을 한 텔레그램 그룹에 모아
함께 대화**하고 싶으면 **System OP 봇**을 붙인다 — 이 봇이 팀 텔레그램 **그룹의 입구(ingress, 수신 경로)**
역할을 해서 그룹 메시지를 담당 팀원(에이전트)에게 라우팅한다. 즉 System OP 봇은 **그룹 협업을 켜는
스위치**이지 모니터링 알림 봇이 아니다. (그래서 이 단계가 "첫 팀원(DM)" 다음에 오는 선택 단계다.)

**System OP 봇이 하는 일 (정확히):**
- **그룹 ingress** — 팀 텔레그램 그룹을 읽어 각 메시지를 담당 팀원에게 라우팅.
- **온디맨드(on-demand) 명령** — 그룹/DM에서 물으면 그때 답하는 명령: `/status`(팀 상태) ·
  `/board`(칸반) · `/digest`(요약) · `/approve`(민감 실행 승인) · `/onoff`(라우터/기능 토글).

> **⚠️ System OP 봇은 "시스템 오퍼레이터"입니다 — 대화모드 OFF.** 팀원처럼 잡담·대화하지 않습니다.
> 그룹을 연결(ingress/라우팅)하고 **명령**(`/status` `/board` `/digest` `/approve` `/onoff`)에만 답할 뿐입니다.
> 그러니 사용자에게 이 봇을 **팀원처럼 "말 걸 수 있는" 대상으로 안내하지 마세요** — 대화는 팀원(에이전트)에게, OP 봇은 명령에.

**셋업 (사람: 봇 1개 + 그룹 chat_id):**
1. BotFather로 **System OP 전용 봇**을 하나 더 만들어 토큰을 받는다(팀원 봇과 별개의 봇).
2. 팀원들을 넣을 **텔레그램 그룹**을 만들고 그 봇을 초대한다. 그룹 **chat_id**(대개 `-100…`으로 시작) 얻는 법: 그룹에 잠깐 **@userinfobot**(또는 @RawDataBot)을 초대하면 그룹 id를 알려준다(확인 후 내보내면 됨). 또는 System OP 봇을 그룹에 넣고 아무 메시지를 보낸 뒤 `https://api.telegram.org/bot<OP봇토큰>/getUpdates` 응답의 `chat.id` 를 본다.
3. 대시보드 **Settings ▸ 시스템 OP (System OP)** 에 **봇 토큰 + 그룹 chat_id** 를 입력 → **서버 재시작**(capture 봇 poller 는 재시작 시 기동된다).
4. **Router ON** (Settings ▸ 시스템 OP 토글 또는 `.env` `ROUTER_ENABLED=true`). ★라우터 토글은 즉시 반영★(재시작 불필요) — 재시작은 위 3번 토큰 입력에만 필요하다.
5. 그룹에 `@팀원` 멘션 또는 `/status` → 응답이 오면 팀방 협업 준비 완료.

**헬스 모니터링은 대시보드에서만 본다 (정직하게):**
- b3os는 에이전트 위험/복구 감지·라이브 상태 같은 **헬스 모니터링을 자동으로** 돌리지만, 그 결과는
  **대시보드(Topology/Team 탭)에서만** 보인다. **b3os는 텔레그램으로 헬스 알림을 push 하지 않는다.**
- 공개 빌드에는 **auto-heal(자동복구)도, 예약 digest 자동 푸시도 없다** — 그건 별도 내부 전용
  스크립트/launchd이고 **공개 저장소에서 제외**돼 있다. (`/digest` 명령은 물었을 때 답하는 온디맨드일 뿐,
  주기적으로 알아서 보내주지 않는다.)
- 그러니 **"뭔가 깨지면 텔레그램으로 알려준다"고 안내하지 말 것** — 공개 빌드에선 사실이 아니다. 상태는
  **대시보드에서 확인**하고, System OP 봇은 **ingress + 온디맨드 명령**만 한다고 정직하게 안내한다.

---

## 삭제 (uninstall)

사용자가 "b3os 언인스톨/삭제해줘" 하면:
```bash
cd "$B3OS" && bash uninstall.sh          # 확인 프롬프트 → 팀원 전원 오프보드 → 서버 정지 → 데이터 삭제
#   bash uninstall.sh --yes              # 확인 생략(자동화)
#   bash uninstall.sh --keep-data        # 오프보드+정지만, team.db/.env/데이터 보존
```
마지막에 스크립트가 안내하는 `rm -rf "$B3OS"` 로 repo 폴더까지 지우면 끝.
(uninstall.sh는 base hermes 프로필 `b3ryshermes`는 보존하고, 알려진 경로만 안전하게 지운다.)

## 참고 파일

- `references/recruit.md` — 영입 상세: API 페이로드·OT 단계(register→provision→preflight→bundle→join)·
  telegram 플러그인 user-scope 설치·페어링 코드 승인·토큰 안전전달·런타임별 차이(claude/openclaw/hermes).
- `references/runtime-setup.md` — OpenClaw/Hermes BYO 런타임 설치·인증 절차와 preflight 재확인.
- `references/b3os-ops-primer.md` — **첫 팀원이 이어받을 운영 요약**: 추가 영입·퇴사·**런타임 교체(swap)**·
  라우터 토글·트러블슈팅·삭제. 핸드오프(§7) 이후 팀원이 세팅·운영 질문을 받으면 이 스킬을 통해
  **온디맨드로 참조**하는 운영 레퍼런스(코드 주입 아님).
- `references/troubleshooting.md` — 봇 무응답·활성화 실패·활성화 비허용·bun PATH 등 4대 트러블슈팅.

## 안전 원칙 (항상)

- **토큰 값 다시 출력 금지** — 받은 BotFather/봇 토큰을 화면·로그·커밋에 다시 노출하지 않는다(provision 호출에만 사용).
- **활성화 승인·페어링 코드는 사람 몫** — Claude가 대신 승인하거나 우회하지 않는다. (b3os는 승인 PIN을
  강제하지 않는다 — 민감 실행은 대시보드에서 사람이 승인하면 바로 실행된다.)
- **본인 전용 장비 전제** — 공용/공개 노출 금지(엣지 인증 없이).
- 저장소가 공개 repo이므로, clone 후 로컬 `.env`·`team.db`·토큰은 커밋 대상이 아니다(이미 gitignore).
