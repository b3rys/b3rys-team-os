---
name: b3os-model-rollout
description: 팀원 런타임(hermes · codex · openclaw)의 모델을 새 모델로 바꿀 때 쓰는 절차와 도구. 팀원별 지금 모델 확인(inventory), 새 모델이 그 런타임·계정에서 실제로 응답하는지 확인(check — 설정 안 바꿈), 미리보기 뒤 한 팀원씩 백업 → 설정 한 줄 → 그 팀원만 재시작 → 실제 응답 모델 확인 → 실패 시 자동 복원(apply). 새 프론티어 모델이 나왔을 때, 주간 모델 점검 때, "팀원 모델 바꿔줘" 요청 때 사용. 다른 맥은 --host 로 같은 절차.
trigger: switch team members to a new model
owner: bill
---

# b3os-model-rollout — 팀원 모델 전환

새 모델이 나올 때마다 런타임마다 설정 파일·재시작 방법·확인 방법이 달라 손으로 하던 일을 한 도구로 묶었다.
**결정(어느 모델로 바꿀지)은 사람이 한다.** 이 도구는 "되는지 재고, 바꾸고, 확인하고, 안 되면 되돌린다" 만 한다.

## 명령

```bash
S=skills/b3os-model-rollout/scripts/model-rollout.ts
bun $S inventory                                   # 팀원별 런타임 · 지금 모델 · effort · 설정 파일
bun $S check --model gpt-6.1-sol --effort medium   # 실제로 되는지(설정 안 바꿈). 전원 works 면 exit 0
bun $S apply --model gpt-6.1-sol --effort medium   # 미리보기 — 아무것도 바꾸지 않는다
bun $S apply --model gpt-6.1-sol --effort medium --yes   # 실제 전환
# 공통: --members a,b(일부만) · --json · --registry <agents.json>
# 다른 맥: --host <ssh 이름> --remote-repo <그 맥의 저장소 경로>  (그 맥 저장소의 같은 스크립트를 돌린다)
```

## 런타임별로 무엇을 보고 무엇을 바꾸나

| 런타임 | 팀원 목록 | 설정 | 확인(check) | 재시작 |
|---|---|---|---|---|
| hermes | `agents.json` 의 `hermes_profile` | `~/.hermes/profiles/<p>/config.yaml` — `model:` 블록 `default`, `agent:` 블록 `reasoning_effort` | one-shot 1회(`--provider` 필수) → usage 파일의 실제 `model` | 그 팀원 게이트웨이(`gateway_service` 또는 `ai.hermes.gateway-<p>`) |
| codex | `agents.json` 의 `runtime: codex` | `~/.codex-agents/<id>/config.toml` — 최상위 `model`·`model_reasoning_effort` | `codex exec` 1회 → 세션 기록의 실제 `model` | 그 팀원 브리지(`<prefix>.codex-bridge-<id>`) |
| openclaw | `~/.openclaw/openclaw.json` 의 `agents.entries`(모델을 따로 정한 에이전트) | `openclaw config set agents.entries.<id>.model` | 게이트웨이 `openclaw models list` 의 `available === true` | 게이트웨이 1회(openclaw 팀원 전원 잠깐 멈춤) |

- **claude 런타임은 대상이 아니다** — 모델은 CLI 쪽 설정이다.
- **codex 실행 파일**: `CODEX_BIN` 이 없으면 저장소 `.env` 의 `CODEX_BIN` 한 줄을 쓴다. 새로 받은 Homebrew 사본은 macOS 격리 표시 때문에 화면 없이 실행하면 멈출 수 있다 — 그럴 때는 격리 표시가 없는 사본을 `CODEX_BIN` 으로 준다.

## 판정 규칙

- `works` = 실제 호출이 그 모델로 응답했다(openclaw 는 게이트웨이가 available=true).
- `not_supported` = 다른 모델이 응답했거나, 게이트웨이가 그 모델을 모른다.
- `unknown` = 인증·한도·시간 초과 — "지원 안 됨" 이 아니다. 원인부터 푼다.
- 목록(카탈로그)에 이름이 있다는 것은 근거가 아니다. 구독 로그인에서 실제로 되는지는 check 로만 안다.

## apply 가 하는 일

1. 이미 그 모델이면 건너뛴다.
2. 설정 모양이 예상과 다르면 그 팀원은 건너뛰고 "손으로" 라고 적는다(줄을 새로 끼워 넣지 않는다).
3. 백업(`<설정>.bak-rollout-<시각>`) → 값 한 줄 → 그 팀원만 재시작 → 설정만으로(덮어쓰기 없이) 다시 check.
4. 확인이 실패하면 백업 복원 + 재시작.
5. openclaw: 먼저 게이트웨이가 모델을 아는지 본다. 모르면 **아무도 바꾸지 않는다**. 알면 `openclaw.json` 백업 → 에이전트마다 `config set` → 게이트웨이 재시작 1회 → 반영 확인, 실패하면 복원 + 재시작.

## 안 하는 것

- 사람 승인 없는 전환. `--yes` 는 승인 뒤에만 쓴다.
- 런타임 프로그램 자체 업데이트(openclaw·hermes·codex 버전 올리기) — 데이터 마이그레이션이 따를 수 있어 따로 승인·백업한다.
- 공유 설정(호스트 `~/.codex/config.toml`, openclaw `agents.defaults`)을 바꾸는 것.

## 주간 점검과 같이 쓰기

새 모델 후보가 생기면 두 맥에서 `check` 를 돌려 결과(팀원별 works/not_supported/unknown)를 변경 요청 하나에 붙인다. 승인되면 `apply --yes`. 결과가 `not_supported`(예: openclaw 게이트웨이가 모델을 모름)면 무엇이 풀려야 하는지(런타임 새 버전 등)를 같이 적는다.
