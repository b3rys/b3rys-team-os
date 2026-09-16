import { posix } from "node:path";

export const RENDERER_VERSION = "projects-1";
export interface RenderContext {
  id: string; repo: string; sha: string; path: string; docs: Record<string, string>;
}
export interface RenderedProjectDoc {
  html: string; title: string; toc: { level: number; text: string; anchor: string }[]; needs: string[];
}
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const encodePath = (s: string) => s.split("/").map(encodeURIComponent).join("/");
const plain = (s: string) => s.replace(/!?(?:\[([^\]]+)\])\([^)]*\)/g, "$1").replace(/[*_`~]/g, "").replace(/<[^>]*>/g, "").trim();

export function projectDocUrl(target: string, ctx: RenderContext, image = false): string | null {
  const value = target.trim().replace(/^<(.*)>$/, "$1");
  if (!value || /[\u0000-\u0020\u007f\\]/.test(value) || value.startsWith("//")) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
    if (!/^https?:\/\//i.test(value) && !( !image && /^mailto:/i.test(value))) return null;
    try { const u = new URL(value); return u.username || u.password ? null : u.href; } catch { return null; }
  }
  if (value.startsWith("#")) return value;
  const match = value.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/)!;
  let path: string;
  try { path = decodeURIComponent(match[1]!); } catch { return null; }
  path = posix.normalize(value.startsWith("/") ? path.slice(1) : posix.join(posix.dirname(ctx.path), path));
  if (path === ".." || path.startsWith("../")) return null;
  const hash = match[3] ?? "";
  if (!image) {
    const key = Object.entries(ctx.docs).find(([, p]) => posix.normalize(p) === path)?.[0];
    if (key) return `?view=projects&id=${encodeURIComponent(ctx.id)}&doc=${encodeURIComponent(key)}${hash}`;
  }
  const base = image ? "https://raw.githubusercontent.com" : "https://github.com";
  return `${base}/${ctx.repo}/${image ? "" : "blob/"}${ctx.sha}/${encodePath(path)}${match[2] ?? ""}${hash}`;
}

/** HTML is not an input language: discard raw tags, emit only owned markup. */
function inline(input: string, ctx: RenderContext, depth = 0): string {
  if (depth > 8) return escapeHtml(input);
  const tokens = /(`+)([\s\S]*?)\1|(!?)\[([^\]\n]*)\]\((<[^>\n]+>|[^\s)]+)(?:\s+"[^"\n]*")?\)|<(https?:\/\/[^>\s]+)>|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*\n]+)\*|_([^_\n]+)_|<\/?[a-zA-Z][^>]*>/g;
  let html = "", last = 0;
  for (const m of input.matchAll(tokens)) {
    html += escapeHtml(input.slice(last, m.index));
    if (m[1]) html += `<code>${escapeHtml(m[2]!)}</code>`;
    else if (m[4] !== undefined) {
      const url = projectDocUrl(m[5]!, ctx, !!m[3]);
      const label = m[4]!;
      html += !url ? escapeHtml(label) : m[3]
        ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(label)}" loading="lazy" referrerpolicy="no-referrer">`
        : `<a href="${escapeHtml(url)}" rel="noopener noreferrer">${inline(label, ctx, depth + 1)}</a>`;
    } else if (m[6]) {
      const url = projectDocUrl(m[6], ctx);
      html += url ? `<a href="${escapeHtml(url)}" rel="noopener noreferrer">${escapeHtml(m[6])}</a>` : escapeHtml(m[6]);
    } else if (m[7] || m[8]) html += `<strong>${inline((m[7] || m[8])!, ctx, depth + 1)}</strong>`;
    else if (m[9]) html += `<del>${inline(m[9], ctx, depth + 1)}</del>`;
    else if (m[10] || m[11]) html += `<em>${inline((m[10] || m[11])!, ctx, depth + 1)}</em>`;
    last = m.index! + m[0].length;
  }
  return html + escapeHtml(input.slice(last));
}

