// Projects 문서 본문(.projects-prose) 스타일 — 대시보드(Projects.ts)와 새창 페이지(routes/projects.ts) 가 같은 규칙을 쓴다.
//   한 곳에만 두면 다른 쪽이 조용히 어긋난다. 색은 대시보드 CSS 변수(--slate-*, --accent 등)를 그대로 쓰고,
//   새창 페이지는 그 변수 값을 자기 :root 에 박아 온다(PAGE_VARS_CSS).
export function proseCss(headOffset: number): string {
  return `
.projects-prose{font-size:14.5px;line-height:1.75;color:rgb(var(--slate-200));min-width:0;overflow-wrap:anywhere}
.projects-prose h1,.projects-prose h2,.projects-prose h3,.projects-prose h4{color:rgb(var(--slate-50));font-weight:700;line-height:1.3;margin:1.4em 0 .5em;letter-spacing:-.01em;scroll-margin-top:var(--projects-head, ${headOffset}px)}
.projects-prose h1{font-size:1.6em;border-bottom:1px solid rgb(var(--border));padding-bottom:.3em}
.projects-prose h2{font-size:1.35em}.projects-prose h3{font-size:1.15em}.projects-prose h4{font-size:1em}
.projects-prose h1:first-child,.projects-prose h2:first-child{margin-top:0}
.projects-prose p{margin:.7em 0}
.projects-prose ul,.projects-prose ol{margin:.7em 0;padding-left:1.5em}
.projects-prose li{margin:.35em 0}
.projects-prose li>p{margin:.25em 0}
.projects-prose ul.task-list{list-style:none;padding-left:.1em}
.projects-prose li.task{display:grid;grid-template-columns:auto minmax(0,1fr);column-gap:.65em;align-items:start;margin:.45em 0}
.projects-prose li.task>input{grid-column:1;margin:.42em 0 0;width:15px;height:15px;accent-color:rgb(var(--accent));pointer-events:none}
.projects-prose li.task>.task-text{grid-column:2;min-width:0}
.projects-prose li.task>:not(input):not(.task-text){grid-column:2}
.projects-prose li.task.is-done>.task-text,.projects-prose li.task.is-done>p{color:rgb(var(--slate-500))}
.projects-prose li.task.is-done>.task-text strong,.projects-prose li.task.is-done>.task-text code{color:rgb(var(--slate-500))}
.projects-prose .task-doing{display:inline-block;vertical-align:.08em;margin-right:.15em;padding:0 .45em;border-radius:5px;border:1px solid var(--txt-amber);color:var(--txt-amber);font-size:.72em;font-weight:700;line-height:1.5;letter-spacing:.03em}
.projects-prose a{color:var(--accent-soft-text);text-decoration:underline;text-underline-offset:2px}
.projects-prose code{background:rgb(var(--surface-0));border:1px solid rgb(var(--border));border-radius:5px;padding:.1em .4em;font-size:.88em;font-family:ui-monospace,Menlo,monospace;color:var(--accent-soft-text)}
.projects-prose pre{background:rgb(var(--surface-0));border:1px solid rgb(var(--border));border-radius:10px;padding:14px 16px;overflow-x:auto;margin:1em 0;max-width:100%}
.projects-prose pre code{background:none;border:0;padding:0;color:rgb(var(--slate-200))}
.projects-prose pre.mermaid-src{margin-top:0;border-top-left-radius:0;border-top-right-radius:0}
.projects-prose .projects-mermaid-badge{display:inline-flex;align-items:center;gap:6px;margin-top:1em;padding:3px 10px;border:1px solid rgb(var(--border));border-bottom:0;border-radius:8px 8px 0 0;background:rgb(var(--surface-1));font-size:11px;font-weight:600;color:var(--txt-amber)}
.projects-prose blockquote{border-left:3px solid rgb(var(--accent) / .5);padding:.2em 0 .2em 14px;margin:1em 0;color:rgb(var(--slate-400))}
.projects-prose strong{color:rgb(var(--slate-50));font-weight:600}
.projects-prose hr{border:0;border-top:1px solid rgb(var(--border));margin:1.6em 0}
.projects-prose img{max-width:100%;height:auto}
.projects-prose .table-wrap,.projects-prose table{max-width:100%}
.projects-prose table{border-collapse:collapse;width:100%;margin:1em 0;font-size:.92em;display:block;overflow-x:auto}
.projects-prose th,.projects-prose td{border:1px solid rgb(var(--border));padding:7px 11px;text-align:left}
.projects-prose th{background:rgb(var(--surface-1));color:rgb(var(--slate-50));font-weight:600}
#projects-toc{scroll-margin-top:var(--projects-head, ${headOffset}px)}
.projects-toc{font-size:13px;line-height:1.4}
.projects-toc-row{display:flex;align-items:flex-start;gap:1px;min-width:0}
.projects-toc-caret{flex:0 0 16px;height:22px;display:inline-flex;align-items:center;justify-content:center;border-radius:5px;color:rgb(var(--slate-600));font-size:8px;opacity:.8;transition:transform .12s}
.projects-toc-caret:hover{color:rgb(var(--slate-100));background:rgb(var(--surface-3) / .6)}
.projects-toc-caret[aria-expanded="true"]{transform:rotate(90deg)}
.projects-toc-head{flex:1 1 auto;min-width:0;text-align:left;padding:3px 6px;border-radius:6px;color:rgb(var(--slate-300));line-height:1.35}
.projects-toc-label{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere}
.projects-toc-head:hover{color:rgb(var(--slate-100));background:rgb(var(--surface-3) / .5)}
.projects-toc-head[aria-current="true"]{color:rgb(var(--slate-50));font-weight:600;background:rgb(var(--accent) / .14)}
.projects-toc-children{display:flex;flex-direction:column;padding:1px 0 4px 22px}
.projects-toc-sec[data-open="false"] .projects-toc-children{display:none}
.projects-toc-children a{display:block;color:rgb(var(--slate-400));text-decoration:none;padding:2px 6px;border-radius:5px;font-size:12.5px;line-height:1.35}
.projects-toc-children a:hover{color:rgb(var(--slate-100));background:rgb(var(--surface-3) / .5)}
.projects-toc-children a[aria-current="true"]{color:var(--accent-soft-text);font-weight:600}
.projects-toc-children a[data-level="4"],.projects-toc-children a[data-level="5"],.projects-toc-children a[data-level="6"]{padding-left:16px;font-size:12px}
.projects-raw{white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;line-height:1.6;color:rgb(var(--slate-200))}`;
}

