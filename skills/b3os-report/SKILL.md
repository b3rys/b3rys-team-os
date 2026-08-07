---
name: b3os-report
description: b3rys 팀 표준 보고서 스킬. 모든 보고서는 MD를 소스로 먼저 쓰고 → 아이폰에서 읽기 좋은 자체완결 반응형 HTML+SVG로 렌더한다. 사용 시점 — "보고서 써줘", "report", "팀 보고서", "결과 정리해서 보고", "테스트/리뷰/분석 보고서", MD를 HTML로 렌더. owner=maintainer.
trigger: publish to `/reports`
entry: scripts/publish.sh
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
- **/reports 게시는 컨펌 없이 진행한다** (the team lead 2026-08-01 — 2026-06-07 의 "컨펌 필수"를 뒤집음). `/reports` 는 팀 내부 포털이라 approval gate 대상이 아니다. **팀 밖으로 나가는 것(공개 포스팅·외부 이메일/DM·서드파티 API)은 그대로 승인 대상이다.**

## 문체 원칙 — humanize-korean 최종 패스 (the team lead 2026-06-10)
- 보고서는 **무조건 한글화하지 않는다**. 업계 표준 용어, 제품명, 모델명, API 이름, 검색/평가 용어처럼 영어가 더 정확한 표현은 살린다.
- 대신 한국어 독자가 자연스럽게 읽을 수 있게 아래 기준으로 최종 검수한다. (`humanize-korean` 스킬을 이미 설치해 둔 사람은 그걸 써도 된다 — ★이 저장소에 포함되어 있지 않고 `install.sh`가 설치하지도 않는 외부 스킬★이다.)
- 첫 등장 용어는 `영어 용어(한국어 뜻)`으로 설명한다. 이후에는 문맥상 자연스러운 쪽을 쓴다.
- 장 제목·실행 계획·판단 문장은 한국어 흐름을 기본으로 한다. `Result`, `Decision`, `Step`, `Default criteria` 같은 기계적 영어 라벨은 그대로 남기지 말고 필요한 경우 한국어로 풀어쓴다.
- 영어를 억지로 한국어로 바꾸지 않는다. 목표는 "영어 제거"가 아니라 **의미 보존 + 자연스러운 한국어 리듬**이다.
- 수치·날짜·고유명사·직접 인용은 바꾸지 않는다.

## 단계
1. **MD 소스 먼저** — Markdown 작성(`reports/<주제>-<YYYYMMDD>/<name>.md`). 재편집·버전관리·재렌더 원본.
2. **최종 윤문** — 렌더 전에 위 “문체 원칙” 기준으로 번역투·기계적 병렬·영어 라벨 남발을 줄인다. 내용 추가/삭제가 아니라 문체·리듬·표현만 다듬는다. (외부 `humanize-korean` 스킬이 설치돼 있으면 그걸로 돌려도 된다.)
3. **HTML 렌더** — `scripts/render.sh <md> [out.html] [제목]` → 아이폰 반응형 HTML+SVG(자체완결, **다크/라이트 테마 토글**).
4. **포털 게시** — ★원본 md/html 은 `reports/` 밖(작업 폴더·임시 폴더)에 두고 publish.sh 가 복사하게 한다.★
   이미 `reports/<id>/` 안에 써 두면 자기 자신을 복사하다 `SameFileError` 로 죽는다(lui 실측 2026-08-01).
   `scripts/publish.sh --title "T" --author maintainer --summary "S" --md a.md --html a.html` → team-collab `reports/`에 복사 + 등록 → **<dashboard-url>/reports** 목록에 바로 뜬다. HTML이 있으면 포털 기본 form은 HTML이고, MD는 정본·다운로드용 보조 form으로 남는다.

두 스크립트는 **이 저장소 안에** 있다. clone 루트에서 실행한다(`install.sh`는 `~/.claude/skills/b3os`만 연결하므로 `~/.claude/skills/b3os-report/…` 경로는 없다).

```bash
skills/b3os-report/scripts/render.sh report.md report.html "제목"
skills/b3os-report/scripts/publish.sh --title "제목" --author maintainer --summary "한줄요약" --md report.md --html report.html
```
→ Telegram `.html` 첨부(아이폰 Safari) + /reports 포털 둘 다 가능.

