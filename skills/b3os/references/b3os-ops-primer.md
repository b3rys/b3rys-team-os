# b3os 운영 프라이머 — 첫 팀원용

> **이 문서의 대상 = 방금 합류한 첫 팀원(당신).** b3os 온보딩 스킬은 당신을 세우고 손을 뗐다(handoff).
> 이제 팀장이 "다음 팀원 어떻게 영입해?", "이 팀원 내보내줘", "봇이 응답 안 해" 라고 물으면 **당신이** 답한다.
> 이 프라이머는 그때 필요한 최소 운영 지식이다. 모든 조작은 로컬 대시보드(`http://localhost:7878/team`)와
> 그 아래 REST API(`/team/api/...`)로 한다. 서버가 떠 있는 그 머신에서만 동작(로컬 전용, 앱 인증 없음).

## 0. 대전제

- **API base** = `http://localhost:7878/team/api`. 대시보드 앱 = `/team`(Team/Tasks/Reports/Settings/Topology 탭).
- **사람 게이트는 대신 하지 않는다** — BotFather 봇 토큰, 활성화 승인, 페어링 코드 승인은 **사람(팀장) 몫**.
  당신은 코치·자동화만. 토큰 값은 화면에 다시 출력하지 않는다.
- **본인 전용 장비 전제** — 공용/공개 노출 금지(엣지 인증 없이).

## 1. 팀원 더 영입하기

활성 공식 팀원은 최대 **15명**이다. 비공식/테스트 agent(`team_official_member:false`)와 정지(off) 팀원은 상한 계산에서 제외된다. 상한 도달 시 기존 팀원을 정지하거나 퇴사 처리한 뒤 영입한다.

새 팀원 = 등록(recruit) + OT(provision→preflight→activate→pairing). 팀명·팀장ID가 이미 세팅돼 있으니(당신이
합류했다는 건 setup_complete) 바로 recruit부터 된다.

```bash
# ① 영입 등록 → ot_id 받기 (runtime = 기본 claude_channel, 고급 BYO: openclaw / hermes_agent)
curl -s -X POST http://localhost:7878/team/api/members/recruit \
  -H 'content-type: application/json' \
  -d '{"id":"alex","display_name":"Alex","role":"풀스택","runtime":"claude_channel"}'
#   → {ok, ot_id, member, persona_file}. 이 ot_id 를 이후 단계에 쓴다. 중복 id=409, 잘못된 runtime=400.

# ── 사람: BotFather(@BotFather → /newbot)로 봇 만들고 토큰 받기 → 팀장이 입력 ──

# ② 토큰 저장(provision) — 토큰은 파일에서 읽어 넘긴다(리터럴 금지). 직후 런타임 로그인 preflight 자동 실행.
curl -s -X POST http://localhost:7878/team/api/ot/<ot_id>/provision \
  -H 'content-type: application/json' -d "{\"bot_token\":\"$(cat <토큰파일>)\"}"
#   형식 <숫자6+>:<30자+> 안 맞으면 bot_token_invalid 400. preflight blocked면 fixHint대로 로그인 후 재확인.

# ③ 활성화(activate) — 런타임 실제 기동. APPROVAL_EXECUTION_ENABLED=1 필요.
curl -s -X POST http://localhost:7878/team/api/ot/<ot_id>/activate
#   미로그인=runtime_auth_required 400+fixHint. claude=poller 헬스게이트(bot.pid) 통과해야 '진짜 대화됨'.
```

- **claude_channel 런타임**: telegram 플러그인 enable + 첫부팅 poller 복구는 **활성화 런처가 자동 처리**한다
  (`~/.claude/settings.json` 의 `enabledPlugins` 에 직접·원자적 기록 + poller 미기동 시 `/mcp reconnect` 자동 주입, 5db5510).
  **수동 설치 단계 없음.** ⛔ `claude plugin install`/`/plugin install` 은 돌리지 말 것 — 공유 플러그인 캐시를 inode 째 스왑해
  실행 중인 다른 팀원 봇 세션을 파괴한다(하네스 CONFIRMED 2026-07-25).
