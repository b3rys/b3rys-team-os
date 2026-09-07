#!/usr/bin/env node
// b3os-report — zero-dep Markdown → 자체완결 반응형 HTML(+SVG passthrough).
// 사용: node render.mjs <input.md> [output.html] [--title "제목"]
// 지원: # ## ### 헤딩 / **굵게** *기울임* `코드` / 표 / -·* 목록 / 1. 순서목록 /
//       > 인용 / --- 구분선 / [텍스트](url) / 코드펜스 ``` / <svg>…</svg> 원문 통과 /
//       <div id="x" data-tab="라벨"></div> 탭 구분 (2개 이상일 때만 탭이 생긴다).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let title = null;
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--title") { title = args[++i]; } else positional.push(args[i]);
}
const inPath = positional[0];
if (!inPath) { console.error("usage: render.mjs <input.md> [output.html] [--title T]"); process.exit(1); }
const outPath = positional[1] || inPath.replace(/\.md$/i, "") + ".html";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inline(t) {
  // 코드 스팬 보호
  const spans = [];
  t = t.replace(/`([^`]+)`/g, (_, c) => { spans.push(`<code>${esc(c)}</code>`); return `__CODE_SPAN_${spans.length - 1}__`; });
  t = esc(t);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  t = t.replace(/__CODE_SPAN_(\d+)__/g, (_, i) => spans[+i]);
  return t;
}

const lines = readFileSync(inPath, "utf8").replace(/\r\n/g, "\n").split("\n");
const out = [];
const tabs = [];   // 탭 구분 표식 — {id, label, at}. at = out 배열에서 그 탭이 시작하는 자리.
let i = 0;
while (i < lines.length) {
  let line = lines[i];
  const t = line.trim();

  // 탭 구분 표식: <div id="개요" data-tab="개요"></div>
  // ★아래 passthrough 보다 먼저 본다★ — 순서가 바뀌면 통과 블록이 먼저 먹어 표식이 사라진다.
  if (/^<div\b[^>]*\bdata-tab=/i.test(t)) {
    if (!/<\/div>\s*$/.test(t)) {
      console.error(`탭 표식은 한 줄로 닫아야 한다: ${t}`); process.exit(1);
    }
    const id = (t.match(/\bid="([^"]+)"/) || [])[1];
    const label = (t.match(/\bdata-tab="([^"]*)"/) || [])[1];
    if (!id || !label) { console.error(`탭 표식에 id 와 data-tab 이 둘 다 있어야 한다: ${t}`); process.exit(1); }
    if (tabs.some((x) => x.id === id)) { console.error(`탭 id 중복: ${id}`); process.exit(1); }
    tabs.push({ id, label, at: out.length });
    out.push(`<div id="${id}"></div>`);   // 표식 자체가 앵커로 남는다 → 목차의 #id 링크가 그대로 산다.
    i++; continue;
  }
  // SVG / figure / div 원문 블록 통과. 같은 태그가 중첩돼도 실제 depth가 0이 될 때까지 읽는다.
  if (/^<(svg|figure|div)\b/i.test(t)) {
    const tag = t.match(/^<(\w+)/)[1];
    const open = new RegExp(`<${tag}\\b`, "gi");
    const close = new RegExp(`</${tag}>`, "gi");
    const selfClosing = new RegExp(`<${tag}\\b[^>]*\\/>`, "gi");
    const buf = [];
    let depth = 0;
    do {
      const raw = lines[i];
      const opens = (raw.match(open) || []).length;
      const closes = (raw.match(close) || []).length;
      const selfClosed = (raw.match(selfClosing) || []).length;
      depth += opens - closes - selfClosed;
      buf.push(raw); i++;
    } while (i < lines.length && depth > 0);
    out.push(buf.join("\n")); continue;
  }
  // 코드펜스
  if (/^```/.test(t)) {
    const buf = []; i++;
    while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(esc(lines[i])); i++; }
    i++; out.push(`<pre><code>${buf.join("\n")}</code></pre>`); continue;
  }
  // 빈 줄
  if (t === "") { i++; continue; }
  // hr
  if (/^---+$/.test(t)) { out.push("<hr>"); i++; continue; }
  // 헤딩
  const h = t.match(/^(#{1,4})\s+(.*)$/);
  if (h) { const n = h[1].length; out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
  // 표
  if (t.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
    const row = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    const head = row(line); i += 2;
    const body = [];
    while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") { body.push(row(lines[i])); i++; }
    let h2 = "<table><thead><tr>" + head.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>";
    for (const r of body) h2 += "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>";
    out.push(h2 + "</tbody></table>"); continue;
  }
  // 인용
  if (/^>\s?/.test(t)) {
    const buf = [];
    while (i < lines.length && /^>\s?/.test(lines[i].trim())) { buf.push(inline(lines[i].trim().replace(/^>\s?/, ""))); i++; }
    out.push(`<blockquote>${buf.join("<br>")}</blockquote>`); continue;
  }
  // 목록 (- * 또는 1.)
  if (/^[-*]\s+/.test(t) || /^\d+\.\s+/.test(t)) {
    const ordered = /^\d+\.\s+/.test(t);
    const tag = ordered ? "ol" : "ul";
    const buf = [];
    while (i < lines.length && (/^[-*]\s+/.test(lines[i].trim()) || /^\d+\.\s+/.test(lines[i].trim()))) {
      buf.push(`<li>${inline(lines[i].trim().replace(/^([-*]|\d+\.)\s+/, ""))}</li>`); i++;
    }
    out.push(`<${tag}>${buf.join("")}</${tag}>`); continue;
  }
  // 단락 (연속 비-빈 줄 묶기)
  const para = [inline(t)]; i++;
  while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,4}\s|[-*]\s|\d+\.\s|>|```|<svg|<div|<figure|---+$|\|)/.test(lines[i].trim())) {
    para.push(inline(lines[i].trim())); i++;
  }
  out.push(`<p>${para.join("<br>")}</p>`);
}

// ── 탭 조립 ────────────────────────────────────────────────────────────────
// ★왜 탭인가★ — 긴 보고서는 한 장에 그림이 몰리면서, 브라우저가 앵커로 스크롤한 뒤
// 그림들이 뒤늦게 자리를 잡아 내용이 밀린다. 목차 링크를 눌러도 엉뚱한 데 서는 실제 원인이다.
// 부마다 나누면 한 화면이 다루는 양이 줄어 그 밀림이 없어진다.
// ★전환은 CSS :target 하나로 한다★ — /reports 뷰어가 iframe 을 sandbox 로 띄워
// 스크립트를 막으므로, 자바스크립트에 기대면 거기서 탭이 죽는다.
let bodyHtml = out.join("\n");
let tabsCss = "", tabsJs = "";
if (tabs.length === 1) {
  console.error(`탭 표식이 1개뿐이다(${tabs[0].id}) — 2개 이상이어야 탭이 된다. 표식을 더 넣거나 지워라.`);
  process.exit(1);
}
if (tabs.length >= 2) {
  const panels = tabs.map((tb, k) => {
    const end = k + 1 < tabs.length ? tabs[k + 1].at : out.length;
    return `<section id="panel-${tb.id}" class="tab-panel${k === 0 ? " is-default is-active" : ""}" data-tab="${tb.id}" role="tabpanel" aria-labelledby="tab-${tb.id}">\n`
      + out.slice(tb.at, end).join("\n") + `\n</section>`;
  });
  // ★탭은 링크로 두고, 스크립트가 있으면 가로챈다★
  //   포털 뷰어는 보고서를 sandbox="allow-same-origin allow-popups" iframe 으로 띄운다 —
  //   allow-scripts 가 없어 자바스크립트가 안 돈다(src/web/components/Reports.ts:1272).
  //   그래서 링크와 :target 을 남긴다. 스크립트가 죽어도 탭이 동작한다.
  //   스크립트가 살아 있으면(파일 주소로 직접 열 때) 클릭을 가로채 화면을 ★안 옮긴다★ —
  //   브라우저의 앵커 이동을 따라다니며 위치를 저장·복원하다가 2026-09-07 하루에 결함이 넷 났다.
  const bar = `<div id="report-top"></div>\n<nav class="report-tabs" role="tablist" aria-label="보고서 탭">\n`
    + tabs.map((tb, k) => `  <a id="tab-${tb.id}" class="report-tab${k === 0 ? " is-active" : ""}" role="tab" href="#panel-${tb.id}" data-target="${tb.id}" aria-selected="${k === 0 ? "true" : "false"}">${esc(tb.label)}</a>`).join("\n")
    + `\n</nav>`;
  bodyHtml = out.slice(0, tabs[0].at).join("\n") + "\n" + bar + "\n" + panels.join("\n");

  const activeBg = "{background:color-mix(in srgb,var(--card) 78%,var(--green) 22%);color:var(--ink)}";
  tabsCss = `
/* ★탭 보고서에서는 부드러운 스크롤을 끈다★ — theme.css 의 scroll-behavior:smooth 가 켜져 있으면
   깊은 앵커로 갈 때 브라우저 애니메이션과 아래 이동이 다투어 화면이 떨린다. */
html{scroll-behavior:auto}
.tab-panel{display:none}
/* 스크립트가 안 도는 자리(포털 sandbox iframe) — 주소로 고른다 */
.wrap:not(.js-tabs) .tab-panel:target,.wrap:not(.js-tabs) .tab-panel:has(:target){display:block}
.wrap:not(.js-tabs):not(:has(.tab-panel:target)):not(:has(.tab-panel :target)) .tab-panel.is-default{display:block}
${tabs.map((tb) => `.wrap:not(.js-tabs):has(#panel-${tb.id}:target) [href="#panel-${tb.id}"],.wrap:not(.js-tabs):has(#panel-${tb.id} :target) [href="#panel-${tb.id}"]${activeBg}`).join("\n")}
.wrap:not(.js-tabs):not(:has(.tab-panel:target)):not(:has(.tab-panel :target)) [href="#panel-${tabs[0].id}"]${activeBg}
/* 스크립트가 도는 자리 — 클래스로 고른다. 화면은 안 옮긴다 */
.js-tabs .tab-panel.is-active{display:block}
.js-tabs .report-tab.is-active${activeBg}
.wrap div[id]:empty{scroll-margin-top:104px}`;

  // ★화면을 옮기지 않는다★ — 탭 전환은 패널을 바꿔 끼우는 것이 전부다.
  //   주소는 history.replaceState 로 조용히 바꾼다(브라우저 이동 없음).
  //   깊은 앵커(#어느-장)로 들어온 경우에만 그 장이 든 패널을 켜고 ★한 번★ 옮긴다.
  tabsJs = `
(function(){
  var TOP=104;   // 깊은 앵커 — 제목이 상단 탭 줄에 가리지 않는 자리
  var wrap=document.querySelector('.wrap'); if(wrap) wrap.classList.add('js-tabs');   // 여기부터는 클래스로 고른다
  var btns=[].slice.call(document.querySelectorAll('.report-tab[data-target]'));
  var panels=[].slice.call(document.querySelectorAll('.tab-panel[data-tab]'));
  if(!btns.length||!panels.length) return;
  var first=panels[0].dataset.tab;
  function has(name){ return panels.some(function(p){ return p.dataset.tab===name; }); }
  function setTab(name, updateHash){
    if(!has(name)) name=first;
    btns.forEach(function(b){ var on=b.dataset.target===name; b.classList.toggle('is-active',on); b.setAttribute('aria-selected',on?'true':'false'); });
    panels.forEach(function(p){ p.classList.toggle('is-active',p.dataset.tab===name); });
    if(updateHash) history.replaceState(null,'','#tab='+encodeURIComponent(name));
  }
  function panelOf(el){ while(el&&el!==document.body){ if(el.classList&&el.classList.contains('tab-panel')) return el; el=el.parentNode; } return null; }
  // 주소 해석 — #tab=<이름> 이면 그 탭, 그 밖의 #무언가 는 깊은 앵커로 본다.
  function apply(){
    var h=(location.hash||'');
    var m=h.match(/tab=([^&]+)/);
    if(m){ setTab(decodeURIComponent(m[1]), false); return; }
    var id=h.length>1?decodeURIComponent(h.slice(1)):'';
    var el=id?document.getElementById(id):null;
    if(!el){ setTab(first,false); return; }
    var host=panelOf(el);
    setTab(host?host.dataset.tab:first, false);
    // 패널을 켠 뒤에야 그 장의 자리가 정해진다. 그 자리에서 한 번만 옮긴다.
    window.scrollTo({top: Math.max(0, el.getBoundingClientRect().top+window.scrollY-TOP), behavior:'instant'});
  }
  btns.forEach(function(b){ b.addEventListener('click', function(e){ e.preventDefault(); setTab(b.dataset.target,true); }); });
  window.addEventListener('hashchange', apply);
  apply();
})();`;

  // ★스크롤 보정★ — 탭으로 나눠도 남는 문제가 하나 있다.
  // 목적지가 ★닫혀 있던 패널★ 안이면, 브라우저가 첫 스크롤을 시도하는 시점에
  // 그 요소는 화면에 없어 레이아웃 상자가 없다 → 갈 곳을 못 찾는다.
  // CSS 가 패널을 편 뒤에도 브라우저는 다시 시도하지 않는다. 그래서 열린 다음 한 번 더 옮긴다.
  // 이건 스크롤만 거든다 — 스크립트가 막힌 곳(포털 iframe)에서도 탭 전환 자체는 CSS 로 그대로 돈다.
  // ★스크롤 보정 — 한 번만 움직인다★
  // 목적지가 닫혀 있던 탭 안이면 브라우저는 첫 스크롤 시점에 그 요소의 위치를 모른다(화면에 없어서다).
  // CSS 가 탭을 편 뒤에도 브라우저는 다시 시도하지 않으므로 여기서 한 번 옮긴다.
}

const css = readFileSync(resolve(__dir, "../assets/theme.css"), "utf8");
const docTitle = title || (lines.find((l) => /^#\s+/.test(l)) || "# 보고서").replace(/^#\s+/, "").trim();
const html = `<!doctype html>
<html lang="ko" data-theme="dark"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(docTitle)}</title>
<style>
${css}${tabsCss}
</style>
</head><body><div class="report-shell">
  <div class="report-toolbar">
    <div class="report-brand"><span class="report-mark"></span><b>b3rys report</b><span>self-contained HTML</span></div>
    <div class="theme-switch" role="group" aria-label="theme switch"><button id="theme-dark" class="active" type="button">Dark</button><button id="theme-light" type="button">Light</button></div>
  </div>
  <div class="wrap">
${bodyHtml}
    <div class="report-footer">b3rys report · Dark/Light theme · generated from Markdown</div>
  </div>
</div>
<script>
(function(){
  var root=document.documentElement,d=document.getElementById('theme-dark'),l=document.getElementById('theme-light');
  function setTheme(t){root.setAttribute('data-theme',t);try{localStorage.setItem('b3os-report-theme',t)}catch(e){};d.classList.toggle('active',t==='dark');l.classList.toggle('active',t==='light')}
  try{var saved=localStorage.getItem('b3os-report-theme'); if(saved==='light') setTheme('light');}catch(e){}
  d.onclick=function(){setTheme('dark')}; l.onclick=function(){setTheme('light')};
})();${tabsJs}
</script></body></html>
`;
writeFileSync(outPath, html);
console.log(`✅ rendered: ${basename(inPath)} → ${outPath} (${(html.length / 1024).toFixed(1)}KB)`);
