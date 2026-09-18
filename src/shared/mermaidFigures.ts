// 프로젝트 문서의 mermaid 다이어그램을 브라우저에서 SVG 로 그린다(팀장 2026-09-18 "다이어그램 렌더까지").
// 서버 렌더러가 ```mermaid 펜스를 <figure class="project-diagram"><figcaption class="mermaid-pending">…</figcaption>
// <pre class="mermaid-src"><code>…</code></pre></figure> 로 내보내고, 여기서 그 figure 를 찾아 SVG 로 바꾼다.
// 대시보드(Projects.ts)는 이 TS 함수를, 새창 페이지는 같은 절차를 담은 MERMAID_INLINE_JS(nonce 스크립트)를 쓴다 — 둘을 같이 고친다.

export interface MermaidLike {
  initialize(cfg: Record<string, unknown>): void;
  render(id: string, src: string): Promise<{ svg: string }>;
}

export function mermaidConfig(dark: boolean): Record<string, unknown> {
  // securityLevel strict: 라벨의 HTML 을 DOMPurify 로 정제, 클릭 콜백 금지.
  return { startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral", fontFamily: "inherit" };
}

/** figure 하나하나를 SVG 로 바꾼다. 문법 오류인 figure 는 원문 <pre> 를 두고 캡션만 오류 문구로. */
export async function renderMermaidFigures(
  container: ParentNode,
  mermaid: MermaidLike,
  opts: { dark: boolean; errorText: string; idPrefix?: string },
): Promise<{ ok: number; failed: number }> {
  const figs = Array.from(container.querySelectorAll<HTMLElement>("figure.project-diagram:not([data-rendered])"));
  if (!figs.length) return { ok: 0, failed: 0 };
  mermaid.initialize(mermaidConfig(opts.dark));
  let ok = 0, failed = 0, i = 0;
  const stamp = Date.now().toString(36);
  for (const fig of figs) {
    const pre = fig.querySelector<HTMLElement>("pre.mermaid-src");
    const cap = fig.querySelector<HTMLElement>(".mermaid-pending");
    try {
      const { svg } = await mermaid.render(`${opts.idPrefix ?? "pd"}-${stamp}-${i++}`, pre?.textContent ?? "");
      const div = document.createElement("div");
      div.className = "project-diagram-svg";
      div.innerHTML = svg;
      cap?.remove();
      if (pre) pre.replaceWith(div); else fig.appendChild(div);
      fig.dataset.rendered = "1";
      ok++;
    } catch {
      if (cap) cap.textContent = opts.errorText;
      fig.dataset.rendered = "error";
      failed++;
    }
  }
  return { ok, failed };
}

/** 새창 페이지용 — 위 함수와 같은 절차의 순수 JS(빌드 없이 <script nonce> 로 들어간다). 바꾸면 위 함수도 같이. */
export const MERMAID_INLINE_JS =
  '(function(){var figs=document.querySelectorAll("figure.project-diagram:not([data-rendered])");' +
  'if(!figs.length||!window.mermaid)return;' +
  'var dark=window.matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches;' +
  'mermaid.initialize({startOnLoad:false,securityLevel:"strict",theme:dark?"dark":"neutral",fontFamily:"inherit"});' +
  'var i=0,stamp=Date.now().toString(36);' +
  'figs.forEach(function(fig){var pre=fig.querySelector("pre.mermaid-src");var cap=fig.querySelector(".mermaid-pending");' +
  'mermaid.render("pd-"+stamp+"-"+(i++),pre?pre.textContent:"").then(function(r){' +
  'var div=document.createElement("div");div.className="project-diagram-svg";div.innerHTML=r.svg;' +
  'if(cap)cap.remove();if(pre)pre.replaceWith(div);else fig.appendChild(div);fig.setAttribute("data-rendered","1");' +
  '}).catch(function(){if(cap)cap.textContent="\uB2E4\uC774\uC5B4\uADF8\uB7A8 \uBB38\uBC95 \uC624\uB958 \u2014 \uC6D0\uBB38 \uD45C\uC2DC";fig.setAttribute("data-rendered","error")});' +
  '})})();';