- **페어링(사람)**: claude_channel = 봇에 첫 DM → 6자리 페어링 코드 승인. openclaw = 봇에 DM 후
  `POST /team/api/ot/<ot_id>/pair-approve`. hermes(v0.18) = DM 페어링 게이트 있음 — activate가 팀장 chat_id(`owner_chat_id`)를 게이트웨이 allowlist(`TELEGRAM_ALLOWED_USERS`)에 시드해 팀장은 코드 없이 통과(팀장 외=`hermes pairing approve`).
- 상세는 온보딩 스킬의 `recruit.md`와 동일 — 그 문서가 있으면 참조.
- **preflight 재확인**: 로그인 직후 `POST /team/api/ot/<ot_id>/preflight-recheck` 로 blocked 회복.
- **UI로도 가능**: `http://localhost:7878/team` ▸ **Settings** 영입 마법사(스테퍼)가 같은 단계를 화면에서 안내.

## 2. 팀원 런타임 교체(runtime swap) — 퇴사 없이 런타임만 바꾸기

**이미 있는 팀원**을 다른 런타임으로 옮긴다. 워크스페이스(`MEMORY.md`·`memory/*.md`·`TODO.md`·git)는
**id로 키잉**돼 있어 그대로 유지된다 — §3(퇴사)의 `archiveWorkspace`(워크스페이스를 `.archived/<id>-<ts>`로
이동)는 **여기서 호출되지 않는다.** "런타임만 바꾸고 싶다"는 요청에 퇴사(DELETE)+재영입(recruit) 경로를
쓰지 말 것 — 그 경로는 메모리를 archive로 옮겨버려 되돌리려면 수동 복구가 필요하다.

### 절차

```bash
# ① preflight — 대상 런타임의 CLI·인증 확인 (present→진행 / missing→아래 안내). 서버가 swap-runtime 안에서도
#    동일 checkRuntimeAuth를 최전방에서 실행하므로 사전 확인은 UX용(사람에게 먼저 알려주기 위함).
#    바이너리: which/고정경로 확인. 인증: 파일 "존재"만 확인([ -s ] 또는 ls) — 값은 절대 cat/echo 하지 않는다.

# ② 실제 교체 — confirm_name은 display_name과 정확히 일치해야 한다(퇴사와 동일한 오발 방지 안전장치).
curl -s -X POST http://localhost:7878/team/api/members/<id>/swap-runtime \
  -H 'content-type: application/json' \
  -d '{"target_runtime":"hermes_agent","confirm_name":"Alex"}'
#   bot_token 생략 시 var/secrets/<id>.bot-token(퇴사해도 안 지워지는 토큰 파일)을 서버가 재사용한다.
#   응답 = {ok, steps:[{step,ok,detail}, ...], error?, code?}. steps를 순서대로 사람에게 보여주면 진행상황이 된다.
```

### 서버가 내부에서 하는 일(각 단계 실패 지점과 의미)

1. **검증(read-only)** — 대상 존재·no-op(같은 런타임)·공개 런타임(`claude_channel`/`openclaw`/
   `hermes_agent`) 우선. 오타·미지원 문자열은 여기서 즉시 400 `invalid_runtime`)·base hermes 프로필
   (`HERMES_BASE_PROFILE`, 기본 `b3os`) 가드·`APPROVAL_EXECUTION_ENABLED`(활성화 스위치) 확인. **여기서 막히면 아무것도 안 바뀐다**
   (가장 안전한 실패).
2. **preflight** — `checkRuntimeAuth(target_runtime)`. 미설치/미인증이면 여기서 중단 — 구 런타임은 아직
   살아 있어 다운타임 0. `error/code="preflight_blocked"`, `detail`에 조치법(fixHint)이 그대로 온다.
