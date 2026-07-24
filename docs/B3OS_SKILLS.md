# b3rys 스킬 인덱스

> b3rys 팀 워크플로우 스킬 관리 인덱스 (starter, 2026-06-02). owner: maintainer.
> **이 파일 = 스킬 단일 정본 인덱스(읽기용)**. 코드가 로딩하는 게 아니라, 에이전트가 TEAM-OS §11 통해 이걸 읽어 "어떤 팀 스킬이 있나" 발견하는 카탈로그. 스킬 추가/이동/리네임 시 **여기만 갱신하면 전원이 새 정보 봄.**
> **정책**: 신규 팀 워크플로우 스킬 = `b3rys-<영역>-<기능>`.
> **상용 정본 위치 = `skills`** (런타임 중립, 제품이 싣는 것). 팀 스킬 대부분 셸/노드 스크립트라 claude·openclaw·hermes 어디서든 `scripts/*.sh|*.mjs` 직접 실행 가능. `~/.claude/skills` = claude 사용자 편의(있으면 참고, 없으면 skip).
> 외부 공개 시 ai-hackathon-skill 패턴처럼 팀 내부 state/시크릿 분리.

## b3rys-* (팀 워크플로우)
| 스킬 | 정본 위치 | 설명 |
|---|---|---|
| **b3os-bwf** | **skills** | **기본 과제 수행 워크플로우(b3os workflow) — 단일 진입점 stage router.** 과제 받으면 PM계획→팀배정→실행+품질방법→검증→보고+카드→학습hook. BWF≠harness(harness·multi-ai·judge·적대적리뷰는 BWF 안에서 고르는 품질방법). 얇은 오케스트레이터 — 하위 스킬 참조. rubric(`references/bwf-rubric.md`)+self-test(`scripts/bwf-selftest.sh`). 전 런타임. 팀 리뷰 7/7(2026-06-22) |
| b3os-report | **skills** | 팀 표준 보고서 — MD 소스 → 아이폰 반응형 HTML+SVG 렌더(자체완결). `scripts/render.sh`·`publish.sh`. "보고서 써줘" |
| b3os-slack-format | **skills** | 슬랙 메시지 포맷 — 팀원이 슬랙에 올리는 실행·검증·인수인계·보고를 Slack mrkdwn+운영보고 구조로 정리. `scripts/md-to-slack.py`(**→*·##→볼드·-→•·링크·코드보존). "슬랙 포맷/정리해서 올려". owner=maintainer |
| b3os-harness-playbook | **skills** | harness(sub agent 병렬) 플레이북 — **트리거 우선**("병렬 실소스 커버면 기본, 그 외 솔로") + ready-run 레시피(`templates/recipes.md`: audit·migration·N후보·release-verify) + 7품질패턴 + 런타임별(클로드 Workflow/openclaw 수동) + 비용게이트. §10 연계 (2026-06-14 #2 reframe) |
| **b3os-ai-code-safety** | **skills** | **AI 생성/수정 코드 안전 체크리스트 — SOLID + Effects.** 코딩 작업·리뷰·완료 전, 특히 상태 변경·외부 side effect·동시성·트랜잭션·멱등성·재시도·webhook/queue/payment 경로에서 race condition, partial write, duplicate execution, hidden coupling을 점검한다. |
| **b3os-infra-safety** | **skills** | **b3os 인프라 변경 안전 규칙.** fresh 격리 clone·런타임 상태(`agents.json`/`team.db`) 심링크 금지·백업 우선·테스트 FS 격리·릴리스/배포 가드·격리 검증을 강제한다. b3os 소스·config·registry·릴리스를 수정할 때 필독. owner=maintainer |
| b3os-team-inbox | **skills** | 팀 메시지 버스 도구(inbox·send·reply·ack·thread). `scripts/send.sh`·`scripts/reply.sh <message_id>`(답장 주소 자동: to=원발신자+in_reply_to+thread — 회신이 broadcast로 안 묻히게, V1.0 근본 fix)·`scripts/thread.sh <thread_id>`(위임 회신 추적 정본 — inbox는 directed unread만, thread.sh는 그 thread 전체) 등. 셸이라 전 런타임 사용 |
| b3os-telegram-file-delivery | skills | Telegram 파일 전송 정본 — `message`/첨부 도구가 막을 때 Bot API `sendDocument`로 HTML·PDF·이미지·ZIP·문서 등 원본 전송(확장자별 MIME). "파일이 안 보내져" 반복 이슈 해결 |
| **b3os-task-loop** | **skills** | **Tasks 칸반·주행모드·handoff·review-wait·scheduled workloop 통합 진입점.** 리뷰/응답/승인 대기 중 멈추지 않도록 `thread_id`·`recheck_at`·`fallback`·`next_safe_action`·`stop_rule`을 기록하고, `task-wait/check/close.sh`로 완료/blocked/승인대기까지 추적. |
| b3os-task-mgmt | skills | Deprecated compatibility stub — 신규 절차는 `b3os-task-loop` 사용. 기존 참조 호환용으로 유지. |
| b3os-workloop | skills | Deprecated compatibility stub — scheduled wake 처리도 `b3os-task-loop` 사용. 기존 참조 호환용으로 유지. |
| b3os-scheduler | skills | b3os durable 스케줄러 — 반복(cron 시·분·요일·월)·간격·1회성 리마인드 잡을 `team.db`(`scheduled_job`)에 durable 등록, 서버 워커가 시각 맞춰 인박스 wake. 잡별 휴일정책(run/skip/shift, KST 고정오프셋). 세션 cron(유실됨) 대신 팀 정본 반복작업·launchd 이관에. API=`src/server/scheduler/core.ts`(`createCronJob`·`scheduleReminder`). 라이브발사·launchd제거=GD/운영자 게이트 |
| **b3os-release-ops** | **skills** | **공개 정본 배포·PR 머지·핫픽스·force-push 안전 게이트.** `docs/DEPLOY_MERGE_HOTFIX_WORKFLOW.md` 정본 문서 + `scripts/release-preflight.sh` 기계적 가드(clean worktree·noreply author·branch protection·live repo 확인). 봇 자율머지 범위와 live deploy acceptance/rollback 보고 기준. |
| b3os-team-learning-loop | skills | 주간 self-learning — 팀 정책 자가발전, SHARED→TEAM-OS 승격, compacting, 프로젝트별 운영리뷰, 월간 개선지표 |
| b3os-team-member-lifecycle | skills | 팀원 온보딩/lifecycle |
| **b3os** | **skills** | b3os(팀 OS) **설치·세팅·운영** 스킬 — 공개 repo clone→install→대시보드→팀 기본정보 채팅 세팅→첫 팀원 영입(텔레그램)까지 몰아주고 handoff. **신규 사용자 설치용** + 팀원이 세팅·운영 질문("다음 팀원 어떻게 영입?") 받을 때 참조하는 **ops 레퍼런스**(`references/recruit.md`·`b3os-ops-primer.md`·`troubleshooting.md` = 온디맨드 운영 지식). "b3os 설치/세팅해줘" |

> 참고: 구 `team-inbox` 계열 이름은 일부 개인 런타임에 호환용으로 남아 있을 수 있습니다. 정본은 b3os-team-inbox(skills)입니다.

## 외부 스킬 (호환 — 출처 명시)
b3rys 팀이 함께 쓰는 외부(third-party) 스킬입니다. 팀 워크플로우 스킬과 별개이며 각자 라이선스를 따릅니다.

| 스킬 | 출처 / 라이선스 | 설명 |
|---|---|---|
| humanize-korean | epoko77-ai · MIT | AI가 쓴 한글 텍스트를 사람이 쓴 것처럼 윤문 — 탐지 → 윤문 → 검수 파이프라인 |
