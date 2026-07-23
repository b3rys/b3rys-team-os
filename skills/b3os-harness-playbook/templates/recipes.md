# harness ready-run 레시피 (복붙 → 적응 → 실행)

모양을 보면 골라 쓴다. 핵심 = **각자 읽을 소스 + 반환 schema를 먼저 박기**(sub agent 수가 아니라). owner가 ④ 7품질패턴으로 종합·검증.

각 레시피는 **클로드(네이티브 Workflow 스크립트)** + **openclaw(수동 명세)** 두 형태. 같은 레시피, 엔진만 다름.

---

## 1. audit — 코드/시스템 다면 점검

**소스 분할**: A=라우팅/엔트리 코드 · B=DB/스키마 · C=테스트/로그.

### 클로드 (Workflow)
```js
export const meta = { name: 'audit', description: '3면 코드 audit', phases: [{title:'Scan'},{title:'Verify'}] }
const AREAS = [
  {k:'routing', prompt:'<라우팅/엔트리 코드>에서 owner-decision 버그·엣지케이스를 찾아라'},
  {k:'schema',  prompt:'<DB/스키마>에서 제약·마이그레이션 갭을 찾아라'},
  {k:'tests',   prompt:'<테스트/로그>에서 미커버·실패·잔재를 찾아라'},
]
const FIND = { type:'object', properties:{ findings:{type:'array', items:{type:'object',
  properties:{ title:{type:'string'}, file:{type:'string'}, severity:{type:'string'}, evidence:{type:'string'} },
  required:['title','file','evidence'] }}}, required:['findings'] }
const VERDICT = { type:'object', properties:{ real:{type:'boolean'}, why:{type:'string'} }, required:['real','why'] }
const results = await pipeline(AREAS,
  a => agent(a.prompt, {label:`scan:${a.k}`, phase:'Scan', schema:FIND}),
  r => parallel((r?.findings??[]).map(f => () =>          // 각 발견을 반증검증(adversarial)
    agent(`반증 시도: "${f.title}" (${f.file}). 근거 없으면 real=false.`, {label:`verify:${f.file}`, phase:'Verify', schema:VERDICT})
      .then(v => ({...f, verdict:v})))))
const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.real)   // owner: dedup은 confirmed에서
return { confirmed }
```
### openclaw/Hermes (수동 명세 — task에 박기)
```
scope: routing 코드 / DB·스키마 / 테스트·로그 3분할
max_agents: 3 (OpenClaw 수동 spawn cap 6), budget: 각 ~50k 토큰/전체 시간, stop_rule: 각 scope 완료 또는 예산 도달
return_schema: {findings:[{title,file,severity,evidence}]}
owner synthesis: dedup + 각 발견 반증(근거 없으면 버림) + 재현 + 최종판단
```

---

## 2. migration — N곳 변경 영향

**소스 분할**: A=호출부 검색 · B=타입/스키마 영향 · C=테스트 갭.
- 클로드: 위 audit 패턴에서 AREAS를 {callsites, type-impact, test-gaps}로 교체, owner가 '영향범위 합성 + 변경 순서' 결정.
- openclaw/Hermes: `scope: 호출부/타입영향/테스트갭` · `max_agents/budget/stop_rule/return_schema 필수` · `owner synthesis: 영향범위 + 안전 순서`.

---

## 3. N후보 비교 — 모델·라이브러리·설계안

**규칙**: 후보당 1 에이전트, **동일 평가 기준표(rubric)**로. owner가 같은 rubric으로 비교·추천.
```js
const CANDIDATES = ['exaone3.5','llama3.2','haiku']   // 예
const RUBRIC = '정확도/비용/지연/운영난이도 각 1~5 + 근거'
const SCORE = { type:'object', properties:{ candidate:{type:'string'}, scores:{type:'object'}, note:{type:'string'} }, required:['candidate','scores'] }
const scored = await parallel(CANDIDATES.map(c => () =>
  agent(`후보 ${c}를 이 기준표로 평가: ${RUBRIC}`, {label:`eval:${c}`, schema:SCORE})))
return { scored: scored.filter(Boolean) }   // owner: 동일 rubric 비교 → 추천 + 가정/불확실 분리
```
- openclaw/Hermes: `scope: 후보당 1` · `max_agents/budget/stop_rule/return_schema 필수` · `return_schema: {candidate,scores,note}` · `owner: 동일 rubric 비교·추천`.

---

## 4. release-verify — 릴리즈 전 검증

**소스 분할**: A=회귀 테스트 · B=문서 정합 · C=구현 diff. owner가 gate 통과/blocker 판정.
- audit 패턴 재사용(AREAS={tests, docs, diff}), 단 verdict를 'blocker 여부'로.

---

## 공통 주의
- **2층 harness**(팀원 여러 명 × 각 N)면 총 fan-out·총 비용을 owner/PM이 관리.
- 큰 fan-out·full workflow는 실행 전 the team lead 고지 + stop_rule(⑤). 총 동시 subagents > 8 또는 팀원 2명 이상 동시 총 >= 10이면 the team lead 고지 + stop_rule + 예상 토큰을 먼저 남긴다.
- cap은 목표가 아니라 천장이다. 기본 2~3으로 시작하고, limited는 보통 6 이하(필요시 8), full은 `min(16, logical CPU core - 2)` 머신캡(절대 상한 16, host override 가능)을 따른다.
- 커버리지 줄였으면 명시(no silent caps). 미검증 추측은 「추정」 표기.
