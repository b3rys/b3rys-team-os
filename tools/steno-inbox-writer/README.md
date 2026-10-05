# steno-inbox-writer

`steno-send.sh`가 권한 없는 outbox에 둔 Steno 지원 텍스트 파일, 그림, zip 파일을 Steno의 `받은 파일` 폴더로 옮기는 macOS 전용 도우미다. zip은 풀지 않고 파일 그대로 옮긴다. 프로덕션 바이너리의 두 경로는 소스에 고정되어 있으며 실행 인자나 환경변수로 바꿀 수 없다.

파일 하나의 상한은 20MB다. 폴더와 링크는 받지 않으며, 대상 파일은 실행 비트 없이 `0600`으로 만든다.

```text
~/Library/Application Support/b3os/steno-outbox
→ ~/Documents/Steno/받은 파일
```

`install.sh`는 바이너리와 LaunchAgent plist를 설치하지만 `launchctl`로 등록하거나 실행하지 않는다. 설치 뒤에는 시스템 설정에서 설치된 바이너리에 문서 폴더 접근 권한을 부여하고 LaunchAgent를 별도로 등록한다.

## 시험

```bash
tools/steno-inbox-writer/test.sh
```

시험 빌드만 임시 outbox와 목적지 경로를 인자로 받는다. 실제 문서 폴더에는 쓰지 않는다.
