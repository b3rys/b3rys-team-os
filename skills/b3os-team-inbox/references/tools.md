# 보조 도구

## cogs 메시지 리액션 (`react.sh`)
```bash
scripts/react.sh --msg <받은 cogs 메시지의 버스 id> --emoji 👍
scripts/react.sh --msg <id> --emoji ""            # 지우기
scripts/react.sh --msg <id> --emoji 👍 --no-reply  # 리액션만 하고 글 답 없이 끝낼 때
```
- 내 봇으로, 내가 받은 cogs 메시지에만 붙는다. 이모지는 하나이고 다시 부르면 바뀐다.
- 리액션은 답을 대신하지 않는다. 답할 일이면 답한다.
- 글 답 없이 끝낼 때 `--no-reply` 를 안 붙이면 팀장 앱에 "입력 중"이 4분 남았다가 "응답 시간이 초과되었어요"가 뜬다. 이미 답했으면 붙여도 무방하다.

## 팀버스 맥락 조회 (`bus-recall.sh`)
1:1 세션에서 팀버스 맥락이 필요할 때 쓴다(1:1 방과 팀버스는 다른 세션). team.db 를 read-only 로 조회하니 SQL 을 직접 치지 말고 이걸 먼저 쓴다.
```bash
scripts/bus-recall.sh                    # 내가 최근 관여한 버스 맥락 + 내 GD 1:1
scripts/bus-recall.sh --about "맛집"      # 특정 주제
scripts/bus-recall.sh --with devon        # 나와 devon 사이
scripts/bus-recall.sh --from-gd devon     # GD가 devon에게 최근 뭐 시켰나
scripts/bus-recall.sh --me ames --with bill   # hermes/openclaw 는 --me 명시
```
옵션: `--limit N`(기본 8) · `--days N`(기본 7, 0=전체).

## Steno 로 파일 보내기 (`steno-send.sh`)
```bash
scripts/steno-send.sh <파일> [--name <이름>]
```
Steno 지원 텍스트 파일·그림·zip(20MB 이하)을 전용 outbox 에 넣으면 권한이 분리된 도우미(`steno-helper` LaunchAgent)가 팀장 Steno 의 "받은 파일/"로 옮긴다. zip 은 풀지 않는다. 기본은 쌓기만 한다(같은 이름이면 " 2").
- 이미 있는 파일을 고칠 때는 새로 보내지 않고 `--replace`(팀 공유 기본, 받은 파일은 `--to-received`)를 쓴다. 치울 때는 `--remove <경로>`.
- 바뀌기 전 판은 도우미가 `steno-shared/.replaced/` 에 남긴다.
- 팀장 노트를 고칠 때는 내가 쓴 부분 앞뒤에 `✦<내 이름> ▼` … `✦<내 이름> ▲` 를 넣는다.

## 응답가드 자가등록 (`expect-report.sh`)
작업이 길어져 팀장 보고를 잊을 것 같으면 1회성 리마인더를 건다(런타임 무관, 같은 명령).
```bash
scripts/expect-report.sh --thread <지금 작업 thread>          # 10분 뒤 1회 재알림
scripts/expect-report.sh --thread <t> --in 30m                # 기한 지정
scripts/expect-report.sh --thread <t> --cancel                # 보고 마쳤으면 정리
```
- openclaw·hermes_agent: 서버가 기한 안의 보고(버스/`--direct-to-gd`)를 확인하고, 보이면 알림을 내지 않는다.
- claude·codex: 팀장 1:1 보고가 서버에 안 보이므로 팀 스케줄러에 나를 깨우는 리마인더를 건다(응답 `"via":"scheduler_reminder"`). 깨어나면 보고했는지 보고 판단하고, 마쳤으면 `--cancel`. 같은 thread 로 다시 걸면 앞의 것을 바꾼다.
