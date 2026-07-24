---
name: b3os-report
description: b3rys 팀 표준 보고서 스킬. 모든 보고서는 MD를 소스로 먼저 쓰고 → 아이폰에서 읽기 좋은 자체완결 반응형 HTML+SVG로 렌더한다. 사용 시점 — "보고서 써줘", "report", "팀 보고서", "결과 정리해서 보고", "테스트/리뷰/분석 보고서", MD를 HTML로 렌더. owner=maintainer.
---

# b3os-report — 팀 표준 보고서

## 언제 작동? (트리거 규율 — the team lead)
- **"보고해 / 현황 알려줘 / 어떻게 됐어"** = 그냥 **메신저로 답변**한다. 스킬 작동 X (단순 질의응답).
- **"보고서 작성해 / 리포트 만들어 / 문서로 정리해"** = 이 스킬 작동.

## /reports 대상 = "지식화되는 컨텐츠"만 (the team lead 2026-06-07)
- ✅ 대상: ①**외부지식 정리**(교육자료·해설·리서치 결과물) ②**내부 플젝하며 얻은 지식·경험**(노하우·교훈을 지식으로 정리한 것)
- ❌ 제외: 단순 논의결과·로그성·운영성(진행보고·리뷰메모·개발로그·툴평가) → **하던 대로 docs/작업카드에**. 포털엔 안 올림.

## 실행 전 확인 (confirm 게이트)
- **렌더 범위**: "①MD만? ②HTML까지? ③/reports 게시까지?" 물어보고 그 범위만.
- **/reports 게시 전 = the team lead 컨펌 필수** (the team lead 2026-06-07, 정책 튜닝 중): 올리기 전 the team lead에게 "이거 지식 보고서로 /reports에 올릴까요?" 확인받고 게시한다. 컨펌 없이 자동 게시 금지.
- 단, 같은 대화에서 the team lead가 직접 "대시보드 Reports에 올려", "reports에 게시"처럼 게시 표면을 명시하면 그 메시지를 게시 컨펌으로 본다.

## 문체 원칙 — humanize-korean 최종 패스 (the team lead 2026-06-10)
- 보고서는 **무조건 한글화하지 않는다**. 업계 표준 용어, 제품명, 모델명, API 이름, 검색/평가 용어처럼 영어가 더 정확한 표현은 살린다.
- 대신 한국어 독자가 자연스럽게 읽을 수 있게 `humanize-korean` 스킬을 최종 검수 단계로 사용한다.
- 첫 등장 용어는 `영어 용어(한국어 뜻)`으로 설명한다. 이후에는 문맥상 자연스러운 쪽을 쓴다.
- 장 제목·실행 계획·판단 문장은 한국어 흐름을 기본으로 한다. `Result`, `Decision`, `Step`, `Default criteria` 같은 기계적 영어 라벨은 그대로 남기지 말고 필요한 경우 한국어로 풀어쓴다.
- 영어를 억지로 한국어로 바꾸지 않는다. 목표는 "영어 제거"가 아니라 **의미 보존 + 자연스러운 한국어 리듬**이다.
- 수치·날짜·고유명사·직접 인용은 바꾸지 않는다.

## 단계
1. **MD 소스 먼저** — Markdown 작성(`reports/<주제>-<YYYYMMDD>/<name>.md`). 재편집·버전관리·재렌더 원본.
2. **humanize-korean 최종 윤문** — 렌더 전 `humanize-korean` 기준으로 번역투·기계적 병렬·영어 라벨 남발을 줄인다. 내용 추가/삭제가 아니라 문체·리듬·표현만 다듬는다.
3. **HTML 렌더**(확인 시) — `scripts/render.sh <md> [out.html] [제목]` → 아이폰 반응형 HTML+SVG(자체완결, **다크/라이트 테마 토글**).
4. **포털 게시**(확인 시) — `scripts/publish.sh --title "T" --author maintainer --summary "S" --md a.md --html a.html` → team-collab `reports/`에 복사 + 등록 → **<dashboard-url>/reports** 목록에 바로 뜬다. HTML이 있으면 포털 기본 form은 HTML이고, MD는 정본·다운로드용 보조 form으로 남는다.

