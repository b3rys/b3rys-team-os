# 아이폰 개발·시험 — 겪은 이슈와 해결법 (팀 정본)

> 원자료: `cogs-ios` `docs/ios-dev-notes.md`(2026-10-16) + Steno 아이폰 TestFlight 빌드 1~6(2026-10-15~16).
> 각 항목은 증상 → 원인 → 해결·지금 방법. 날짜는 실제로 일어난 날.
> 예시의 번들 id·경로·PR 번호는 그 앱 기준이다. 다른 앱에서는 자기 값으로 바꾼다.
> 공용 맥에서 시뮬레이터·무거운 빌드를 함께 쓰는 운영 규칙(1장·8장)은 b3os-sf [`dev-mode-operations.md`](../../b3os-sf/references/dev-mode-operations.md#공용-맥에서-시뮬레이터-함께-쓰기)에도 요약이 있다. 내용이 다르면 이 문서가 정본이다.

## 1. 공용 맥에서 시뮬레이터 함께 쓰기

| # | 증상 | 원인 | 해결·지금 방법 |
|---|---|---|---|
| 1-1 | UI 시험이 무더기로 실패(10/12 전후) | 두 작업이 같은 시간에 `xcodebuild test` 를 돌려 시뮬레이터·CPU 를 나눠 씀 | 무거운 명령은 전부 `lockf -k -t <초> /Users/Shared/steno-locks/machine.lock <명령>` 안에서. 정본: b3os-sf `references/dev-mode-operations.md` |
| 1-2 | 전체 UI 시험이 2시간 넘음, 타이밍 시험 1/3 실패(10/15) | 다 쓴 시뮬레이터 14대가 켜진 채 남아 부하 평균 340 | 안 쓰는 기기는 `xcrun simctl shutdown`(지우지 않음, 다른 팀원의 기기는 주인 확인). 9대 끄고 부하 한 자릿수. 느리면 `xcrun simctl list devices booted` 개수·`uptime` 부터 |
| 1-3 | 다른 작업의 시험이 "로그인 화면" 전제를 못 맞춰 실패(10/14) | 실서버(로컬 시험 서버) 로그인 시험이 남긴 토큰이 공용 시뮬레이터 키체인에 남음 | 실제 로그인 시험 뒤 잠금 안에서 `shutdown → simctl uninstall <udid> <bundle id> → simctl keychain <udid> reset → boot`. 목업 시험은 키체인을 쓰지 않게 |
| 1-4 | 내 시험이 2시간 기다리다 잘림(10/16 새벽) | 잠금 대기 24개. 대기 시간과 실행 시간 제한을 한 타이머로 걸었음 | 잠금 대기 제한(`lockf -t`)과 실행 제한(`perl -e 'alarm N; exec @ARGV'`)을 따로. `scripts/sim-run.sh`(제안 prop_9b2fd0074489, 10/16 승인) 하나로 잠금·자기 기기 켜기·시험·정리·끄기·대기 수 표시 |
| 1-5 | 시험 시작 때 "AX loaded" 시간 초과 | 오래 켜 둔 시뮬레이터 상태 | 시험 전에 `shutdown → boot → bootstatus -b` |
| 1-6 | 결과 묶음(.xcresult) 경로 충돌로 실패 | 같은 경로 재사용 | `-resultBundlePath …-$(date +%s).xcresult` |

## 2. 어떤 기기·OS 로 시험하나

| # | 증상 | 원인 | 해결·지금 방법 |
|---|---|---|---|
| 2-1 | 실기기(iOS 26)에서만 나는 결함(키보드 열 때 내용이 먼저 점프, 읽던 자리, 링크 확인 창) — iOS 17 시뮬레이터에선 통과(10/13) | iOS 26 은 키보드 inset 을 첫 알림 전에 최종값으로 주는 등 OS 차이 | **기준 = iOS 26 시뮬레이터**(주 사용 실기기 26.6.1), iOS 17 은 보조. 26.0 런타임은 `xcodebuild -downloadPlatform iOS -buildVersion 26.0` |
| 2-2 | 부분 시험만 돌리고 머지 → 접근성 회귀(10/14) | 말풍선 접근성 구조를 바꿨는데 관련 시험만 골라 돌림 | 화면·제스처·접근성에 닿는 PR 은 **전체 UI 시험 1회 통과**가 완료 기준. 실패 시험을 조회만 느슨하게 고쳐 덮지 않음 |
| 2-3 | 실패 1개가 진짜인지 흔들림인지 모름("Activation point invalid") | XCTest 의 누름 판정이 가끔 실패 | 그 시험만 단독으로 2회 재실행 → 둘 다 통과면 흔들림으로 기록, 하나라도 실패면 결함 |
| 2-4 | 시뮬레이터 통과인데 실기기에서 첫 실행 크래시·빈 화면(Steno 10/15 빌드 1~2) | 실기기에만 있는 것: 실제 iCloud 컨테이너 경로, 아직 내려받지 않은 파일, 서명·entitlement | 실기기 확인이 남은 항목은 "시뮬레이터 통과 / 실기기 미확인"으로 나눠 보고. TestFlight 크래시·스크린샷 피드백은 App Store Connect API(`betaFeedbackCrashSubmissions`·`betaFeedbackScreenshotSubmissions`)로 바로 읽는다 |

## 3. 빌드·프로젝트

| # | 증상 | 원인 | 해결·지금 방법 |
|---|---|---|---|
| 3-1 | main 합친 뒤 "새 파일 못 찾음" 빌드 실패 | `.xcodeproj` 는 git 에 없는 생성물 | merge·rebase·핀 변경 뒤 첫 단계로 프로젝트 생성기 실행(예: `python3 scripts/generate-project.py`) |
| 3-2 | pbxproj 의 코어 리비전을 고쳤는데 안 바뀜 | 코어 패키지 핀의 정본은 `packages.json` | 핀은 `packages.json` 의 `revision`(전체 sha)만 고친 뒤 3-1 |
| 3-3 | 다른 작업의 PR 검증 결과가 이상함 | 그 작업 폴더에서 checkout → 미커밋 작업이 섞임 | 검증은 `git worktree add --detach <내 임시 폴더> <sha>` 로 따로 꺼내서, DerivedData 도 따로 |
| 3-4 | 시험이 전혀 안 돌았는데 "통과"(뮤턴트가 전부 살아남음) | zsh 는 따옴표 없는 변수를 쪼개지 않음 · heredoc 안 `zsh -c "…$U…"` 에서 바깥에 없는 변수가 빈 값으로 펼쳐짐 | 스크립트는 변수를 파일 안에서 정의하고, 결과 줄에 `Executed N tests` 를 꼭 출력해 N 을 본다 |
| 3-5 | 뮤턴트 복원이 안 됨 | 앞 뮤턴트가 `git checkout <sha> -- 파일` 로 index 에 올린 것을 `git checkout .` 이 index 기준으로 되살림 | 복원은 `git checkout HEAD -- <경로>` |

## 4. 속도·배터리

| # | 증상 | 원인 | 해결·지금 방법 |
|---|---|---|---|
| 4-1 | 답이 끝난 뒤에도 앱 CPU 95%·메인 스레드 99%(10/13) — 화면은 멀쩡 | TimelineView → 행 갱신 반복 | TestFlight 전 주요 화면·답 완료 5초 뒤 CPU 를 `top` 5초 평균으로(2% 이하 목표) iPhone 15 Pro·iOS 26 에서 재고 숫자를 PR 에. UI 시험이 query timeout 으로 멈추면 `sample` 부터 |

## 5. 화면·접근성

| # | 증상 | 원인 | 해결·지금 방법 |
|---|---|---|---|
| 5-1 | 버튼·요소를 시험이 못 찾음 | SwiftUI 에서 부모에 단 `accessibilityIdentifier` 가 안쪽 요소의 식별자를 덮음 | 식별자는 실제로 찾을 요소에, 덮는 부모(목록·행)는 overlay 보다 먼저 지정. 식별자를 옮기면 그 식별자를 쓰는 시험 전체(`grep`)를 같이 확인 |
| 5-2 | VoiceOver 가 체크 아이콘을 "선택됨" 으로 읽음 | `Label(text, systemImage:)` 의 접근성 이름이 아이콘 쪽으로 | 한 줄로 읽혀야 하면 `.accessibilityElement(children: .ignore).accessibilityLabel(text)` |
| 5-3 | 크기 계산이 실제와 반대로 틀림 | 머리로 글자 수→픽셀 계산 | 위임 전에 실제 값으로 목업·캡처를 찍어 잰다 |
| 5-4 | UI 시험 영상의 답이 "띄엄띄엄" | UI 시험은 애니메이션 끔(`UI_TEST_DISABLE_ANIMATIONS=1`), 목업 봇은 시험용으로 느리게 | 시험 영상으로 실제 스트리밍 느낌을 판단하지 않는다. 시연 영상은 실제 속도 목업 + 애니메이션 켜고 |
| 5-5 | 하단 도구막대의 글자(예: "노트 7개")가 동그란 버튼처럼 보임(Steno 10/16) | iOS 26 은 툴바 항목을 유리 알약으로 그림 | 누를 수 없는 정보는 툴바에 두지 않는다. 툴바에는 실제 동작만 |
| 5-6 | 읽기 화면에서 문장을 누르면 그 줄이 사라짐(Steno 10/16) | 데스크톱용 웹 편집기를 읽기 전용으로 쓰면서 커서 줄(`.cm-activeLine`)을 통째로 숨김 + 탭이 커서를 옮김 | 커서·선택 장식만 숨기고 줄은 남긴다. 읽기 화면은 탭·텍스트 선택 경로를 막고, "탭 전후 화면 동일"을 UI 시험으로 고정 |

## 6. 다국어(ko·en)

| # | 증상 | 원인 | 해결·지금 방법 |
|---|---|---|---|
| 6-1 | 한국어 기기에서 코어 문구가 영어(맥 앱, 10/15) | 앱 번들이 ko 지역화를 선언하지 않으면 패키지 리소스도 ko 를 못 고름 | 앱 번들에 ko·en lproj(아이폰은 String Catalog 가 만들어 줌). 확인은 `-testLanguage ko/en/ja` 로 실행 시험 + `en.lproj` 를 뺀 뮤턴트가 실패하는지 |
| 6-2 | 카탈로그에 키가 있는데 영어 기기에서 한글 | `Text("…")`·`Label("…")` 는 tableName 없으면 **Localizable 표만** 찾음 | 화면별 표를 쓰면 `String(localized: "…", table: "X")` |
| 6-3 | 비교용 상수를 현지화하면 영어에서 분기가 깨짐 | 화면 글자를 `==` 비교 표식으로도 씀 | 내부 표식은 언어와 무관한 코드, 그릴 때만 카탈로그 |
| 6-4 | 푸시 문구가 기기 언어를 안 따름 | 서버가 완성 문장을 보냄 | `loc-key` + 앱 `Localizable` 키(ko·en), 등록에 `capabilities:["loc_keys"]`, 옛 서버(400 invalid_json)면 필드 없이 재등록. 빌드된 앱의 `ko.lproj/Localizable.strings` 에 키가 들어갔는지 `plutil -p` 로 확인 |

## 7. 검증·리뷰 습관

| # | 증상 | 원인 | 해결·지금 방법 |
|---|---|---|---|
| 7-1 | 시험은 통과하는데 가드가 실제로 동작하는지 모름 | 통과 = 검증 아님 | 가드마다 뮤턴트(그 줄을 지우거나 바꿔 실행) → 실패해야 함. 살아남으면 시험을 고침 |
| 7-2 | 이미 다른 작업이 올린 기능을 새로 만듦(10/16) | 착수 전 열린 PR 미확인. 코드에 "Reserved feature hook"/`unsupported` 스텁이 있었음 | 착수 전 관련 저장소 모두 `gh pr list --state open` |
| 7-3 | 보안 지적이 매 회차 새로 나옴(명령 원문 → 따옴표 → `${}` → 유니코드 공백) | 셸 문법을 막는 목록(blocklist)으로 접근 | 허용 목록으로 뒤집기: 확실한 것만 보이고 나머지는 숨김. ASCII 공백·탭으로만 나눔 |
| 7-4 | 서버 응답 순서·네트워크 기한 때문에 상태가 꼬임 | HTTP 응답보다 웹소켓 답이 먼저 옴 · `URLRequest.timeoutInterval` 은 "무응답" 제한이라 전체 기한이 아님 | 이른 답은 받은 시각과 함께 보관(30초)·전체 완료 기한(25초)을 코드로 걸고 "보관 > 기한" 을 시험으로 고정 |

## 8. 디스크

| # | 증상 | 원인 | 해결·지금 방법 |
|---|---|---|---|
| 8-1 | 개발·임시 파일이 금방 쌓임(10/16 맥스튜디오: 데이터 볼륨 570G/926G 64%, 시뮬레이터 기기 51G, 한 작업 임시 폴더 23G — 워크트리·DerivedData·.xcresult) | 검증마다 워크트리·DerivedData·결과 묶음을 새로 만듦 | 1시간마다 용량 확인·알림. 지우기는 보고 후 결정한다(자동 삭제 범위는 미확정 — 확정되면 이 줄을 갱신). 다른 작업 폴더·저장소·키체인은 건드리지 않는다 |

## 9. TestFlight 내보내기·올리기 (Steno 10/15~16)

| # | 상황 | 지금 방법 |
|---|---|---|
| 9-1 | 빌드 번호 | 올릴 때마다 1씩 올린다(`--build-number N`). 같은 번호는 App Store Connect 가 거부 |
| 9-2 | 내보내기 | `archive → export` 후 IPA 서명과 실제 운영 iCloud entitlement 를 검사하고 나서 올린다. App Store Connect API 키 파일은 경로로만 넘기고 내용을 출력하지 않는다 |
| 9-3 | 올리기 | `xcrun altool --upload-app -f <ipa> -t ios --api-key <id> --api-issuer <issuer> --p8-file-path <키 경로>`. 처리(VALID)까지 보통 5~20분 — `builds` API 로 상태를 기다려 VALID 가 된 뒤 설치 가능하다고 알림 |

## 10. iCloud 로 맥 앱과 같은 폴더 쓰기 (Steno 10/15)

| # | 증상 | 원인 | 해결·지금 방법 |
|---|---|---|---|
| 10-1 | 맥 앱이 쓰는 iCloud 폴더가 있는데 아이폰 첫 실행에 아무것도 안 보임 | 아이폰이 컨테이너 안 다른 하위 폴더(`Documents/<앱>`)를 봄 | 컨테이너 id·하위 경로를 맥·아이폰이 **한 정의**(공용 소스 파일)에서 가져온다. 첫 실행은 설정 없이 그 폴더를 바로 연다 |
| 10-2 | 목록에 일부 파일이 빠짐 | 아직 내려받지 않은 iCloud 파일(placeholder)은 일반 디렉터리 읽기로 안 보이거나 열 때 멈춤 | `NSMetadataQuery`(ubiquitous documents scope) 하나로 목록을 만들고, 안 받은 파일은 파일명으로 먼저 보이며 내려받기를 비동기로 요청. 읽기는 비차단 + 받은 파일만 NSFileCoordinator |
| 10-3 | 같은 파일이 두 번 나오거나 비교가 틀림 | `/var/…` 와 `/private/var/…` 경로 별칭 | 비교 전에 경로를 정규화(`resolvingSymlinksInPath`) |
| 10-4 | NSMetadataQuery stop 에서 앱이 멈춤 | 동시 질의가 많을 때 stop 교착 | 질의는 하나만, stop 은 알림 콜백 밖에서 |
| 10-5 | 첨부(음성 등) 링크가 맥·아이폰 한쪽에서만 열림 | 링크 상대경로 기준이 서로 다름 | 노트의 링크는 ★노트 파일이 있는 폴더 기준★ 상대경로로 쓴다(하위 폴더 노트면 `../attachments/…`). 라이브러리 밖을 가리키면 거부 |

## 참고 위치

- b3os-sf [`references/dev-mode-operations.md`](../../b3os-sf/references/dev-mode-operations.md) — `machine.lock`, 공용 맥 운영
- 팀 학습 로그 `rules/SHARED.md` 2026-10-14·15 항목
- 원자료: `cogs-ios` `docs/ios-dev-notes.md` · `README.md`(시뮬레이터 검사·TestFlight) · `docs/performance-battery.md`
- Steno: `iOS/scripts/archive-testflight.sh`, `Sources/Steno/Core/LibraryCloudContainer.swift`, `iOS/StenoIOS/IPhoneCloudCatalog.swift`
