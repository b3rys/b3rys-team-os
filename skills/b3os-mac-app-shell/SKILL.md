---
name: b3os-mac-app-shell
description: 웹 대시보드/웹앱을 Apple 네이티브 셸(.app)로 빠르게 래핑하는 팀 스킬. mac-iphone-shell 골격(SwiftUI multi-platform + WKWebView 라이브러리 + HostApp 패턴)을 참조해 URL 구성형 Mac/iPhone 앱을 만들고 .app으로 패키징한다. "이 웹대시보드를 맥앱으로 만들어줘", "b3os.app 같은 셸 앱", "사내 웹툴 네이티브 래핑"일 때 사용. 검증된 함정(특히 WebView 창 채움/viewport)을 피하는 레시피 포함. 주 사용자·업데이트 책임자: agent A·developer.
---

# b3os-mac-app-shell

웹앱을 Apple 네이티브 셸(.app)로 래핑하는 팀 표준 레시피. **골격 저장소(`mac-iphone-shell`)를 참조**하며 코드를 복제하지 않는다 — 이 스킬은 "언제·어떻게·무엇을 조심"의 운영 지식이고, 실제 구현·빌드 스크립트는 골격에 있다.

> 정본 골격: `~/Development/mac-iphone-shell` (SwiftUI multi-platform 라이브러리 + HostApp 패턴)
> owner / 업데이트 책임자: **agent A, developer** (둘이 함께 유지·리뷰)

## 언제 쓰는가

- 이미 있는 웹 대시보드/웹툴을 **설치 가능한 Mac 앱(.app)** 으로 내보내고 싶을 때 (예: b3os 대시보드 → `b3os.app`)
- "맥앱으로 래핑한 티 안 나게, 라이트/다크 seamless, 창이 네이티브처럼" 요구
- iPhone 동반 앱(같은 골격, read-only/동일 셸)도 필요할 때
- ❌ 쓰지 않는 경우: 네이티브 UI가 본질인 앱(웹뷰가 아니라 SwiftUI 화면이 주). 그건 골격 없이 일반 SwiftUI로.

## 전제 · 요구사항 (이게 없으면 이 스킬은 못 쓴다)

- **macOS Sonoma 14+** (골격 deployment target). **Xcode 16.2+** (`xcodebuild -version`). Swift toolchain 포함.
- 배포(외부 공개)하려면 **Apple Developer 계정** + Developer ID Application 인증서. 로컬/팀 테스트는 ad-hoc만으로 가능(서명 안 됨).
- 이 스킬은 **macOS 빌드 환경 전용** — Windows/Linux에선 `.app` 빌드 불가(셸 컨셉만 참고).
- 핀(검증된 조합): macOS 14 / Xcode 16.2 / 골격 `mac-iphone-shell` 최신 main. 더 높은 버전은 빌드 후 §검증 통과 시 사용.

## 입력값 (앱마다 정하는 것)

| 값 | 무엇 | 어디서 설정 |
|---|---|---|
| **webURL** | 셸이 로드할 웹 주소 | `AppShellSettings.defaultWebURL` (기본 `http://localhost:7878/team`) + 런타임 UserDefaults 키 `AppShell.webURL`로 덮어쓰기 가능 |
| **app name** | `.app` 표시 이름 | `scripts/package-macos-app.sh`의 `APP_NAME` (예: `b3os.app`) / Xcode HostApp 프로젝트명 |
| **product name** | 빌드 산출 바이너리 | 같은 스크립트 `PRODUCT_NAME` (예: `B3rysMacApp`) |
| **bundle id** | 번들 식별자 | Xcode HostApp 프로젝트 (Signing & Capabilities) |
| **WKAppBoundDomains** | 셸이 이동 가능한 도메인 화이트리스트 | HostApp `Info.plist` (보안: `limitsNavigationsToAppBoundDomains=true`와 한 세트) |

## 절차 (요약 — 상세는 골격 `docs/QuickStart.md` "30분")

