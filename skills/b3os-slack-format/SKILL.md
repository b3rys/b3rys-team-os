---
name: b3os-slack-format
description: "b3rys 팀 슬랙 메시지 포맷 스킬. 팀원이 Slack(팀 메신저)에 올리는 실행·검증·인수인계·보고 메시지를 '읽히는 운영 보고'로 정리한다(Slack mrkdwn + 구조 템플릿). 사용 시점 — 슬랙에 길거나 단계 있는 메시지 게시 전, '슬랙 포맷/정리해서 올려', 'slack 메시지 다듬어', 인수테스트·체크리스트·핸드오프를 슬랙에 올릴 때. owner=maintainer."
---

# b3os-slack-format — 슬랙 메시지 포맷

## 언제 작동? (트리거 규율)
- 슬랙에 **길거나 단계가 있는** 메시지(실행 절차·검증·인수인계·보고·체크리스트)를 올리기 직전.
- "슬랙 포맷 해줘 / 정리해서 슬랙에 / slack 메시지 다듬어".
- 단발 한 줄 채팅·텔레그램은 대상 아님(슬랙 게시물 전용). 보고서는 `b3os-report`, 슬라이드는 `b3rys-make-ppt`.

## 왜? (the team lead 2026-06-25)
팀원이 슬랙에 평문(plain text)으로 길게 올리면 읽기 나쁘다. 슬랙은 마크다운과 문법이 달라서 `**볼드**`·`## 헤더`가 그대로 노출된다. 이 스킬로 **Slack mrkdwn + 운영 보고 구조**를 입혀 일관되게 읽히게 한다.

## Slack mrkdwn 핵심 (마크다운과 다름 — 꼭 기억)
- **볼드** = `*text*` (별 1개. `**text**` 아님)
- 이탤릭 = `_text_` · 취소선 = `~text~`
- **헤더(`#`,`##`) 없음** → `*볼드 줄*` 로 섹션 제목
- 불릿 = `•` (`-`/`*` 를 `•` 로)
- 링크 = `<url|텍스트>` (`[텍스트](url)` 아님)
- 코드 `` `x` `` / 코드블록 ```` ```x``` ```` 은 그대로
- 줄바꿈은 실제 개행(`\n`). 섹션 사이 빈 줄로 숨 쉬게.

## 일반 메시지 포맷 (briefing agent 스타일 — 읽기 좋은 기본)
briefing-agent 스타일처럼 가볍고 읽히는 일반 메시지 패턴. Block Kit 컬러바 없이 mrkdwn만으로 충분히 깔끔:
- `*제목*` (또는 `*01. 섹션*`) — 볼드 헤더로 구분
- `> 핵심 한 줄` — 인용 블록(슬랙이 왼쪽 세로 바로 강조 — briefing agent의 그 바 느낌)
- `• 불릿` — 핵심만 짧게
- `*라벨:* 내용` — 'the team lead 관점:' 같은 볼드 라벨 + 설명
- `` `용어`/`명령` `` — 인라인 코드(주황 하이라이트)
- 섹션 사이 빈 줄로 숨 쉬게
→ md-to-slack.py 가 `##`→`*볼드*`, `>` 유지, `-`→`•`, `**`→`*`, 코드 보존을 전부 처리하므로 마크다운으로 쓰고 변환만 하면 이 모양이 나온다.
(briefing agent의 섹션별 컬러 세로바·"자세히 표시" 접기는 Slack **Block Kit/attachment(color)** 가 필요 — 리치 버전은 별도 옵션. 일반 메시지엔 위 mrkdwn `>`·볼드로 충분.)

## 운영 보고 구조 (길거나 단계 있는 메시지)
단순 "예쁘게"가 아니라 **검증 가능한 형태**로. 권장 골격:
```
*[제목]* — 무엇을 하는지 1줄
*목적:* 왜 하는지 1~2줄
*절차:*
• 1단계 …
• 2단계 …
*통과 기준:* 무엇이면 OK
*실패 시:* 단계·증상·다음 액션
*owner:* 담당자  ·  *ETA:* 예상 완료  ·  *근거:* evidence(있으면)
```
- 단계는 번호/불릿으로 끊어 한 줄씩. 코드·명령은 코드블록.
- 짧은 메시지는 골격 강요하지 말고 mrkdwn(볼드·불릿)만 입혀도 됨.

## 사용법 (다듬기 → 변환 → 게시)
0) **humanize 최종 패스(기본)**: 길거나 공유·게시용 본문은 슬랙 게시 전에 `humanize` 스킬로 자연스러운 한국어로 다듬는다(team-os 기본 품질 게이트 — docs·reports·slack 공통). 단 **긴급·짧은 ack·기계 출력·로그 원문은 예외**. (humanize는 산문을 다듬으므로 *아래 mrkdwn 변환 전*에 돌린다. humanize-korean = 카탈로그 등록 dependency, MIT, 원저자 epoko77-ai — 우리 원본 아님.)
1) 마크다운/평문으로 내용 작성(+0의 humanize 결과) → 변환:
```
python3 skills/b3os-slack-format/scripts/md-to-slack.py <input.md>     # 또는 stdin
```
   (`**볼드**`→`*볼드*`, `##헤더`→`*헤더*`, `-불릿`→`•`, `[텍스트](url)`→`<url|텍스트>`, 코드/코드블록 보존)
2) 변환 결과를 슬랙에 게시:
```
curl -s -X POST http://127.0.0.1:7878/team/api/slack/post \
  -H "Content-Type: application/json" \
  -d "$(python3 -c 'import json,sys;print(json.dumps({"agent_id":"<나>","channel":"<채널>","text":sys.stdin.read()}))' < slack.txt)"
```
   (스레드 댓글이면 body 에 `"thread_ts":"<부모 ts>"` 추가)

## 예시 (examples/) + 회귀 테스트
실전 예시 3종 — 그대로 참고하거나 md-to-slack 입력으로:
- `examples/01-execution-report.md` — 실행/배포 보고
- `examples/02-handoff.md` — 핸드오프(인수인계)
- `examples/03-short-notice.md` — 짧은 공지
포맷: `*제목 1줄*` + 빈 줄 + `> 핵심 인용` + `• 불릿` + `*볼드*` + 끝에 owner·상태.
각 예시의 변환 결과는 `tests/<name>.expected.txt`. `bash tests/run-tests.sh` 로 변환 회귀 검증(추가법은 run-tests.sh 주석).

## 완료 기준
- 게시된 슬랙 메시지에 `**`·`##`·`[..](..)` 같은 날(raw) 마크다운이 안 보이고, 섹션·불릿·코드가 슬랙에서 제대로 렌더된다.
- 길거나 단계 있는 메시지는 제목·목적·절차·통과기준이 한눈에 들어온다.

## 비고
- self-contained(외부 repo 의존 없음). 전 런타임(Claude/OpenClaw/Hermes)에서 스크립트 직접 실행.
- 슬랙 활성 봇만 게시 가능(예: maintainer·agent-a·agent-b). Block Kit(리치 레이아웃)이 필요하면 별도 확장.
