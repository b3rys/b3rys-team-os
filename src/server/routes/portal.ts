import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { join, isAbsolute, resolve, extname } from "node:path";
import {
  listReports, listReportsPage, getReport, upsertReport, deleteReport, setReportImportant,
  listResearch, getResearch, upsertResearch,
  type PortalForm,
} from "../db/reports";
import { ensureThread, insertMessage } from "../db/inbox/messages";
import { createTask } from "../db/taskQueries";
import { leadActorId, trustedActorFromRequest } from "../lib/opAuth";

// 팀 결과물 포털 라우트 — rootApp 에 /reports, /research 로 마운트(BASE_PATH /team 형제).
// 메타=DB, 본문=디스크 파일. report=Bill, research=Demis. 허브 next.config.ts rewrite 로 your-team.example.com 노출.

interface PortalDeps {
  db: Database;
  reportsDir: string;   // 본문 파일 루트 (forms[].path 상대경로 기준)
  researchDir: string;
  webDir: string;       // src/web (Steve 의 reports.html 등 페이지)
}

const MIME: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".pdf": "application/pdf",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav",
  ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json; charset=utf-8",
};

// path traversal 방지: 해석된 경로가 root 안에 있어야 함.
function safeResolve(root: string, p: string): string | null {
  const abs = isAbsolute(p) ? p : join(root, p);
  const r = resolve(abs);
  if (r !== resolve(root) && !r.startsWith(resolve(root) + "/")) {
    // 절대경로 입력이 root 밖이면 거부 (스킬은 reportsDir 안에만 쓰게 함)
    if (isAbsolute(p)) return null;
    return null;
  }
  if (existsSync(r)) {
    try {
      const realRoot = realpathSync(root);
      const real = realpathSync(r);
      if (real !== realRoot && !real.startsWith(realRoot + "/")) return null;
    } catch { return null; }
  }
  return r;
}

function requireActor(request: Request) {
  return trustedActorFromRequest(request, { loopbackDashboardActor: leadActorId() });
}

function serveFile(path: string): Response {
  const ct = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
  return new Response(Bun.file(path), {
    headers: { "content-type": ct, "cache-control": "no-store, max-age=0, must-revalidate" },
  });
}

function findForm(forms: PortalForm[], type: string): PortalForm | undefined {
  return forms.find((f) => (f.type || "").toLowerCase() === type.toLowerCase());
}