1. 골격 라이브러리 가져오기 (로컬 클론 또는 SPM 의존성)
2. Xcode에서 App 프로젝트(HostApp) 생성 → AppShell 라이브러리 추가
3. App entry를 `AppShellRootView`(셸)로 교체, `webURL`·환경 주입
4. `Info.plist`: `WKAppBoundDomains` + 환경 도메인 설정
5. Capabilities (서명용 — Apple Developer 계정)
6. 빌드·실행: `swift build` / Xcode Run
7. 배포용 `.app` 패키징: `scripts/package-macos-app.sh` → `.build/<APP_NAME>` (테스트=ad-hoc 서명, 배포=notarize)

## 산출물

- 더블클릭으로 실행되는 `.app` (테스트: ad-hoc 서명 / 배포: Developer ID 서명 + notarization)
- 라이트/다크 자동 추종, 네이티브 창 chrome(타이틀바 통합·이동·디스플레이 변경 재클램프)
- (선택) iPhone 동반 앱 — 같은 골격 + 플랫폼 분기

## 검증 절차 (반드시)

1. `swift build` 0 에러
2. **창 채움 실측 (회귀 가드)** — 앱 실행 후 webview 높이 == 창 높이인지 *측정으로* 확인. 방법: in-app JS로 `document.documentElement.clientHeight`(또는 `window.innerHeight`)를 네이티브 창 높이와 비교 → 같으면 OK, webview가 더 크면 viewport 부풀림 회귀(아래 회귀주의 3종세트 점검). 화면 못 보는 세션은 측정값을 `/tmp` 로그로 남기고 the team lead/실기 확인 위임.
3. 라이트/다크 전환 seamless(셸 배경이 웹과 어긋나지 않음)
4. 창 리사이즈·디스플레이 변경 시 잘림/벌어짐 없음
5. 배포 전: notarization 통과 + Gatekeeper 통과(`spctl -a`)

## ⚠️ 검증된 함정 — 반드시 references 읽기

- [`references/viewport-and-gotchas.md`](references/viewport-and-gotchas.md) — **WebView 창 채움 버그(위 벌어짐/아래 잘림) 회귀주의**. NonIntrinsicWebView + autoresizing pin 3종세트. 제거 금지.
- [`references/build-sign-notarize.md`](references/build-sign-notarize.md) — 패키징 스크립트, ad-hoc vs Developer ID, notarization, 미서명 테스트 배포.

## 근거 / evidence

- 골격: `~/Development/mac-iphone-shell` — Steno, b3os.app 실사용 검증
- 패턴 박제: `mac-iphone-shell/docs/Architecture.md` "주요 결정" Q/A (커밋 `5f80a8e`)
- viewport 근본해결: `WebView.swift`·`AppShell.swift` (커밋 `c626beb`, `ac8ed27` — 측정 기반)
- **레시피 재현 evidence**: 이 레시피(`package-macos-app.sh`)로 빌드한 `b3os.app` → `.build/b3os-latest.zip`(397KB, 2026-06-24 빌드), the team lead 실기 확인 + `<dashboard-domain>` 배포본. 빌드 로그: `references/build-evidence.md`.

## 유지보수 — owner · 갱신 트리거

- **owner / 업데이트 책임자: agent A, developer** (둘이 함께 유지·교차리뷰).
- **언제 갱신하나(트리거)**:
  - 골격(`mac-iphone-shell`)의 WebView/창 chrome/패키징 스크립트가 바뀔 때 → 이 스킬의 references 동기화.
  - 새 macOS/Xcode에서 빌드·viewport가 깨질 때 → 전제 핀 버전 갱신 + 회귀주의 보강.
  - notarization/서명 흐름(Apple 정책)이 바뀔 때 → `build-sign-notarize.md` 갱신.
  - 새 실전 앱을 이 레시피로 만들 때 → evidence에 추가(관측 누적).
