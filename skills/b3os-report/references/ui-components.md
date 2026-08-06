# b3os-report UI components reference

이 문서는 팀원이 보고서를 만들 때 그대로 참고할 기본 UI 조각이다. source of truth는 `assets/theme.css`이며, 아래 class 이름은 그 CSS에 맞춰져 있다.

## 1. 레이아웃 폭

기본 보고서 폭은 960px이다.

- 표·코드·비교표가 많은 보고서: 960px 유지
- 순수 해설형 긴 글: 필요하면 820~880px 별도 custom 가능
- 더 넓히는 것은 기본 금지: line length가 길어져 읽기 피로가 커진다

```html
<div class="report-shell">
  <div class="wrap">
    ...
  </div>
</div>
```

legacy/custom HTML이 `body > .wrap`만 쓰는 경우도 테마가 960px로 잡아준다.

## 2. 탭 — 조용한 blurred segmented row

큰 pill 버튼처럼 튀게 만들지 않는다. 탭이라는 것은 인지되되 본문보다 조용해야 한다.

```html
<nav class="report-tabs" aria-label="보고서 탭">
  <a class="report-tab is-active" href="#panel-a" aria-current="page">요약</a>
  <a class="report-tab" href="#panel-b">상세</a>
</nav>
<section id="panel-a">...</section>
<section id="panel-b">...</section>
```

디자인 기준:

- 탭 행: blurred row, 얇은 border, 낮은 대비
- 선택 탭: 아래 초록 선 없음, 배경만 살짝 밝게
- 색: green/sage 중심, sky-blue 금지
- 모바일: 가로 스크롤 가능해야 함

특수 탭 보고서가 이미 `.tab-shell`, `.tab-nav`, `.tab-btn`, `.tab-panel.active`를 쓰면 그대로 유지한다. 표준 렌더로 덮어쓰지 말고 CSS만 맞춘다.

```html
<div class="tab-shell">
  <nav class="tab-nav" role="tablist">
    <a class="tab-btn active" role="tab" href="#panel-story" data-target="story">Story</a>
    <a class="tab-btn" role="tab" href="#panel-evidence" data-target="evidence">Evidence</a>
  </nav>
</div>
<section class="tab-panel active" id="panel-story">...</section>
<section class="tab-panel" id="panel-evidence">...</section>
```

필수 CSS 동작:

```css
.tab-panel{display:none}
.tab-panel.active{display:block}
```

## 3. 표

Markdown 표를 기본으로 쓴다. 테마가 자동으로 card table로 만든다.

```md
| 항목 | 판단 | 이유 |
|---|---|---|
| A | 유지 | 사용자가 이미 익숙함 |
| B | 변경 | 비용 대비 효과가 큼 |
```

표 기준:

- 숫자 비교는 표 + SVG 바차트가 좋다
- 너무 긴 설명은 표 안에 다 넣지 말고 표 아래 문단으로 분리
- 5열 이상이면 모바일에서 가로 스크롤되는지 확인

## 4. 한 줄 결론 / 풀이 박스

맨 위 첫 `>`는 한 줄 결론이다.

```md
> **한 줄 결론:** 지금 병목은 구현량이 아니라 승인 게이트다.
```

복잡한 개념은 문단 바로 아래에 5줄 이내 풀이 박스를 둔다. 모든 용어를 다 풀이하지 않는다.

```md
본문에서 RAG(Retrieval-Augmented Generation, 검색 증강 생성)가 처음 등장했다.

> **개념 해설 · RAG:** 모델이 답하기 전에 외부 문서를 검색해 함께 넣는 방식이다.  
> 장점은 최신 지식과 출처를 붙이기 쉽다는 점이다.  
> 단점은 검색기가 틀리면 답도 같이 흔들린다는 점이다.
```

## 5. 영어 약어 / 전문 용어

첫 등장 때 괄호로 원래 표현과 짧은 설명을 붙인다.

```md
API(Application Programming Interface, 프로그램끼리 요청을 주고받는 접점)
ARR(Annual Recurring Revenue, 연간 반복 매출)
RAG(Retrieval-Augmented Generation, 검색 증강 생성)
```

규칙:

- 독자가 막힐 가능성이 높은 약어·전문어만 고른다
- 쉬운 단어까지 모두 풀이하지 않는다
- 이미 괄호 풀이한 용어는 이후 문맥상 자연스러운 표현을 쓴다

## 6. 모바일/데스크톱 SVG 카드

복잡한 가로 SVG는 모바일에서 그대로 축소하지 않는다. 같은 figure 안에 모바일 카드와 데스크톱 SVG를 같이 둔다.

```html
<figure>
  <figcaption>한눈에 보기 · 모바일은 세로 카드, 데스크톱은 전체 다이어그램</figcaption>
  <div class="mobile-infographic" role="group" aria-label="모바일 요약">
    <div class="mi-card mi-green"><h4>1단계</h4><p>핵심 설명</p></div>
    <div class="mi-card mi-orange"><h4>2단계</h4><p>주의할 점</p></div>
  </div>
  <svg class="desktop-infographic" viewBox="0 0 760 300" role="img" aria-label="전체 다이어그램">...</svg>
</figure>
```

## 7. 색상 기준

- Primary: green/sage
- Secondary: amber/orange
- Red: 위험·삭제·실패
- Blue/cyan: 기본 accent로 쓰지 말고 링크·보조 정보에만 제한

새 보고서에서 하늘색 제목/탭/강조를 기본값으로 쓰지 않는다.

## 8. 최종 검토 체크리스트

- [ ] `# 제목` + 메타줄 + 첫 `>` 한 줄 결론이 있는가
- [ ] 영어 약어 첫 등장에 괄호 풀이가 있는가
- [ ] 복잡한 개념만 5줄 이내 풀이 박스로 뺐는가
- [ ] 탭이 큰 버튼처럼 튀지 않고 blurred row로 보이는가
- [ ] 표가 960px 안에서 읽히고 모바일에서 깨지지 않는가
- [ ] 다크/라이트 둘 다 실제 `/reports/file/<id>/html`에서 확인했는가
