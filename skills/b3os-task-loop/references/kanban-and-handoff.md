# 칸반 카드·handoff 절차

정본은 team-collab `task` DB, 화면은 `/team` → Tasks. 칸반은 현황판이라 필드를 늘리지 않고 맥락은 description 에 둔다.

## 카드
- 필드는 제목(결과물 기준 한 줄) · 담당자(1명, 공동작업은 description) · 상태(계획/실행 중/완료) · description. blocked 는 컬럼 없이 description 첫 줄 `🚫 blocked: 이유` 로 표시하고 `재개 시각`·`fallback` 도 둔다.
- 작은 일(한 번의 행동으로 끝)은 `제목 / owner / 상태 / 다음 액션` 만. 여러 사람 handoff·배포·검증·재개가 있으면 SKILL.md 의 전체 블록을 쓴다.
- 완료 기준에는 코드 완료 / 배포 완료 / 실환경 확인 중 어느 gate 까지인지 적는다. 완료는 기준 충족 + `검증 증거` 가 있을 때만.
- 계획 = 팀장이 확인했으나 미착수. 챗방 논의 단계는 입력하지 않는다(팀장 확인 = 실행 시작, 그때 owner 가 입력).
- guard 가 읽는 필드(`재개 시각:` 등)는 줄 시작을 유지하고 `재개 시각: 2026-06-02 10:30 KST` 처럼 쓴다. 긴 설명은 `메모:` 에.
- 드랍은 카드 삭제. 감사가 필요하면 `dropped: 이유` 를 남기고 done 으로 옮긴 뒤 삭제 여부는 팀장 판단.

## 입력·갱신
- 대시보드: 컬럼의 "+ 과제 추가", 카드 펼쳐 description 편집, 담당자 드롭다운, ◀▶ 이동, ✕ 삭제.
- API: `POST /team/api/tasks {title, column, owner, description}` · `PATCH /team/api/tasks/:id` · `DELETE /team/api/tasks/:id`. column = plan|doing|done. PATCH 는 title·column·owner·description·sort_order·held·hold_reason·review_at 만 받고, 다른 키가 하나라도 있으면 아무것도 바꾸지 않고 400 `unsupported_fields`.
- 내 카드가 아니면 owner 의 카드를 임의로 바꾸지 않는다.

## 상태 질문
"진행중인 작업", "현재 상황", "열린 과제", "누가 하던 일" 은 기억으로 답하지 않고 `/team/api/tasks` 또는 `team.db task` 를 조회해 doing / plan / 최근 중요 done / 보류·대기 / 카드 밖 즉시완료 예외로 답한다.

## 주행모드와 continuation guard
- 턴모드(한 번 묻고 답) → 주행모드(실행 단계 기본, done·blocked·확인 대기까지 `다음 액션`·`재개 시각`·`fallback`·`stop_rule` 유지) → 완전자율모드(기획~보고까지 위임, 범위·권한·stop_rule 을 더 분명히).
- 종료·보고 전 확인: 남은 일이 있으면 `다음 액션`, 확인이 필요하면 누구에게 무엇을 물을지, 기다리면 `재개 시각`+`fallback`, 같은 실패·무응답 반복은 `stop_rule` 대로 요약 보고하고 멈춘다.
- `재개 시각` 이 지났거나 `다음 액션` 이 없는 실행 중 카드는 guard 스크립트가 owner 에게 버스 DM 을 보낸다. 평일 06:00 KST `task-review-ping` 이 owner 별 active 카드를 다시 보여 주고, 주말·공휴일엔 돌지 않는다. 정리할 게 없으면 억지로 고치거나 보고하지 않는다. 이미 완료됐거나 변화 없는 상태는 반복 ping 하지 않는다.

## Handoff
- owner 전환은 받은 쪽이 접수·다음 액션·ETA 중 하나를 남기기 전까지 끝나지 않는다(그때까지 이전 owner 가 추적).
- 메시지는 짧게: 팀원에게는 지시·완료 기준·근거만, 팀방에는 팀장에게 필요한 상태만. 카드/메시지에 현재상태, 다음 액션, 검증된 것/아직 안 된 것, 파일·링크, 다음 owner. 같은 본문을 bus DM 과 팀방에 복붙하지 않는다.
- 같은 과제의 새 지시는 기존 thread/`in_reply_to` 를 이어간다.

## 중복 방지
보내기 전에 같은 과제·수신자의 기존 handoff, 이어갈 thread, 동시에 도는 경로(cron·수동·OpenClaw injection 재시도)가 있는지 본다. 실패처럼 보여도 재전송 전에 `message` DB 와 audit log 를 먼저 조회한다. 재전송이 필요하면 `dedupe_key` 또는 `in_reply_to` 를 둔다. 중복이 의심되면 새 지시를 멈추고 하나의 경로만 남긴다.

## 피드백 요청
스킬·운영 원칙·UI·문서 피드백은 "실제로 쓴다고 생각하고 막히는 점, 빠진 점, 헷갈리는 점, 중복될 점" 으로 묻는다. 역할 관점은 보조 질문으로만 붙이고, 팀원마다 다른 역할 박스를 씌우지 않는다. 종합은 핵심만 뽑는다. 반복되는 교훈은 `rules/SHARED.md` 로 올린다.
