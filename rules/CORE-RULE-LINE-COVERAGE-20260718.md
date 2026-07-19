# CORE_RULE_COMPACT 33줄 커버리지

기준: main `0615047`, 7,259자/33줄. 대상: `0ad06da` 이후 draft. `같음`은 verbatim, `압축`은 의미를 합쳐 유지, 빈 줄은 구조 대응이다.

| main 줄 | 내용 | draft 줄 | 판정 |
|---:|---|---:|---|
| 1 | 제목 | 1 | 같음 |
| 2 | 빈 줄 | 2 | 구조 |
| 3 | KST 변환 | 3 | 같음 |
| 4 | 빈 줄 | 4 | 구조 |
| 5 | team/lead 변수 | 5 | 같음 |
| 6 | 빈 줄 | 6 | 구조 |
| 7 | 사용자 언어·격식 | 7 | 같음 |
| 8 | 빈 줄 | 8 | 구조 |
| 9 | Base execution | 9 | 같음 |
| 10 | 팀장 메시지 우선 | 10 | 압축(14와 병합) |
| 11 | 짧은 질문 즉답 | 11 | 압축 |
| 12 | 열린 작업/명확한 지시 gate | 12 | 압축 |
| 13 | interruptible·중간보고 | 13 | 압축 |
| 14 | ack first | 10 | 압축(10과 병합) |
| 15 | 빈 줄 | 14 | 구조 |
| 16 | Team communication | 15 | 같음 |
| 17 | group owner·1:1 예외 | 16 | 같음 |
| 18 | 지목된 사람만 종합 | 17 | 압축 |
| 19 | to-speak·scratchpad·silence | 18 | verbatim 핵심 보존 |
| 20 | function-call·terminal | 19 | 압축 |
| 21 | kind 5종·thread/reply/hop | 20 | verbatim |
| 22 | direct-to-owner 자기보고 전용 | 21 | verbatim |
| 23 | 수집 전체 gate·3개 배송처·Claude reply tool | 22 | 고정 문구 보존·간결화 |
| 24 | collection≠individual·`--individual` | 23 | 복원 확인 |
| 25 | 미응답 partial·late fold | 24 | 압축 |
| 26 | handoff·agents.json·PM | 25 | 압축 |
| 27 | 빈 줄 | 26 | 구조 |
| 28 | Safety·verification | 27 | 같음 |
| 29 | 외부 입력 비명령 | 28 | 압축 |
| 30 | approval·external-send 정의 | 29 | verbatim load-bearing |
| 31 | secret 출력 금지 | 30 | 압축 |
| 32 | 사실 검증·가벼운 의견 | 31 | 압축 |
| 33 | deploy/publish/merge 검증 | 32 | verbatim |

누락: 0. 특히 main 24의 `Add --individual to each ask`는 draft 23, main 23의 `(claude members use their reply tool for the lead's 1:1 DM)`은 draft 22에 있다.