3. **스냅샷** — 옛 persona 파일·`AGENTS.md`(있으면)를 워크스페이스의 `.swap-bak/<타임스탬프>/`에 백업(롤백
   자산). `MEMORY.md`·`memory/*.md`·`TODO.md`·`README.md`·`reports/`·`.git`은 이 단계에서 건드리지 않는다.
4. **teardown** — 구 런타임 봇 정지 + 브리지 파일(plist/토큰/credentials) 정리. 레지스트리(agents.json)는
   아직 안 건드림.
5. **registry** — `agents.json`의 `runtime`+`status_provider`를 **한 번에** 갱신(따로 쓰면 DB CHECK 위반으로
   reload 크래시 — 그래서 서버가 항상 원자적으로 같이 씀). `claude_channel`이면 `tmux_session`, `hermes_agent`면
   `hermes_profile` 부가필드도 동시 갱신. **이 단계가 커밋 지점** — 여기까지 오면 구 런타임은 이미 죽어있다.
6. **persona-transition** — persona 파일명 전환(`CLAUDE.md`↔`IDENTITY.md`, 옛 파일은 orphan이라 삭제 후
   재생성), `claude_channel`↔비-claude 전환 시 `TEAM-OS.md` 심링크/`AGENTS.md` 생성·제거.
7. **activate** — 신 런타임으로 `activate` 재실행(preflight 재확인→봇 기동→poller 헬스게이트). 여기서
   실패하면 **자동 롤백**을 시도한다(아래 참조).

### 실패 시 동작 — 자동 롤백 vs 변경 없음

- **STEP5(registry) 이전 실패** = 레지스트리 안 건드림 → **아무 변경 없음**, 구 런타임 그대로 동작 중.
- **STEP5(registry) 이후 STEP7(activate) 실패** = 위험 구간(teardown으로 구 런타임이 이미 죽었을 수 있음).
  서버가 **자동으로**: registry를 old runtime으로 되돌리고, `.swap-bak/`의 옛 persona를 복원한 뒤, old
  runtime으로 `activate`를 재시도(best-effort self-heal)한다. self-heal 성패와 무관하게 `ok:false` +
  `steps`에 각 단계 결과가 남으므로, **응답의 steps를 그대로 사람에게 보여주면 어디서 막혔는지 안다.**
  self-heal도 실패하면 팀원이 양쪽 다 죽은 상태 — GD에게 명확히 알리고 수동 개입을 요청한다.

### 알아둘 것

- **활성 세션 중 교체 주의** — 대상 팀원이 지금 작업 중(열린 세션·진행 중 wake)이면 teardown이 그 작업을
  끊는다. 교체 전 "지금 진행 중인 작업이 있으면 끊깁니다" 안내를 권장.
- **auto-memory 소실(claude→비claude만 해당)** — `~/.claude/projects/.../memory/`(Claude 전용 자동 기억)는
  워크스페이스 밖에 있고 Claude 런타임에서만 주입된다. `claude_channel`에서 다른 런타임으로 바꾸면 파일은
  디스크에 남지만 다음 세션에 주입되지 않는다 — 교체 전 경고. 역방향(→`claude_channel`)으로 복귀하면 같은
  워크스페이스 경로 기준으로 다시 주입될 수 있다.
- **base hermes 프로필(`HERMES_BASE_PROFILE`, 기본 `b3os`)은 교체 대상 아님** — 모든 hermes 멤버의 공유 auth 소스라 어느 방향이든
  거부된다(`code:"base_hermes_guard"`).
- **`APPROVAL_EXECUTION_ENABLED`가 꺼져 있으면 아예 시작 안 함** — `code:"execution_off"`. 팀장 인가(터미널
  y/n 또는 `/approve`) 후에만 켜져 있다.
- **UI**: 대시보드는 preflight 게이트를 항상 켜두지만 **대신 설치는 하지 않는다** — 미설치면 조치 안내
  텍스트 + recheck 버튼만 준다. 실제 설치·로그인 가이드는 이 스킬(Claude Code)이 대화형으로 더 강하게
  도와줄 수 있다(§SKILL.md [9] 참조).

