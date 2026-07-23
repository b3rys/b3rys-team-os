# Viewport & 검증된 함정

> 정본: `mac-iphone-shell/docs/Architecture.md` "주요 결정" Q/A. 여기는 스킬 사용자가 빨리 보는 요약.

## ⚠️ #1 — WebView 창 채움 버그 (제거 금지)

**증상**: 맥앱 창에서 웹 콘텐츠 상단에 빈 공간이 벌어지고, 하단(예: 3패널의 맨 아래)이 창 밖으로 잘려 안 보인다. `100dvh`가 창 높이가 아니라 콘텐츠 높이로 잡힌다.

**근본원인**: `WKWebView`가 웹 콘텐츠 전체 높이(예: 1132px)를 `intrinsicContentSize`로 노출 → `NSViewRepresentable` 컨테이너가 그 높이까지 부풀어 창(예: 650px)을 넘침 → 뷰포트가 창이 아닌 콘텐츠 크기가 됨.
※ 추측 금지: in-app JS로 `webview=1132 vs window=618`을 측정해 근본원인을 확정한 사례다. CSS/safe-area부터 만지면 헛수고(실제로 3회 낭비).

**해결 — 3개가 한 세트, 하나라도 빠지면 깨짐**:
1. `NonIntrinsicWebView` — `intrinsicContentSize`를 `noIntrinsicMetric`으로 override해 부풀림 차단. `PlatformWebView` typealias로 iOS(`WKWebView`)/macOS(`NonIntrinsicWebView`) 분기(iOS 빌드 깨짐 방지).
2. **autoresizing pin** — `translatesAutoresizingMaskIntoConstraints = true` + `frame = container.bounds` + `autoresizingMask = [.width, .height]`. Auto Layout 제약이 아니라 autoresizing으로 컨테이너에 고정. **결정적 수정.**
3. `sizeThatFits`가 `proposal.replacingUnspecifiedDimensions()` 반환 + `.frame(maxWidth:.infinity, maxHeight:.infinity)`.

**코드 위치**: `Sources/AppShell/Web/WebView.swift`, `Sources/AppShell/AppShell.swift`.

## #2 — 신호등(트래픽 라이트) 클리어런스

타이틀바 통합(`fullSizeContentView`) 시 신호등 버튼과 웹 콘텐츠가 겹칠 수 있다. 네이티브에서 일원화 클리어런스 + 디스플레이 변경 시 재클램프(`didChangeScreenNotification`). 참조: `MacWindowChrome.swift`.

## #3 — 라이트/다크 seamless

셸 배경색을 `prefers-color-scheme`에 맞춰 동적으로(웹과 어긋나면 래핑 티가 남). 웹 토큰과 셸 배경을 같은 명도로.

## 측정 방법 (회귀 가드 — 빌드할 때마다 1회)

앱 실행 후 webview에서 in-app JS로:
```js
// webview 콘텐츠 높이 vs 네이티브 창 높이 비교
console.log(document.documentElement.clientHeight, window.innerHeight);
```
또는 네이티브에서 `webView.frame.height`(== 창 콘텐츠 높이)와 비교. **둘이 같으면 OK**. webview가 더 크면 viewport 부풀림 회귀 → 위 3종세트 점검. 화면 못 보는 세션은 `evaluateJavaScript`로 값을 `/tmp` 로그에 남겨 확인.

## 교훈

- WebView 창 채움/잘림은 **CSS 추측 말고 webview 실제 높이부터 측정**.
- iOS/macOS 플랫폼 분기는 typealias로 — 한쪽만 고치면 다른 빌드가 깨진다(크로스리뷰로 잡힌 함정).