/** 새창(독립) 페이지용 변수 — src/web/styles.css 의 다크 팔레트와 같은 값. */
// 대시보드 styles.css 의 :root 값과 같게(다크 기본 · 라이트는 prefers-color-scheme 오버라이드). 값이 바뀌면 여기도 맞춘다.
export const PAGE_VARS_CSS = `:root{color-scheme:dark light;--surface-0:13 15 18;--surface-1:20 22 25;--surface-2:23 25 29;--surface-3:33 36 42;--border:43 47 54;--slate-50:246 247 249;--slate-100:240 242 244;--slate-200:218 220 225;--slate-300:188 191 198;--slate-400:157 161 169;--slate-500:144 151 160;--slate-600:117 123 133;--accent:61 220 132;--accent-soft-text:#6fd9a0;--txt-amber:#f0bd6a}
@media (prefers-color-scheme: light){:root{--surface-0:236 238 241;--surface-1:243 244 246;--surface-2:247 248 250;--surface-3:255 255 255;--border:231 232 236;--slate-50:20 21 26;--slate-100:28 29 34;--slate-200:51 53 60;--slate-300:74 77 85;--slate-400:80 83 91;--slate-500:92 95 103;--slate-600:109 112 121;--accent:31 157 90;--accent-soft-text:#198a52;--txt-amber:#875a0e}}`;