## 3. 팀원 내보내기(퇴사/오프보드)

```bash
# confirm_name 은 display_name 과 정확히 일치해야 진행(오발 방지). runtime cleanup(봇 정지·토큰·plist·workspace archive) 자동.
curl -s -X DELETE http://localhost:7878/team/api/members/<id> \
  -H 'content-type: application/json' -d '{"confirm_name":"Alex"}'
```
- 마지막 1명은 못 지운다(`cannot_remove_last_member`). 설정된 base hermes 프로필은 퇴사 대상 아님(auth 소스).
- 퇴사 = 봇·tmux/게이트웨이·슬랙 완전 disconnect + workspace는 삭제가 아니라 `.archived/<id>-<ts>`로 보관.
- **UI**: Settings ▸ 팀원 목록에서 퇴사(이름 정확 입력 확인).

## 4. 라우터 토글 (봇 무응답 1순위)

라우터 OFF면 라우팅 결정만 로그에 남고 **팀원이 응답 안 함.**
```bash
curl -s http://localhost:7878/team/api/system-op                                   # 현재 상태(router_enabled)
curl -s -X PATCH http://localhost:7878/team/api/system-op \
  -H 'content-type: application/json' -d '{"router_enabled":true}'                  # 즉시 ON (재시작 불필요)
```
UI: Settings ▸ 시스템 OP 라우터 토글. 영구 고정은 `.env` `ROUTER_ENABLED=true` + 재시작.

## 5. 트러블슈팅 (봇 무응답 = 라우터/플러그인/poller 순서)

1. **라우터 ON?** — `GET /system-op` 에서 `router_enabled:true` 인지(§4).
2. **telegram 플러그인?** (claude 런타임) — user scope 설치 확인. 없으면 §1의 플러그인 설치.
3. **poller 살아있나?** — `ls ~/.claude/channels/telegram-<id>/bot.pid` 있으면 폴링 중(= 진짜 대화됨).
   없으면 대시보드에서 그 팀원 **재활성화**(activate 다시) → poller 재기동.
4. **활성화 실패** — preflight 에러 메시지 그대로 읽고 조치: CLI 미설치→설치 / 미로그인→선택한 런타임 CLI 로그인 /
   `subscription_needed`→구독·결제 확인 후 재활성화.
5. **`command not found: bun`** — `export PATH="$HOME/.bun/bin:$PATH"` 또는 새 터미널.
6. **대시보드 무응답(`/health` X)** — 서버 안 떠 있거나 포트 충돌. `bun run start` 로그 확인(포트=`TEAM_HTTP_PORT`, 기본 7878).

더 깊은 항목은 온보딩 스킬의 `troubleshooting.md` 또는 clone한 저장소 README 하단.

## 6. 팀 세팅 바꾸기

- **팀명·팀장ID·owner_name**: `PUT /team/api/settings` (팀명 ≤20자, lead_id 영문 slug).
- **미션**: 기본은 TEAM-OS.md §1 의 기본 미션(셋업에서 안 물어봄, 대시보드 편집칸 없음). 프로그래밍적으로 바꾸려면 `PUT /team/api/mission` `{"mission":"..."}`(TEAM-OS §1 갱신, non-empty 필수) — 이 API는 유지되나 UI 노출은 없다.
- **팀원 아이콘/색**: `PATCH /team/api/members/<id>` `{icon, icon_color}` 또는 각자 Settings에서.

## 7. 삭제(uninstall)

```bash
cd "$HOME/b3rys-team-os" && bash uninstall.sh     # 팀원 전원 오프보드 → 서버 정지 → 데이터 삭제
#   --yes(확인 생략) · --keep-data(오프보드+정지만, team.db/.env 보존)
```
스크립트가 안내하는 `rm -rf` 로 repo 폴더까지 지우면 끝. 설정된 base hermes 프로필은 보존된다.

## 8. 어디까지가 사람(팀장) 몫인가

