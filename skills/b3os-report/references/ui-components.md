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

> **아래 마크업을 손으로 짜지 마라.** MD 에 `<div id="p0" data-tab="0부 구조"></div>` 표식만 넣으면
> 렌더러가 이 마크업과 `:target` 전환 규칙을 만든다. 쓰는 법·검사 목록은 `SKILL.md` 「긴 보고서는 탭으로 나눈다」.
> 아래는 렌더러가 무엇을 내놓는지, 그리고 이미 손으로 짜 둔 보고서를 고칠 때의 기준이다.

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
- 탭이 많아도 두 줄로 접지 않는다. **한 줄 horizontal scroll**이 기본이다. sticky 상태에서 본문을 가리지 않게 얇게 유지한다.

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

- `.tab-shell`: `position: sticky`, `top:57px`, `display:flex`, `overflow-x:auto`, `scrollbar-width:none`
- `.tab-nav`: `flex-wrap:nowrap`
- `.tab-btn`: `white-space:nowrap`, `min-height:29px` 안팎
- `.tab-panel`: 기본 `display:none`, active만 `display:block`
```css
.tab-panel{display:none}
.tab-panel.active{display:block}
```

## 3. 텍스트 리듬 / 핵심 수치 카드

보고서는 나중에 발표자료로 바뀔 수 있어야 한다. 각 큰 섹션은 슬라이드 한 장으로 떼어도 이해되는 단위로 쓴다.

```html
<div class="lede">이 섹션의 핵심은 긴 문장을 한 칸씩 기다리지 않고 전체 관계를 한 번에 보는 계산 구조다.</div>
<div class="stat-grid" aria-label="핵심 요약">
  <div class="stat-card"><b>문제</b><span>무엇이 막혔는지</span></div>
  <div class="stat-card"><b>해법</b><span>어떤 구조를 바꿨는지</span></div>
  <div class="stat-card"><b>대가</b><span>무엇이 새 병목이 됐는지</span></div>
</div>
```

기준:

- `lede`: 섹션 첫 문단이 너무 길 때 쓰는 한 단락 요약. 렌더러 passthrough(원문 통과) 규칙에 맞춰 최상위에서는 `<div class="lede">`로 쓴다.
- `stat-grid`: 수치만이 아니라 문제·해법·대가 같은 발표용 요약 카드에도 사용
- 카드 하나는 “제목 1줄 + 설명 1~2줄”로 제한한다

## 4. 표

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

### 다크 모드 입체감

다크 배경에서는 바깥 그림자만 키워도 검은 캔버스에 묻힌다. 표·인용·코드·figure·요약 카드는 `surface-shadow` 계열 토큰을 사용해 **아래 방향의 짧은 그림자 + 위쪽 1px inset highlight + 분명한 외곽선**을 함께 만든다.

- 큰 표·인용·figure: `box-shadow: var(--surface-shadow)`
- 작은 stat/mobile 카드·코드: `box-shadow: var(--surface-shadow-soft)`
- 컴포넌트마다 임의의 검정 shadow 값을 만들지 않는다. 라이트/다크가 같은 구조로 전환되도록 테마 토큰을 쓴다.
- 배경 grid는 다크에서도 눈을 집중하면 보이는 수준이어야 한다. 본문이나 카드보다 먼저 보이면 과하다.

## 5. 한 줄 결론 / 풀이 박스

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

## 6. 영어 약어 / 전문 용어

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

## 7. 인포그래픽 / 다이어그램

복잡한 가로 SVG는 모바일에서 그대로 축소하지 않는다. 같은 figure 안에 모바일 카드와 데스크톱 SVG를 같이 둔다.

다이어그램은 보고서와 분리된 SaaS 슬라이드처럼 보이면 안 된다. **테마 토큰을 쓰는 `diagram-flow` kit**를 기본으로 쓴다.

