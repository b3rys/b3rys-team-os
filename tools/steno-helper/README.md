# steno-helper (Steno 도우미)

팀 공유는 파일 공유와 보기용이다. 팀원이 고친 파일을 되돌려 넣으면 원본 대신 수정 사본을 만든다.

문서 폴더 권한을 가진 macOS 프로그램은 이것 하나다. 한 번 돌 때 세 일을 차례로 한다.

```text
1. 받은 파일 넣기  ~/Library/Application Support/b3os/steno-outbox  →  <라이브러리>/받은 파일
2. 팀 공유 올리기  ~/Library/Application Support/b3os/steno-share-outbox → <라이브러리>/팀 공유
3. 팀 공유 복사    <라이브러리>/팀 공유  →  ~/Library/Application Support/b3os/steno-shared   (라이브러리는 읽기만)
```

하나가 실패해도 다른 하나는 돈다. LaunchAgent `com.b3os.steno-helper` 가 outbox 변화 때와 30초마다 실행한다.

## 1. 받은 파일 넣기 (Sources/Inbox.swift)

`steno-send.sh --to-received` 가 권한 없는 outbox 에 둔 Steno 지원 텍스트 파일, 그림, zip 을 `받은 파일` 로 옮긴다.
- zip 은 풀지 않는다.
- outbox 와 `받은 파일` 폴더 이름은 고정이다. 실행 인자로 경로를 바꿀 수 없으며, 라이브러리는 아래 앱 기록·환경 변수 규칙으로 정한다.
- 파일 하나의 상한은 20MB 다. 폴더와 링크는 받지 않는다.
- 대상 파일은 실행 비트 없이 `0600` 으로 만들고, 같은 이름이 있으면 덮지 않고 " 2" 를 붙인다.

## 3. 팀 공유 복사 (Sources/Share.swift)

받은 파일·팀 공유 올리기·팀 공유 복사는 매 주기 `Sources/Library.swift`의 `resolveLibrary` 결과 하나를 함께 쓴다. 라이브러리 결정 순서는 다음과 같다.

1. `~/Library/Application Support/Steno/library-location.json`: Steno 앱이 시작할 때와 라이브러리를 고르거나 옮길 때 원자적으로 쓰는 JSON 기록(`Sources/Steno/Core/LibraryLocationRecord.swift`). `{"path": "<절대경로>", "bookmark": "<base64>"}`에서 `path`만 읽고 `bookmark`는 무시한다.
2. 기록이 없거나 무효면 `STENO_LIBRARY` 환경 변수. 사용자가 설치 때 명시한 경우에만 plist에 기록한다.
3. `~/Library/Mobile Documents/iCloud~com~b3rys~steno/Documents`: 앱 컨테이너 `iCloud.com.b3rys.steno`의 Documents이며, 앱 화면에서는 “iCloud Drive › Steno”로 보인다.
4. `~/Documents/Steno`.

Steno 앱은 `STENO_LIBRARY`로 띄운 경우에는 이 기록을 쓰지 않는다. 기록이 없으면 `STENO_LIBRARY` → iCloud 기본값 순으로 정한다.

경로는 1024바이트 이하 절대 경로이며 줄바꿈·NUL이 없어야 한다. 실제 디렉터리여야 하며 경로 자체와 상위 구성요소가 심링크 또는 비정규 경로이면 거절한다. 앱 기록도 상위 구성요소의 링크를 금지하고, 현재 사용자 소유의 일반 파일·단일 링크·64KB 이하인지 확인한다. JSON 파싱 실패나 문자열 `path` 누락도 무효다. 앱 기록이 없으면 조용히 다음 후보로 넘어간다. 그 밖에 후보가 사라졌거나 무효면 이유를 한 줄 기록하고 다음 후보로 넘어간다. 모든 후보가 무효면 파일을 옮기지 않고 실패한다. 폴더 이름 `받은 파일`과 `팀 공유`는 고정이다.

Mobile Documents는 macOS 개인정보 보호(TCC)로 접근이 막힐 수 있다. EPERM/EACCES도 무효 후보로 처리하며 “권한 없음 — 시스템 설정 › 개인정보 › 파일 및 폴더에서 steno-helper 허용 필요”를 기록한다.

