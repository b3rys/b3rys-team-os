# 룰 압축 draft (latest-main 기준)

## 자수

| 대상 | before | draft | 감소 |
|---|---:|---:|---:|
| `CORE_RULE_COMPACT` 렌더 | 7,259자 / 33줄 | 5,867자 / 32줄 | 1,392자 (19.2%) |
| `TEAM-OS.md` | 11,694자 | 9,573자 | 2,121자 (18.1%) |

최신 main `0615047`에서 새 branch/worktree로 시작했다. 이전 낡은-base draft `d43e19d`는 사용하지 않으며 이 branch에 포함하지 않았다.

## 보존

- DO-NOT-COMPACT: speaking, owner, safety/security/external-send/self-mod, `SECTION_CORE_RULE`, rule-change review·behavior verification
- verbatim/하네스 고정: to-speak, kind 5종 routing, `--direct-to-owner` 금지, external-send 정의, collection 대기·마감·요청별 식별·배송처·late follow-up gate
- TEAM-OS와 `TEAM-OS.template.md` 동기화

## 행동이 바뀔 수 있는 지점

1. 기본 실행의 설명·예시를 기호형 문장으로 줄여 open-ended/clear 경계 해석이 달라질 수 있다.
2. collection의 이유 설명을 줄여 짧은 모델이 origin routing 또는 재팬아웃 금지를 덜 따를 수 있다. 고정 문구와 구조 테스트는 유지했다.
3. member function-call 규율에서 반복 설명을 없애 terminal 답에 불필요한 ack가 재발할 수 있다.
4. TEAM-OS owner 설명의 예시를 제거해 다중 mention에서 대표 1명만 답하는 오해가 생길 수 있다. `each answers`는 유지했다.
5. 외부 전송 사고 사례를 제거해 안전 우선 모델이 내부 bus도 승인 대상으로 다시 넓힐 수 있다. 정의와 no-approval 결론은 유지했다.

## Gate

comm-suite 복구 전 적용·머지 금지. 이후 cross-runtime 행동 A/B와 Bill 교차 대조, 팀장 diff 승인이 필요하다.
