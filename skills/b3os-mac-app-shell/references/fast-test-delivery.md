# 공증본 시험 배포 — 한 명령, 약 9분

기능 추가·버그 수정 한 건을 **공증된 zip** 으로 사람에게 건네기까지의 팀 표준 흐름.
실제 구현 예: Steno 저장소 `scripts/ship-lite.sh` · `scripts/verify-zip.sh` · `scripts/deliver.sh` · `scripts/lock-lib.sh` · `scripts/release-app.sh`.
★아직 Steno main 에는 `release-app.sh` 만 있다. 나머지는 통합 가지 `steve/int-065` 에 있다(main 머지 전까지는 그 가지에서 본다).★
다른 맥 앱(cogs 등)은 이 구조를 그대로 옮기고 앱 이름·검사 범위만 바꾼다.

## 왜 이 구조인가

- 시험과 공증을 **동시에** 돌린다. 공증(빌드·서명·Apple 서버 대기)은 실측 약 1분 반이지만 Apple 쪽이 붐비면 몇 분으로 늘어난다 — 앞에 따로 세우면 그만큼 통째로 늘어난다.
- 가장 긴 것은 **앱을 띄우는 기능 확인(약 7분)**이다. 줄이려면 여기서 범위를 줄인다(핵심 화면만).
- 사람이 받는 것은 **공증본만**. 서명만 된 앱(공증 X)은 다른 맥에서 내려받으면 Gatekeeper 가 막는다. 서명 ≠ 공증.
- 실패하면 **그 자리에서 멈춘다**. 다시 돌리기·건너뛰기·선택 표를 두지 않는다 — 단순해야 빠르다.

## 흐름 (Steno v0.7.29 실측: 시작 → zip 약 515초 — 앱마다 다르다)

```
0s    시작 전 확인: 작업 트리 깨끗 · 앱이 떠 있지 않음 · 맥 앞 시스템 알림 창 닫기 · 웹 번들 = 소스
3s    ┌ 기능 테스트(swift test, 속도·번역 판 제외)          ~60s
      └ 공증 빌드(release-app.sh: 서명 → notarytool submit --wait → stapler staple)  백그라운드, 실측 ~85s에 끝
67s   테스트 통과 → debug 빌드 → 앱을 띄우는 기능 확인(핵심 화면 6개 범위)   ~7분
503s  앱 확인 통과 → 공증 끝날 때까지 wait
      번들 안 파일 이름 ASCII 확인 → ditto zip → 받은 쪽 검증(verify-zip.sh) → 로컬 태그 v<버전>
515s  ✓ zip
```

- 기능 테스트가 실패하면 공증 프로세스도 죽이고 멈춘다.
- 속도 검사는 기본으로 하지 않는다. 큰 변경·리팩터링·공개 전에만 켠다(`SHIP_SPEED=1`).
- 같은 맥에서 앱을 띄우는 검사는 **한 번에 하나**. 기계 잠금으로 줄 세운다: OS 잠금(`lockf`) 하나, 파일은 **`/Users/Shared/steno-locks/machine.lock`**(HOME 밖 공용 폴더라 다른 사용자·러너도 같은 파일을 본다). ★다른 앱도 이 같은 파일을 잡아야 서로 줄 선다★ — 앱별 잠금 파일을 따로 만들면 소용없다. 잡은 프로세스가 죽으면 OS 가 풀어 준다.

## 받은 쪽 검증 (verify-zip.sh) — 사람에게 주기 전 마지막 문

zip 은 **확장 속성 없이** 만든다: `ditto -c -k --norsrc --keepParent <앱 또는 버전 폴더> <zip>`.
zip 을 임시 폴더에 **`unzip` 으로** 풀고(`ditto -x` 금지 — 아래 참고), **인터넷에서 내려받은 것처럼 격리 속성(quarantine)을 붙인 뒤**:

0. `codesign --verify --deep --strict <app>` — 앱 안 모든 파일이 서명(봉인)과 맞는지. 군더더기 파일 하나만 있어도 실패
1. `xcrun stapler validate <app>` — 공증 표가 앱에 붙었는지
2. `spctl -a -t exec -vv <app>` — Gatekeeper 가 실행을 허락하는지
3. 번들 안 도우미 실행 파일 확인(앱별)
4. 빌드 폴더 없이 실행되는지(개발 경로에 기대는 코드가 없는지)
5. (두 아키텍처로 내는 앱) `lipo -archs <app>/Contents/MacOS/<실행 파일>` 에 `arm64 x86_64` 둘 다

모두 통과해야 zip 을 남긴다.

