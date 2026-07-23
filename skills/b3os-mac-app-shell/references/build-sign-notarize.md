# 빌드 · 서명 · notarization

> 정본 스크립트: `mac-iphone-shell/scripts/package-macos-app.sh`. 골격 `docs/AppStoreReview.md`·`docs/UNSIGNED_APP_TEST_GUIDE.md` 참조.
> **전제**: macOS Sonoma 14+ / Xcode 16.2+ (`xcodebuild -version`). 배포는 Apple Developer 계정 필요.
> **⚠ 이 파트의 risk = medium** (서명/notarization은 credential이 얽혀 가장 깨지기 쉽고, 잘못하면 secret 유출).

## 패키징

```
bash scripts/package-macos-app.sh
# → .build/<APP_NAME>  (예: .build/b3os.app)
```
스크립트가 하는 일: `swift build --product <PRODUCT_NAME> --configuration release` → 바이너리를 `.app` 번들 구조로 래핑(Info.plist 포함) → 서명.

## 패키징 입력 체크리스트 (앱마다 확인)

`.app`을 빌드하기 전, 아래가 의도한 값인지 확인(`package-macos-app.sh` 상단 변수 + Info.plist):

- [ ] `APP_NAME` — `.app` 표시 이름 (예: `b3os.app`)
- [ ] `PRODUCT_NAME` — swift build product / 실행 바이너리명 (예: `B3rysMacApp`)
- [ ] `CFBundleDisplayName` — Finder 표시명
- [ ] `CFBundleExecutable` — `PRODUCT_NAME`과 일치해야 실행됨
- [ ] `CFBundleIdentifier` — 번들 id (서명·notarization 단위)
- [ ] `AppShellEnv` / `webURL` — 셸이 로드할 환경/주소(테스트 vs prod)
- [ ] `WKAppBoundDomains` — 셸 이동 허용 도메인 (보안, `limitsNavigationsToAppBoundDomains=true`와 세트)

## 서명 단계 (용도별 명확히 분리)

| 용도 | 서명 | Gatekeeper |
|---|---|---|
| **로컬/팀 테스트** | ad-hoc (`codesign --force --sign -`) | 통과 못 함 → 받는 사람이 우클릭>열기 또는 `xattr -dr com.apple.quarantine` 안내 |
| **외부 배포** | Developer ID Application 서명 + **notarization** | 통과 |

## 🔐 credential 안전처리 (필수 — 위반 시 secret 유출)

- **이 스킬·문서·커밋에는 어떤 credential 값도 넣지 않는다**: Apple ID, app-specific password, Team ID, 인증서 private key, notarytool password 전부 금지.
- **stdout/로그 금지**: 위 값들을 `echo`/`cat`/빌드 로그에 출력하지 않는다(세션 로그·CI 로그에 영구 기록됨).
- **참조 방식만 사용**:
  - 서명 identity → keychain의 "Developer ID Application: ..." 이름으로 참조(`codesign --sign "Developer ID Application: …"`). private key는 keychain에 둔다.
  - notarization → `xcrun notarytool store-credentials <profile>`로 **keychain profile** 1회 등록 후, 이후엔 `--keychain-profile <profile>`로만 호출. Apple ID/password를 명령에 직접 쓰지 않는다.
  - 절차: `xcrun notarytool submit <zip> --keychain-profile <profile> --wait` → `xcrun stapler staple <app>`.
- **확인은 값이 아니라 존재로**: credential 비었는지 점검은 내용 출력 말고 `security find-identity -p codesigning`(identity 목록만) 등으로.

## 배포 전 확인

- `spctl -a -vv <APP_NAME>` → Gatekeeper 평가(accepted 여야 외부 배포 가능).
- 테스트 배포 가이드: `docs/UNSIGNED_APP_TEST_GUIDE.md`.

## 환경 분리

- 테스트 = 미서명/ad-hoc + 테스트 URL(예: `<dashboard-domain>`)
- 배포 = notarized + prod URL
- webURL은 빌드에 하드코딩 말고 `AppShellSettings`(UserDefaults `AppShell.webURL`)로 구성 — 같은 빌드를 환경별로 가리키게.

## 자동 업데이트 (향후)

골격 RemoteConfig + Sparkle 결합 예정(TODO). 현재는 수동 재배포.