```bash
~/.claude/skills/b3os-report/scripts/render.sh report.md report.html "제목"
~/.claude/skills/b3os-report/scripts/publish.sh --title "제목" --author maintainer --summary "한줄요약" --md report.md --html report.html
```
→ Telegram `.html` 첨부(아이폰 Safari) + /reports 포털 둘 다 가능.

## 왜
the team lead는 주로 아이폰에서 읽는다. 표·차트가 모바일에서 깨지지 않게 **SVG**로, 매 보고서 CSS 재발명 없이 **한 테마**로 통일. MD 소스를 남겨 추적·재렌더 가능. (메모리 규칙: 보고서=MD→HTML+SVG iPhone.)

## 렌더러가 지원하는 MD
`#`~`####` 헤딩 · `**굵게**` `*기울임*` `` `코드` `` · 표(`| |`) · `-`/`*`/`1.` 목록 · `>` 인용(=강조 박스) · `---` 구분선 · `[텍스트](url)` · 코드펜스 ```` ``` ```` · **`<svg>…</svg>` 원문 통과**(차트는 SVG로 직접 그려 넣으면 그대로 렌더).

## 차트는 SVG로 (passthrough)
바차트 등은 MD 안에 인라인 SVG로 직접 작성한다(렌더러가 통과시킴). 가로형 바 예시:
```html
<svg viewBox="0 0 400 60"><g font-size="11" fill="#475467">
  <text x="0" y="22">솔로</text><rect x="80" y="12" width="40" height="13" fill="#15803d" rx="2"/><text x="124" y="22" fill="#172033">58s</text>
  <text x="0" y="42">harness</text><rect x="80" y="32" width="160" height="13" fill="#c2410c" rx="2"/><text x="244" y="42" fill="#172033">92s</text>
</g></svg>
```
라이트 기본 색 토큰: 좋음=`#15803d`(초록), 주의=`#c2410c`(주황), 경고=`#b42318`(빨강), 강조=`#a15c00`(황토), 링크/제목=`#1d4ed8`(파랑), 본문=`#172033`, 배경=`#f7f9fc`, 카드=`#ffffff`.

SVG는 라이트 배경에서 읽히도록 밝은 카드와 진한 글자색을 사용한다. 중첩 wrapper가 필요하면 `<figure>…<svg>…</svg></figure>`를 우선 사용한다. 렌더러는 `<svg>`, `<figure>`, `<div>` raw block의 같은 태그 중첩을 depth 기준으로 통과시킨다.

복잡한 가로 SVG는 iPhone에서 축소하거나 좌우 스크롤시키지 않는다. 같은 `<figure>` 안에 모바일 세로 카드와 데스크톱 SVG를 함께 두면 표준 테마가 640px에서 자동 전환한다.

```html
<figure>
  <figcaption>한눈에 보기 · 모바일은 세로 카드, 데스크톱은 전체 다이어그램</figcaption>
  <div class="mobile-infographic" role="group" aria-label="모바일 요약">
    <div class="mi-card mi-blue"><h4>단계 1</h4><p>핵심 설명</p></div>
    <div class="mi-card mi-green"><h4>단계 2</h4><p>핵심 설명</p></div>
  </div>
  <svg class="desktop-infographic" viewBox="0 0 760 300" role="img" aria-label="전체 다이어그램">…</svg>
</figure>
```

사용 가능한 의미색 class: `mi-blue`, `mi-cyan`, `mi-green`, `mi-amber`, `mi-orange`, `mi-red`, `mi-violet`.

## 컨벤션
- 맨 위 `# 제목` + 메타줄(일시·owner). 첫 `>` 인용 = "한 줄 결론"(노랑 박스로 강조됨).
- 수치 비교는 표 + SVG 바차트 둘 다.
- 끝에 소스 MD 경로 한 줄.
- 최종 보고 전에는 "필요한 영어 용어는 살렸는가 / 장 제목과 실행 계획은 자연스러운 한국어인가 / 용어 첫 등장은 설명했는가"를 확인한다.

## 예제
`examples/harness-pilot-report.md` (소스) → `examples/harness-pilot-report.html` (렌더 결과). 실제 harness 파일럿 보고서.

## 살아있는 스킬
더 나은 차트(자동 바차트 생성기)·레이아웃·호스팅 자동링크는 계속 업뎃(§11 팀 스킬). 테마=`assets/theme.css`(단일 출처, 렌더 시 인라인됨).
