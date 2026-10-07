# steno-helper (Steno 도우미)

문서 폴더 권한을 가진 macOS 프로그램은 이것 하나다. 한 번 돌 때 세 일을 차례로 한다.

```text
1. 받은 파일 넣기  ~/Library/Application Support/b3os/steno-outbox  →  ~/Documents/Steno/받은 파일
2. 팀 공유 올리기  ~/Library/Application Support/b3os/steno-share-outbox → <라이브러리>/팀 공유
3. 팀 공유 복사    <라이브러리>/팀 공유  →  ~/Library/Application Support/b3os/steno-shared   (라이브러리는 읽기만)
```

하나가 실패해도 다른 하나는 돈다. LaunchAgent `com.b3os.steno-helper` 가 outbox 변화 때와 30초마다 실행한다.

## 1. 받은 파일 넣기 (Sources/Inbox.swift)

`steno-send.sh --to-received` 가 권한 없는 outbox 에 둔 Steno 지원 텍스트 파일, 그림, zip 을 `받은 파일` 로 옮긴다.
- zip 은 풀지 않는다.
- 두 경로는 소스에 고정돼 있어 실행 인자나 환경으로 바꿀 수 없다.
- 파일 하나의 상한은 20MB 다. 폴더와 링크는 받지 않는다.
- 대상 파일은 실행 비트 없이 `0600` 으로 만들고, 같은 이름이 있으면 덮지 않고 " 2" 를 붙인다.

## 3. 팀 공유 복사 (Sources/Share.swift)

라이브러리는 Steno 앱과 같은 규칙으로 정한다: `STENO_LIBRARY` → `~/Documents/Steno`. 폴더 이름 `팀 공유` 는 고정이다.

- `팀 공유` 이름과 `.steno-folder` 내용 `team`이 맞아야 복사한다. 내용 양끝 공백·줄바꿈은 무시하며, iCloud 자리표시 파일도 표시가 있는 것으로 본다. 받은 파일 넣기 동작은 바꾸지 않는다.
- `팀 공유` 바로 아래 파일만 복사한다. 하위 폴더, 숨김 파일, `.steno` 사이드카, 링크, 20MB 초과, 이름에 secret·credential·token·password 가 든 파일은 건너뛴다.
- 라이브러리 쪽에는 아무것도 쓰거나 지우지 않는다.
- 못 읽은 원본에는 iCloud 내려받기를 한 번 요청하고 다음 주기에 다시 읽는다. 요청 여부는 manifest에 남겨 반복 요청하지 않는다.
- `steno-shared/.manifest.json` 에 파일마다 해시 두 개를 적는다. `base` 는 사본을 만들 때의 원본 해시, `source` 는 마지막으로 본 원본 해시다. 원본을 못 읽으면 `source` 를 `unreadable` 로 적는다.
- `.bases/<sha256>.data`에 합치기 기준 본문을 보존한다. 현재 manifest·반환 확인이 참조하지 않는 이전 기준은 동기화 완료 뒤 정리한다.
- 팀원이 고친 사본은 덮지 않는다. 읽지 못한 사본도 덮거나 지우지 않는다.
- `팀 공유` 에서 빠진 노트는 안 고친 사본만 지운다. 목록을 끝까지 못 읽으면 그 주기는 아무것도 지우지 않는다.
- manifest 키는 NFC 로 맞추고, 디스크 실제 이름은 `file` 칸에 둔다.

### 되돌려 넣기 (steno-share-return.py)

```bash
tools/steno-helper/steno-share-return.py AAA.md --as 빌
```

1. 도우미를 한 번 돌려(`launchctl kickstart`) manifest 를 새로 받은 뒤 사본을 읽는다. 사본이 기준 판 그대로면 아무것도 보내지 않는다.
2. 사본 본문과 기준 해시를 `steno-share-outbox`에 요청으로 넣는다. 출력은 요청 접수이며, 실제 반영은 다음 도우미 실행 때다.
3. 열린 노트는 `.steno/mcp-proposals` 요청과 분산 알림으로 앱 편집기에 넘기고 답을 기다린다. 다른 맥의 열린 기록이나 기록을 읽지 못한 경우도 같은 제안 길로 보낸다. PID·프로세스 시작 시각 검사는 기록의 `host`가 이 맥과 같을 때만 한다. 도우미는 열린 노트 파일을 쓰지 않는다. 편집기는 기준 판·현재 글·팀원 글을 줄 단위로 합쳐 한 번의 편집으로 넣는다.
4. 닫힌 노트도 같은 줄 합치기 규칙을 적용한다. 서로 다른 줄은 함께 살리고, 같은 위치의 순수 삽입은 사용자 줄 다음 팀원 줄로 남긴다. 겹쳐 고친 줄은 팀원 글을 쓴다. 원본이 CRLF 줄바꿈이면 결과도 CRLF로 쓴다. 결과가 현재 글과 같으면 백업·고침 표시를 남기지 않는다.
5. 앱 답이 `applied`면 완료, `notOpen`이면 닫힌 노트 길로 합친다. 무응답이면 같은 제안 번호와 요청을 보존하고 다음 30초 주기에 재확인한다. 최초 제안 후 5분 무응답·거절·저장 실패·원본 삭제 등 반영 실패는 `AAA (빌 수정).md` 사본 하나를 남기고 요청을 정리한다. 사본을 쓰지 못하거나 입력 안전 조건이 맞지 않으면 요청을 보존한다. 응답 대기 중 `.return-<id>.pending`에 최초 제안 시각과 열린 상태 기록을 보존하며, 완료되면 제안·응답·대기 기록을 함께 정리한다.
6. 원본을 고칠 때 이전 판은 `.steno/trash`에, 표시·파일 번호는 `.steno/ai-edits.json`에 남긴다. 성공한 반환은 제출한 본문 해시로 확인하여 다음 동기화의 기준을 갱신한다. 빈 글로 문서를 비우는 반환도 가능하다.

