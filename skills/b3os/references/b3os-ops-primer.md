# b3os 운영 프라이머 — 첫 팀원용

이 문서의 대상은 방금 합류한 첫 팀원이다. 온보딩 스킬은 팀원을 세우고 손을 뗐다(handoff). 팀장이 "다음 팀원 어떻게 영입해?", "이 팀원 내보내줘", "봇이 응답 안 해" 라고 물으면 팀원이 답한다. 조작은 로컬 대시보드(`http://localhost:7878/team`)와 REST API(`/team/api/...`)로 하며, 서버가 떠 있는 그 머신에서만 동작한다(앱 인증 없음). 포트는 `.env` 의 `TEAM_HTTP_PORT`(기본 7878)이고 바꿨다면 아래 URL 의 7878 을 그 값으로 읽는다.

BotFather 봇 토큰, 활성화 승인, 페어링 코드 승인은 사람(팀장) 몫이다. 팀원은 코치와 자동화만 하고, 토큰 값을 화면에 다시 출력하지 않으며, 본인 전용 장비 전제를 지킨다.

## 1. 팀원 더 영입하기

활성 공식 팀원은 최대 15명이다(`team_official_member:false` 비공식/테스트 agent와 정지(off) 팀원은 제외). 도달하면 기존 팀원을 정지하거나 퇴사 처리한 뒤 영입한다. 팀명·팀장ID는 이미 세팅돼 있으니 바로 recruit 부터 된다.

```bash
# ① 등록 → ot_id (runtime 기본 claude_channel, 고급 BYO: openclaw / hermes_agent, 베타: codex)
curl -s -X POST http://localhost:7878/team/api/members/recruit \
  -H 'content-type: application/json' \
  -d '{"id":"alex","display_name":"Alex","role":"풀스택","runtime":"claude_channel"}'
# ── 사람: @BotFather → /newbot 으로 봇 만들고 토큰 받기 ──
# ② provision — 토큰은 파일에서 읽어 넘긴다(리터럴 금지). 직후 런타임 로그인 preflight 실행.
curl -s -X POST http://localhost:7878/team/api/ot/<ot_id>/provision \
  -H 'content-type: application/json' -d "{\"bot_token\":\"$(cat <토큰파일>)\"}"
# ③ activate — APPROVAL_EXECUTION_ENABLED=1 필요
curl -s -X POST http://localhost:7878/team/api/ot/<ot_id>/activate
```

- 에러: 중복 id 409 · 잘못된 runtime 400(`invalid_runtime`) · 토큰 형식 오류 `bot_token_invalid` 400 · 미로그인 `runtime_auth_required` 400+fixHint. 로그인 직후 `POST /team/api/ot/<ot_id>/preflight-recheck` 로 blocked 를 푼다.
- claude_channel: telegram 플러그인 enable 과 첫부팅 poller 복구는 활성화 런처가 자동 처리한다. `claude plugin install` / `/plugin install` 은 돌리지 않는다(공유 플러그인 캐시를 inode 째 스왑해 실행 중인 다른 팀원 봇 세션을 깨뜨린다).
- 페어링은 사람이 한다: claude_channel = 봇에 첫 DM → 6자리 코드 승인, openclaw = DM 후 `POST /team/api/ot/<ot_id>/pair-approve`, hermes(v0.18) = activate 가 팀장 `owner_chat_id` 를 게이트웨이 allowlist 에 시드해 팀장은 코드 없이 통과(팀장 외 `hermes pairing approve`). 상세 = `recruit.md`.
- UI 로도 가능: Settings 영입 마법사.

## 2. 팀원 런타임 교체 (swap-runtime) — 퇴사 없이

이미 있는 팀원을 다른 런타임으로 옮긴다. 워크스페이스(`MEMORY.md`·`memory/*.md`·`TODO.md`·git)는 id 로 키잉돼 그대로 유지된다. 퇴사(DELETE)+재영입은 메모리를 `.archived/<id>-<ts>` 로 옮겨 수동 복구가 필요하니 쓰지 않는다.