| 사람만 | 당신(팀원)이 |
|---|---|
| BotFather 봇 생성·토큰 발급 | recruit/provision/activate API 호출 |
| 활성화 승인(대시보드 버튼) | 활성화 상태·에러 읽고 안내 |
| 페어링 코드 승인(봇에 DM) | 페어링 단계 코치·pair-approve 호출(openclaw) |
| 구독·결제 | 구독 필요 여부 진단·안내 |
| 런타임 교체 승인(self-mod 확인) | preflight 확인·swap 호출·steps 결과 안내 |

당신은 절대 페어링/승인을 대신 만들거나 우회하지 않는다. 토큰 값을 화면에 다시 출력하지 않는다.

## 9. 일상 운영 — 서버·팀원 관리

운영 진입점은 **둘**이다. 서버(b3os 자체)는 **package.json 스크립트**로, 팀원(봇)은 **대시보드 또는 API**로 다룬다.

> ⚠️ `team-os` 라는 셸 CLI 는 **퍼블릭 b3os 에 없다.** 예전 문서가 그렇게 안내했지만 그 스크립트는 배포에 포함되지 않는다 — 아래 명령을 쓴다.

**서버 (설치 폴더에서 실행 — `cd "$HOME/b3rys-team-os"`)**

| 명령 | 하는 일 |
|---|---|
| `bun run start` | 서버 기동 (이것만으로 b3os 는 완전히 동작한다) |
| `bun run service status` | 상시가동(LaunchAgent) 등록·실행 상태 |
| `bun run service install` | 재부팅해도 계속 돌게 등록 (+ 즉시 기동) · **선택 기능** |
| `bun run service restart` | 서버 재시작 (등록돼 있을 때) |
| `bun run service uninstall` | 등록 해제 (되돌리기) |

**팀원 (봇)** — 대시보드 **팀원 설정** 패널의 버튼이 정본이다. 같은 동작의 API:

| 동작 | API |
|---|---|
| 재시작 | `POST /team/api/members/<id>/restart` · 본문 `{"fresh":true}` 면 새 세션(대화 맥락 비움) |
| 전원 재시작 | `POST /team/api/members/restart-all` |
| 정지/기동 (서킷브레이커) | `POST /team/api/members/<id>/enabled` · 본문 `{"enabled":false\|true}` |

> **재시작**과 **기동**은 서로 다른 경로를 탄다. 재시작은 repo 안의 기동 스크립트를 **직접** 실행하고, 기동(`enabled:true`)은 그 팀원의 **LaunchAgent 등록 파일**을 통해 띄운다. 그래서 등록 파일이 옛 경로를 가리키면(§10) 재시작은 최신 스크립트로 뜨는데 기동·로그인 자동기동은 옛 스크립트로 뜬다.

**상태 확인**

| 보고 싶은 것 | 방법 |
|---|---|
| 서버 생존 | `curl -s localhost:7878/health` |
| 팀원 목록·상태 | 대시보드, 또는 `GET /team/api/agents` |
| 서비스·예약잡 종합 | `GET /team/api/teamos` |
| 설정·규칙·인프라 종합 점검 (구 `doctor`) | 대시보드 **인수테스트**, 또는 `GET /team/api/acceptance-check` |
| 로그 | 서버 = LaunchAgent 의 `StandardOutPath` · 팀원 = `tmux attach -t claude-<id>` (분리는 `Ctrl-b d`) |

> 포트는 기본 `7878`. 대시보드 경로는 `/team` 아래다 (`/api/...` 가 아니라 **`/team/api/...`**).
> 에이전트 폭주 등 **긴급 정지**가 필요하면 SKILL.md의 "🛑 긴급 ALL-STOP" 절 참조.

## 10. 기동 실패·리부팅 후 복구

