import type { Database } from "bun:sqlite";
import { Buffer } from "node:buffer";
import { nanoid } from "nanoid";

// 팀 결과물 포털 데이터 레이어 — /reports(report) + /research(research).
// 메타는 DB, 본문은 디스크 파일(forms[].path). report=Bill owned, research=Demis owned, 골격 동일.

export interface PortalForm {
  type: string; // 'md' | 'html' | 'pdf' | 'pptx' | 'audio' | ...
  path: string; // REPORTS_DIR/RESEARCH_DIR 기준 상대경로 또는 절대경로
  label?: string; // 표시 라벨(선택, 번들 챕터 등)
}

export interface ReportMeta {
  id: string;
  title: string;
  author: string | null;
  summary: string | null;
  category: string | null; // '보고서' | '교육자료' | '리서치' | ... (/research 통합)
  is_important: boolean;
  forms: PortalForm[];
  project: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReportListPage {
  reports: ReportMeta[];
  next_cursor: string | null;
  has_more: boolean;
  total: number;
  important_count: number;
  category_counts: Record<string, number>;
}

export interface ReportListOptions {
  limit?: number;
  cursor?: string | null;
  category?: string | null;
  important?: boolean;
  q?: string | null;
}

interface ReportRow {
  id: string;
  title: string;
  author: string | null;
  summary: string | null;
  category: string | null;
  is_important: number | boolean | null;
  forms_json: string;
  project: string | null;
  created_at: string;
  updated_at: string;
}

function rowToReport(r: ReportRow): ReportMeta {
  let forms: PortalForm[] = [];
  try {
    const p = JSON.parse(r.forms_json);
    if (Array.isArray(p)) forms = p;
  } catch {}
  return { id: r.id, title: r.title, author: r.author, summary: r.summary, category: r.category ?? null, is_important: Boolean(r.is_important), forms, project: r.project, created_at: r.created_at, updated_at: r.updated_at };
}

// ── report (/reports) ────────────────────────────────────────────────
export function listReports(db: Database): ReportMeta[] {
  const rows = db.query("SELECT * FROM report ORDER BY created_at DESC, id DESC").all() as ReportRow[];
  return rows.map(rowToReport);
}

const DEFAULT_REPORT_CATEGORY = "보고서";
const CATEGORY_EXPR = `COALESCE(NULLIF(TRIM(category), ''), '${DEFAULT_REPORT_CATEGORY}')`;
const MAX_REPORT_PAGE_SIZE = 100;
type DbArg = string | number | boolean | null;

function encodeCursor(r: ReportMeta): string {
  return Buffer.from(JSON.stringify({ created_at: r.created_at, id: r.id })).toString("base64url");
}

function decodeCursor(cursor: string | null | undefined): { created_at: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { created_at?: unknown; id?: unknown };
    return typeof parsed.created_at === "string" && typeof parsed.id === "string"
      ? { created_at: parsed.created_at, id: parsed.id }
      : null;
  } catch {
    return null;
  }
}

function qFilter(q: string | null | undefined, args: DbArg[]): string | null {
  const s = String(q ?? "").trim();
  if (!s) return null;
  const like = `%${s}%`;
  args.push(like, like, like, like);
  return `(title LIKE ? OR author LIKE ? OR summary LIKE ? OR ${CATEGORY_EXPR} LIKE ?)`;
}

function countScalar(db: Database, whereSql: string, args: DbArg[]): number {
  const row = db.query(`SELECT COUNT(*) AS c FROM report ${whereSql}`).get(...args) as { c: number } | null;
  return row?.c ?? 0;
}