```bash
# ① preflight — 대상 런타임의 CLI·인증 확인(UX용; 서버도 swap 안에서 같은 checkRuntimeAuth 를 먼저 돈다).
#    인증은 파일 "존재"만 확인([ -s ] 또는 ls) — 값은 cat/echo 하지 않는다.
# ② 교체 — confirm_name 은 display_name 과 정확히 일치해야 한다(오발 방지).
curl -s -X POST http://localhost:7878/team/api/members/<id>/swap-runtime \
  -H 'content-type: application/json' \
  -d '{"target_runtime":"hermes_agent","confirm_name":"Alex"}'
#   bot_token 생략 시 var/secrets/<id>.bot-token 을 재사용한다.
#   응답 = {ok, steps:[{step,ok,detail}, ...], error?, code?} — steps 를 순서대로 사람에게 보여준다.
```

서버 단계: 검증(read-only; 대상 존재·no-op·공개 런타임·base hermes 가드·`APPROVAL_EXECUTION_ENABLED`) → preflight → 스냅샷(옛 persona·`AGENTS.md` 를 `.swap-bak/<타임스탬프>/` 에 백업) → teardown(구 런타임 정지) → registry(`agents.json` 의 `runtime`+`status_provider` 원자 갱신; 커밋 지점) → persona-transition → activate.

- registry 이전 실패(`preflight_blocked` 등)는 아무 변경 없이 구 런타임이 그대로 돈다. `detail` 에 fixHint 가 온다.
- registry 이후 activate 실패는 서버가 registry·persona 를 되돌리고 old runtime 으로 activate 를 재시도(best-effort)한다. 성패와 무관하게 `ok:false` + `steps` 가 남는다. self-heal 도 실패하면 양쪽 다 죽은 상태이니 팀장에게 알리고 수동 개입을 요청한다.
- 대상 팀원이 작업 중이면 teardown 이 끊는다. 교체 전 안내한다.
- claude → 비claude 교체는 `~/.claude/projects/.../memory/`(Claude 전용 auto-memory)가 다음 세션에 주입되지 않는다. 교체 전 경고한다.
- base hermes 프로필(`HERMES_BASE_PROFILE`, 기본 `b3os`)은 공유 auth 소스라 교체 불가(`code:"base_hermes_guard"`). `APPROVAL_EXECUTION_ENABLED` 가 꺼져 있으면 시작하지 않는다(`code:"execution_off"`).
- UI 는 설치를 대신하지 않고 안내 텍스트와 recheck 버튼만 준다. 실제 설치·로그인은 Claude Code 가 대화형으로 돕는다.

## 3. 팀원 내보내기 (퇴사/오프보드)

```bash
curl -s -X DELETE http://localhost:7878/team/api/members/<id> \
  -H 'content-type: application/json' -d '{"confirm_name":"Alex"}'   # display_name 과 정확히 일치해야 진행
```

- 봇 정지·토큰·plist 정리가 자동이고, workspace 는 삭제가 아니라 `.archived/<id>-<ts>` 로 보관된다.
- 마지막 1명은 못 지운다(`cannot_remove_last_member`). base hermes 프로필은 퇴사 대상이 아니다.
- UI: Settings 팀원 목록에서 퇴사(이름 정확 입력).

## 4. 라우터 토글 (그룹 무응답 1순위)

라우터 OFF 면 라우팅 결정만 로그에 남고 그룹에서 팀원이 응답하지 않는다(1:1 DM 은 무관).

```bash
curl -s http://localhost:7878/team/api/system-op                                   # router_enabled 확인
curl -s -X PATCH http://localhost:7878/team/api/system-op \
  -H 'content-type: application/json' -d '{"router_enabled":true}'                  # 즉시 ON, 재시작 불필요
```

UI: Settings 시스템 OP 라우터 토글. 영구 고정은 `.env` `ROUTER_ENABLED=true` + 재시작. 그 밖의 무응답 진단 순서 = `troubleshooting.md`.

## 5. 팀 세팅 바꾸기

- 팀명·팀장ID·owner_name: `PUT /team/api/settings` (팀명 ≤20자, lead_id 영문 slug).
- 미션: 기본은 TEAM-OS.md §1 이고 셋업에서 묻지 않는다. 바꾸려면 `PUT /team/api/mission` `{"mission":"..."}` (non-empty 필수, UI 노출 없음).
- 팀원 아이콘/색: `PATCH /team/api/members/<id>` `{icon, icon_color}` 또는 각자 Settings.
- 삭제(uninstall): `bash uninstall.sh` — SKILL.md 의 삭제 절.