export function renderProjectDoc(md: string, ctx: RenderContext): RenderedProjectDoc {
  const toc: RenderedProjectDoc["toc"] = [], needs = new Set<string>(), anchors = new Map<string, number>();
  // Strip executable HTML outside code fences, including multiline elements.
  let protectedFence: string | undefined;
  const safeLines: string[] = [];
  let htmlBlock = "";
  for (const line of md.replace(/\r\n/g, "\n").split("\n")) {
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (!htmlBlock && f && (!protectedFence || (f[1]![0] === protectedFence[0] && f[1]!.length >= protectedFence.length && !f[2]!.trim()))) {
      protectedFence = protectedFence ? undefined : f[1]!;
      safeLines.push(line); continue;
    }
    if (protectedFence) { safeLines.push(line); continue; }
    let clean = line;
    if (htmlBlock) {
      const end = new RegExp(`</${htmlBlock}\\s*>`, "i").exec(clean);
      if (!end) { safeLines.push(""); continue; }
      clean = clean.slice(end.index + end[0].length); htmlBlock = "";
    }
    clean = clean.replace(/<(script|style|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
    const open = /<(script|style|iframe|object)\b[^>]*>/i.exec(clean);
    if (open) { htmlBlock = open[1]!; clean = clean.slice(0, open.index); }
    safeLines.push(clean.replace(/<!--.*?-->/g, ""));
  }
  const tableCells = (s: string) => s.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map(x => x.trim().replace(/\\\|/g, "|"));
  const isTableRule = (s: string) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(s);
  function blocks(lines: string[], depth = 0): string {
    if (depth > 16) return `<pre>${escapeHtml(lines.join("\n"))}</pre>`;
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!;
      if (!line.trim()) { i++; continue; }
      const fence = line.match(/^\s{0,3}(`{3,}|~{3,})\s*(.*)$/);
      if (fence) {
        const code: string[] = []; i++;
        const end = new RegExp(`^\\s{0,3}${fence[1]![0]}{${fence[1]!.length},}\\s*$`);
        while (i < lines.length && !end.test(lines[i]!)) code.push(lines[i++]!);
        if (i < lines.length) i++;
        if (fence[2]!.trim().toLowerCase() === "mermaid") {
          needs.add("mermaid-svg");
          out.push(`<figure class="project-diagram"><figcaption class="mermaid-pending">다이어그램 렌더 예정</figcaption><pre class="mermaid-src"><code>${escapeHtml(code.join("\n"))}</code></pre></figure>`);
        } else out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        continue;
      }
      const h = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*$/);
      const setext = i + 1 < lines.length && /^\s*(?:={3,}|-{3,})\s*$/.test(lines[i + 1]!) && !/^\s*[-*+]\s/.test(line);
      if (h || setext) {
        const level = h ? h[1]!.length : lines[i + 1]!.trim()[0] === "=" ? 1 : 2;
        const text = plain(h ? h[2]! : line);
        const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-") || "section";
        const n = anchors.get(base) ?? 0; anchors.set(base, n + 1);
        const anchor = `${base}${n ? `-${n}` : ""}`;
        toc.push({ level, text, anchor });
        out.push(`<h${level} id="${escapeHtml(anchor)}">${inline(h ? h[2]! : line, ctx)}</h${level}>`);
        i += h ? 1 : 2; continue;
      }
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
      if (i + 1 < lines.length && line.includes("|") && isTableRule(lines[i + 1]!)) {
        const heads = tableCells(line); i += 2;
        let table = `<div class="project-table"><table><thead><tr>${heads.map(x => `<th>${inline(x, ctx)}</th>`).join("")}</tr></thead><tbody>`;
        while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) {
          table += `<tr>${tableCells(lines[i++]!).map(x => `<td>${inline(x, ctx)}</td>`).join("")}</tr>`;
        }
        out.push(table + "</tbody></table></div>"); continue;
      }
      if (/^\s{0,3}>/.test(line)) {
        const quoted: string[] = [];
        while (i < lines.length && /^\s{0,3}>/.test(lines[i]!)) quoted.push(lines[i++]!.replace(/^\s{0,3}>\s?/, ""));
        out.push(`<blockquote>${blocks(quoted, depth + 1)}</blockquote>`); continue;
      }
      const li = line.match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
      if (li) {
        const indent = li[1]!.length, ordered = /^\d/.test(li[2]!);
        const tag = ordered ? "ol" : "ul";
        let list = `<${tag}>`;
        while (i < lines.length) {
          const current = lines[i]!.match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
          if (!current || current[1]!.length !== indent || /^\d/.test(current[2]!) !== ordered) break;
          const body = current[3]!, task = body.match(/^\[([ xX~])\]\s+(.*)$/);
          const content: string[] = []; i++;
          while (i < lines.length && lines[i]!.trim() && /^\s/.test(lines[i]!) && lines[i]!.match(/^\s*/)![0].length > indent) content.push(lines[i++]!.slice(indent + 2));
          list += `<li>${task ? `<input type="checkbox" disabled${/[xX]/.test(task[1]!) ? " checked" : ""} aria-label="${task[1] === "~" ? "진행중" : task[1] === " " ? "계획" : "완료"}">${task[1] === "~" ? '<span class="task-doing">진행중</span> ' : ""}${inline(task[2]!, ctx)}` : inline(body, ctx)}${content.length ? blocks(content, depth + 1) : ""}</li>`;
        }
        out.push(list + `</${tag}>`); continue;
      }
      const paragraph = [line]; i++;
      while (i < lines.length && lines[i]!.trim() && !/^\s*(?:#{1,6}\s|>|`{3,}|~{3,}|[-+*]\s|\d+[.)]\s)/.test(lines[i]!) && !(i + 1 < lines.length && isTableRule(lines[i + 1]!))) paragraph.push(lines[i++]!);
      out.push(`<p>${inline(paragraph.join("\n"), ctx)}</p>`);
    }
    return out.join("\n");
  }
  const html = blocks(safeLines);
  return { html, title: toc.find(h => h.level === 1)?.text ?? ctx.path, toc, needs: [...needs] };
}

export function projectIntro(md: string): string {
  const paragraphs = md.replace(/```[\s\S]*?```/g, "").split(/\n\s*\n/);
  const paragraph = paragraphs.find(p => p.trim() && !/^\s*(?:#|>|[-*+]|\d+\.|<|!\[)/.test(p));
  return [...plain(paragraph ?? "").replace(/\s+/g, " ")].slice(0, 200).join("");
}