```html
<figure>
  <figcaption>한눈에 보기 · 모바일은 세로 카드, 데스크톱은 전체 다이어그램</figcaption>
  <div class="mobile-infographic" role="group" aria-label="모바일 요약">
    <div class="mi-card mi-green"><h4>1단계</h4><p>핵심 설명</p></div>
    <div class="mi-card mi-amber"><h4>2단계</h4><p>주의할 점</p></div>
  </div>
  <svg class="desktop-infographic diagram-flow" viewBox="0 0 760 220" role="img" aria-label="전체 다이어그램">
    <defs>
      <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0 0L10 5L0 10Z" class="diagram-muted"/>
      </marker>
    </defs>
    <text x="380" y="24" text-anchor="middle" class="diagram-title">작동 흐름</text>
    <g transform="translate(32,58)">
      <rect class="diagram-node diagram-node-primary" width="150" height="92" rx="14"/>
      <text x="20" y="34" class="diagram-text">1 · 발견</text>
      <text x="20" y="62" class="diagram-muted">후보를 넓게 수집</text>
    </g>
    <path d="M190 104H246" class="diagram-line" marker-end="url(#flow-arrow)"/>
    <g transform="translate(256,58)">
      <rect class="diagram-node diagram-node-warm" width="150" height="92" rx="14"/>
      <text x="20" y="34" class="diagram-text">2 · 검증</text>
      <text x="20" y="62" class="diagram-muted">본문과 조건 확인</text>
    </g>
  </svg>
</figure>
```

다이어그램 기준:

- 카드형 flow/sequence/architecture diagram은 `svg.diagram-flow`를 쓴다.
- 색은 `diagram-node`, `diagram-node-primary`, `diagram-node-warm`, `diagram-node-danger`와 `diagram-line*` class로 구분한다.
- 단계 구분은 여러 파스텔 박스를 남발하지 말고 **neutral 면 + 더 분명한 전체 테두리 + 작은 dot/선**을 기본으로 한다.
- 사각형 node의 왼쪽 모서리나 왼쪽 edge에 두꺼운 accent bar를 붙이지 않는다. rounded rectangle과 겉돌고 모서리 밖으로 삐져나와 보인다. 강조는 전체 stroke color/width, 작은 dot, connector line, badge로 처리한다.
- 기본 색은 밝은 professional sage/gold/red를 쓴다. 큰 면을 칠하지 말고 작은 강조와 테두리에만 사용한다.
- 금지: `#eff6ff`, `#eef2ff`, `#93c5fd`, `#1d4ed8`, `#2563eb`, `#faf5ff`, `#c4b5fd`, `#7c3aed` 같은 blue/violet slide palette를 기본 도식 색으로 쓰지 않는다.

### 표현 패턴 reference

다이어그램/인포그래픽은 한 가지 flowchart만 고집하지 않는다. 내용 구조에 맞춰 아래 패턴을 고른다.

| 패턴 | 쓸 때 | 구조 |
|---|---|---|
| Horizontal flowchart | 요청·데이터가 왼쪽에서 오른쪽으로 흘러갈 때 | 3~5개 노드 + 짧은 arrow. 단계 설명은 노드 안 1~2줄로 제한 |
| Vertical flowchart | 절차·승인·게이트처럼 위에서 아래로 내려가는 흐름 | 세로 카드 stack + 아래 화살표. 모바일/좁은 화면에 특히 좋음 |
| Branching flow / decision tree | 조건에 따라 경로가 갈라질 때 | 질문 노드 → yes/no 또는 option A/B/C 가지. 조건 label은 선 위에 짧게 |
| Tree / hierarchy | 조직·권한·파일 구조·개념 분류 | root → branch → leaf. 같은 level은 같은 y축/색상 규칙 유지 |
| Loop / operating cycle | 반복 운영 체계·학습 루프 | 중앙 카드 + 원형 단계 노드 + curved arrows. 점선은 보조/학습 루프에만 |
| Swimlane | 역할·주체별 책임이 나뉘는 프로세스 | lane별 row/column을 나누고 handoff만 arrow로 연결 |
| Architecture map | 시스템 구성·데이터 흐름 | 입력 채널 → 중앙 bounded context → 런타임/저장소 |
| Layer stack | 서버·DB·worker처럼 층이 있는 구조 | 큰 boundary 안에 row/column layer 배치 |
| Timeline / lineage | 논문·릴리즈·사건 순서 | 하나의 report-card 안에 neutral axis를 두고 milestone을 위/아래로 stagger 배치한다. 날짜·이름·venue는 짧게, 인과가 아니라 순서임을 caption에 명시한다. dark/light 모두 CSS var로 전환되게 hard-coded white/blue/violet fill을 쓰지 않는다. |
| Matrix / quadrant | 두 판단 축으로 위치 비교 | label을 점 위에 길게 쓰지 말고 작은 callout으로 분리 |
| Funnel / narrowing | 후보를 줄여 선택하거나 우선순위를 좁힐 때 | 넓은 단계 → 좁은 단계. 면을 과하게 채우지 말고 outline 중심 |
| Radial / hub-and-spoke | 하나의 중심 개념과 주변 요소 관계 | 중앙 node + 주변 작은 node. 선은 얇게, 중심만 강조 |
| Sankey-lite / weighted flow | 흐름의 양·비중이 중요한 경우 | 굵기 차이를 2~3단계만 사용. 복잡한 Sankey는 이미지/별도 도구 권장 |