## 6. 어디까지가 사람(팀장) 몫인가

| 사람만 | 팀원이 |
|---|---|
| BotFather 봇 생성·토큰 발급 | recruit/provision/activate API 호출 |
| 활성화 승인(대시보드 버튼) | 상태·에러 읽고 안내 |
| 페어링 코드 승인(봇에 DM) | 페어링 코치 · pair-approve 호출(openclaw) |
| 구독·결제 | 구독 필요 여부 진단·안내 |
| 런타임 교체 승인(self-mod 확인) | preflight 확인 · swap 호출 · steps 안내 |

팀원은 페어링/승인을 대신 만들거나 우회하지 않는다.

## 7. 일상 운영 — 서버·팀원 관리

서버는 package.json 스크립트로, 팀원(봇)은 대시보드 또는 API 로 다룬다. 퍼블릭 b3os 에는 `team-os` 셸 CLI 가 없다.

서버 (설치 폴더 `cd "$HOME/b3rys-team-os"` 에서):

| 명령 | 하는 일 |
|---|---|
| `bun run start` | 서버 기동 (이것만으로 b3os 는 완전히 동작) |
| `bun run service status` | 상시가동(LaunchAgent) 등록·실행 상태 |
| `bun run service install` | 재부팅해도 돌게 등록 (+ 즉시 기동) · 선택 기능 |
| `bun run service restart` | 서버 재시작 (등록돼 있을 때) |
| `bun run service uninstall` | 등록 해제 |

팀원 (대시보드 팀원 설정 패널 버튼이 정본, 같은 동작의 API):

| 동작 | API |
|---|---|
| 재시작 | `POST /team/api/members/<id>/restart` · 본문 `{"fresh":true}` 면 새 세션(맥락 비움) |
| 전원 재시작 | `POST /team/api/members/restart-all` |
| 정지/기동 (서킷브레이커) | `POST /team/api/members/<id>/enabled` · 본문 `{"enabled":false\|true}` |

재시작은 repo 안의 기동 스크립트를 직접 실행하고, 기동(`enabled:true`)은 그 팀원의 LaunchAgent 등록 파일로 띄운다. 그래서 등록 파일이 옛 경로를 가리키면 재시작은 최신 스크립트로 뜨는데 기동·로그인 자동기동은 옛 스크립트로 뜬다(§8).

상태 확인:

| 보고 싶은 것 | 방법 |
|---|---|
| 서버 생존 | `curl -s localhost:7878/health` |
| 팀원 목록·상태 | 대시보드, 또는 `GET /team/api/agents` |
| 서비스·예약잡 종합 | `GET /team/api/teamos` |
| 설정·규칙·인프라 점검 | 대시보드 인수테스트, 또는 `GET /team/api/acceptance-check` |
| 로그 | 서버 = LaunchAgent 의 `StandardOutPath` · 팀원 = `tmux attach -t claude-<id>` (분리 `Ctrl-b d`) |

경로는 `/api/...` 가 아니라 `/team/api/...` 이다.

## 8. 기동 실패·리부팅 후 복구

"b3os가 안 떠요 / 봇이 응답 안 해요" 순서:
1. `curl -s localhost:7878/health` — 죽었으면 `bun run start` (등록했다면 `bun run service restart`).
2. 서버는 사는데 팀원이 무응답이면 그 팀원 재시작(대시보드 또는 `POST /team/api/members/<id>/restart`).
3. 그래도면 인수테스트 `GET /team/api/acceptance-check` 로 필수 서비스·plist·런처 경로 어긋남을 잡는다.
4. 봇만 무응답이면 §4 와 `troubleshooting.md`.

런처 경로 어긋남: 인수테스트의 "런처 정본 일치"가 fail 이면 그 팀원의 LaunchAgent 등록 파일이 옛 런처 스크립트를 가리킨다(다른 도구로 등록했거나 설치 경로를 옮긴 경우). 정지→기동은 등록 파일을 읽을 뿐 다시 쓰지 않아 고쳐지지 않는다. 대시보드 온보딩에서 그 팀원을 다시 활성화(activate)하면 정본 경로로 새로 쓰인다.

