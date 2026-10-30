---
name: b3os-report
description: b3rys 팀 표준 보고서 스킬. 보고서는 MD 소스를 먼저 쓰고 아이폰에서 읽기 좋은 자체완결 반응형 HTML+SVG로 렌더해 /reports 에 게시한다. 사용 시점 — "보고서 써줘", "report", "팀 보고서", "결과 정리해서 보고", "테스트/리뷰/분석 보고서", MD를 HTML로 렌더. owner=maintainer.
trigger: publish to `/reports`
entry: scripts/publish.sh
---

# b3os-report — 팀 표준 보고서

## 언제 작동하나
- "보고해 / 현황 알려줘 / 어떻게 됐어"는 메신저로 답한다. 이 스킬은 쓰지 않는다.
- "보고서 작성해 / 리포트 만들어 / 문서로 정리해"는 이 스킬을 쓴다. 기본은 MD 원본 → HTML 렌더 → /reports 등록이다.

## /reports 에 올리는 것
- 올린다: 외부지식 정리(교육자료·해설·리서치), 내부 프로젝트에서 얻은 노하우·교훈을 지식으로 정리한 글.
- 올리지 않는다: 단순 논의 결과·로그·운영성 글(진행보고·리뷰메모·개발로그·툴평가). 하던 대로 docs/작업카드에 둔다.

## 실행 전 확인
- 렌더 범위를 묻고 그 범위만 한다: ①MD만 ②HTML까지 ③/reports 게시까지.
- /reports 는 팀 내부 포털이라 게시에 컨펌이 필요 없다. 팀 밖으로 나가는 것(공개 포스팅·외부 이메일/DM·서드파티 API)은 승인 대상이다.

## 문체
- 한글화가 목표가 아니다. 업계 용어·제품명·모델명·API 이름처럼 영어가 정확한 표현은 살린다. 목표는 의미 보존과 자연스러운 한국어 리듬이다.
- 첫 등장 용어는 `영어 용어(한국어 뜻)`으로 쓴다. 독자가 막힐 만한 약어·전문어만 고르고, 별도 풀이 섹션은 만들지 않는다. 예: `API(Application Programming Interface, 프로그램끼리 요청을 주고받는 접점)`.
- 장 제목·실행 계획·판단 문장은 한국어로 쓴다. `Result`, `Decision`, `Step` 같은 기계적 영어 라벨은 풀어쓴다.
- 수치·날짜·고유명사·직접 인용은 바꾸지 않는다.
- 수식·개발·경제처럼 괄호로 부족한 개념은 해당 문단 아래에 5줄 이내 풀이 박스(원래 표현 → 쉬운 해석 → 왜 중요한지)를 붙인다.

### 같이 쓰는 스킬
설명 구성은 `b3os-how-to-explain` 을 따른다. 아래 둘은 외부 스킬(이 저장소·`install.sh` 에 없음)이라 설치돼 있을 때만 쓰고, 없으면 해당 절차를 직접 한다.

| 스킬 | 언제 | 범위 |
|---|---|---|
| `b3os-how-to-explain` | 쓰기 전 | 독자가 되물을 만한 곳(새 용어 첫 문단, 원인 설명, "왜 이렇게 했나")에 적용. 현황·수치 나열에는 안 쓴다 |
| `humanize-korean` | 렌더 직전 마지막 패스 | 번역투·기계적 병렬·AI 티 리듬만 다듬는다. 내용은 바꾸지 않는다 |
| `gd-explain-like-5` | 논문·계약서 등 남의 원문을 풀어 주는 보고서일 때만 | 원문 인용 → 용어 설명 → 해석 → 의견 4단. 내 본문에는 안 쓴다 |

`humanize-korean` 을 돌릴 때는 숫자, 영어 기술 용어, 백틱 코드, 마크다운 강조, 절·그림 번호, 예문을 잠그고, 돌린 뒤 원문과 숫자·백틱을 전수 대조해 바뀐 것은 되돌린다. 길면 나눠 돌리되 줄 수와 줄 순서를 유지하게 지시한다.