export function listReportsPage(db: Database, options: ReportListOptions = {}): ReportListPage {
  const limit = Math.max(1, Math.min(MAX_REPORT_PAGE_SIZE, Math.floor(options.limit ?? 30)));
  const baseWhere: string[] = [];
  const baseArgs: DbArg[] = [];
  const q = qFilter(options.q, baseArgs);
  if (q) baseWhere.push(q);
  const baseWhereSql = baseWhere.length ? `WHERE ${baseWhere.join(" AND ")}` : "";

  const where = [...baseWhere];
  const args = [...baseArgs];
  const category = String(options.category ?? "").trim();
  if (category) {
    where.push(`${CATEGORY_EXPR} = ?`);
    args.push(category);
  }
  if (options.important === true) {
    where.push("is_important = 1");
  }
  const totalWhereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = countScalar(db, totalWhereSql, args);

  const cursor = decodeCursor(options.cursor);
  if (cursor) {
    where.push("(created_at < ? OR (created_at = ? AND id < ?))");
    args.push(cursor.created_at, cursor.created_at, cursor.id);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db.query(
    `SELECT * FROM report ${whereSql}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
  ).all(...args, limit + 1) as ReportRow[];
  const pageRows = rows.slice(0, limit).map(rowToReport);
  const hasMore = rows.length > limit;

  const categoryRows = db.query(
    `SELECT ${CATEGORY_EXPR} AS category, COUNT(*) AS c
       FROM report ${baseWhereSql}
      GROUP BY ${CATEGORY_EXPR}
      ORDER BY CASE WHEN ${CATEGORY_EXPR} = '${DEFAULT_REPORT_CATEGORY}' THEN 0 ELSE 1 END, ${CATEGORY_EXPR} COLLATE NOCASE`,
  ).all(...baseArgs) as { category: string; c: number }[];
  const categoryCounts: Record<string, number> = {};
  for (const r of categoryRows) categoryCounts[r.category || DEFAULT_REPORT_CATEGORY] = r.c;
  const importantCount = countScalar(db, baseWhere.length ? `WHERE ${baseWhere.join(" AND ")} AND is_important = 1` : "WHERE is_important = 1", baseArgs);

  return {
    reports: pageRows,
    next_cursor: hasMore && pageRows.length ? encodeCursor(pageRows[pageRows.length - 1]!) : null,
    has_more: hasMore,
    total,
    important_count: importantCount,
    category_counts: categoryCounts,
  };
}

export function getReport(db: Database, id: string): ReportMeta | null {
  const row = db.query("SELECT * FROM report WHERE id = ?").get(id) as ReportRow | null;
  return row ? rowToReport(row) : null;
}

export function setReportImportant(db: Database, id: string, important: boolean): ReportMeta | null {
  const res = db.query("UPDATE report SET is_important = ?, updated_at = datetime('now') WHERE id = ?").run(important ? 1 : 0, id);
  return res.changes > 0 ? getReport(db, id) : null;
}

/** upsert by id. id 없으면 생성. forms=[{type,path}]. 스킬 등록 훅이 호출. */
export function upsertReport(
  db: Database,
  input: { id?: string; title: string; author?: string | null; summary?: string | null; category?: string | null; forms?: PortalForm[]; project?: string | null; date?: string | null },
): ReportMeta {
  const id = input.id || nanoid();
  const forms_json = JSON.stringify(input.forms ?? []);
  // date = 실제 작성일(있으면 created_at 으로). 없으면 INSERT 시 now / 갱신 시 기존값 유지.
  // created_at = 정렬·표시 기준(보고서 작성일). 등록시각은 updated_at 으로 충분.
  const date = input.date ?? null;
  db.query(
    `INSERT INTO report (id, title, author, summary, category, forms_json, project, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, author=excluded.author, summary=excluded.summary,
       category=excluded.category, forms_json=excluded.forms_json, project=excluded.project,
       created_at=COALESCE(?, report.created_at), updated_at=datetime('now')`,
  ).run(id, input.title, input.author ?? null, input.summary ?? null, input.category ?? null, forms_json, input.project ?? null, date, date);
  return getReport(db, id)!;
}

export function deleteReport(db: Database, id: string): boolean {
  const res = db.query("DELETE FROM report WHERE id = ?").run(id);
  return res.changes > 0;
}

// ── research (/research, Demis owned) — 형제 골격 ─────────────────────
export interface ResearchMeta {
  slug: string;
  title: string;
  author: string | null;
  category: string | null;
  summary: string | null;
  forms: PortalForm[];
  created_at: string;
  updated_at: string;
}
interface ResearchRow {
  slug: string; title: string; author: string | null; category: string | null;
  summary: string | null; forms_json: string; created_at: string; updated_at: string;
}
function rowToResearch(r: ResearchRow): ResearchMeta {
  let forms: PortalForm[] = [];
  try { const p = JSON.parse(r.forms_json); if (Array.isArray(p)) forms = p; } catch {}
  return { slug: r.slug, title: r.title, author: r.author, category: r.category, summary: r.summary, forms, created_at: r.created_at, updated_at: r.updated_at };
}
export function listResearch(db: Database): ResearchMeta[] {
  const rows = db.query("SELECT * FROM research ORDER BY created_at DESC").all() as ResearchRow[];
  return rows.map(rowToResearch);
}
export function getResearch(db: Database, slug: string): ResearchMeta | null {
  const row = db.query("SELECT * FROM research WHERE slug = ?").get(slug) as ResearchRow | null;
  return row ? rowToResearch(row) : null;
}
export function upsertResearch(
  db: Database,
  input: { slug: string; title: string; author?: string | null; category?: string | null; summary?: string | null; forms?: PortalForm[] },
): ResearchMeta {
  const forms_json = JSON.stringify(input.forms ?? []);
  db.query(
    `INSERT INTO research (slug, title, author, category, summary, forms_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       title=excluded.title, author=excluded.author, category=excluded.category,
       summary=excluded.summary, forms_json=excluded.forms_json, updated_at=datetime('now')`,
  ).run(input.slug, input.title, input.author ?? null, input.category ?? null, input.summary ?? null, forms_json);
  return getResearch(db, input.slug)!;
}
