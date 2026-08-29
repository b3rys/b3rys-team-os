import type { Database } from "bun:sqlite";
import { canonicalCategory, DEFAULT_REPORT_CATEGORY, REPORT_CATEGORIES } from "../lib/reportCategory";
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
  tags: ReportTag[];
  forms: PortalForm[];
  project: string | null;
  created_at: string;
  updated_at: string;
}
export interface ReportTag {
  id: string;
  name: string;
  color: string;
  report_count?: number;
}

export interface ReportListPage {
  reports: ReportMeta[];
  next_cursor: string | null;
  has_more: boolean;
  total: number;
  important_count: number;
  category_counts: Record<string, number>;
  tags: ReportTag[];
}

export interface ReportListOptions {
  limit?: number;
  cursor?: string | null;
  category?: string | null;
  important?: boolean;
  q?: string | null;
  tagIds?: string[];
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
  return { id: r.id, title: r.title, author: r.author, summary: r.summary, category: r.category ?? null, is_important: Boolean(r.is_important), tags: [], forms, project: r.project, created_at: r.created_at, updated_at: r.updated_at };
}

function attachTags(db: Database, reports: ReportMeta[]): ReportMeta[] {
  if (!reports.length) return reports;
  const byId = new Map(reports.map((r) => [r.id, r]));
  const marks = reports.map(() => "?").join(",");
  const rows = db.query(
    `SELECT m.report_id, t.id, t.name, t.color
       FROM report_tag_map m JOIN report_tag t ON t.id = m.tag_id
      WHERE m.report_id IN (${marks})
      ORDER BY t.name COLLATE NOCASE`,
  ).all(...reports.map((r) => r.id)) as Array<{ report_id: string } & ReportTag>;
  for (const row of rows) byId.get(row.report_id)?.tags.push({ id: row.id, name: row.name, color: row.color });
  return reports;
}

export function listReportTags(db: Database): ReportTag[] {
  return db.query(
    `SELECT t.id, t.name, t.color, COUNT(m.report_id) AS report_count
       FROM report_tag t LEFT JOIN report_tag_map m ON m.tag_id = t.id
      GROUP BY t.id ORDER BY t.name COLLATE NOCASE`,
  ).all() as ReportTag[];
}

export function createReportTag(db: Database, input: { name: string; color?: string }): ReportTag {
  const name = input.name.trim();
  if (!name || name.length > 40) throw new Error("tag name must be 1-40 characters");
  const id = nanoid(12);
  db.query("INSERT INTO report_tag (id, name, color) VALUES (?, ?, ?)").run(id, name, input.color || "blue");
  return db.query("SELECT id, name, color FROM report_tag WHERE id = ?").get(id) as ReportTag;
}

export function updateReportTag(db: Database, id: string, input: { name?: string; color?: string }): ReportTag | null {
  const current = db.query("SELECT id, name, color FROM report_tag WHERE id = ?").get(id) as ReportTag | null;
  if (!current) return null;
  const name = input.name == null ? current.name : input.name.trim();
  if (!name || name.length > 40) throw new Error("tag name must be 1-40 characters");
  db.query("UPDATE report_tag SET name = ?, color = ?, updated_at = datetime('now') WHERE id = ?")
    .run(name, input.color ?? current.color, id);
  return db.query("SELECT id, name, color FROM report_tag WHERE id = ?").get(id) as ReportTag;
}

export function deleteReportTag(db: Database, id: string): boolean {
  return db.query("DELETE FROM report_tag WHERE id = ?").run(id).changes > 0;
}

export function setReportTags(db: Database, reportId: string, tagIds: string[]): ReportMeta | null {
  if (!getReport(db, reportId)) return null;
  const unique = [...new Set(tagIds)];
  if (unique.length > 20) throw new Error("a report can have at most 20 tags");
  if (unique.length) {
    const marks = unique.map(() => "?").join(",");
    const count = (db.query(`SELECT COUNT(*) AS c FROM report_tag WHERE id IN (${marks})`).get(...unique) as { c: number }).c;
    if (count !== unique.length) throw new Error("unknown tag");
  }
  db.transaction(() => {
    db.query("DELETE FROM report_tag_map WHERE report_id = ?").run(reportId);
    const insert = db.query("INSERT INTO report_tag_map (report_id, tag_id) VALUES (?, ?)");
    for (const tagId of unique) insert.run(reportId, tagId);
    db.query("UPDATE report SET updated_at = datetime('now') WHERE id = ?").run(reportId);
  })();
  return getReport(db, reportId);
}

// ── report (/reports) ────────────────────────────────────────────────
export function listReports(db: Database): ReportMeta[] {
  const rows = db.query("SELECT * FROM report ORDER BY created_at DESC, id DESC").all() as ReportRow[];
  return attachTags(db, rows.map(rowToReport));
}