## 독자와 구성
- 별도 지정이 없으면 해당 분야 배경지식이 없는 중학생도 이해할 수준으로 쓴다. 유치한 말투나 부정확한 비유는 쓰지 않는다. 전문 독자·원문 순서·구현 중심 지정이 있으면 그것이 우선이다.
- 작성 전과 내용 리뷰 때 `references/reader-fit.md` 를 읽는다. 구체적인 예 하나가 입력에서 결과까지 먼저 끝나게 구성하고, 이해에 필요 없는 수식·코드·내부 구조는 선택 심화로 분리한다.
- 첫 화면은 `# 제목` + 메타줄(일시·owner) + 첫 `>` 인용의 한 줄 결론이다. iPhone 에서 5초 안에 무슨 문서인지, 결론이 뭔지 알아야 한다.
- 수치 비교는 표와 SVG 바차트를 같이 쓴다. 끝에 소스 MD 경로 한 줄을 둔다.
- 설명그림을 적극 쓴다. 구조·비교·상태변화가 나오면 그림을 먼저 생각하되, "이 그림만 보고 개념을 남에게 설명할 수 있나"가 아니면 뺀다. 그리는 법은 `references/diagrams.md`.

## 추론 레벨
보고서 작성 작업(본문 초안, 숫자·계산 검증, 인터랙티브 컴포넌트)만 high 로 돌린다. 팀원 기본 레벨과 렌더·게시 같은 기계 단계는 안 바꾼다. 작업 단위로 정할 수 있으면 서브에이전트 하나를 high 로 띄워 맡기고, 못 하는 런타임은 기본 레벨로 쓰되 숫자 대조를 빠뜨리지 않는다. high 는 아래 3단계 리뷰를 대신하지 않는다.

## 단계
1. **MD 소스** — `reports/<주제>-<YYYYMMDD>/<name>.md` 에 쓴다(재편집·재렌더 원본).
2. **최종 윤문** — 위 문체 기준으로 번역투·기계적 병렬·영어 라벨을 줄인다. 문체·리듬만 다듬고 내용은 더하거나 빼지 않는다.
3. **팀원 리뷰** — 렌더 전에 다른 팀원 한 명이 읽는다. 건너뛰지 않는다.
   - 내용: 사실이 맞나, 근거가 있나, 빠진 것이 있나
   - 표현: 문장 하나를 앞뒤 가리고 읽어도 무엇에 대한 말인지 아나
   - 이해 흐름: `references/reader-fit.md` 의 재설명 검사로, 기초 본문만으로 입력→처리→결과와 중요한 한계를 설명할 수 있나
   표현 리뷰는 글쓴이가 대신할 수 없다. 걸러야 하는 문장 다섯 갈래와 처방은 `references/expression-review.md`.
4. **HTML 렌더** — `scripts/render.sh <md> [out.html] [제목]`. 자체완결 반응형 HTML+SVG, 다크/라이트 토글.
5. **포털 게시** — 원본 md/html 은 `reports/` 밖(작업 폴더·임시 폴더)에 둔다. `reports/<id>/` 안에 있으면 자기 자신을 복사하다 `SameFileError` 로 죽는다.

두 스크립트는 이 저장소 안에 있다. clone 루트에서 실행한다(`install.sh` 는 `~/.claude/skills/b3os` 만 연결하므로 `~/.claude/skills/b3os-report/…` 경로는 없다).

```bash
skills/b3os-report/scripts/render.sh report.md report.html "제목"
skills/b3os-report/scripts/publish.sh --title "제목" --author maintainer --summary "한줄요약" --md report.md --html report.html
```

publish.sh 는 team-collab `reports/` 에 복사·등록하고 `<dashboard-url>/reports` 목록에 바로 띄운다. HTML 이 있으면 포털 기본 form 은 HTML, MD 는 정본·다운로드용으로 남는다. 결과 HTML 은 Telegram `.html` 첨부(아이폰 Safari)로도 보낼 수 있다.