/** 새창 페이지 CSP. meta 와 응답 헤더 양쪽에 같은 값을 쓴다(헤더에는 frame-ancestors 를 더한다 — meta 로는 못 건다). */
export const STANDALONE_CSP = "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
export const DOC_KEYS_ORDER = ["readme", "design", "features", "todo"] as const;
export const DOC_LABELS: Record<string, string> = { readme: "README", design: "DESIGN", features: "FEATURES", todo: "TODO" };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * 새창 페이지 — 프로젝트 문서를 그 창 안에서 돌려볼 수 있게 상단 바(문서 전환 · HTML/MD)가 붙는다(팀장 2026-09-18).
 * html 은 서버가 정제한 것이고, md 는 이스케이프해 <pre> 로. 스크립트는 넣지 않는다(CSP default-src 'none').
 */
export function standaloneDocPage(opts: {
  projectId: string; projectName: string; title: string; path: string; sha: string;
  key: string; mode: "html" | "md"; html: string; md: string;
  exists: Record<string, boolean>; basePath: string; githubUrl: string | null;
}): string {
  const { projectId, projectName, title, path, sha, key, mode, basePath, githubUrl } = opts;
  const pageUrl = (k: string, m: "html" | "md") => `${basePath}/api/projects/${encodeURIComponent(projectId)}/doc/${k}/page${m === "md" ? "?mode=md" : ""}`;
  const chips = DOC_KEYS_ORDER.map((k) => opts.exists[k]
    ? `<a class="chip${k === key ? " on" : ""}" href="${esc(pageUrl(k, mode))}">${DOC_LABELS[k]}</a>`
    : `<span class="chip off">${DOC_LABELS[k]}</span>`).join("");
  const modes = (["html", "md"] as const).map((m) => `<a class="mode${m === mode ? " on" : ""}" href="${esc(pageUrl(key, m))}">${m.toUpperCase()}</a>`).join("");
  const body = mode === "md"
    ? `<pre class="projects-raw">${esc(opts.md)}</pre>`
    : `<article class="projects-prose">${opts.html}</article>`;
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${STANDALONE_CSP}">
<title>${esc(projectName)} · ${esc(title)}</title>
<style>${PAGE_VARS_CSS}
html,body{margin:0;background:rgb(var(--surface-1));color:rgb(var(--slate-200));font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
.bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 20px;background:rgb(var(--surface-2) / .96);border-bottom:1px solid rgb(var(--border));backdrop-filter:blur(6px)}
.bar .t{font-weight:600;color:rgb(var(--slate-50));font-size:15px}.bar .m{font-size:11px;color:rgb(var(--slate-500));font-family:ui-monospace,Menlo,monospace}
.bar .sp{flex:1}
.chip,.mode{display:inline-flex;align-items:center;padding:3px 9px;border-radius:6px;border:1px solid rgb(var(--surface-3));font-size:11px;font-weight:600;letter-spacing:.04em;text-decoration:none;color:rgb(var(--slate-300))}
.chip.on,.mode.on{color:rgb(var(--slate-50));border-color:rgb(var(--accent) / .7);background:rgb(var(--accent) / .18)}
.chip.off{color:rgb(var(--slate-600));border-style:dashed}
.gh{font-size:12px;color:rgb(var(--slate-300));text-decoration:none;border:1px solid rgb(var(--surface-3));border-radius:6px;padding:3px 9px}
main{max-width:1100px;margin:0 auto;padding:20px 24px 80px}
.projects-raw{white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;line-height:1.6;color:rgb(var(--slate-200));background:rgb(var(--surface-2));border:1px solid rgb(var(--surface-3));border-radius:12px;padding:16px 20px}
${proseCss(64)}</style></head>
<body><div class="bar"><span class="t">${esc(projectName)}</span><span class="m">${esc(path)} · ${esc(sha.slice(0, 7))}</span>${githubUrl ? `<a class="gh" href="${esc(githubUrl)}" target="_blank" rel="noopener">GitHub</a>` : ""}<span class="sp"></span>${chips}<span style="width:8px"></span>${modes}</div>
<main>${body}</main></body></html>`;
}
