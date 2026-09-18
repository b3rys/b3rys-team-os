import { describe, expect, test } from "bun:test";
import { projectDocUrl, projectIntro, renderProjectDoc } from "./projectDocRender";
const ctx = { id: "sample", repo: "example/sample", sha: "a".repeat(40), path: "README.md", docs: { readme: "README.md", design: "docs/DESIGN.md", todo: "TODO.md" } };
const render = (md: string) => renderProjectDoc(md, ctx);
describe("project document renderer", () => {
  test("headings have unique anchors, TOC and readable title", () => {
    const result = render("# **Project**\n\n## 구조\n\n## 구조");
    expect(result.title).toBe("Project");
    expect(result.toc.map(x => x.anchor)).toEqual(["project", "구조", "구조-1"]);
    expect(result.html).toContain('id="구조-1"');
  });
  test("체크박스 목록은 ul.task-list + li.task.is-{done,doing,todo}, 글은 .task-text 에 — 일반 목록은 그대로", () => {
    const html = render("- [x] done\n- [~] doing\n- [ ] later\n  - child\n\n- plain").html;
    expect(html).toContain('<ul class="task-list"><li class="task is-done"><input type="checkbox" tabindex="-1" checked aria-label="완료"><span class="task-text">done</span></li>');
    expect(html).toContain('<li class="task is-doing"><input type="checkbox" tabindex="-1" aria-label="진행중"><span class="task-text"><span class="task-doing">진행중</span> doing</span></li>');
    expect(html).toContain('<li class="task is-todo"><input type="checkbox" tabindex="-1" aria-label="계획"><span class="task-text">later</span><ul><li>child</li></ul></li>');
    expect(html).toContain("<ul><li>plain</li></ul>");
    expect(html.match(/class="task-list"/g)).toHaveLength(1);
  });

  test("renders tables, list nesting, quotes, checkboxes and strikethrough", () => {
    const html = render("| A | B |\n| --- | --- |\n| one | two |\n\n- [x] done\n- [~] doing\n  - child\n\n> **quote**\n\n~~old~~").html;
    for (const tag of ["<table>", "<th>A</th>", "<ul>", "<blockquote>", "<strong>quote</strong>", "<del>old</del>", "tabindex=\"-1\" checked", 'class="task-doing"', "child"]) expect(html).toContain(tag);
  });
  test("preserves all Mermaid diagrams safely and records pending work", () => {
    const result = render(Array.from({ length: 6 }, (_, n) => "```mermaid\ngraph TD\nA-->B" + n + "\n```").join("\n\n"));
    expect(result.html.match(/class="mermaid-src"/g)).toHaveLength(6);
    expect(result.html.match(/다이어그램 렌더 예정/g)).toHaveLength(6);
    expect(result.html).toContain("A--&gt;B5");
    expect(result.needs).toEqual(["mermaid-svg"]);
  });
  test("unclosed fences preserve code, script code cannot execute", () => {
    const html = render("```html\n<script>alert(1)</script>").html;
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  test("strips raw executable HTML, event handlers and unsafe URLs", () => {
    const html = render('<script>\nalert(1)\n</script>\n\n<img src=x onerror=alert(2)>\n\n<a href="javascript:alert(3)" onclick="evil()">text</a>\n\n[x](javascript:alert) ![x](data:image/svg+xml,bad)').html;
    for (const bad of ["<script", "alert(1)", "onerror", "onclick", "javascript:", "data:image"]) expect(html).not.toContain(bad);
    expect(html).toContain("text");
  });
  test("resolves known docs, other files, images and relative parent paths", () => {
    expect(projectDocUrl("docs/DESIGN.md#diagram", ctx)).toBe("?view=projects&id=sample&doc=design#diagram");
    expect(projectDocUrl("../TODO.md", { ...ctx, path: "docs/DESIGN.md" })).toBe("?view=projects&id=sample&doc=todo");
    expect(projectDocUrl("docs/other.md", ctx)).toBe(`https://github.com/example/sample/blob/${ctx.sha}/docs/other.md`);
    expect(projectDocUrl("images/a.png", ctx, true)).toBe(`https://raw.githubusercontent.com/example/sample/${ctx.sha}/images/a.png`);
    expect(render("[design](docs/DESIGN.md) ![photo](images/a.png)").html).toContain("&amp;doc=design");
  });
  test("rejects dangerous schemes, protocol-relative URLs, escapes and credentials", () => {
    for (const link of ["javascript:x", "JaVaScRiPt:x", "data:text/html,x", "//evil.test", "\\evil.test", "../escape", "%2e%2e/escape", "https://name:password@example.com", "java\tscript:x"]) expect(projectDocUrl(link, ctx)).toBeNull();
  });
  test("README intro is first prose paragraph, not heading or badge", () => {
    expect(projectIntro("# Project\n\n![badge](x)\n\nA **useful** app.\nSecond line.\n\nOther paragraph.")).toBe("A useful app. Second line.");
    expect(projectIntro("# Empty")).toBe("");
  });
});
