#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "b3os-report-test-"));
try {
  const md = join(tmp, "input.md");
  const out = join(tmp, "output.html");
  writeFileSync(md, `# 라이트 보고서\n\n<div class="outer">\n  <div class="hint">안내</div>\n  <svg viewBox="0 0 100 40" role="img" aria-label="테스트 차트">\n    <rect x="1" y="1" width="98" height="38" fill="#ffffff"/>\n    <text x="50" y="24" text-anchor="middle" fill="#172033">정상 SVG</text>\n  </svg>\n</div>\n\n<figure><figcaption>한눈에 보기</figcaption><div class="mobile-infographic"><div class="mi-card mi-blue"><h4>모바일</h4><p>세로 카드</p></div></div><svg class="desktop-infographic" viewBox="0 0 100 40"><text x="10" y="20">데스크톱</text></svg></figure>\n\n본문입니다.\n`, "utf8");
  execFileSync(process.execPath, [join(here, "render.mjs"), md, out, "--title", "테스트"], { stdio: "pipe" });
  const html = readFileSync(out, "utf8");
  assert.match(html, /<html lang="ko" data-theme="dark">/);
  assert.match(html, /color-scheme:dark/);
  assert.match(html, /--bg:#0a0f0d/);
  assert.match(html, /--card:#111a15/);
  assert.match(html, /--glow:rgba\(52,211,153,\.16\)/);
  assert.match(html, /--grid:rgba\(52,211,153,\.055\)/);
  assert.match(html, /--surface-edge:rgba\(232,255,241,\.055\)/);
  assert.match(html, /--surface-shadow:0 18px 42px rgba\(0,0,0,\.30\),0 3px 10px rgba\(0,0,0,\.20\),inset 0 1px 0 var\(--surface-edge\)/);
  assert.match(html, /--blue:#9fc7ac/);
  assert.match(html, /blockquote\{[^}]*box-shadow:var\(--surface-shadow\)/);
  assert.match(html, /table\{[^}]*box-shadow:var\(--surface-shadow\)/);
  assert.match(html, /\.stat-card\{[^}]*box-shadow:var\(--surface-shadow-soft\)/);
  assert.match(html, /linear-gradient\(90deg,var\(--grid\) 1px,transparent 1px\)/);
  assert.match(html, /linear-gradient\(var\(--grid\) 1px,transparent 1px\)/);
  assert.match(html, /h3\{[^}]*color:var\(--green\)/);
  assert.match(html, /\.report-tabs\{[^}]*backdrop-filter:blur\(14px\)/);
  assert.match(html, /\.report-tab\{[^}]*min-height:34px/);
  assert.match(html, /\.report-tab\.is-active[^}]*box-shadow:none/);
  assert.match(html, /body>\.report-toolbar\{max-width:960px/);
  assert.match(html, /body>\.wrap\{max-width:960px/);
  assert.match(html, /\.tab-shell\{position:sticky;top:57px[^}]*display:flex/);
  assert.match(html, /\.tab-shell\{[^}]*overflow-x:auto/);
  assert.match(html, /\.tab-shell\{[^}]*scrollbar-width:none/);
  assert.match(html, /\.tab-nav\{[^}]*flex-wrap:nowrap/);
  assert.match(html, /\.tab-btn,\.pager-btn\{[^}]*min-height:29px/);
  assert.match(html, /\.tab-btn,\.pager-btn\{[^}]*white-space:nowrap/);
  assert.match(html, /\.tab-panel\{display:none/);
  assert.match(html, /\.tab-panel\.active\{display:block\}/);
  assert.match(html, /\[data-theme="light"\]/);
  assert.match(html, /--bg:#f6f8f5/);
  assert.match(html, /--grid:rgba\(22,136,77,\.052\)/);
  assert.match(html, /class="theme-switch"/);
  assert.match(html, /localStorage\.getItem\('b3os-report-theme'\)/);
  assert.match(html, /\.wrap>h1:first-child::before/);
  assert.match(html, /\.mobile-infographic\{display:none\}/);
  assert.match(html, /\.mi-card p\{[^}]*color:var\(--ink\)\}/);
  assert.doesNotMatch(html, /\[data-theme="light"\] svg text\{fill:var\(--mut\)\}/);
  assert.match(html, /\[data-theme="light"\] svg text\[fill="#e6edf3"\][^}]*\{fill:var\(--ink\)\}/);
  assert.match(html, /\.desktop-infographic\{display:block\}/);
  assert.match(html, /figure img,\.report-image\{display:block;width:100%;height:auto;border:1px solid var\(--line\)/);
  assert.match(html, /\.image-grid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(html, /\.lede\{font-size:18px/);
  assert.match(html, /\.stat-grid\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(html, /\.stat-card b\{display:block;color:var\(--green\);font-size:24px/);
  assert.match(html, /\.diagram-flow\{--diagram-green:#10a36f;--diagram-green-soft:#36c18a;--diagram-gold:#d49421/);
  assert.match(html, /\[data-theme="light"\] \.diagram-flow\{--diagram-green:#0f9f6e;--diagram-green-soft:#2fbf87/);
  assert.match(html, /\.diagram-flow \.diagram-node-primary,\.diagram-flow \.diagram-node-accent\{fill:var\(--diagram-neutral\);stroke:color-mix\(in srgb,var\(--diagram-green\) 72%,var\(--diagram-stroke\)\);stroke-width:1\.8\}/);
  assert.doesNotMatch(html, /diagram-accent-bar/);
  assert.match(html, /\.diagram-flow \.diagram-text\{fill:var\(--ink\);font:650 13px\/1\.2 var\(--sans\)/);
  assert.match(html, /\.diagram-flow \.diagram-line-warm\{stroke:var\(--diagram-gold\)/);
  assert.match(html, /\.desktop-infographic\{display:none!important\}/);
  assert.match(html, /<div class="outer">[\s\S]*<div class="hint">안내<\/div>[\s\S]*<svg/);
  assert.match(html, /<figure><figcaption>한눈에 보기<\/figcaption><div class="mobile-infographic">[\s\S]*<svg class="desktop-infographic"/);
  assert.match(html, /<rect x="1"/);
  assert.match(html, /<text x="50"/);
  const refs = readFileSync(new URL('../references/ui-components.md', import.meta.url), 'utf8');
  assert.match(refs, /Vertical flowchart/);
  assert.match(refs, /Tree \/ hierarchy/);
  assert.match(refs, /Swimlane/);
  assert.match(refs, /Funnel \/ narrowing/);
  assert.match(refs, /Radial \/ hub-and-spoke/);
  assert.match(refs, /Sankey-lite \/ weighted flow/);
  assert.match(refs, /Timeline \/ lineage/);
  assert.match(refs, /milestone을 위\/아래로 stagger 배치/);
  assert.match(refs, /hard-coded white\/blue\/violet fill/);
  assert.match(refs, /Matrix \/ quadrant/);
  assert.match(refs, /다크 모드 입체감/);
  assert.match(refs, /surface-shadow/);
  assert.doesNotMatch(html, /&lt;(svg|rect|text|div)/);
  assert.match(html, /<p>본문입니다\.<\/p>/);

  // ── 탭(부별 페이지 나누기) ────────────────────────────────────────────────
  // ★이 시험이 지키는 것★ — "탭이 생겼다" 가 아니라 ①본문이 제 패널에 들어갔나
  // ②목차가 가리키는 앵커가 살아있나 ③표식이 잘못됐을 때 조용히 넘어가지 않고 멈추나.
  const tmd = join(tmp, "tabs.md");
  const tout = join(tmp, "tabs.html");
  writeFileSync(tmd, [
    "# 탭 보고서", "", "머리말은 탭 밖에 남는다.", "",
    '<div id="a" data-tab="첫째"></div>', "", "## 첫째 마당", "",
    '<div id="a-1"></div>', "", "### 1. 안쪽 절", "", "내용가나다.", "",
    '<div id="b" data-tab="둘째"></div>', "", "## 둘째 마당", "", "내용라마바.", "",
  ].join("\n"), "utf8");
  execFileSync(process.execPath, [join(here, "render.mjs"), tmd, tout], { stdio: "pipe" });
  const th = readFileSync(tout, "utf8");

  // 패널 두 개, 첫 패널이 기본
  assert.equal((th.match(/<section id="panel-/g) || []).length, 2);
  assert.match(th, /<section id="panel-a" class="tab-panel is-default"/);
  assert.match(th, /<section id="panel-b" class="tab-panel"/);
  // 탭 줄은 theme.css 가 정한 컴포넌트를 그대로 쓴다(생김새를 렌더러가 다시 정의하지 않는다)
  assert.match(th, /<nav class="report-tabs" role="tablist"/);
  assert.match(th, /<a id="tab-a" class="report-tab" role="tab" href="#panel-a">첫째<\/a>/);
  // ★내용이 제 패널에 들어갔나★ — 이걸 안 보면 패널만 생기고 본문이 통째로 한쪽에 몰려도 통과한다
  const segA = th.slice(th.indexOf('id="panel-a"'), th.indexOf('id="panel-b"'));
  assert.ok(segA.includes("내용가나다") && !segA.includes("내용라마바"));
  // ★목차 앵커가 살아있나★ — 표식 div 와 절 앵커가 둘 다 남아야 #a-1 링크가 뜻을 갖는다
  assert.match(th, /<div id="a"><\/div>/);
  assert.match(th, /<div id="a-1"><\/div>/);
  // 머리말은 패널 바깥
  assert.ok(th.indexOf("머리말은 탭 밖에 남는다") < th.indexOf('class="tab-panel'));
  // 전환은 CSS :target — 스크립트가 막힌 곳(/reports 뷰어 iframe sandbox)에서도 돌아야 한다
  assert.match(th, /\.tab-panel:target,\.tab-panel:has\(:target\)\{display:block\}/);
  // 패널 바깥을 가리키는 주소에서 화면이 비지 않게, "어느 패널도 안 걸렸을 때만" 기본을 켠다
  assert.match(th, /\.wrap:not\(:has\(\.tab-panel:target\)\):not\(:has\(\.tab-panel :target\)\) \.tab-panel\.is-default\{display:block\}/);

  // ★표식이 없으면 탭도 없다★ — 기존 보고서가 영향받지 않는지
  const pmd = join(tmp, "plain.md"), pout = join(tmp, "plain.html");
  writeFileSync(pmd, "# 그냥 보고서\n\n<div id=\"x\"></div>\n\n## 마당\n\n본문사아자.\n", "utf8");
  execFileSync(process.execPath, [join(here, "render.mjs"), pmd, pout], { stdio: "pipe" });
  const ph = readFileSync(pout, "utf8");
  assert.doesNotMatch(ph, /<section id="panel-/);
  assert.doesNotMatch(ph, /<nav class="report-tabs"/);
  assert.match(ph, /본문사아자/);

  // ★잘못된 표식은 조용히 넘어가지 않고 멈춘다★ — 안 멈추면 탭이 하나만 생기거나
  // 표식이 본문에 그대로 찍힌 채 배포된다. 넷 다 실제로 낼 수 있는 실수다.
  const mustFail = [
    ["탭 1개", '# t\n\n<div id="a" data-tab="하나"></div>\n\n## A\n'],
    ["id 중복", '# t\n\n<div id="a" data-tab="하나"></div>\n\n## A\n\n<div id="a" data-tab="둘"></div>\n\n## B\n'],
    ["여러 줄 표식", '# t\n\n<div id="a" data-tab="하나"\n></div>\n\n## A\n\n<div id="b" data-tab="둘"></div>\n'],
    ["id 없음", '# t\n\n<div data-tab="하나"></div>\n\n## A\n\n<div id="b" data-tab="둘"></div>\n'],
  ];
  for (const [name, body] of mustFail) {
    const f = join(tmp, "bad.md");
    writeFileSync(f, body, "utf8");
    let threw = false;
    try { execFileSync(process.execPath, [join(here, "render.mjs"), f, join(tmp, "bad.html")], { stdio: "pipe" }); }
    catch { threw = true; }
    assert.ok(threw, `${name}: 렌더가 멈춰야 하는데 통과했다`);
  }

  console.log("PASS b3os-report dark/light theme + nested raw block passthrough + CSS-only tabs");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
