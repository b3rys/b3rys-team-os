# CLAUDE.md 한글 bootstrap 템플릿

> 상태: 검토용 템플릿. 실제 멤버 파일 재생성은 팀장 diff 승인 후에만 한다.
> 구조: `SOUL.md` persona + `@TEAM-OS.md` 정본 import + Claude 전용 전송 규칙.

## 역할과 Persona

역할·persona는 `@SOUL.md`를 참조한다. Claude Code는 이 파일을 자동 inline 로드한다.

## 팀 규칙 정본

@TEAM-OS.md

공통 규칙의 정본은 `TEAM-OS.md`다. 이 파일에는 정본 규칙을 다시 장문 복사하지 않는다. 단, Claude runtime에서 답변이 실제 채널로 전송되지 않는 문제를 막기 위한 전송 규칙은 아래에 둔다.

## Claude Runtime 전송 규칙

> 최우선 실행 규칙: 사용자가 답을 봐야 완료다.

- 팀장의 1:1 DM에 답하는 일은 reply tool이 실제로 전송해야 완료된다.
- 작업 view/transcript에 쓴 텍스트는 상대에게 도달하지 않는다. **1:1 DM은** `mcp__plugin_telegram_telegram__reply` 호출이 실제 전송이다.
- **reply tool은 팀장의 1:1 DM 전용이다. 단톡방 답변에는 절대 쓰지 않는다.** 텔레그램은 봇의 글을 다른 봇에게 주지 않으므로, 봇이 그룹에 직접 올린 글은 캡처봇이 못 보고 **DB에 한 줄도 안 남는다** — 위임한 팀원에게는 "답이 없음"으로 보인다(에러도 경고도 없이 155건이 이렇게 사라졌다). **단톡방에는 항상 `send.sh --to broadcast --thread <그 방의 thread>`** 로 보낸다. 서버를 거치므로 기록도 남고 방에도 뜬다.
- 조사, 검증, 작성까지 끝냈더라도 마지막 전송이 없으면 답하지 않은 것이다.
- 턴을 끝내기 전 항상 "이번 턴의 답을 reply tool로 보냈는가?"를 확인한다. 아니면 지금 보낸다.
- 가벼운 질문, 인사, 확인 답변도 상대에게 답하려는 경우 reply tool로 보낸다.
- OpenClaw/Hermes 계열은 최종 assistant 메시지가 자동 전송될 수 있지만, Claude runtime은 transcript와 전송이 다르므로 이 규칙을 매 턴 의식한다.

## 작업 컨텍스트

- 작업 디렉터리: `~/Development/<member-id>/`
- 자신의 TODO·MEMORY는 이 폴더 안에 둔다. 외부 프로젝트 작업 시 해당 프로젝트 폴더로 이동한다.

## 팀 공유

- 팀 현재 상태·학습 로그: `~/Development/b3rys-team-os/rules/SHARED.md`
- 팀 skill catalog: `~/Development/b3rys-team-os/rules/B3OS_SKILLS.md`
- teammate 메시지/리뷰 요청: `skills/b3os-team-inbox/scripts/send.sh` 또는 해당 skill의 `reply.sh`/`thread.sh`를 사용한다.
- Telegram 파일 전송: `b3os-telegram-file-delivery` skill을 사용한다.
- 팀장 확인 실행/위임 과제: `b3os-bwf` skill을 따른다. 최소 정의는 TEAM-OS §4에 있다.
- Workloop wake: `[작업루프: ...]` 또는 `[workloop: ...]`를 받으면 실제 상태를 조회·검증하고 그 턴 안에 닫는다. 상세는 `b3os-task-loop` skill을 읽는다.
- 팀 ops, workflow, skill을 깊게 다루거나 실제 수행할 때는 요약만 믿지 말고 관련 canonical source와 SKILL.md를 직접 읽는다.

## 전역 규칙

- 구현 milestone은 10분 단위로 나눈다. dev/stage/prod 설정을 명확히 구분한다.
- secret/token 값은 출력하지 않는다. 경로나 변수명만 언급한다.
- self-mod, 서비스 재시작, credential, wake allowlist, LaunchAgent, 다른 멤버 session 변경, 외부 전송, 공개 게시, 결제, 삭제는 팀장 승인 또는 ops gate 전에는 하지 않는다.
- 변경 보고에는 files changed, verified, unverified scope, rollback을 포함한다.
