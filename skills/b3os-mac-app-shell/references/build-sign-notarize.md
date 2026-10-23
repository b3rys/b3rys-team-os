# 빌드 · 서명 · notarization

> 정본 스크립트와 참조 문서(`scripts/package-macos-app.sh` · `docs/AppStoreReview.md` · `docs/UNSIGNED_APP_TEST_GUIDE.md`)는 모두
> ★골격 저장소(`mac-iphone-shell`, b3rys 내부 비공개) 안에 있고 이 저장소에는 없다★. 아래 경로는 전부 그 저장소 기준이다.
> **전제**: macOS Sonoma 14+ / Xcode 16.2+ (`xcodebuild -version`). 배포는 Apple Developer 계정 필요.
> **⚠ 이 파트의 risk = medium** (서명/notarization은 credential이 얽혀 가장 깨지기 쉽고, 잘못하면 secret 유출).

## 패키징

이 저장소에서는 실행되지 않는다 — 골격을 clone 한 위치(`$SHELL_SKELETON`)에서 실행한다.

```
cd "$SHELL_SKELETON"                     # 골격 저장소를 clone 한 경로
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

다운로드·메신저로 받는 전달본은 dev 여부와 무관하게 공증(notarization)+staple 본만 보낸다. 서명만 된 앱은 Gatekeeper 가 차단한다(`codesign --verify` 통과 ≠ 공증됨). 확인은 `stapler validate` + `spctl -a -t exec -vv` 의 `source=Notarized`, 결과는 보고에 적는다. 아이콘 등 번들을 바꿔 재서명하면 staple 이 깨지므로 재공증한다.

## 🔐 credential 안전처리 (필수 — 위반 시 secret 유출)

- **이 스킬·문서·커밋에는 어떤 credential 값도 넣지 않는다**: Apple ID, app-specific password, Team ID, 인증서 private key, notarytool password 전부 금지.
- **stdout/로그 금지**: 위 값들을 `echo`/`cat`/빌드 로그에 출력하지 않는다(세션 로그·CI 로그에 영구 기록됨).
- **참조 방식만 사용**:
  - 서명 identity → keychain의 "Developer ID Application: ..." 이름으로 참조(`codesign --sign "Developer ID Application: …"`). private key는 keychain에 둔다.
  - notarization → `xcrun notarytool store-credentials <profile>`로 **keychain profile** 1회 등록 후, 이후엔 `--keychain-profile <profile>`로만 호출. Apple ID/password를 명령에 직접 쓰지 않는다.
  - 절차: `xcrun notarytool submit <zip> --keychain-profile <profile> --wait` → `xcrun stapler staple <app>`.
- **키체인이 잠겼을 때**: notarytool 의 "No Keychain password item found" 는 항목이 없다는 뜻이 아니라 데이터 보호 키체인이 잠긴 것이다(소유자가 자리를 비우면 잠김). 소유자에게 재등록을 시키지 않고 ①소유자가 맥을 쓰는 동안 공증하거나 ②App Store Connect API 키 파일을 쓴다(경로만 참조, 값 출력 금지). 출고 스크립트는 키·키 ID·발급자 세 값이 모두 있어야 키 파일을 쓰고 하나라도 비면 조용히 키체인으로 돌아가므로 반쯤 채운 파일을 두지 않는다. Key ID 와 Issuer ID 는 다르다. `.p8` 은 메신저로 받지 않고 경로만 받는다. 한 번의 성공을 원인 확정으로 쓰지 말고 시간을 두고 두 번 잰다. 서명(codesign)은 화면 잠김과 무관하다.
- **공증 거절 "HTTP 403 A required agreement is missing or has expired"**: 약관 미동의다 — 키·서명 문제가 아니다. 키 재등록·재서명을 하지 않고 계정 소유자에게 동의를 요청한 뒤(동의 후 약 3분) 2분 간격으로 재제출한다. 출고 스크립트의 공증 칸은 실패로 남으므로 zip→submit→staple→validate→spctl 을 손으로 한 번 더 확인한다.
- **확인은 값이 아니라 존재로**: credential 비었는지 점검은 내용 출력 말고 `security find-identity -p codesigning`(identity 목록만) 등으로.

## 배포 전 확인

- `spctl -a -vv <APP_NAME>` → Gatekeeper 평가(accepted 여야 외부 배포 가능).
- 테스트 배포 가이드: `docs/UNSIGNED_APP_TEST_GUIDE.md`.

## 전달 전 검증

받는 사람 조건 그대로 검증한다.

- 앱 번들 안의 비-ASCII 파일 이름은 Finder(Archive Utility)가 zip 을 풀 때 NFD 로 바뀌어 서명 봉인이 깨진다("손상되었기 때문에 열 수 없습니다"). 로컬 `ditto -x`·`spctl` 검사는 통과해 못 잡는다. 번들 안 이름은 ASCII 로 두고 복사 때 표로 제목을 붙인다. 전달 전에 zip 에 quarantine 속성을 붙여 Archive Utility 로 열고 `codesign --verify --deep --strict` + `spctl -a -vv -t exec`.
- 공증이 정상인데 받는 맥에서 "악성 코드 확인 불가"가 나오면 zip 의 `._`(확장 속성)가 Finder 해제 때 프레임워크 봉인을 깨는 경우다. zip 은 `ditto -c -k --norsrc --keepParent` 로 만든다. 검증은 `ditto -x` 가 아니라 `unzip` 으로 풀어 `codesign --verify --deep --strict` + stapler + spctl, Finder 재현은 `open -W -g -a "Archive Utility" <zip>`. 추정을 원인처럼 말하지 않고 재현부터.
- 출고 게이트는 권한 없는 테스트 번들로 띄우므로 공증본의 실제 시작 경로(키체인·iCloud·권한 이행)를 타지 않는다. 권한·키체인·iCloud·시작 경로를 바꾼 출고본은 공증 원본 그대로 + 테스트 로그인 키 하나로 한 번 실제 실행해 창이 뜨는지 보고 배포한다. 롤백 경로(직전 버전 업로드)를 미리 확인한다.
- 만든 기계에서만 통과하고 받는 기계에서 죽는 결함(예: SwiftPM `Bundle.module` 이 빌드 머신 절대경로를 대체 경로로 둠)은 재현이 핵심이다 — 만든 기계에만 있는 산출물(빌드 폴더의 번들)을 숨기고 앱을 실행해 죽는지 본다. 리소스는 `Bundle.main.resourceURL` 아래에서 직접 찾고 없으면 nil 로 두어 앱이 죽지 않게 한다. 번들 이름을 손으로 적지 말고 glob 으로 전부 다룬다. 검사 합격 기준은 리소스를 실제로 읽었을 때만 나오는 것(생성된 노트 파일·화면의 잉크)으로 둔다.
  적용 사례(상황에 맞게 적용하고 그대로 따라 하지 않는다): 공증본이 받는 맥에서 실행 2.5초 만에 종료됐는데 만든 기계에서는 한 번도 재현되지 않았다.

## 환경 분리

- 테스트 = 미서명/ad-hoc + 테스트 URL(예: `<dashboard-domain>`)
- 배포 = notarized + prod URL
- webURL은 빌드에 하드코딩 말고 `AppShellSettings`(UserDefaults `AppShell.webURL`)로 구성 — 같은 빌드를 환경별로 가리키게.

## 자동 업데이트 (향후)

골격 RemoteConfig + Sparkle 결합 예정(TODO). 현재는 수동 재배포.