// 기본 분류는 lib/reportCategory 의 정본을 쓴다 — 여기 따로 두면 두 곳이 갈린다(오늘 고치는 게 그 문제다).
const CATEGORY_EXPR = "NULLIF(TRIM(category), '')";
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
  const tagIds = [...new Set((options.tagIds ?? []).map((id) => id.trim()).filter(Boolean))];
  if (tagIds.length > 20) throw new Error("too many tag filters");
  if (tagIds.length) {
    const marks = tagIds.map(() => "?").join(",");
    where.push(`report.id IN (SELECT DISTINCT tm.report_id FROM report_tag_map tm WHERE tm.tag_id IN (${marks}))`);
    args.push(...tagIds);
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
  const pageRows = attachTags(db, rows.slice(0, limit).map(rowToReport));
  const hasMore = rows.length > limit;

  const categoryRows = db.query(
    `SELECT categories.name AS category, COUNT(report.id) AS c
       FROM (SELECT name FROM report_category UNION SELECT DISTINCT ${CATEGORY_EXPR} FROM report WHERE ${CATEGORY_EXPR} IS NOT NULL) categories
       LEFT JOIN report ON ${CATEGORY_EXPR} = categories.name ${baseWhereSql ? `AND ${baseWhereSql.slice(6)}` : ""}
      GROUP BY categories.name ORDER BY categories.name COLLATE NOCASE`,
  ).all(...baseArgs) as { category: string; c: number }[];
  const categoryCounts: Record<string, number> = {};
  for (const r of categoryRows) categoryCounts[r.category] = r.c;
  const importantCount = countScalar(db, baseWhere.length ? `WHERE ${baseWhere.join(" AND ")} AND is_important = 1` : "WHERE is_important = 1", baseArgs);

  return {
    reports: pageRows,
    next_cursor: hasMore && pageRows.length ? encodeCursor(pageRows[pageRows.length - 1]!) : null,
    has_more: hasMore,
    total,
    important_count: importantCount,
    category_counts: categoryCounts,
    tags: listReportTags(db),
  };
}

export function getReport(db: Database, id: string): ReportMeta | null {
  const row = db.query("SELECT * FROM report WHERE id = ?").get(id) as ReportRow | null;
  return row ? attachTags(db, [rowToReport(row)])[0]! : null;
}

export function setReportImportant(db: Database, id: string, important: boolean): ReportMeta | null {
  const res = db.query("UPDATE report SET is_important = ?, updated_at = datetime('now') WHERE id = ?").run(important ? 1 : 0, id);
  return res.changes > 0 ? getReport(db, id) : null;
}

function editableCategoryName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (!name || name.length > 40) throw new Error("category must be 1-40 characters");
  return name;
}

/** Move one report between user-managed category folders. */
export function setReportCategory(db: Database, id: string, category: unknown): ReportMeta | null {
  const name = editableCategoryName(category);
  db.query("INSERT OR IGNORE INTO report_category (name) VALUES (?)").run(name);
  const res = db.query("UPDATE report SET category = ?, updated_at = datetime('now') WHERE id = ?").run(name, id);
  return res.changes > 0 ? getReport(db, id) : null;
}

/** Rename a category folder by moving every report that currently belongs to it. */
export function renameReportCategory(db: Database, current: unknown, next: unknown): number {
  const from = editableCategoryName(current);
  const to = editableCategoryName(next);
  if (from === to) return 0;
  db.query("INSERT OR IGNORE INTO report_category (name) VALUES (?)").run(to);
  const changed = db.query(`UPDATE report SET category = ?, updated_at = datetime('now') WHERE NULLIF(TRIM(category), '') = ?`).run(to, from).changes;
  db.query("DELETE FROM report_category WHERE name = ?").run(from);
  return changed;
}

export function createReportCategory(db: Database, category: unknown): string {
  const name = editableCategoryName(category);
  db.query("INSERT INTO report_category (name) VALUES (?)").run(name);
  return name;
}

/** Delete a category folder while preserving its reports without a category. */
export function deleteReportCategory(db: Database, category: unknown): number {
  const name = editableCategoryName(category);
  const changed = db.query("UPDATE report SET category = NULL, updated_at = datetime('now') WHERE NULLIF(TRIM(category), '') = ?").run(name).changes;
  db.query("DELETE FROM report_category WHERE name = ?").run(name);
  return changed;
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
  // 과거 내부 호출자의 분류 별칭은 정본화하지만, 게시 API는 category=null을 넘겨 이 경고 경로를 사용하지 않는다.
  // 신규 게시물은 NULL로 저장되어 ‘전체’에서만 보이고, 폴더 배치는 화면에서 관리한다.
  const category = canonicalCategory(input.category, (original) => {
    console.warn(`[reports] 알 수 없는 분류 "${original}" → "${DEFAULT_REPORT_CATEGORY}" 로 저장합니다 (분류는 ${REPORT_CATEGORIES.join("·")} 만 씁니다)`);
  });
  // 재게시에서 분류를 생략하면 사용자가 화면에서 옮긴 폴더를 유지한다.
  // 신규 보고서는 분류 미지정 시 NULL을 쓰고, 명시된 분류만 기존 값을 덮는다.
  const hasExplicitCategory = typeof input.category === "string" && input.category.trim().length > 0;
  db.query(
    `INSERT INTO report (id, title, author, summary, category, forms_json, project, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, author=excluded.author, summary=excluded.summary,
       category=CASE WHEN ? THEN excluded.category ELSE report.category END,
       forms_json=excluded.forms_json, project=excluded.project,
       created_at=COALESCE(?, report.created_at), updated_at=datetime('now')`,
  ).run(id, input.title, input.author ?? null, input.summary ?? null, hasExplicitCategory ? category : null, forms_json, input.project ?? null, date, hasExplicitCategory, date);
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
