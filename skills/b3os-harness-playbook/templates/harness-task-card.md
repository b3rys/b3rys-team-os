# harness 작업 카드 템플릿 (TEAM-OS §10 필드)

harness로 돌리는 과제는 카드/지시에 아래를 명시한다.

```
제목: <과제>
owner: <팀원>
harness: off | limited | full        # 단순작업은 off. limited=주행 기본(2~3 시작, 보통 <=6, 필요시 8). full=완전자율 12(절대 16)
subagents/max_agents: N               # cap은 목표가 아니라 천장. OpenClaw 수동 spawn 명시 cap=6
budget: <토큰 상한, 시간 상한>        # 예: 각 ~50k, 전체 10분. manual runtime은 필수
scope: 조사 | 구현 | 테스트 | 문서    # 어디까지
verify: <검증 방법>                   # dedup + adversarial verify + (테스트/빌드/출처)
자격증명: 인증·시크릿이 얽힌 조사면 서브에이전트 프롬프트에 넣는다 → "인증 상태는 `login status` 류 명령이나 파일 존재·경로로만 판단하고 auth.json·.env·*secret*·*.key 의 내용은 cat·grep·출력하지 말 것. 값이 필요하면 `[ -s file ]`·`wc -c` 로 비었는지만." (전역 규칙은 서브에이전트에 자동 전파되지 않는다)
return_schema: <반환 JSON/필드>       # manual runtime은 필수
stop_rule: <중단 조건>                # manual runtime은 필수
실행: Workflow 툴 우선 (budget·schema 자동) / manual runtime은 max_agents·budget·stop_rule·return_schema 없으면 금지
게이트: 사전 결정트리 통과? (분해가능 AND 다른 실소스 AND 이득>비용 AND N·budget·verify 있음)
비용 알림: full·큰 fan-out이면 팀장에게 알림 + stop_rule (알림은 승인 대기가 아니다. 알리고 바로 시작. full 은 팀장이 완전자율로 정한 과제에서만). 2층 fan-out은 >8 또는 팀원2+ 총>=10이면 팀장에게 알림 + 예상토큰
```

## 적용 사례 (상황에 맞게 적용하고 그대로 따라 하지 않는다)
```
제목: <서비스> DB write 경로 전수 audit
owner: <팀원>
harness: limited · subagents: 4 · budget: ~50k/10분
scope: 조사(전수 수집)
verify: 모듈 union dedup + grep 교차대조 + 숨은 write 반증
실행: 인라인 Agent 4 (디렉토리 분담) → owner 종합
게이트: ✅ 분해가능(디렉토리별) · ✅ 다른 실소스(각 모듈) · ✅ 누락0 audit 목표
```
