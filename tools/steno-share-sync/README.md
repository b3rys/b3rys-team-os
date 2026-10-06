# steno-share-sync

Steno 라이브러리의 `팀 공유` 폴더 노트를 AI 팀원이 읽고 고칠 수 있게 하는 macOS 전용 도우미다. 두 부분으로 되어 있다.

```text
복사:      <라이브러리>/팀 공유/*  →  ~/Library/Application Support/b3os/steno-shared/   (steno-share-sync, 30초마다)
되돌려 넣기: steno-shared/<파일>   →  steno-mcp edit_note 또는 create_note              (steno-share-return.py)
```

라이브러리는 Steno 앱과 같은 규칙으로 정한다: `STENO_LIBRARY` → `~/Documents/Steno`. 폴더 이름 `팀 공유` 는 고정이다.

## 복사 (steno-share-sync)

- `팀 공유` 바로 아래 파일만 복사한다. 하위 폴더, 숨김 파일, `.steno` 사이드카(댓글·꾸밈), 링크, 20MB 초과, 이름에 secret·credential·token·password 가 든 파일은 건너뛴다.
- 라이브러리 쪽에는 아무것도 쓰거나 지우지 않는다. 문서 폴더 권한은 읽기에만 쓴다.
- `steno-shared/.manifest.json` 에 파일마다 두 해시를 적는다. `base` 는 사본을 만들 때의 원본 해시이고, `source` 는 마지막으로 본 원본 해시다.
- 팀원이 사본을 고쳤으면(사본 해시 ≠ base) 원본이 바뀌어도 사본을 덮지 않는다.
- `팀 공유` 에서 빠진 노트는 안 고친 사본만 지운다. 목록에는 있지만 읽지 못한 파일(iCloud 에서 아직 안 받은 파일 등)은 빠진 것으로 보지 않고, manifest 의 source 를 `unreadable` 로 적는다. 목록을 끝까지 못 읽으면 그 주기는 아무것도 지우지 않는다.
- 사본을 읽지 못하면(권한·크기) 덮지도 지우지도 않는다.
- manifest 키는 NFC 로 맞추고, 디스크의 실제 이름은 `file` 칸에 둔다.

## 되돌려 넣기 (steno-share-return.py)

```bash
tools/steno-share-sync/steno-share-return.py AAA.md --as 빌
```

1. 도우미를 한 번 돌려(`launchctl kickstart`) manifest 를 새로 받는다.
2. `base == source` 이면, 즉 사본을 만든 뒤 원본이 그대로이면 `edit_note` 로 원본 자리에 쓴다. Steno 가 "빌이 고침 ✦" 표시와 ⌘⌥Z 되돌리기를 붙인다.
3. `edit_note` 에는 `expected_sha256`(base)을 함께 보낸다. 그사이 원본이 바뀌었으면 Steno 가 거절하고, 거절되면 4번으로 간다. 먼저 `tools/list` 에서 edit_note 가 이 인자를 아는지 보고, 모르는 Steno 면(모르는 인자는 조용히 무시된다) edit_note 를 부르지 않고 4번으로 간다.
4. 원본이 바뀌었거나, 지금 원본을 읽지 못했거나(manifest source = `unreadable`), manifest 를 새로 받지 못했으면 덮지 않는다. 대신 `create_note` 로 `팀 공유/AAA (빌 수정).md` 를 만든다. 같은 이름이 있으면 Steno 가 " 2" 를 붙인다. 1단계에서 따로 만들기는 md·html 만 된다. 다른 형식은 거절하고 아무것도 쓰지 않는다.

쓰기는 전부 steno-mcp 가 한다. steno-mcp 위치는 기본 `/Applications/Steno.app/Contents/MacOS/steno-mcp` 이고, `STENO_MCP` 로 바꿀 수 있다. Steno 설정의 AI 편집 범위가 `팀 공유` 를 허용해야 한다.

## 설치

```bash
tools/steno-share-sync/install.sh          # 라이브러리를 옮겨 썼다면 STENO_LIBRARY=/경로 를 앞에 붙인다
```

`install.sh` 는 바이너리와 LaunchAgent plist 를 설치하지만 등록하거나 실행하지 않는다. 설치 뒤 사람이 할 일은 둘이다.

1. `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.b3os.steno-share-sync.plist`
2. 도우미가 처음 문서 폴더에 접근할 때 뜨는 허락 창에서 허용한다. "파일 및 폴더" 목록에는 직접 추가하는 단추가 없어서 이 창으로만 들어간다. 바이너리를 다시 빌드하면 서명이 바뀌어 다시 허락해야 한다. 허락 전에는 로그에 "팀 공유 폴더 열기 실패(errno 1…)" 가 남는다.

### 다른 팀(맥)에서 쓰려면

- 이 도우미가 들어간 b3os 버전
- steno-mcp 가 든 Steno 버전이 이 맥의 `/Applications` 에 설치돼 있을 것. 앱을 띄워 둘 필요는 없지만, 창에 열린 노트를 고칠 때는 앱이 떠 있어야 한다.
- Steno 설정의 AI 편집 범위가 `팀 공유` 를 허용할 것
- Steno 라이브러리가 이 맥에 있을 것. 다른 맥에서 편집하면 iCloud 로 동기화된 같은 폴더여야 한다.
- 위 설치 1·2 (문서 폴더 권한은 사람 손으로 한 번)
- AI 팀원이 이 맥의 같은 사용자 계정으로 돌 것. 다른 계정이면 `steno-shared` 권한을 따로 맞춰야 한다.

## 시험

```bash
tools/steno-share-sync/test.sh
```

임시 폴더와 가짜 steno-mcp 만 쓴다. 실제 문서 폴더와 Steno 에는 쓰지 않는다.