- `팀 공유` 이름과 `.steno-folder` 내용 `team`이 맞아야 복사한다. 내용 양끝 공백·줄바꿈은 무시하며, iCloud 자리표시 파일도 표시가 있는 것으로 본다. 받은 파일 넣기 동작은 바꾸지 않는다.
- `팀 공유` 아래 파일을 하위 폴더 두 단계(`팀 공유/A/B`, 앱 라이브러리 폴더 깊이 3 과 같다)까지 같은 폴더 구조로 복사한다. 더 깊은 폴더, 숨김 파일·폴더, `.steno` 사이드카, 링크(파일·폴더), 20MB 초과, 이름에 secret·credential·token·password 가 든 파일·폴더는 건너뛴다. 하위 폴더 목록을 하나라도 끝까지 못 읽으면 그 주기는 아무것도 지우지 않는다. 사본을 지워 빈 하위 폴더는 정리한다.
- 라이브러리 쪽에는 아무것도 쓰거나 지우지 않는다.
- 못 읽은 원본에는 iCloud 내려받기를 한 번 요청하고 다음 주기에 다시 읽는다. 요청 여부는 manifest에 남겨 반복 요청하지 않는다.
- `steno-shared/.manifest.json` 에 파일마다 해시 두 개를 적는다. `base` 는 사본을 만들 때의 원본 해시, `source` 는 마지막으로 본 원본 해시다. 원본을 못 읽으면 `source` 를 `unreadable` 로 적는다.
- `.bases/<sha256>.data`에 사본 기준 본문을 보존한다. 현재 manifest·반환 확인이 참조하지 않는 이전 기준은 동기화 완료 뒤 정리한다.
- 팀원이 고친 사본은 덮지 않는다. 읽지 못한 사본도 덮거나 지우지 않는다.
- `팀 공유` 에서 빠진 노트는 안 고친 사본만 지운다. 목록을 끝까지 못 읽으면 그 주기는 아무것도 지우지 않는다.
- manifest 키는 NFC 로 맞추고, 디스크 실제 이름은 `file` 칸에 둔다.

### 되돌려 넣기 (steno-share-return.py)

```bash
tools/steno-helper/steno-share-return.py AAA.md --as 빌
tools/steno-helper/steno-share-return.py 발표/AAA.md --as 빌   # 하위 폴더의 노트 — 수정 사본도 같은 폴더에 만든다
```

1. 도우미를 한 번 돌려(`launchctl kickstart`) manifest 를 새로 받은 뒤 사본을 읽는다. 사본이 기준 판 그대로면 아무것도 보내지 않는다.
2. 사본 본문과 파일명·팀원명·본문 해시를 `steno-share-outbox`에 요청으로 넣는다. 출력은 요청 접수이며, 실제 반영은 다음 도우미 실행 때다.
3. 도우미는 언제나 `AAA (빌 수정).md` 새 사본 하나를 만든다. 같은 이름이 있으면 `AAA (빌 수정) 2.md`처럼 번호를 붙인다. 원본이 열려 있거나 닫혀 있거나 iCloud에서 내용이 아직 내려오지 않았어도 원본을 읽거나 바꾸지 않는다.
4. 앱에 편집을 제안하지 않는다. 열린 노트 기록, 응답 대기, 줄 합치기, AI 편집 표시, 원본 백업을 사용하지 않는다. 새 사본을 만든 뒤 요청과 본문을 정리한다. 사본을 쓰지 못하거나 입력 안전 조건이 맞지 않으면 요청을 보존한다.
5. 빈 글도 빈 수정 사본으로 전달한다. 기존 버전이 남긴 기준 본문은 입력 검증과 정리만 하고 병합에 쓰지 않는다.

팀원은 문서 폴더에 직접 쓰거나 Steno MCP 를 실행하지 않는다. 받은 파일 넣기는 유지한다.

## 팀 공유에 새 파일 올리기

```bash
skills/b3os-team-inbox/scripts/steno-send.sh report.md
skills/b3os-team-inbox/scripts/steno-send.sh attachment.zip --to-received
skills/b3os-team-inbox/scripts/steno-send.sh report.html --folder "발표"          # 팀 공유/발표/report.html
skills/b3os-team-inbox/scripts/steno-send.sh report.html --to-received --folder "발표/초안"
```

`--folder` 는 `A` 또는 `A/B`(두 단계까지)다. 없는 폴더는 도우미가 만든다. 점으로 시작하는 이름, 비밀값이 들어갈 수 있는 이름, 세 단계 이상은 보내는 쪽과 도우미 양쪽에서 거절한다.

기본 대상은 팀 공유 보낼 칸이다. 도우미는 이름과 표시(`.steno-folder`의 내용 `team`)가 맞는 팀 공유 폴더에만 넣는다. 받은 파일과 같은 크기·링크·권한 제한을 적용하고, 같은 이름이면 ` 2`를 붙여 기존 파일을 보존한다.

## 같은 자리에서 고쳐 보내기·치우기

```bash
skills/b3os-team-inbox/scripts/steno-send.sh report.md --folder bill --name report.md --replace         # 팀 공유/bill/report.md 를 새 내용으로
skills/b3os-team-inbox/scripts/steno-send.sh note.md --to-received --name note.md --replace             # 받은 파일/note.md 를 새 내용으로
skills/b3os-team-inbox/scripts/steno-send.sh --remove "bill/report 2.md"                                # 팀 공유/bill/report 2.md 를 치운다
```

