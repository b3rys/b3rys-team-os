# b3os-bwf — 설계 SPEC (internal)

> Status: draft · Owner: Bill · 2026-06-22
> 근거: GD 2026-06-22 발족(적대적리뷰 경험 → BWF 품질방법을 전 팀원 스킬로) + 팀 전원 리뷰 7/7 만장일치(thread bwf-skill-review-0622).
> 이 문서는 설계 정본(내부). 산출물 = SKILL.md(상세) + TEAM-OS 핵심룰 thin 정의(always-load) + rubric + 테스트.

## 1. 목적 / 한 줄 정의

**BWF(b3os workflow)는 harness가 아니라 b3rys 팀의 "기본 과제 수행 워크플로우"다.** (6/19 BWF=harness 오해 재발 방지 — 이 문장을 SKILL.md 첫 줄에 박는다.)

지금 문제: 워크플로우 지식이 흩어져 있다 — project-loop(Codex 한정) / BWF(TEAM-OS 텍스트만) / 품질방법(harness 등). 팀원이 "이 일에 어떤 흐름을 써야 하지?"를 매번 추론한다. 퍼블릭 사용자는 더 모른다.

해결: **단일 진입점 b3os-bwf = stage router(얇은 오케스트레이터).** 각 단계는 짧은 선택 기준 + 하위 스킬 링크. 거대 만능 문서 X.

## 2. 팀 리뷰 합의 (7/7, 설계 제약)

- ✅ b3os-bwf 신설(전 런타임). **project-loop 흡수**(폐기 → BWF로).
- ✅ **learning-loop 별도 유지**(만장일치). BWF는 "학습 후보·검증증거 → learning-loop 이관" **hook만**. 이유: BWF=과제 실행(미시) / learning-loop=주간 메타-개선(거시, cadence·산출물·승인게이트 다름).
- ✅ **task-mgmt 하위 연계**(폐기 X). BWF가 카드 작성·guard 필드를 호출. owner·핵심룰은 TEAM-OS always-load 유지(스킬 이동 금지, §9 DO-NOT-COMPACT).
- ✅ 품질방법 **정본 = harness 유지**, BWF는 **참조(링크)**. 복붙하면 드리프트.
- ✅ 비대화 방지: **작업크기 게이팅**(턴/주행/완전자율 = harness off/limited/full) 필수.
- ✅ **검증기준(완료기준) 먼저** 단계화(글로벌룰 "코딩 전 완료기준"과 일치). judge panel·적대적리뷰는 rubric 없으면 형식만 돎.
- ✅ 런타임 로딩: claude SKILL.md 자동로드 전제 금지. TEAM-OS/AGENTS에 5~7줄 always-load + openclaw·hermes 명시 진입점 + B3OS_SKILLS.md discoverable. 실행 도구 = 런타임중립 스크립트.
- ✅ 단일점 실패 대비: "스킬 없어도 도는 최소 절차"를 TEAM-OS에. 마이그레이션 = deprecate stub + 인덱스 동시 갱신.

## 3. BWF 스테이지 (backbone)

작업 받으면 → **턴모드(대화/검토)** vs **주행모드(실행 기본)** 판단. 실행이면 아래 루프:

```
0. 트리거      과제 분류: 열린 과제(계획·확인 먼저) vs 명확한 지시(바로). 모드 선택.
1. PM 계획     목표 / 비목표 / 완료기준(rubric) 먼저. owner 결정(역할 밖이면 PM 전환·위임).
2. 팀 배정     owner·ETA·검증자. handoff = 받는쪽 ack까지 추적(보냄≠수신확인).
3. 실행+품질   작업모양 → 품질방법 선택(§4 카탈로그). 작업크기 게이팅(off/limited/full).
4. 검증        완료기준(rubric) 대조 + 검증증거(테스트·빌드·실측, 할루시네이션 "됐다" 금지).
               중요 릴리즈 = 팀원리뷰 + 하네스(TEAM-OS §4 릴리즈 게이트, 무조건).
5. 보고+카드   GD-visible 보고(생성≠보임) + 칸반 갱신. closure까지 owner가 들고 감.
6. 학습 hook   교훈·재발사례 → learning-loop 입력으로 흘림(별도 스킬, 합치지 않음).
```

각 단계 = 짧은 체크 + 하위 스킬 링크(아래). 작은 일은 1·4·5만 가볍게(카드 대신 thread), 10분+·handoff·배포는 풀 루프.

## 4. 품질방법 카탈로그 (선택 기준표 — 라우팅만, 정본은 각 스킬)