## 디자인 기준
팀장은 주로 아이폰에서 읽는다. 매번 CSS 를 새로 만들지 않도록 한 테마로 통일하고, 단일 출처는 `assets/theme.css`(렌더 시 인라인)와 renderer 다. 기준 예시는 `/reports/file/differential-privacy/html`(다크 editorial 톤, 짧은 섹션, 카드형 설명, 개념 바로 아래 짧은 풀이)이며 KaTeX 전용 HTML 은 복사하지 않는다.
- 어두운 캔버스 위 960px 상한 본문(순수 해설형은 820~880px 가능), 라이트 모드도 같은 구조에 밝은 토큰.
- 초록/세이지가 primary, amber/orange 가 보조. 파랑 계열은 링크·코드 같은 보조 정보에만 muted sage 톤으로 쓴다.
- 배경은 아주 연한 grid texture, 본문 가독성을 해치지 않게 한다.
- 다크 모드 표·인용·코드·figure·요약 카드는 `--surface-shadow`/`--surface-shadow-soft`(아래 방향 그림자 + 위 1px inset highlight + 외곽선)로 라이트와 같은 깊이를 만든다.
- 탭 UI 는 작은 segmented navigation(`report-tabs`/`report-tab`)을 쓰고 큰 pill 버튼은 쓰지 않는다. 컴포넌트는 `references/ui-components.md`.
- 손으로 짠 특수 구조 보고서(CSS-only 탭 등)는 표준 render 로 덮지 말고 공통 테마 CSS 만 교체한다. 새 보고서는 손으로 짜지 말고 `data-tab` 표식을 쓴다.
- 도식은 `svg.diagram-flow` kit 와 `diagram-node*`, `diagram-line*` class 를 쓴다. blue/violet SaaS 팔레트(`#eff6ff`, `#2563eb`, `#faf5ff`, `#7c3aed` 등)는 기본 색으로 쓰지 않는다.

## 렌더러가 지원하는 MD
`#`~`####` 헤딩 · `**굵게**` `*기울임*` `` `코드` `` · 표 · `-`/`*`/`1.` 목록 · `>` 인용(강조 박스) · `---` · `[텍스트](url)` · 코드펜스 · `<svg>…</svg>` 원문 통과 · `<div id="x" data-tab="라벨"></div>` 탭 구분.

## 다이어그램 (SVG 통과)
다이어그램을 넣으면 `references/diagrams.md` 를 먼저 읽는다(여섯 틀, 실제 값 규칙, class 표, 글자 폭 계산, 브라우저 검사). 아래는 통과 문법이다.
- 차트·흐름도는 MD 안에 인라인 SVG 로 쓴다. 라이트/다크 둘 다 읽혀야 한다. SVG 안에서는 줄바꿈이 자동이 아니므로 `<text>` 한 줄에 긴 문장을 넣지 않는다. 도식 안은 구조, 아래 문단은 해석을 맡긴다.
- 복잡한 가로 SVG 는 같은 `<figure>` 안에 모바일 세로 카드 `<div class="mobile-infographic">`(`mi-card mi-green|mi-amber|mi-orange|mi-red`)와 `<svg class="desktop-infographic diagram-flow">` 를 같이 둔다. 640px 에서 자동 전환한다. `mi-blue`/`mi-cyan`/`mi-violet` 은 legacy 호환용이다.

```html
<svg class="diagram-flow" viewBox="0 0 420 92" role="img" aria-label="리뷰 방식별 시간 비교">
  <text x="18" y="24" class="diagram-title">시간 비교</text>
  <text x="18" y="52" class="diagram-muted">솔로</text>
  <rect x="86" y="40" width="74" height="14" rx="7" class="diagram-accent"/>
  <text x="170" y="52" class="diagram-text">58s</text>
</svg>
```

## 인터랙티브 컴포넌트
값을 바꾸면 결과가 따라 바뀌는 관계(비트 수 → 오차, 문장 길이 → attention 계산량)는 `<b3-이름 class="ix">…</b3-이름>` 블록으로 쓴다. 렌더러가 `assets/components/b3-이름.js` 를 그 보고서에만 넣는다. 쓸 때·규약·검사는 `references/interactive-components.md`. 보고서당 1~3개, 돕는 문단 바로 아래에 둔다. 포털 미리보기는 스크립트가 막힌 iframe 이라 태그 안에 정적 그림을 먼저 두고, 조작은 새창·첨부 파일에서 된다. 숫자는 본문에 있는 값과 공식만 쓰고, 지어낸 값은 캡션에 "설명용 예시 값"이라고 쓴다.

## 긴 보고서는 탭으로 나눈다
본문 15,000자 초과 또는 그림 20장 초과면 `<div id="p0" data-tab="0부 구조"></div>` 표식으로 나눈다. 표식 규칙(한 줄로 닫기, 1개뿐이면 렌더 멈춤), `:target` 전환, scrollTo 주의, 배포 전 브라우저 검사 4가지, 실제 열람 경로 검증은 `references/tabs.md` 를 읽는다.

## 예제
`examples/harness-pilot-report.md` → `examples/harness-pilot-report.html`. 다이어그램·부별 탭 예시는 `/reports/file/llm-book/html`.