첨부 reference로 확인한 좋은 형태:

- 운영 루프형: 중앙 설명 카드 주변에 1~9 원형 노드를 배치하고, 실선/점선 curved arrow로 순환과 learning loop를 구분한다.
- 아키텍처형: 좌측 입력 채널, 중앙 서버 boundary, 우측 runtime, 하단 DB를 큰 영역으로 분리한다. box가 많아도 hierarchy가 보여야 한다.
- 비교 map형: 점과 설명이 겹치지 않게 callout을 분리하고, 추천안만 더 선명하게 표시한다.
- 세로 플로우차트형: 승인·검증·배포처럼 순서가 중요한 절차는 가로로 억지 배치하지 말고 위→아래로 읽히게 만든다.
- 트리형: “무엇의 하위 항목인가”가 핵심이면 flow arrow보다 tree branch가 낫다. 원인 분석, 권한 체계, 문서 목차, 파일 구조에 쓴다.
- Swimlane형: 팀장·에이전트·서버·DB처럼 주체가 다르면 lane을 나눠 책임과 handoff를 먼저 보이게 한다.
- Funnel형: 후보군을 좁히는 리서치/우선순위 판단은 단계별 탈락 이유를 짧게 적고 마지막 선택지만 강조한다.
- Radial형: 하나의 전략/제품/서버를 중심에 두고 주변 기능을 보여줄 때 쓴다. 모든 주변 노드를 같은 무게로 보이면 안 되고 핵심 3~5개만 둔다.
- 복잡한 Sankey/정교한 네트워크 그래프는 SVG로 억지로 만들지 않는다. 직접 그린 이미지나 별도 시각화 도구를 쓰고, 보고서에는 해설과 legend를 붙인다.
- 허용: blue는 링크·코드·보조 정보에만 제한한다. 도식의 primary flow는 green/sage, secondary는 amber다.

## 8. 이미지 / 스크린샷

이미지는 보고서 밖에서 붙인 첨부물이 아니라 본문 컴포넌트처럼 다룬다.

```html
<figure>
  <figcaption>승인 팝업 예시 · 핵심 문구가 실제로 어디까지 보이는지 확인</figcaption>
  <img class="report-image" src="assets/popup.png" alt="승인 팝업에서 명령 일부가 보이는 화면">
  <p class="media-note">이미지는 설명을 대신하지 않는다. 본문에서 왜 이 화면이 판단 근거인지 한 문단으로 적는다.</p>
</figure>
```

기준:

- 스크린샷은 `figure + figcaption + alt`를 기본으로 한다.
- 이미지 안의 텍스트가 작으면 본문에 핵심 문구를 다시 적는다.
- 두 이미지를 비교할 때는 `.image-grid`를 쓰고 모바일에서는 한 열로 접는다.
- 발표자료 전환을 고려해 한 figure는 “한 메시지”만 담는다. 한 이미지에 여러 주장과 표식을 과하게 넣지 않는다.

## 9. 색상 기준

- Primary: green/sage
- Secondary: amber/orange
- Red: 위험·삭제·실패
- Blue/cyan: 기본 accent로 쓰지 말고 링크·보조 정보에만 제한
- Grid texture: 라이트 모드는 `--grid`를 은은하게 보여 종이 질감을 만들고, 다크 모드는 낮은 대비를 유지하되 완전히 사라지지 않을 정도로 보이게 한다.

새 보고서에서 하늘색 제목/탭/강조를 기본값으로 쓰지 않는다.

## 10. 최종 검토 체크리스트

- [ ] `# 제목` + 메타줄 + 첫 `>` 한 줄 결론이 있는가
- [ ] 영어 약어 첫 등장에 괄호 풀이가 있는가
- [ ] 복잡한 개념만 5줄 이내 풀이 박스로 뺐는가
- [ ] 탭이 큰 버튼처럼 튀지 않고 blurred row로 보이는가
- [ ] 표가 960px 안에서 읽히고 모바일에서 깨지지 않는가
- [ ] 다크 모드에서 표·인용·카드가 배경과 구분되고 위쪽 highlight와 아래쪽 shadow가 함께 보이는가
- [ ] 다크/라이트 둘 다 실제 `/reports/file/<id>/html`에서 확인했는가