**"b3os가 안 떠요 / 봇이 응답 안 해요"** — 순서대로:
1. `curl -s localhost:7878/health` — 서버가 살아 있나 본다. 죽었으면 `bun run start` (또는 등록했다면 `bun run service restart`).
2. 서버는 사는데 팀원이 무응답이면 대시보드에서 그 팀원 **재시작**, 또는 `POST /team/api/members/<id>/restart`.
3. 그래도면 **인수테스트**(`GET /team/api/acceptance-check`)로 설정·인프라를 훑는다 — 필수 서비스·plist·런처 경로 어긋남을 잡아준다.
4. 봇만 무응답이면 §4(라우터 토글)·§5(트러블슈팅)를 먼저 본다.

**런처 경로 어긋남** — 인수테스트의 **런처 정본 일치** 항목이 fail 이면, 그 팀원의 LaunchAgent 등록 파일이 옛 런처 스크립트를 가리키고 있다는 뜻이다(예: 예전에 다른 도구로 등록한 봇, 또는 설치 경로를 옮긴 경우).

증상이 헷갈린다 — **재시작 버튼은 멀쩡히 최신 스크립트로 뜨는데**, 로그인 후 자동기동이나 정지→기동은 옛 스크립트로 뜬다. 두 경로가 다르기 때문이다(§9).

⚠️ **정지 → 기동으로는 안 고쳐진다.** 기동은 등록 파일을 *읽을* 뿐 다시 쓰지 않는다. 등록 파일은 팀원을 **활성화(activate)** 할 때 생성된다 — 대시보드 온보딩에서 그 팀원을 다시 활성화하면 정본 경로로 새로 쓰인다.

**"리부팅 후 안 올라와요"** — macOS는 서비스(LaunchAgent)를 **로그인할 때** 올린다:
- 리부팅 후 **로그인을 한 번** 하면 대부분 자동 기동된다. 안 뜬 게 있으면 `bun run service status` 로 확인하고 필요하면 `bun run service restart`.
- 서버를 아직 등록 안 했다면 `bun run service install` 로 등록할 수 있다(선택). **설치할지 사용자에게 물어보고** 진행한다.
- ⚠️ **자동 로그인(auto-login)을 켜라고 권하지 않는다.** 상시 켜진 서버에 자동 로그인은 보안을 약화시킨다 — 리부팅은 드무니 "로그인 한 번 + 자동 복구"가 안전하고 충분하다.

## 11. b3os 업데이트 (버전 올리기)

새 버전(코드·스키마 변경)을 반영할 때:

```bash
cd "$HOME/b3rys-team-os"
cp team.db "team.db.bak-$(date +%Y%m%d-%H%M%S)"   # ★백업 먼저★ — 마이그레이션 실패 시 롤백 자산
git pull                    # 새 코드
bun install                 # 새 의존성
bun run build               # 대시보드(프론트) 재빌드
bun run service restart     # 서버 재시작 — 스키마 마이그레이션은 시작 시 자동 적용
                            #   (상시가동 미등록이면: 기존 프로세스 종료 후 `bun run start`)
curl -s localhost:7878/health   # 서버 생존 확인
```

서버 코드(`src/`)를 바꿨으면 **서버 재시작**이 필요하고, 대시보드(`src/web/`)를 바꿨으면 **`bun run build`** 가 필요하다.
팀원 기동 스크립트만 바뀐 경우엔 그 **팀원을 재시작**해야 새 스크립트가 적용된다(서버 재시작만으로는 이미 떠 있는 팀원이 안 바뀐다).

- **업데이트 전에 반드시 `team.db`를 백업**한다(위 첫 줄). 스키마 마이그레이션은 서버 시작 시 자동 적용되는데, 실패·중단 시 백업이 유일한 롤백 자산이다.
- 스키마 변경은 서버 시작 시 `migrate`가 자동 적용하므로 별도 마이그레이션 명령은 없다.
- 업데이트 후 반드시 대시보드(또는 `GET /team/api/agents`)로 전원 생존을 확인한다.
- **이 설치·운영 스킬 자체도 매 b3os 버전에서 실제 절차와 어긋나지 않는지 함께 점검**한다(스킬↔버전 싱크).
