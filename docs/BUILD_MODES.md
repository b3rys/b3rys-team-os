# Build Modes — 공개(public) vs 라이브(live)

b3os는 **하나의 소스 트리**로 두 가지 실행 모드를 지원한다. 모드는 ★런타임 환경변수★로 정해진다 —
빌드 시점에 소스를 바꾸지 않는다(public=source: 공개 repo가 곧 정본).

## 스위치: `B3OS_LIVE`

| 값 | 모드 | 설명 |
|---|---|---|
| (미설정) | **공개(public)** — 기본 | fail-safe. 라이브 전용 기능이 꺼진다. 새 클론/외부 사용자의 안전 기본값. |
| `B3OS_LIVE=1` | **라이브(live)** | 풀 기능. 팀을 실제 운영하는 정본 인스턴스에서만 켠다(`.env`에 설정). |

- 서버: `PUBLIC_BUILD = (process.env.B3OS_LIVE !== "1")` (`src/server/routes/settings.ts`)
- 클라이언트: 서버가 대시보드 HTML에 `window.__B3OS_LIVE__`를 주입 → `LIVE_ONLY_OPS`가 읽음 (`src/web/components/Settings.ts`, 주입=`src/server/index.ts`)

## 모드별 차이 (토글 목록)

| 기능 | 공개(기본) | 라이브(`B3OS_LIVE=1`) | 게이트 |
|---|---|---|---|
| **런타임 선택지** | Claude·OpenClaw·Hermes 3종 | + codex·b3os_native(내부 검증용) | `PUBLIC_BUILD` → `allowedRuntimes`/`VISIBLE_CAPABILITIES` (server) |
| **전체 핵심룰 재적용/롤백 버튼** | 숨김 | 표시 | `LIVE_ONLY_OPS` (client UI) + 엔드포인트 `PUBLIC_BUILD` 가드 (server, 이중) |
| **런타임 swap UI** | 숨김 | 표시 | `LIVE_ONLY_OPS` (client) + `publicRuntimeGate` (server) |
| **배포(/deploy) 메뉴** | 없음 | 있음 | 라이브 전용 내부 배포 도구 |

> ★원칙★: 클라이언트 UI 숨김(`LIVE_ONLY_OPS`)은 편의일 뿐, **실제 차단은 항상 서버(`PUBLIC_BUILD`)가 이중으로** 한다. 공개 모드에서 라이브 전용 엔드포인트는 404/거부된다.

## 새 토글을 추가할 때

라이브↔공개에서 다르게 동작해야 하는 기능을 새로 만들면:
1. 서버 차단은 `PUBLIC_BUILD`로 게이트(정본 방어선).
2. 클라이언트 UI 숨김이 필요하면 `LIVE_ONLY_OPS`로 게이트.
3. **이 표에 한 줄 추가**한다(토글 목록을 여기 한 곳에서 관리).
