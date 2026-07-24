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
  assert.match(html, /\[data-theme="light"\]/);
  assert.match(html, /class="theme-switch"/);
  assert.match(html, /localStorage\.getItem\('b3os-report-theme'\)/);
  assert.match(html, /\.mobile-infographic\{display:none\}/);
  assert.match(html, /\.mi-card p\{[^}]*color:var\(--ink\)\}/);
  assert.doesNotMatch(html, /\[data-theme="light"\] svg text\{fill:var\(--mut\)\}/);
  assert.match(html, /\[data-theme="light"\] svg text\[fill="#e6edf3"\][^}]*\{fill:var\(--ink\)\}/);
  assert.match(html, /\.desktop-infographic\{display:none!important\}/);
  assert.match(html, /<div class="outer">[\s\S]*<div class="hint">안내<\/div>[\s\S]*<svg/);
  assert.match(html, /<figure><figcaption>한눈에 보기<\/figcaption><div class="mobile-infographic">[\s\S]*<svg class="desktop-infographic"/);
  assert.match(html, /<rect x="1"/);
  assert.match(html, /<text x="50"/);
  assert.doesNotMatch(html, /&lt;(svg|rect|text|div)/);
  assert.match(html, /<p>본문입니다\.<\/p>/);
  console.log("PASS b3os-report dark/light theme + nested raw block passthrough");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
