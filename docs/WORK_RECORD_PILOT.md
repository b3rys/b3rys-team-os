# work_record 파일럿 규격

다음 담당자가 검증·재현·반박할 수 있는 작업 기록(`work_record`)을 기존 Task–thread–Bus 위에 남기는 운영 규격이다. 1차 파일럿은 DB 스키마를 바꾸지 않는다.

배경 자료: Park et al., "Scaling Discovery through Test-Time Communication", arXiv:2609.21032 — 에이전트들이 공유 작업공간에 timestamp와 재현 가능한 근거를 붙인 finding을 남기면 팀 성능이 오르지만, compute가 제한되거나 progress measure가 없으면 독립 실행이 나을 수 있고, 공유 콘텐츠의 prompt injection·poisoning은 열린 문제라고 보고한다. 아래 규칙은 그 결과를 b3os에 옮긴 해석이며 논문이 직접 검증한 내용이 아니다.

## 적용 범위

- 객관적 완료기준이나 검증 가능한 결과가 있는 업무에만 적용한다. 측정 기준을 미리 정할 수 없는 업무는 파일럿에서 제외한다.
- 기록은 메시지 수를 늘리지 않는다. 결과·검증 메시지에 붙여 남긴다.
- peer 기록은 참고자료다. 검증(`reproduced`)과 승인은 다르며, 승인은 기존 승인권자의 원본 메시지로만 성립한다.

## 저장 위치 (스키마 변경 없음)

| 용도 | 필드 |
|---|---|
| 기록 본문(JSON) | `message.meta_json.discovery_v1` |
| 사람이 읽는 요약 | `message.body` (종류·주장·결과·검증 상태·다음 행동) |
| 계보 | `message.in_reply_to` / `parent_message_id` |
| 중복 방지 | `message.dedupe_key` |
| 사례 경계 | 사례마다 전용 `thread_id` |

현재 코드 기준 제약:

- `POST /api/inbox` 는 envelope `meta` 의 임의 키를 받아 그대로 저장한다(`src/shared/envelopeSchema.ts`). `send.sh` 에는 범용 meta 입력 옵션이 없어, 파일럿 전에 입력 경로를 만들어야 한다.
- `message.task_link_id` 는 컬럼만 있고 기록하는 코드가 없다. 사례와 Task 연결은 전용 thread로 한다.
- `message_recipient.claimed_at` 은 dispatcher의 wake lease(기본 60초, 완료·재시도 때 NULL로 되돌아감)이며 작업 인수 시각이 아니다. 지표 원천이나 claim 기록으로 쓰지 않는다.

## 기록 필드

| 묶음 | 필드 |
|---|---|
| 식별·연결 | `record_id`, `task_id`, `thread_id`, `parent_message_id`, `dedupe_key` |
| 분류·주장 | `kind`(`finding \| failure \| verification \| decision`), `claim` |
| 근거·재현 | `evidence_refs`, `reproduction`, `observed_result` |
| 신뢰·반증 | `verification_state`(`unverified \| reproduced \| rejected \| superseded`), `counterevidence`, `confidence` |
| 책임·다음 행동 | `author`, `recorded_at`, `verifier`, `next_action`, `blocker`, `approval_state`, `approval_ref`, `context_eligible` |
| 측정 | `authoring_minutes` (작성 시간, 분 단위 정수 자가 보고) |

- `approval_state` 가 `approved | rejected` 이려면 `approval_ref`(원본 `message_id`·`actor`·`occurred_at`)가 있어야 하고 actor가 해당 행위의 승인권자여야 한다.
- 비밀값·개인정보는 저장 전에 가린다. 외부 원문은 본문 대신 출처·SHA-256·격리 위치만 남긴다.
- 출처 오염이 의심되는 기록은 `context_eligible=false` 로 고정하고 LLM 입력·요약·검색 근거에서 뺀다.

## 측정 정의