리부팅 후 안 올라올 때: macOS 는 LaunchAgent 를 로그인 시점에 올린다. 로그인을 한 번 하면 대부분 자동 기동되고, 안 뜬 게 있으면 `bun run service status` 후 `bun run service restart`. 서버를 아직 등록하지 않았다면 `bun run service install` 을 사용자에게 물어보고 진행한다. 자동 로그인(auto-login)은 보안을 약화시키니 권하지 않는다.

## 9. b3os 업데이트

```bash
cd "$HOME/b3rys-team-os"
cp team.db "team.db.bak-$(date +%Y%m%d-%H%M%S)"   # 백업 먼저 — 마이그레이션 실패 시 유일한 롤백 자산
git pull
bun install
bun run build               # 대시보드(프론트) 재빌드
bun run service restart     # 스키마 마이그레이션은 시작 시 자동 적용 (미등록이면 기존 프로세스 종료 후 `bun run start`)
curl -s localhost:7878/health
```

서버 코드(`src/`)를 바꿨으면 서버 재시작, 대시보드(`src/web/`)를 바꿨으면 `bun run build` 가 필요하다. 팀원 기동 스크립트만 바뀐 경우엔 그 팀원을 재시작해야 적용된다. 업데이트 후 대시보드 또는 `GET /team/api/agents` 로 전원 생존을 확인하고, 이 스킬이 새 버전의 실제 절차와 어긋나지 않는지도 함께 점검한다.

## 10. 긴급 ALL-STOP (에이전트 폭주·이상)

서버가 살아 있으면 Claude Code + 대시보드/API 로 되살릴 수 있다.

```bash
# ① 유입 차단 (가장 빠름, 재시작 불필요) — 팀원이 새 메시지를 받지 못한다
curl -s -X PATCH http://localhost:7878/team/api/system-op \
  -H 'content-type: application/json' -d '{"router_enabled":false}'
# ② 전원 정지 (UI: 빨강 All-Stop 버튼, 더블 컨펌)
curl -s -X POST http://localhost:7878/team/api/members/stop-all
```

- stop-all 은 각 팀원의 세션/poller 를 내린다. coordinator 팀원은 복구 창구로 남기려고 자동 제외되고(끄려면 개별 정지), 서버(대시보드·API)는 유지된다.
- ③ 개별 정지: Settings 정지(서킷브레이커) 또는 `POST /team/api/members/<id>/enabled` `{"enabled":false}`.
- 정지·재시작 API 는 `APPROVAL_EXECUTION_ENABLED=1` 이 켜져 있어야 동작한다(꺼져 있으면 "팀장 인가 필요").
- 복구: 라우터는 위 PATCH 를 `{"router_enabled":true}` 로, 팀원은 개별 기동 또는 `POST /team/api/members/restart-all`. 원인이 특정 팀원이면 그 팀원만 정지 유지하고 나머지를 기동한다. 상태는 §7 과 인수테스트로 확인한다.

## 11. (선택) 상시가동 등록

아무것도 안 해도 된다. `bun run start` 로 띄워 쓰는 것이 기본이고 등록 없이 모든 기능이 동작한다. 설치·영입 단계에서 묻거나 강요하지 않고, 사용자가 원할 때만 안내한다(macOS 전용).

```bash
cd "$B3OS"
bun run service install     # 등록 + 즉시 기동
bun run service status
bun run service uninstall   # 되돌리기
```

얻는 것: 재부팅 자동복구, 터미널/앱을 닫아도 서버 생존, 맥앱 [서버 재시작] 버튼 활성화. macOS 는 부팅이 아니라 로그인 시점에 올리므로 재부팅 후 로그인을 한 번 해야 뜬다. 서버 라벨은 `com.$USER.team-collab`(`TEAMOS_LAUNCHD_PREFIX` 로 변경 가능)이다.

맥앱이 "b3os 스킬로 복구하세요"라고 안내하면(서버가 죽으면 앱이 대시보드를 띄울 수 없다) `bun run service status` 로 확인한다. 등록 안 됨(기본)이면 `bun run start`, 등록됨이면 `bun run service restart`.