export function createReportsApp(deps: PortalDeps): Hono {
  const r = new Hono();

  // 2026-06-07 OWNER: top-level /reports 대신 대시보드 nav 'Reports' 탭으로 일원화.
  // top-level 접근은 대시보드로 redirect (API·파일서빙은 아래 그대로 유지 — 대시보드 탭이 사용).
  r.get("/", (c) => c.redirect("/team?view=reports"));

  r.get("/api/list", (c) => {
    const hasPageQuery =
      c.req.query("limit") != null ||
      c.req.query("cursor") != null ||
      c.req.query("category") != null ||
      c.req.query("important") != null ||
      c.req.query("q") != null;
    if (!hasPageQuery) return c.json({ reports: listReports(deps.db) });
    const limitRaw = Number(c.req.query("limit") ?? 30);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 30;
    const importantRaw = c.req.query("important");
    return c.json(listReportsPage(deps.db, {
      limit,
      cursor: c.req.query("cursor") ?? null,
      category: c.req.query("category") ?? null,
      important: importantRaw === "1" || importantRaw === "true",
      q: c.req.query("q") ?? null,
    }));
  });

  r.get("/api/:id", (c) => {
    const rep = getReport(deps.db, c.req.param("id"));
    return rep ? c.json(rep) : c.json({ error: "not found" }, 404);
  });

  // 본문 파일 서빙: /reports/file/:id/:name
  //  - :name 이 form type('html'/'md'…)이면 해당 form 파일
  //  - 아니면 reports/<id>/<name> 번들 파일(예: ml-bible 챕터 — index 의 상대링크가 여기로 해석됨)
  r.get("/file/:id/:name", (c) => {
    const id = c.req.param("id");
    const name = c.req.param("name");
    const rep = getReport(deps.db, id);
    if (!rep) return c.text("report not found", 404);
    const form = findForm(rep.forms, name);
    const path = form ? safeResolve(deps.reportsDir, form.path) : safeResolve(deps.reportsDir, `${id}/${name}`);
    if (!path || !existsSync(path)) return c.text("file missing", 404);
    return serveFile(path);
  });

  // 등록 훅 (b3os-report 스킬이 렌더 후 POST). localhost 전용 서비스.
  r.post("/api/register", async (c) => {
    const auth = requireActor(c.req.raw);
    if (!auth.ok) return c.json({ error: auth.error }, (auth.status ?? 401) as 401);
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "bad json" }, 400); }
    if (!body?.title) return c.json({ error: "title required" }, 400);
    if (Array.isArray(body.forms) && body.forms.some((f: any) => {
      if (!f || typeof f.path !== "string") return true;
      const resolved = safeResolve(deps.reportsDir, f.path);
      return !resolved || !existsSync(resolved);
    })) {
      return c.json({ error: "report form path escapes reports root" }, 400);
    }
    const rep = upsertReport(deps.db, {
      id: body.id, title: String(body.title), author: body.author ?? null,
      summary: body.summary ?? null, category: body.category ?? null,
      forms: Array.isArray(body.forms) ? body.forms : [], project: body.project ?? null,
      date: body.date ?? null,
    });
    return c.json({ ok: true, report: rep });
  });

  r.patch("/api/:id/important", async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "bad json" }, 400); }
    if (typeof body?.important !== "boolean") return c.json({ error: "important boolean required" }, 400);
    const rep = setReportImportant(deps.db, c.req.param("id"), body.important);
    return rep ? c.json({ ok: true, report: rep }) : c.json({ error: "report not found" }, 404);
  });

  // 요청 버튼: 보고서 + 요청내용을 담당자(기본=author)에게 버스로 directed 전달(깨움) + 추적 task.
  // 담당자가 처리 후 팀장께 보고. (OWNER 2026-06-07)
  r.post("/api/:id/request", async (c) => {
    const auth = requireActor(c.req.raw);
    if (!auth.ok || !auth.actor) return c.json({ error: auth.error }, (auth.status ?? 401) as 401);
    const id = c.req.param("id");
    const rep = getReport(deps.db, id);
    if (!rep) return c.json({ error: "report not found" }, 404);
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "bad json" }, 400); }
    const text = String(body?.text ?? "").trim();
    if (!text) return c.json({ error: "text required" }, 400);
    const assignee = String(body?.assignee ?? rep.author ?? "").trim();
    if (!assignee) return c.json({ error: "no assignee (보고서에 author 없음 — assignee 지정 필요)" }, 400);
    const requester = auth.actor.actor;
    // 유지보수자 도메인 하드코딩 금지 — telegramCapture(mediaUrlBase)와 동일하게 env 미설정 시 빈 문자열 →
    // 상대경로(`/reports#/r/…`)로 우아하게 강등한다(신선 설치서 your-team.example.com 누출 방지). 대시보드 브라우저
    // 컨텍스트에선 상대경로가 그대로 해석된다. 라이브 풀 URL 을 원하면 TEAM_PUBLIC_BASE_URL 을 설정.
    const publicBase = (process.env.TEAM_PUBLIC_BASE_URL ?? process.env.TEAM_BASE_URL ?? "").replace(/\/$/, "");
    const link = `${publicBase}/reports#/r/${id}`;
    const msg = `[보고서 요청 · ${requester}] "${rep.title}"\n${link}\n\n요청: ${text}\n\n→ 처리 후 팀장께 보고해주세요.`;
    // 1) 담당자에게 버스 directed (wakeDispatcher 가 깨움)
    const { thread_id } = ensureThread(deps.db, { from_agent_id: requester, to_agent_id: assignee, type: "dm", body: msg });
    insertMessage(deps.db, { thread_id, from_agent_id: requester, to_agent_id: assignee, type: "dm", body: msg, source: "user", hop_count: 0, priority: "normal" } as any);
    // 2) 추적 task (안 묻히게 — PM 체크포인트와 연결)
    try {
      createTask(deps.db, { title: `요청: ${rep.title}`, column: "doing", owner: assignee, description: `[/reports 요청 · ${requester} → ${assignee}]\n${link}\n\n${text}` });
    } catch {}
    return c.json({ ok: true, assignee, thread_id });
  });

  r.delete("/api/:id", (c) => {
    const auth = requireActor(c.req.raw);
    if (!auth.ok || auth.actor?.actor !== leadActorId()) return c.json({ error: "lead authorization required" }, 403);
    return c.json({ ok: deleteReport(deps.db, c.req.param("id")) });
  });

  return r;
}

export function createResearchApp(deps: PortalDeps): Hono {
  const r = new Hono();

  // 인덱스 페이지: Demis 의 research.html 있으면 그것, 없으면 reports.html 셸 재사용(톤 통일).
  r.get("/", (c) => {
    const page = existsSync(join(deps.webDir, "research.html"))
      ? join(deps.webDir, "research.html")
      : join(deps.webDir, "reports.html");
    if (!existsSync(page)) return c.text("research page not built yet", 503);
    return new Response(Bun.file(page), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  });

  r.get("/api/list", (c) => c.json({ research: listResearch(deps.db) }));
  r.get("/api/:slug", (c) => {
    const it = getResearch(deps.db, c.req.param("slug"));
    return it ? c.json(it) : c.json({ error: "not found" }, 404);
  });

  // 본문: /research/file/:slug/:type (정적 HTML 등)
  r.get("/file/:slug/:type", (c) => {
    const it = getResearch(deps.db, c.req.param("slug"));
    if (!it) return c.text("research not found", 404);
    const form = findForm(it.forms, c.req.param("type"));
    if (!form) return c.text("form not found", 404);
    const path = safeResolve(deps.researchDir, form.path);
    if (!path || !existsSync(path)) return c.text("file missing", 404);
    return serveFile(path);
  });

  r.post("/api/register", async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "bad json" }, 400); }
    if (!body?.slug || !body?.title) return c.json({ error: "slug, title required" }, 400);
    const it = upsertResearch(deps.db, {
      slug: String(body.slug), title: String(body.title), author: body.author ?? null,
      category: body.category ?? null, summary: body.summary ?? null,
      forms: Array.isArray(body.forms) ? body.forms : [],
    });
    return c.json({ ok: true, research: it });
  });

  return r;
}
