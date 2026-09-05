// 렌더된 보고서 HTML 을 브라우저에서 열고 이 코드를 실행한다(DevTools 콘솔 또는 CDP).
// 토큰 계산이 아니라 getComputedStyle + getBBox 로 "실제 그려진 값"을 잰다.
// 그래서 SVG 안 하드코딩 색(fill="#0b0f14")도 걸린다.
//
// render.test.mjs 의 대비 검사와 겹치지 않는다.
//   render.test.mjs — theme.css 토큰을 계산한다. CSS 회귀를 CI 에서 잡는다.
//   이 스크립트    — 그려진 결과를 본다. 하드코딩 색·넘침·여백·marker 를 잡는다.
//
// ★재는 사람이 알아야 하는 한계 셋★
//   1. 글자를 담는 rect 를 좌표로 추정한다. 겹친 rect 가 여러 개면 첫 번째를 고른다.
//   2. <image>·패턴 위에 얹은 글자는 배경색을 못 읽어 페이지 배경으로 떨어진다.
//   3. ★없는 테마 이름을 걸면 어느 규칙도 안 맞아 :root 로 떨어진다.★ 그러면 그 자리를
//      안 재고도 '통과' 로 집계된다(2026-09-06 실측 — orange-dark/light 로 dark 를 두 번
//      더 재고 "4개 테마" 로 보고했다). 아래 themeApplies() 가 그것을 SKIPPED 로 남긴다.
(() => {
  const lum = c => { const m=c.match(/\d+\.?\d*/g).map(Number);
    const f=v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4};
    return .2126*f(m[0])+.7152*f(m[1])+.0722*f(m[2]); };
  const ratio = (a,b) => { const A=lum(a),B=lum(b);
    return +(((Math.max(A,B)+.05)/(Math.min(A,B)+.05))).toFixed(2); };

  const root = document.documentElement, before = root.getAttribute('data-theme');
  const bodyBg = () => getComputedStyle(document.body).backgroundColor;

  // :root 만 걸린 상태의 배경색 — 없는 테마를 판별하는 기준값
  root.removeAttribute('data-theme');
  const rootBg = bodyBg();

  // 재려는 테마가 실제로 정의돼 있나. 걸었는데 배경이 :root 와 같으면 안 걸린 것이다.
  // dark 는 :root 자체라 예외로 둔다.
  const themeApplies = (theme) => {
    if (theme === 'dark') return true;
    root.setAttribute('data-theme', theme);
    return bodyBg() !== rootBg;
  };

  const THEMES = ['dark', 'light'];   // theme.css 에 정의된 것만. 늘릴 때 여기에 적는다.
  const report = {};

  for (const theme of THEMES) {
    if (!themeApplies(theme)) {
      // ★결과에서 빼지 않는다.★ 조용히 빠지면 개수만 보고 넓게 쟀다고 착각한다.
      report[theme] = 'SKIPPED — theme.css 에 이 테마 정의가 없다(:root 로 떨어짐)';
      continue;
    }
    root.setAttribute('data-theme', theme);
    const pageBg = bodyBg();
    const F = { lowContrast:[], hardcoded:[], viewBoxOverflow:[], tightBox:[], missingMarker:[] };

    // ★diagram-flow 와 desktop-infographic 을 둘 다 본다.★ desktop-infographic 은 모바일
    // 카드와 짝일 때만 붙는다 — 그 하나만 보면 카드 없는 그림이 통째로 빠진다
    // (llm-book 실측: 짝 46개 · diagram-flow 단독 4개).
    const svgs = [...new Set([
      ...document.querySelectorAll('svg.diagram-flow'),
      ...document.querySelectorAll('svg.desktop-infographic'),
    ])];

    svgs.forEach((svg, i) => {
      const fig = i + 1, W = svg.viewBox.baseVal.width;
      const rects = [...svg.querySelectorAll('rect')];

      // ① 화살표 marker 가 실제로 정의돼 있나 (id 충돌 시 화살표가 사라진다)
      svg.querySelectorAll('[marker-end],[marker-start]').forEach(p => {
        ['marker-end','marker-start'].forEach(a => {
          const v = p.getAttribute(a); if (!v) return;
          const id = v.replace(/url\(#|\)/g,'');
          if (!svg.querySelector(`marker#${CSS.escape(id)}`)) F.missingMarker.push({fig,id});
        });
      });

      // ② 하드코딩 색 — class 없이 fill/stroke 를 직접 준 요소
      svg.querySelectorAll('[fill],[stroke]').forEach(el => {
        ['fill','stroke'].forEach(a => {
          const v = el.getAttribute(a);
          if (v && /^#|^rgb/.test(v)) F.hardcoded.push({fig, tag:el.tagName, [a]:v});
        });
      });

      svg.querySelectorAll('text').forEach(t => {
        let b; try { b = t.getBBox() } catch { return }
        const txt = t.textContent.slice(0,40);

        // ③ viewBox 밖으로 나간 글자 (SVG text 는 줄바꿈이 없어 그대로 잘린다)
        if (b.x + b.width > W - 2) F.viewBoxOverflow.push({fig, txt, right:+(b.x+b.width).toFixed(1), limit:W});

        // 이 글자를 담고 있는 rect 찾기 (한계 1 — 좌표 추정)
        const host = rects.find(r => {
          const x=+r.getAttribute('x'), y=+r.getAttribute('y');
          const w=+r.getAttribute('width'), h=+r.getAttribute('height');
          return b.y>=y-2 && b.y+b.height<=y+h+2 && b.x>=x-1 && b.x<x+w;
        });

        const bg = host ? getComputedStyle(host).fill : pageBg;
        const fg = getComputedStyle(t).fill;
        const r  = ratio(fg, bg);
        const fs = parseFloat(getComputedStyle(t).fontSize);
        const fw = +getComputedStyle(t).fontWeight;
        // WCAG AA: 큰 글씨(18.66px+bold 또는 24px+)는 3.0, 그 외 4.5
        const need = (fs>=18.66 && fw>=700) || fs>=24 ? 3.0 : 4.5;
        if (r < need) F.lowContrast.push({fig, txt, ratio:r, need, fg, bg,
          onAccent: !!host && (host.getAttribute('class')||'').includes('accent')});

        // ④ 상자 여백 (diagrams.md 권장 좌우 24px, 최소선 6px)
        if (host) {
          const x=+host.getAttribute('x'), w=+host.getAttribute('width');
          const pad = x + w - (b.x + b.width);
          if (pad < 6) F.tightBox.push({fig, txt, padRight:+pad.toFixed(1)});
        }
      });
    });
    report[theme] = { svgsMeasured: svgs.length, ...F };
  }

  before ? root.setAttribute('data-theme', before) : root.removeAttribute('data-theme');
  return report;
})()