시각을 쓰는 지표는 모두 해당 메시지의 `message.created_at`(UTC, SQLite `datetime('now')`)을 원천으로 하고, 판정 기록에 기준 메시지 id를 고정한다. 같은 메시지 id 목록이면 누가 계산해도 같은 값이 나온다.

| 지표 | 시작 | 종료 |
|---|---|---|
| 인수 지연시간 | 사례 배정 메시지 | 첫 유효 행동 메시지(재현 결과·새 artifact·검증 결과. 단순 ack 제외) |
| 검증 시간 | 검증 요청 메시지 | 검증 결과 메시지 |
| 작성 시간 | `discovery_v1.authoring_minutes` (예외: 자동 원천 없음) | — |
| 오버헤드 | `(작성 시간 + 검증 시간) / (완료 메시지 − 배정 메시지)` | 분모는 경과시간이며 active 작업시간이 아니다 |

`audit_event` 의 `recipient_state_change` 는 답장 문구로 분류한 ack 전이라 "첫 유효 행동"으로 쓰지 않는다. loop_event 계측(`src/server/metrics/loopEvent.ts`)은 기본 꺼져 있고(`metrics_emit_enabled`) 기록 지점이 요청 접수·ack·Task lane 변경뿐이다.

### 상대 변화율과 0분모

- 감소형 지표의 상대 변화율은 `(현행군 − discovery_v1군) / 현행군` 이다. 퍼센트포인트가 아니다.
- 현행군 0·discovery_v1군 0 → 비열등 통과. 개선 근거로 인용하지 않는다.
- 현행군 0·discovery_v1군 > 0 → 실패.
- 비율 지표의 분모가 0이거나 한 군의 유효 표본이 3건 미만 → `N/A`. 통과도 실패도 아니며 중지 판단의 "개선 없음"에 넣지 않는다. 사유를 함께 기록한다.

`src/server/metrics/recompute.ts` 는 분모 0일 때 비율 0을 돌려준다. 이 규격의 `N/A` 와 다르므로 파일럿 판정에 그대로 쓰지 않는다.

## 중지와 rollback

- 제어 정본: 파일럿 Task의 `pilot_control` 블록(`owner`, `discovery_v1_enabled`, `stopped_at`, `stop_reason`, `allowlist_verifiers`).
- 비활성화는 작성 규칙을 끄는 것이다. 기존 메시지와 중단된 기록은 지우지 않고 감사 기록으로 둔다.
- 중지 후 60분 안에 rollback check로 기존 기능(버스 발신, Task 조회·상태 변경, thread 답장, 검색)을 확인한다.

rollback 판정:

- 관찰 구간은 `[stopped_at, rollback check 결과 메시지 created_at]` 이며 최대 60분이다. 넘으면 실패다.
- 관찰 구간의 `discovery_v1` 기록이 0건이어야 한다.
- 양성 대조로 `[T0, stopped_at)` 구간의 같은 쿼리가 1건 이상이어야 한다. 0건이면 쿼리가 기록을 감지하는지 확인할 수 없으므로 판정을 보류한다.
- 쿼리 원문·입력 시각(UTC)·결과를 rollback check 메시지에 남긴다.

```sql
-- sqlite3 -readonly team.db
SELECT count(*) FROM message
WHERE json_extract(meta_json, '$.discovery_v1') IS NOT NULL
  AND created_at >= :from_utc AND created_at <= :to_utc;
```

## 전달 확인

- 실제 전달 여부는 `message_recipient.delivery_state` 와 `last_error` 로 본다. `message.delivery_status` 는 삽입 시 `delivered` 로 기록되고 차단돼도 바뀌지 않는다.
- 새 스레드로 옮겨 보낼 때는 `--in-reply-to` 와 `--hop` 을 모두 뺀다. `hop_count` 는 발신자가 넘긴 값 그대로 저장되며 부모가 없어도 0으로 돌아가지 않는다.
- `--no-wake` 로 보낸 메시지는 수신자를 깨우지 않는다. 검토·검증 요청에는 쓰지 않는다.