팀원은 문서 폴더에 직접 쓰거나 Steno MCP 를 실행하지 않는다. 받은 파일 넣기는 유지한다.

## 팀 공유에 새 파일 올리기

```bash
skills/b3os-team-inbox/scripts/steno-send.sh report.md
skills/b3os-team-inbox/scripts/steno-send.sh attachment.zip --to-received
```

기본 대상은 팀 공유 보낼 칸이다. 도우미는 이름과 표시(`.steno-folder`의 내용 `team`)가 맞는 팀 공유 폴더에만 넣는다. 받은 파일과 같은 크기·링크·권한 제한을 적용하고, 같은 이름이면 ` 2`를 붙여 기존 파일을 보존한다.

## 설치

```bash
tools/steno-helper/install.sh        # 라이브러리를 옮겨 썼다면 STENO_LIBRARY=/경로 를 앞에 붙인다
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.b3os.steno-helper.plist
```

설치 스크립트는 키체인에 유효한 `Developer ID Application: GUE DON JUNG (7NTC94U74E)` 서명 신원이 있으면 이를 사용하고, 없으면 임시(ad-hoc) 서명을 사용한다. 식별자는 두 경우 모두 `com.b3os.steno-helper`로 고정한다.

도우미가 처음 문서 폴더에 접근할 때 뜨는 허락 창에서 허용한다(사람 손). 임시 서명에서 Developer ID 서명으로 전환할 때도 새 허용이 필요할 수 있다. 임시 서명은 재빌드하면 다시 허락해야 할 수 있다. Developer ID로 서명했는지는 `codesign -dv --verbose=4 ~/Library/"Application Support"/b3os/bin/steno-helper`의 `Authority`와 `TeamIdentifier`로 확인한다.

### 예전 도우미 두 개에서 옮길 때

```bash
launchctl bootout gui/$(id -u)/com.b3os.steno-inbox-writer 2>/dev/null
launchctl bootout gui/$(id -u)/com.b3os.steno-share-sync 2>/dev/null
rm -f ~/Library/LaunchAgents/com.b3os.steno-inbox-writer.plist ~/Library/LaunchAgents/com.b3os.steno-share-sync.plist
```

바꾸는 사이 outbox 에 들어온 파일은 그대로 남았다가 새 도우미가 허락받은 뒤 옮긴다.

### 다른 팀(맥)에서 쓰려면

- 이 도우미가 들어간 b3os 버전
- 라이브러리에 시스템 폴더 표시와 열린 노트 기록을 쓰는 Steno 버전. MCP 설치는 팀원 경로에 필요하지 않다.
- Steno 라이브러리가 이 맥에 있을 것. 다른 맥에서 편집하면 iCloud 로 동기화된 같은 폴더여야 한다.
- 위 설치와 문서 폴더 허락 한 번
- AI 팀원이 이 맥의 같은 사용자 계정으로 돌 것

## 시험

```bash
STENO_MERGE_FIXTURES=/path/to/Steno/web/test/fixtures/team-share-merge.json tools/steno-helper/test.sh
```

한 번 빌드해서 받은 파일 시험(`test-inbox.sh`)과 팀 공유 시험(`test-share.sh`)을 둘 다 돌린다. 임시 폴더에서 실제 요청 스크립트와 도우미를 실행한다. 사용자 라이브러리는 쓰지 않는다.

공통 입력표는 Steno 저장소의 `web/test/fixtures/team-share-merge.json` 한 파일이다. 앱 테스트와 도우미 테스트가 이 파일을 읽는다. 경로를 주지 않은 도우미 실행은 동치 검사를 `SKIP`으로 표시하며 전체 공동편집 검증을 대신하지 않는다.
