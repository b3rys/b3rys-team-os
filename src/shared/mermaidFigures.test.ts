import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { MERMAID_INLINE_JS, mermaidConfig, renderMermaidFigures } from "./mermaidFigures";

// 새창 페이지에 실제로 들어가는 인라인 JS 를 그대로 실행해 잰다 — 문자열만 보고 통과시키지 않는다.
let win: Window;
const saved: Record<string, unknown> = {};
beforeAll(() => {
  win = new Window({ url: "http://localhost/" });
  for (const k of ["window", "document", "matchMedia"]) saved[k] = (globalThis as any)[k];
  (globalThis as any).window = win; (globalThis as any).document = win.document;
  (globalThis as any).matchMedia = () => ({ matches: false });
  (win as any).matchMedia = () => ({ matches: false });
  (win as any).SyntaxError = SyntaxError; // happy-dom Window 에 없어 셀렉터 오류 메시지가 가려진다
});
afterAll(() => { for (const k of Object.keys(saved)) (globalThis as any)[k] = saved[k]; });

const figureHtml = (n: number) => Array.from({ length: n }, (_, i) =>
  `<figure class="project-diagram"><figcaption class="mermaid-pending">다이어그램 렌더 예정</figcaption><pre class="mermaid-src"><code>graph TD\nA${i}--&gt;B</code></pre></figure>`).join("");

function fake(failOn: number[] = []) {
  const f = {
    init: null as Record<string, unknown> | null, calls: [] as string[],
    initialize(cfg: Record<string, unknown>) { f.init = cfg; },
    async render(_id: string, src: string) { const n = f.calls.push(src); if (failOn.includes(n)) throw new Error("parse"); return { svg: `<svg data-fake="${n}"></svg>` }; },
  };
  return f;
}
const flush = () => new Promise((r) => setTimeout(r, 10));

describe("mermaidConfig", () => {
  test("strict + 오류 SVG 억제 + 테마만 다르다", () => {
    expect(mermaidConfig(false)).toEqual({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: "neutral", fontFamily: "inherit" });
    expect(mermaidConfig(true).theme).toBe("dark");
  });
});

describe("MERMAID_INLINE_JS (새창 페이지 인라인)", () => {
  test("설정은 mermaidConfig() 의 JSON 그대로 박혀 있고, 원문은 textContent 로 읽는다", () => {
    expect(MERMAID_INLINE_JS).toContain(JSON.stringify(mermaidConfig(true)));
    expect(MERMAID_INLINE_JS).toContain(JSON.stringify(mermaidConfig(false)));
    expect(MERMAID_INLINE_JS).toContain('"securityLevel":"strict"');
    expect(MERMAID_INLINE_JS).toContain('"suppressErrorRendering":true');
    expect(MERMAID_INLINE_JS).toContain("pre.textContent");
    expect(MERMAID_INLINE_JS).not.toContain("</script");
  });
  test("실행하면 figure 를 SVG 로 바꾸고, 오류 figure 는 원문 유지 + 캡션 교체 — TS 함수와 같은 결과", async () => {
    document.body.innerHTML = figureHtml(2);
    const m = fake([2]);
    (win as any).mermaid = m; (globalThis as any).mermaid = m;
    new Function(MERMAID_INLINE_JS)();
    await flush();
    expect(m.init).toEqual(mermaidConfig(false));
    expect(m.calls[0]).toBe("graph TD\nA0-->B"); // 이스케이프된 원문이 글자로 되돌아온다
    const figs = document.querySelectorAll<HTMLElement>("figure.project-diagram");
    expect(figs[0]!.dataset.rendered).toBe("1");
    expect(figs[0]!.querySelector(".project-diagram-svg svg[data-fake]")).not.toBeNull();
    expect(figs[0]!.querySelector("pre.mermaid-src, .mermaid-pending")).toBeNull();
    expect(figs[1]!.dataset.rendered).toBe("error");
    expect(figs[1]!.querySelector("pre.mermaid-src")).not.toBeNull();
    expect(figs[1]!.querySelector(".mermaid-pending")?.textContent).toBe("다이어그램 문법 오류 — 원문 표시");
    // 다시 실행해도 이미 처리한 figure 는 건드리지 않는다
    new Function(MERMAID_INLINE_JS)();
    await flush();
    expect(m.calls).toHaveLength(2);
  });
  test("TS 함수도 같은 DOM 결과", async () => {
    document.body.innerHTML = figureHtml(2);
    const m = fake([2]);
    const r = await renderMermaidFigures(document, m, { dark: false, errorText: "다이어그램 문법 오류 — 원문 표시" });
    expect(r).toEqual({ ok: 1, failed: 1 });
    const figs = document.querySelectorAll<HTMLElement>("figure.project-diagram");
    expect(figs[0]!.querySelector(".project-diagram-svg svg[data-fake]")).not.toBeNull();
    expect(figs[1]!.querySelector(".mermaid-pending")?.textContent).toBe("다이어그램 문법 오류 — 원문 표시");
    expect(m.init).toEqual(mermaidConfig(false));
  });
});