## 왜
the team lead는 주로 아이폰에서 읽는다. 표·차트가 모바일에서 깨지지 않게 **SVG**로, 매 보고서 CSS 재발명 없이 **한 테마**로 통일. MD 소스를 남겨 추적·재렌더 가능. (메모리 규칙: 보고서=MD→HTML+SVG iPhone.)

## 기본 작동 방식 — 팀원들이 따라야 할 기준
- 사용자가 “보고서/리포트/문서로 정리”를 요청하면 기본은 **MD 원본 작성 → HTML 렌더 → /reports 등록**까지다. 단순 현황 답변은 메신저 답변으로 끝낸다.
- 보고서 첫 화면은 항상 `# 제목` + 메타줄 + 첫 `>` 인용의 **한 줄 결론**으로 시작한다. 독자가 iPhone에서 열었을 때 5초 안에 “무슨 문서인지/결론이 뭔지” 알아야 한다.
- 영어 약어·전문 용어가 처음 나오면 별도 풀이 섹션을 만들기보다 **원래 표현과 짧은 설명을 괄호로 바로 붙인다**. 예: `API(Application Programming Interface, 프로그램끼리 요청을 주고받는 접점)`, `ARR(Annual Recurring Revenue, 연간 반복 매출)`. 모든 용어를 다 풀지 말고 독자가 막힐 가능성이 높은 약어·전문어만 고른다.
- 수식·개발·경제·투자처럼 문장 안 괄호만으로 부족한 복잡한 개념은, 해당 문단 바로 아래에 **5줄 이내의 작은 풀이 박스**를 붙인다. 이때만 `gd-explain-like-5` 흐름을 축약 적용한다: 원래 표현 → 쉬운 해석 → 왜 중요한지.
- 팀원이 디자인 기준을 모르겠으면 먼저 `/reports/file/differential-privacy/html`을 reference로 본다. 그 보고서의 장점은 **다크 editorial 톤, 짧은 섹션, 카드형 설명, 복잡한 개념을 바로 아래에서 짧게 풀어주는 방식**이다.
- 단, `differential-privacy`의 KaTeX/수식 전용 HTML을 그대로 복사하지 않는다. 일반 보고서는 이 스킬의 renderer와 `assets/theme.css`를 source of truth로 쓴다.

## 디자인 기준
- 기본 톤은 `differential-privacy` 보고서처럼 **다크 editorial 페이지**다: 큰 종이 카드가 아니라 어두운 캔버스 위 900~960px 본문, 초록 accent, 넉넉한 섹션 여백, 카드형 표/인용/코드 블록.
- 폭 규격: 표준은 **960px 상한**이다. 표·코드가 많은 보고서는 960px이 적당하고, 더 넓히면 line length가 길어져 읽기가 흐트러진다. 차분 프라이버시 같은 순수 해설형은 820~880px이 더 좋을 수 있지만, 기본 스킬은 표준 960px을 쓴다.
- 색 규칙: **초록/세이지를 primary accent**, amber/orange를 보조 강조로 쓴다. 하늘색/파랑은 다크 그린 배경에서 튀므로 링크·코드 같은 보조 정보에만 muted sage 톤으로 제한한다.
- 배경은 아주 연한 grid texture를 기본으로 쓴다. 라이트 모드는 종이 느낌이 나도록 은은하게 보이게 하고, 다크 모드는 같은 grid를 훨씬 낮은 대비로 넣어 깊이만 만든다. 본문 가독성을 해치면 안 된다.
- 탭이 필요하면 큰 pill 버튼을 쓰지 않는다. `report-tabs/report-tab`의 **작은 segmented navigation**을 써서 탭임은 인지되지만 본문보다 튀지 않게 한다. 세부 컴포넌트 예시는 `references/ui-components.md`를 따른다.
- **라이트 모드는 유지**한다. 다만 라이트도 같은 구조와 여백을 쓰고 색만 밝은 토큰으로 바꾼다.
- 보고서가 특수 구조를 가진 경우(예: CSS-only 탭 보고서)는 표준 render로 덮어쓰지 말고, 기존 구조를 유지한 채 공통 테마 CSS만 교체한다.

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
