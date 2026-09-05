// 모바일 전환·가로 스크롤을 잰다. 창을 줄이지 않고 iframe 으로 뷰포트를 강제한다.
// (크롬 창은 500px 아래로 안 줄어들어서 "390 에서 봤다" 가 거짓이 되는 사고가 있었다)
//
// 렌더된 보고서 HTML 을 브라우저에서 열고 실행한다. await 를 쓰므로 콘솔에 그대로 붙여넣는다.
//
// ★한계★ desktop-infographic 만 센다 — 모바일 카드와 짝인 그림이 대상이라 그렇다.
// 그림 자체의 결함은 measure-diagram.js 가 본다.
async function probe(w) {
  const f = document.createElement('iframe');
  f.style.cssText = `position:fixed;left:-9999px;top:0;width:${w}px;height:1400px;border:0`;
  f.src = location.href;
  document.body.appendChild(f);
  await new Promise(r => f.onload = r);
  await new Promise(r => setTimeout(r, 500));
  const d = f.contentDocument, win = f.contentWindow, vis = el => win.getComputedStyle(el).display !== 'none';
  const mob = [...d.querySelectorAll('.mobile-infographic')], desk = [...d.querySelectorAll('svg.desktop-infographic')];

  // 표·코드블록이 자기 스크롤 컨테이너를 갖고 있나 (없으면 내용이 잘려 못 읽는다)
  // 페이지는 안 밀리는데 내용만 잘리는 상태를 잡으려는 것이다.
  const cut = [];
  d.querySelectorAll('table,pre').forEach((el, i) => {
    if (el.getBoundingClientRect().width <= w) return;
    let n = el.parentElement, wrap = null;
    while (n && n !== d.body) { const ov = win.getComputedStyle(n).overflowX;
      if (ov === 'auto' || ov === 'scroll') { wrap = n; break } n = n.parentElement }
    if (!wrap || wrap.scrollWidth <= wrap.clientWidth) cut.push({i, tag:el.tagName});
  });

  const de = d.documentElement;
  const out = { width:w, mobileCards:`${mob.filter(vis).length}/${mob.length}`,
    desktopSvgs:`${desk.filter(vis).length}/${desk.length}`,
    pageHScroll: de.scrollWidth - de.clientWidth, clippedNoScroller: cut };
  f.remove();
  return out;
}
JSON.stringify([await probe(390), await probe(640), await probe(1024)], null, 1)
