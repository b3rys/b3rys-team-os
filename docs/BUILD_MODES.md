# Build Modes — 공개(public) vs 라이브(live)

b3os는 **하나의 소스 트리**로 두 가지 실행 모드를 지원한다. 모드는 ★런타임 환경변수★로 정해진다 —
빌드 시점에 소스를 바꾸지 않는다(public=source: 공개 repo가 곧 정본).

## 스위치: `B3OS_LIVE`

| 값 | 모드 | 설명 |
|---|---|---|
| (미설정) | **공개(public)** — 기본 | fail-safe. 라이브 전용 기능이 꺼진다. **팀을 실제로 운영하는 설치를 포함해, b3os 를 쓰는 거의 모든 인스턴스가 여기 해당한다.** |
| `B3OS_LIVE=1` | **라이브(live)** | 풀 기능. **b3os 자체를 개발·검증하는 인스턴스에서만** 켠다(`.env`에 설정). |

> ★"라이브" 는 "실제로 돌아가는 팀" 이라는 뜻이 아니다.★ 여기서 라이브는 **b3os 를 만드는 쪽의 개발 설치**를
> 가리킨다. 실멤버가 매일 일하는 정식 운영 팀이라도, b3os 자체를 손보는 게 아니라면 **공개 모드가 맞다** —
> 공개는 "덜 갖춘 상태" 가 아니라 **정식 운영 모드**다. 라이브 전용 토글은 아래 표대로 내부 검증용
> (codex·b3os_native 런타임, 재적용/롤백, 배포 메뉴)이다.
>
> 이름이 반대로 읽히기 쉬운 자리다. 실제로 운영 팀 두 명이 사흘 사이에 각각 "우리가 라이브인데 안 켜져
> 있다" 고 오진했다 — 판단 기준은 **"팀이 진짜인가" 가 아니라 "b3os 를 개발하는가"** 다.

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