| 작업 모양 | 품질방법 | 정본 |
|---|---|---|
| 좁고 순차·단일맥락·개념합성 | **솔로** | — |
| 여러 실제 소스 동시(audit·다PR·마이그레이션·N후보·멀티소스 리서치) | **harness(병렬)** | b3os-harness-playbook |
| 결함이 치명적·되돌리기 어려움 | **적대적 리뷰(반증)** | b3os-harness-playbook(7패턴) |
| 중요 설계·빌드 결정 | **multi-ai review** | gd-multi-ai-review |
| 후보·판정 비교 | **judge panel** | b3os-harness-playbook(7패턴) |
| 릴리즈/공개 전 | **팀원리뷰 + 하네스 다차원** | TEAM-OS §4 + b3os-harness-playbook |

판정 한 줄: "각 조각이 서로 다른 실제 소스를 읽나?" YES→harness, NO→솔로. (harness 스킬과 동일 기준, 복붙 아닌 참조.)

## 5. 연계 스킬 (BWF가 호출)

- 카드·continuation guard·handoff = **b3os-task-loop**
- 병렬 실행·품질패턴 = **b3os-harness-playbook**
- 보고서 = **b3os-report** / 덱 = b3rys-make-ppt
- 버스 통신 = **b3os-team-inbox**
- 학습 이관(hook) = **b3os-team-learning-loop**

## 6. 런타임 로딩 (claude만 자동 ≠ 전원)

- **TEAM-OS 핵심룰**: BWF 5~7줄 thin 정의(스테이지 + "BWF≠harness" + 품질방법 트리거 한 줄) = always-load(전 런타임). 단일점 실패 시 "스킬 없어도 도는 최소 절차".
- **claude(빌·스티브·데미스·드박)**: ~/.claude/skills + skills SKILL.md 자동.
- **openclaw(코덱스·데본·루이)·hermes**: AGENTS.md/profile 시작 컨텍스트에 "BWF 과제면 b3os-bwf 명시 로드" + 절대경로 + B3OS_SKILLS.md 발견 경로.
- **실행 도구 = 런타임중립 스크립트**(scripts/*.sh|*.mjs) → 어디서든 직접 실행.

## 7. 테스트 설계 — "팀원이 빌처럼 BWF를 진행하는가" (rubric 기반 3층)

핵심 enabler = **BWF rubric**(아래). fuzzy한 "빌처럼"을 채점 가능하게.

**rubric (BWF 실행 채점 기준):**
- [ ] 완료기준을 실행 전에 정했나
- [ ] 작업모양에 맞는 품질방법을 골랐나(작은건 솔로 / 넓은건 harness / 중요결정 multi-ai·judge / 위험 적대적리뷰)
- [ ] 카드화/추적했나(10분+·handoff·배포)
- [ ] 검증증거로 완료를 입증했나(테스트·빌드·실측, 할루시네이션 "됐다" 아님)
- [ ] GD-visible 보고 + closure까지 들고 갔나
- [ ] owner·안전룰(외부전송·self-mod·승인) 지켰나

**3층 테스트:**
1. **로딩 테스트(기계·결정적, CI 가능)**: 각 런타임이 BWF 발견/로드하는가. 봇에 "X 과제 워크플로우?" → BWF 스테이지 정확 응답(할루시네이션 아님). openclaw/hermes always-load·진입점 검증.
2. **골든태스크 eval(행동·rubric 채점)** ★: 작업모양별 표준 과제 2~3개(작은수정/다파일 audit/리서치). 팀원에 1개 → 실행 trace를 rubric으로 채점. 채점 = **judge panel로 dogfood**(BWF가 BWF 평가). 통과 기준선.
3. **퍼블릭 self-test(GD 검수용)**: fresh clone + 3명 가정. README "BWF self-test" — 샘플 골든태스크 end-to-end → 각 단계 산출물(계획카드·완료기준·실행·검증증거·보고) 실제 생성 확인. 플립 후 새 repo 구조 동작까지.

같은 rubric을 2층(우리 팀)·3층(퍼블릭) 재사용.

## 8. 산출물 / 마이그레이션

- `skills/b3os-bwf/SKILL.md`(상세 stage router) + `scripts/`(self-test·rubric 체크) + `references/`(rubric).
- TEAM-OS 핵심룰 BWF thin 정의 추가(Bill+Codex 교차검토 — 핵심룰 변경).
- `b3rys-project-loop` → deprecate stub(BWF로 안내) + B3OS_SKILLS.md 인덱스 갱신.
- learning-loop SKILL.md에 "BWF에서 hook으로 호출됨" 한 줄.
- 신규영입 OT에 BWF 카탈로그 주입 + README/docs 설명.
- 퍼블릭 동반(스킬 + team-os 핵심룰). 단 push = GD go 게이트.

## 9. 검증 게이트 (이 스킬 자체)

- 적대적 리뷰(반증) 1회 — BWF를 BWF로 dogfood.
- 핵심룰 변경부 = Bill+Codex 교차검토(런타임별 행동 차이).
- 런타임 로딩 = 1층 테스트 실측(claude/openclaw/hermes).
- 공개 누출 grep(실명·경로).