★왜 `unzip` + `--deep --strict` 인가 (Steno 0.7.30, 10-08)★: `ditto -c -k` 는 파일의 확장 속성(macOS 가 붙이는 com.apple.provenance 등)을 `._이름` 파일로 zip 에 넣는다. 받는 사람이 Finder 더블클릭(아카이브 유틸리티)으로 풀면, **안에 framework(예: Sparkle)가 있을 때** 그 심볼릭 링크 자리의 `._` 파일이 앱 안에 그대로 남아 서명 봉인이 깨지고 Gatekeeper 가 "Apple은 … 악성 코드가 없음을 확인할 수 없습니다" 로 막는다 — **공증은 정상인데도**. `ditto -x` 는 `._` 를 다시 합쳐 줘서 검증이 통과해 버린다(우리가 놓친 이유). Finder 와 똑같이 풀어 보려면 `open -W -g -a "Archive Utility" <zip>`. 실패하면 zip 을 지운다.

## 전달 (deliver.sh)

1. zip 이 하나뿐이고, 로컬 태그 `v<버전>` 이 zip 의 커밋에 있는지 확인(어긋나면 거절)
2. 받은 쪽 검증을 **한 번 더**
3. 그 태그 **하나만** origin 에 push(브랜치는 올리지 않는다). 실패하면 zip 을 내놓지 않는다
4. 전달 폴더에 `<앱>-<버전>-<sha>.zip` 으로 복사 → 메시지 뼈대 출력 → 마지막 줄에 zip 경로

★서버가 있는 앱★: 전달 전에 앱이 부르는 API 가 **운영 서버에 이미 배포돼 있는지** 한 줄로 확인한다(예: 새 엔드포인트에 요청해 404 가 아닌지). 서버 배포가 뒤에 오면 받은 사람 손에서 앱이 깨진다.

발송(텔레그램 등)은 스크립트가 하지 않는다. 사람이(또는 담당 에이전트가 reply 도구로) 한다.

## 공증 자격 — API 키 파일을 쓴다

- `--keychain-profile` 은 **사용자 세션이 잠기면 못 읽는다.** 이때 notarytool 은 "No Keychain password item found" 라고 나오지만 항목이 없는 게 아니라 잠긴 것이다. 재등록하지 않는다.
- 무인 빌드는 App Store Connect API 키(.p8)를 쓴다: env 파일 `~/.config/b3rys/notary-key.env`(chmod 600)에 `NOTARY_KEY`(.p8 경로) · `NOTARY_KEY_ID` · `NOTARY_ISSUER` 를 두고 스크립트가 `source` 한다(`NOTARY_ENV` 로 경로 바꿈).
- 600 이라 **같은 macOS 사용자로 도는 프로세스만** 읽는다. 팀 에이전트(Claude·codex 런타임)는 모두 같은 사용자로 돌아 읽을 수 있다. 다른 사용자(CI 러너 등)는 따로 둬야 한다.
- **키·env 파일 내용은 절대 출력하지 않는다**(cat·echo·grep 금지). 있는지만 `[ -s 파일 ]` 로 본다. 로그에도 "자격: API 키 파일(경로)" 만 찍는다.

## 서명 순서

- 안쪽 도우미 실행 파일 → 앱 순서로 따로 서명. `--deep` 쓰지 않는다.
- 모두 `codesign --force --options runtime --timestamp` (hardened runtime 없으면 공증 거절).

## 자주 막히는 곳

| 증상 | 원인 | 처리 |
|---|---|---|
| 앱 확인이 전부 실패 | 맥 앞에 시스템 알림 창(UserNotificationCenter)이 떠 있어 앱이 앞으로 못 나옴 | 시작 전에 닫는다(스크립트가 자동) |
| 공증 "No Keychain password item found" | 세션 잠김 | API 키 파일로 전환 |
| 공증 정상인데 받은 쪽에서 "악성 코드 확인 불가" | zip 에 들어간 `._` 확장 속성 파일이 Finder 풀기 뒤 framework 안에 남아 봉인 깨짐 | `ditto -c -k --norsrc` 로 zip · 검증은 `unzip` + `codesign --verify --deep --strict` |
| 공증 거절: 파일 이름 | 번들 안 비ASCII 파일 이름 | zip 전에 검사해서 멈춘다 |
| 태그 push 가 GitHub 500 | 일시 오류 | 같은 명령 다시(같은 sha 의 태그는 통과) |
| 시험 중 HEAD 가 바뀜 | 빌드 중에 같은 작업 트리에 커밋 | 빌드 중엔 그 트리에 커밋하지 않는다. 스크립트가 감지해 멈춘다 |
| 검사가 실제 사용자 데이터를 건드림 | 시험이 기본 폴더 사용 | 시험·검사는 임시 라이브러리만 쓰게 한다 |

## 다른 앱에 옮길 때 바꿀 것

- 앱 이름·번들 id·서명 identity
- 시작 전 확인 중 앱 전용 항목(Steno 의 "웹 번들 = 소스" 는 웹 번들이 있는 앱만)
- 서버가 있으면 운영 API 확인 한 줄, 두 아키텍처면 lipo 확인
- 앱 확인 범위(그 앱의 핵심 화면 몇 개만 — 전부 넣지 않는다)
- 번들 안 도우미 실행 파일 목록(서명·검증 대상)
- 전달 폴더
