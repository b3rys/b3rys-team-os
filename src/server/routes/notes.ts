// 팀원 → 팀장 편집기(Steno) 파일 우편함.
//
//   POST /api/notes  {from_agent_id, name?, format: "md"|"html", content}  → 201 {id, name}
//   GET  /api/notes?after=<id>&limit=<n>  → {notes: [{id, from_agent_id, name, format, content, created_at}]} (id 오름차순)
//
// 팀원이 쓴 보고서(md·html)를 팀장 맥북 Steno 의 "받은 파일/" 폴더로 보내는 전용 통로다.
// /api/inbox 는 팀장 DM 과 섞이고 본문 길이 제한이 있어 따로 둔다.
//   · 쌓기만 한다 — 덮어쓰기·삭제 없음. 받는 쪽은 마지막으로 받은 id 를 after 로 넘겨 이어 받는다.
//   · 원격 요청은 /api 전체에 걸린 Cloudflare Access 관문(apiCfGate)을 그대로 지난다.
//   · from_agent_id 는 팀 명단에 있는 id 여야 한다.
//   · name 은 받는 쪽이 파일 이름으로 쓰므로 서버에서 경로 문자를 걷어낸다.
import { Hono } from "hono";
import type { Database } from "bun:sqlite";

export type NoteFormat = "md" | "html";
const FORMATS: ReadonlySet<string> = new Set(["md", "html"]);

export const DEFAULT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 50;
const NAME_MAX = 120;

export interface NoteRow {
  id: number;
  from_agent_id: string;
  name: string | null;
  format: NoteFormat;
  content: string;
  created_at: string;
}

interface NotesDeps {
  db: Database;
  /** 팀 명단 id 목록. from_agent_id 검증에 쓴다. */
  memberIds: () => string[];
  maxBytes?: number;
}

export function notesMaxBytes(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.B3OS_NOTES_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_BYTES;
}

/**
 * 받는 쪽이 그대로 파일 이름으로 써도 안전한 이름으로 만든다.
 *   · 경로 부분은 버리고 마지막 조각만(`../../x.md` → `x.md`, `a\b.md` → `b.md`)
 *   · 제어 문자와 `: * ? " < > |` 는 `_`
 *   · 앞의 점·공백 제거(숨김 파일·`..` 방지), 길이 상한
 *   · 확장자가 형식과 다르면 형식 확장자를 붙인다
 * 남는 게 없으면 null — 받는 쪽이 기본 이름을 정한다.
 */
export function safeNoteName(raw: unknown, format: NoteFormat): string | null {
  if (typeof raw !== "string") return null;
  const base = raw.split(/[/\\]/).pop() ?? "";
  let name = base
    .replace(/[\u0000-\u001f\u007f:*?"<>|]/g, "_")
    .replace(/^[.\s]+/, "")
    .trim();
  if (!name) return null;
  const ext = `.${format}`;
  if (!name.toLowerCase().endsWith(ext)) name = `${name}${ext}`;
  if (name.length > NAME_MAX) name = name.slice(0, NAME_MAX - ext.length) + ext;
  return name;
}

type DbRow = { id: number; from_agent: string; name: string | null; format: NoteFormat; content: string; created_at: string };
const toNote = (r: DbRow): NoteRow => ({
  id: r.id,
  from_agent_id: r.from_agent,
  name: r.name,
  format: r.format,
  content: r.content,
  created_at: r.created_at,
});

export function createNotesRoutes(deps: NotesDeps): Hono {
  const app = new Hono();
  const maxBytes = deps.maxBytes ?? notesMaxBytes();

  app.post("/notes", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return c.json({ error: "invalid_json" }, 400);

    const from = typeof body.from_agent_id === "string" ? body.from_agent_id.trim() : "";
    if (!from || !deps.memberIds().includes(from)) return c.json({ error: "unknown_from_agent_id" }, 400);

    const format = typeof body.format === "string" ? body.format : "";
    if (!FORMATS.has(format)) return c.json({ error: "format_must_be_md_or_html" }, 400);

    if (typeof body.content !== "string" || body.content.length === 0) {
      return c.json({ error: "content_required" }, 400);
    }
    const bytes = Buffer.byteLength(body.content, "utf8");
    if (bytes > maxBytes) return c.json({ error: "content_too_large", bytes, max_bytes: maxBytes }, 413);

    const name = safeNoteName(body.name, format as NoteFormat);
    const created = new Date().toISOString();
    const res = deps.db
      .prepare(`INSERT INTO team_note (from_agent, name, format, content, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(from, name, format, body.content, created);
    return c.json({ id: Number(res.lastInsertRowid), name }, 201);
  });

  app.get("/notes", (c) => {
    const afterRaw = c.req.query("after") ?? "0";
    const limitRaw = c.req.query("limit") ?? String(DEFAULT_LIMIT);
    if (!/^\d+$/.test(afterRaw)) return c.json({ error: "after_must_be_integer" }, 400);
    if (!/^\d+$/.test(limitRaw)) return c.json({ error: "limit_must_be_integer" }, 400);
    const after = Number(afterRaw);
    const limit = Math.min(Math.max(Number(limitRaw), 1), MAX_LIMIT);
    const rows = deps.db
      .prepare(
        `SELECT id, from_agent, name, format, content, created_at FROM team_note WHERE id > ? ORDER BY id ASC LIMIT ?`,
      )
      .all(after, limit) as DbRow[];
    return c.json({ notes: rows.map(toNote) });
  });

  return app;
}