- 팀 공유·받은 파일 안이면 누가 만든 파일이든 바꾼다(팀장 결정 10-24). 팀원은 모두 같은 macOS 사용자라 도우미가 요청자를 구분하지 않는다.
- 사람 노트를 고칠 때는 내가 쓴 부분 앞뒤에 보이는 이름 표시를 넣는다: `✦빌 ▼` … `✦빌 ▲`. 관례이고 도우미가 검사하지 않는다.
- 바꾸거나 치우기 전 본문은 팀 폴더 `steno-shared/.replaced/<sha256>.data` 에 남긴다. 남기지 못하면 바꾸지 않는다. 같은 이름 보관본이 있으면 내용까지 맞는지 보고, 다르면 진짜 본문으로 다시 쓴 뒤 진행한다.
- 새 본문은 임시 이름에 다 쓴 뒤 rename 으로 한 번에 바꾼다. 없는 파일은 새로 만들지 않는다. 본문 해시가 요청과 다르면 바꾸지 않는다.
- 보관과 바꾸기 사이(보통 1초 안)에 누가 같은 파일을 저장하면 그 저장은 보관되지 않고 덮인다. 단순함을 위해 막지 않는다(팀장 결정 10-24).
- 경로 오류·대상 없음 요청은 로그만 남기고 치운다. 지금 못 읽는 파일(내려받기 전)·못 여는 폴더(권한·입출력 오류)는 요청을 남기고 다음 주기에 다시 본다.
- 결과는 `~/Library/Logs/b3os-steno-helper.log` 의 `바꾸기:` 줄로 확인한다.

## 설치

```bash
tools/steno-helper/install.sh        # 선택 사항: STENO_LIBRARY=/경로 를 명시하면 앱 기록 다음 후보로 저장한다
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.b3os.steno-helper.plist
```

STENO_LIBRARY를 명시하지 않으면 plist에 그 키를 넣지 않는다. 기본 경로를 고정하지 않아 앱의 라이브러리 위치 변경을 다음 주기에 따라간다.

설치 스크립트는 키체인에 유효한 `Developer ID Application: GUE DON JUNG (7NTC94U74E)` 서명 신원이 있으면 이를 사용하고, 없으면 임시(ad-hoc) 서명을 사용한다. 식별자는 두 경우 모두 `com.b3os.steno-helper`로 고정한다.

도우미가 처음 라이브러리에 접근할 때 뜨는 허락 창에서 허용한다(사람 손). iCloud 라이브러리(기본)면 iCloud Drive 파일 접근, `~/Documents/Steno` 면 문서 폴더 접근이다. 임시 서명에서 Developer ID 서명으로 전환할 때도 새 허용이 필요할 수 있다. 임시 서명은 재빌드하면 다시 허락해야 할 수 있다. Developer ID로 서명했는지는 `codesign -dv --verbose=4 ~/Library/"Application Support"/b3os/bin/steno-helper`의 `Authority`와 `TeamIdentifier`로 확인한다.

### 예전 도우미 두 개에서 옮길 때

```bash
launchctl bootout gui/$(id -u)/com.b3os.steno-inbox-writer 2>/dev/null
launchctl bootout gui/$(id -u)/com.b3os.steno-share-sync 2>/dev/null
rm -f ~/Library/LaunchAgents/com.b3os.steno-inbox-writer.plist ~/Library/LaunchAgents/com.b3os.steno-share-sync.plist
```

바꾸는 사이 outbox 에 들어온 파일은 그대로 남았다가 새 도우미가 허락받은 뒤 옮긴다.

### 다른 팀(맥)에서 쓰려면

- 이 도우미가 들어간 b3os 버전
- 라이브러리에 시스템 폴더 표시를 쓰는 Steno 버전. MCP 설치는 팀원 경로에 필요하지 않다.
- Steno 라이브러리가 이 맥에 있을 것. 다른 맥에서 편집하면 iCloud 로 동기화된 같은 폴더여야 한다.
- 위 설치와 문서 폴더 허락 한 번
- AI 팀원이 이 맥의 같은 사용자 계정으로 돌 것

## 시험

```bash
tools/steno-helper/test.sh
```

한 번 빌드해서 받은 파일 시험(`test-inbox.sh`)과 팀 공유 시험(`test-share.sh`)을 둘 다 돌린다. 임시 폴더에서 실제 요청 스크립트와 도우미를 실행한다. 사용자 라이브러리는 쓰지 않는다. 기존 팀 공유 시험에서 앱 JSON 기록 우선·다음 주기 이동 반영·사라진 환경 변수 폴더의 iCloud 대체·문서 기본값·깨진 JSON·상대 경로·심링크·접근 거부를 검사하고, 각 라이브러리로 받은 파일·팀 공유 올리기·복사가 함께 동작하는지 확인한다.

되돌리기 시험은 원본 불변, 수정 사본 하나, 이름 충돌, 입력 검증과 요청 정리를 확인한다.
