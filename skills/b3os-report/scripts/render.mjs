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
    return `<section id="panel-${tb.id}" class="tab-panel${k === 0 ? " is-default" : ""}" role="tabpanel" aria-labelledby="tab-${tb.id}">\n`
      + out.slice(tb.at, end).join("\n") + `\n</section>`;
  });
  const bar = `<div id="report-top"></div>\n<nav class="report-tabs" role="tablist" aria-label="보고서 탭">\n`
    + tabs.map((tb) => `  <a id="tab-${tb.id}" class="report-tab" role="tab" href="#panel-${tb.id}">${esc(tb.label)}</a>`).join("\n")
    + `\n</nav>`;
  bodyHtml = out.slice(0, tabs[0].at).join("\n") + "\n" + bar + "\n" + panels.join("\n");

  // 켜진 탭 표시. 패널 자체가 target 이거나(탭을 눌렀다), 패널 안의 무언가가 target 이다(목차를 눌렀다).
  const activeBg = "{background:color-mix(in srgb,var(--card) 78%,var(--green) 22%);color:var(--ink)}";
  // ★어느 패널도 안 걸렸을 때만★ 첫 패널을 켠다. 단순히 :not(:has(:target)) 로 쓰면
  // 패널 바깥(머리말)을 가리키는 주소에서 모든 패널이 닫혀 화면이 빈다.
  const noPanelHit = `.wrap:not(:has(.tab-panel:target)):not(:has(.tab-panel :target))`;
  // ★theme.css 에 이미 있는 것은 다시 쓰지 않는다★ —
  // .report-tabs · .report-tab · .report-tab.is-active · .tab-panel{display:none} 은 테마 소관이고
  // 생김새 기준은 references/ui-components.md 2절이 정한다(조용한 blurred row, 한 줄 가로 스크롤).
  // 여기서 더하는 것은 ★:target 으로 어느 패널을 열지 고르는 규칙★ 뿐이다.
  tabsCss = `
.tab-panel:target,.tab-panel:has(:target){display:block}
${noPanelHit} .tab-panel.is-default{display:block}
.wrap div[id]:empty{scroll-margin-top:104px}
${tabs.map((tb) => `.wrap:has(#panel-${tb.id}:target) [href="#panel-${tb.id}"],.wrap:has(#panel-${tb.id} :target) [href="#panel-${tb.id}"]${activeBg}`).join("\n")}
${noPanelHit} [href="#panel-${tabs[0].id}"]${activeBg}`;

  // ★스크롤 보정★ — 탭으로 나눠도 남는 문제가 하나 있다.
  // 목적지가 ★닫혀 있던 패널★ 안이면, 브라우저가 첫 스크롤을 시도하는 시점에
  // 그 요소는 화면에 없어 레이아웃 상자가 없다 → 갈 곳을 못 찾는다.
  // CSS 가 패널을 편 뒤에도 브라우저는 다시 시도하지 않는다. 그래서 열린 다음 한 번 더 옮긴다.
  // 이건 스크롤만 거든다 — 스크립트가 막힌 곳(포털 iframe)에서도 탭 전환 자체는 CSS 로 그대로 돈다.
  tabsJs = `
(function(){
  function go(){
    var h=location.hash; if(!h||h.length<2) return;
    var el=document.getElementById(decodeURIComponent(h.slice(1))); if(!el) return;
    // 탭을 눌러 패널을 바꿀 때는 그 패널의 첫 줄이 아니라 ★탭 줄★ 을 화면 위에 둔다.
    // 패널이 바뀌면 문서 높이가 통째로 달라져, 이전 패널 기준으로 잰 위치는 뜻이 없다.
    if(el.classList.contains('tab-panel')) el=document.getElementById('report-top')||el;
    // ★반드시 behavior:'instant' 다★ — theme.css 가 scroll-behavior:smooth 를 켜 놓아서
    // scrollTo(x,y) 2인자 형태는 이 페이지에서 실제로 화면을 못 움직인다(실측: 목표 5270, 결과 제자리).
    // scrollIntoView 도 같은 이유로 안 쓴다 — 전환 중에 엉뚱한 자리에 선다.
    // ★여러 번 재는 이유★ — 그림이 자리를 잡으면서 위치가 계속 바뀐다.
    function put(){ window.scrollTo({top: Math.max(0, el.getBoundingClientRect().top+window.scrollY-104), behavior:'instant'}); }
    requestAnimationFrame(put); setTimeout(put,200); setTimeout(put,700);
  }
  addEventListener('load',go); addEventListener('hashchange',go);
})();`;
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
