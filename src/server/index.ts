import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, migrate } from "./db/migrate";
import {
  listAgents,
  listStatuses,
  recentLogLines,
  recentMetrics,
  latestMetric,
  appendAudit,
} from "./db/queries";
import { agentActivity, agentStats, recentAlerts } from "./db/inboxQueries";
import { claudePoolUsage } from "./lib/claudeUsage";
import { } from "./lib/personaTemplates";
import { isAgentOff } from "./lib/agentControl";
import { syncRegistry, watchRegistry } from "./lib/registry";
import { initGroupOwnerStore } from "./lib/groupOwner";
import { startTmuxTail } from "./workers/tmuxTail";
import { startStatusProbe } from "./workers/statusProbe";
import { startMetricsProbe } from "./workers/metricsProbe";
import { startMessageMaintenance } from "./workers/messageMaintenance";
import { startSlackPoll } from "./workers/slackPoll";
import { startSlackSocket } from "./workers/slackSocket";
import { startTelegramCapture } from "./workers/telegramCapture";
import { startHealthCheck } from "./workers/healthCheck";
import { startProposalSweeper } from "./workers/proposalSweeper";
import { startSchedulerWorker } from "./workers/schedulerWorker";
import { startFollowupWorker } from "./workers/followupWorker";
import { startDmSyncWorker } from "./workers/dmSyncWorker";
import { classifyAll } from "./lib/health";
import { startWakeDispatcher } from "./bus/wakeDispatcher";
import { computeLearningStats } from "./lib/learningStats";
import { teamOsSnapshot } from "./lib/teamosProbe";
import { createInboxRoutes } from "./routes/inbox";
import { createSystemMessageRoutes } from "./routes/systemMessage";
import { createSlackRoutes } from "./routes/slack";
import { loadAgentCreds, hasSlackTokenFile } from "./lib/slack";
import { createRouterRoutes } from "./routes/router";
import { createBusRoutes } from "./routes/bus";
import { createMonitoringRoutes } from "./routes/monitoring";
import { createTaskRoutes } from "./routes/tasks";
import { createProposalRoutes } from "./routes/proposals";
import { createSearchRoutes } from "./routes/search";
import { createReportsApp } from "./routes/portal";
import { createSettingsApp, PUBLIC_BUILD } from "./routes/settings";
import { createAcceptanceRoutes } from "./routes/acceptance";
import { createSchedulerRoutes } from "./routes/scheduler";
import { ensureDailyTaskReviewJobs, ensureWeeklySelfLearningJob } from "./scheduler/core";
import { renderAndRepoint } from "./lib/teamOsRender";
import { createApprovalsApp } from "./routes/approvals";
import { createPermissionGateRoutes } from "./routes/permissionGate";
import { configureLeadActorDb } from "./lib/opAuth";
import { DEFAULT_MEDIA_DIR, contentTypeForMediaFile, resolveMediaPath } from "./lib/mediaStore";
import type { WsEvent } from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.TEAM_HTTP_PORT ?? 7878);
const BIND = process.env.TEAM_BIND ?? "127.0.0.1";
const BASE_PATH = (process.env.BASE_PATH ?? "/team").replace(/\/$/, "");
const DB_PATH = process.env.TEAM_DB_PATH ?? join(__dirname, "../../team.db");
const REGISTRY_PATH = process.env.TEAM_AGENT_REGISTRY ?? join(__dirname, "../../agents.json");
const OPENCLAW_URL = process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789";
const DIST_WEB = join(__dirname, "../../dist/web");
const DOCS_DIR = join(__dirname, "../../docs");
const REPORTS_DIR = join(__dirname, "../../reports");
const RESEARCH_DIR = join(__dirname, "../../research");
const WEB_DIR = join(__dirname, "../web");
const RULES_DIR = join(__dirname, "../../rules");
const VECTOR_DIR = process.env.TEAM_SEARCH_VECTOR_DIR ?? join(__dirname, "../../var/team-search-vectors.lancedb");
const MODEL_CACHE_DIR = process.env.TEAM_SEARCH_MODEL_CACHE_DIR ?? join(__dirname, "../../var/models/fastembed");

const db = openDb(DB_PATH);
migrate(db);
ensureWeeklySelfLearningJob(db);
ensureDailyTaskReviewJobs(db);
configureLeadActorDb(db);
initGroupOwnerStore(db); // 그룹 owner DB 영속화: db 핸들 주입 + 저장된 owner 복원(재시작 유지)
// agents.json 은 런타임 상태(영입된 팀원 레지스트리)라 git 추적에서 제외된다(.gitignore).
// 공개 clone 엔 이 파일이 없으므로, 부팅 시 없으면 빈 레지스트리로 부트스트랩한다 —
// 이 한 줄이 아래 syncRegistry·watchRegistry·readAgents(들)를 전부 안전하게 만든다.
if (!existsSync(REGISTRY_PATH)) writeFileSync(REGISTRY_PATH, "[]\n", "utf-8");
let agents = syncRegistry(db, REGISTRY_PATH);

const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

const sockets = new Set<{ send: (data: string) => void }>();

function broadcast(event: WsEvent): void {
  const payload = JSON.stringify(event);
  for (const s of sockets) {
    try {
      s.send(payload);
    } catch {
      // ignore
    }
  }
}

const stopTmux = startTmuxTail(db, agents, broadcast);
const stopStatus = startStatusProbe(db, agents, broadcast, OPENCLAW_URL);
const stopMetrics = startMetricsProbe(db, broadcast);
const stopMaintenance = startMessageMaintenance(db);
const stopSlackPoll = startSlackPoll({ db, broadcast, agents: () => agents });
const stopSlackSocket = startSlackSocket({ db, broadcast, agents: () => agents });
const stopCapture = startTelegramCapture({ agents: () => agents, db, broadcast });
// OWNER 1:1 DM sync 워커(준실시간 30초 폴링) — 각 런타임 저장소의 OWNER 1:1을 dm_message로 정규화 적재(recall용).
const stopDmSync = startDmSyncWorker(db, () =>
  agents.map((a) => ({
    id: a.id,
    runtime: a.runtime,
    workspacePath: a.workspace_path,
    openclawAgentId: a.openclaw_agent_id,
    hermesProfile: a.hermes_profile,
    hermesStateDbPath: a.state_db_path,
  })),
);
const stopHealth = startHealthCheck({ db, agents: () => agents });
const stopProposalSweeper = startProposalSweeper(db);
const stopScheduler = startSchedulerWorker(db);
const stopFollowupWorker = startFollowupWorker(db, broadcast);
// {{OWNER}} 렌더본 부팅 시 갱신 + claude_channel 에이전트 심링크 재지정 (렌더본 누락 시 룰 깨짐 방지).
try {
  const ownerRow = db.query("SELECT value FROM setting WHERE key = 'owner_name'").get() as { value: string } | null;
  const claudeIds = agents.filter((a) => a.runtime === "claude_channel").map((a) => a.id);
  const rr = renderAndRepoint(ownerRow?.value ?? null, claudeIds);
  console.log(`[teamos-render] owner='${rr.owner}' repointed=${rr.repointed.join(",") || "none"}`);
} catch (e) {
  console.error("[teamos-render] startup failed:", e instanceof Error ? e.message : String(e));
}
// Team Bus v1: wake dispatcher (default ON; shadow mode only if BUS_DISPATCH_ENABLED=false)
const stopDispatcher = startWakeDispatcher({ db, agents: () => agents });

let stopTmuxFn = stopTmux;
let stopStatusFn = stopStatus;

function applyRegistryReload(reloaded: typeof agents): void {
  agents = reloaded;
  stopTmuxFn();
  stopStatusFn();
  stopTmuxFn = startTmuxTail(db, agents, broadcast);
  stopStatusFn = startStatusProbe(db, agents, broadcast, OPENCLAW_URL);
  broadcast({ type: "hello", agents: agents.map((a) => ({ ...a, off: isAgentOff(a.id) })), statuses: listStatuses(db) });
}

function reloadRegistryFromDisk(): void {
  applyRegistryReload(syncRegistry(db, REGISTRY_PATH));
}

watchRegistry(db, REGISTRY_PATH, (reloaded) => {
  applyRegistryReload(reloaded);
});

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, port: PORT, base_path: BASE_PATH, agents: agents.length }));

const api = new Hono();

api.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store, max-age=0, must-revalidate");
});

api.get("/agents", (c) => {
  const all = listAgents(db);
  const statuses = listStatuses(db);
  const statusMap = new Map(statuses.map((s) => [s.agent_id, s]));
  return c.json({
    agents: all.map((a) => ({ ...a, status: statusMap.get(a.id) ?? null })),
  });
});

api.get("/agents/:id/log", (c) => {
  const id = c.req.param("id");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10) || 100, 500);
  const lines = recentLogLines(db, id, limit);
  return c.json({ agent_id: id, lines });
});

// Agent activity feed — all messages involving this agent (in/out), time DESC.
api.get("/agents/:id/activity", (c) => {
  const id = c.req.param("id");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10) || 100, 200);
  const messages = agentActivity(db, id, limit);
  return c.json({ agent_id: id, count: messages.length, messages });
});

// Per-agent stats (24h / 7d counts + avg reply latency).
api.get("/agents/:id/stats", (c) => {
  const id = c.req.param("id");
  return c.json(agentStats(db, id));
});

// Recent operational alerts (failures, warnings).
api.get("/alerts", (c) => {
  const hours = Math.min(parseInt(c.req.query("hours") ?? "6", 10) || 6, 168);
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 200);
  const alerts = recentAlerts(db, hours, limit);
  return c.json({ hours, count: alerts.length, alerts });
});

// Per-agent health classification (health-check Phase 1, observe-only).
api.get("/health/agents", (c) => {
  const verdicts = classifyAll(listStatuses(db), agents);
  const summary = {
    danger: verdicts.filter((v) => v.level === "danger").map((v) => v.agentId),
    warn: verdicts.filter((v) => v.level === "warn").map((v) => v.agentId),
    capacity: verdicts.filter((v) => v.capacityLevel === "danger").map((v) => v.agentId),
    ok: verdicts.filter((v) => v.level === "ok").length,
  };
  return c.json({ summary, agents: verdicts });
});

// self-learning 측정 — 라우팅/injection/health 통계 (audit 로그 분석).
api.get("/learning", (c) => {
  const days = Math.min(parseInt(c.req.query("days") ?? "1", 10) || 1, 14);
  return c.json(computeLearningStats(days));
});

// Team OS operational snapshot: scripts, scheduled tasks (launchd/openclaw cron),
// in-flight TODO. Read-only, 15s-cached — no effect on the team bus.
api.get("/teamos", (c) => c.json(teamOsSnapshot(db)));

api.get("/metrics", (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "120", 10) || 120, 720);
  return c.json({ latest: latestMetric(db) ?? null, recent: recentMetrics(db, limit) });
});

// Shared Claude Max pool usage (5h / 7d) across all claude_channel agents.
api.get("/usage/claude", async (c) => {
  return c.json(await claudePoolUsage(agents));
});

// Agent config viewer: registry entry + persona file content.
api.get("/agents/:id/config", (c) => {
  const id = c.req.param("id");
  const agent = agents.find((a) => a.id === id);
  if (!agent) return c.json({ error: "unknown_agent", id }, 404);
  let persona: { path: string; content: string | null; exists: boolean; bytes: number } = {
    path: agent.persona_file,
    content: null,
    exists: false,
    bytes: 0,
  };
  try {
    if (existsSync(agent.persona_file)) {
      const content = readFileSync(agent.persona_file, "utf-8");
      persona = { path: agent.persona_file, content, exists: true, bytes: statSync(agent.persona_file).size };
    }
  } catch (e) {
    persona.content = `(읽기 실패: ${e instanceof Error ? e.message : String(e)})`;
  }
  const slackCreds = loadAgentCreds(id);
  const slackConnectionMode = agent.slack_connection_mode === "socket" ? "socket" : "webhook";
  // ★대시보드 persona 칸 = SOUL.md. 그게 전부다.★ (OWNER 2026-07-17)
  //   "persona 값은 그냥 soul.md 에만 저장해. 대시보드 나머지 필드는 agents.json이 원본이면 되고"
  //   agents.json 의 purpose 필드는 제거됐다. fallback 도 없다 — ★소스가 하나면 어긋날 수가 없다.★
  //   (옛 구조는 purpose 를 읽어 pre-fill 했다. 그래서 사용자가 SOUL 을 고치면 칸엔 옛 purpose 가 뜨고,
  //    프론트가 저장 때 그 칸을 항상 보내서 → role 만 바꿔도 손질한 SOUL 이 되돌아갔다. steve 리뷰 2026-07-17)
  const customPersona = persona.exists && persona.content && !persona.content.startsWith("(읽기 실패")
    ? persona.content.trim()
    : "";
  return c.json({
    agent,
    persona,
    custom_persona: customPersona,
    off: isAgentOff(id),
    slack_status: {
      has_token: !!slackCreds?.bot_token,
      has_token_file: hasSlackTokenFile(id),
      has_signing_secret: !!slackCreds?.signing_secret,
      has_app_id: !!slackCreds?.app_id,
      has_app_token: !!slackCreds?.app_token,
      mode: slackConnectionMode,
      slack_connection_mode: slackConnectionMode,
      socket_ready: slackConnectionMode === "socket" && !!slackCreds?.bot_token && !!slackCreds?.app_token,
      state: agent.slack_bot_user_id && slackCreds?.bot_token ? "ready" : agent.slack_bot_user_id || hasSlackTokenFile(id) ? "partial" : "not_connected",
    },
  });
});

// Persona file editor: writes ONLY to the agent's registered persona_file path.
const MAX_PERSONA_BYTES = 256 * 1024;
api.put("/agents/:id/persona", async (c) => {
  const id = c.req.param("id");
  const agent = agents.find((a) => a.id === id);
  if (!agent) return c.json({ error: "unknown_agent", id }, 404);
  let body: { content?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (typeof body.content !== "string") return c.json({ error: "content_must_be_string" }, 400);
  if (Buffer.byteLength(body.content, "utf-8") > MAX_PERSONA_BYTES) {
    return c.json({ error: "too_large", max_bytes: MAX_PERSONA_BYTES }, 413);
  }
  // Scope guard: only ever write to the path declared in the registry for this agent.
  try {
    writeFileSync(agent.persona_file, body.content, "utf-8");
  } catch (e) {
    return c.json({ error: "write_failed", detail: e instanceof Error ? e.message : String(e) }, 500);
  }
  appendAudit(db, "user", "persona_edited", id, { path: agent.persona_file, bytes: Buffer.byteLength(body.content) });
  return c.json({ ok: true, path: agent.persona_file, bytes: Buffer.byteLength(body.content, "utf-8") });
});

const inboxApi = createInboxRoutes({
  db,
  broadcast,
  registeredAgentIds: () => new Set(agents.map((a) => a.id)),
  agents: () => agents,   // ★[B] 텔레그램 릴레이용★ — 팀원이 직접 방/팀장께 말하려면 봇 토큰이 필요하다
});
api.route("/", inboxApi);

const systemMessageApi = createSystemMessageRoutes({
  db,
  broadcast,
  registeredAgentIds: () => new Set(agents.map((a) => a.id)),
});
api.route("/", systemMessageApi);

const slackApi = createSlackRoutes({ db, broadcast, agents: () => agents });
api.route("/", slackApi);

const routerApi = createRouterRoutes({ agents: () => agents, db });
api.route("/", routerApi);

const busApi = createBusRoutes({ db });
api.route("/", busApi);

const monitoringApi = createMonitoringRoutes({ db });
api.route("/", monitoringApi);

const taskApi = createTaskRoutes({ db });
api.route("/", taskApi);

const proposalApi = createProposalRoutes({ db });
api.route("/", proposalApi);

const searchApi = createSearchRoutes({
  db,
  docsDir: DOCS_DIR,
  reportsDir: REPORTS_DIR,
  rulesDir: RULES_DIR,
  registryPath: REGISTRY_PATH,
  vectorDir: VECTOR_DIR,
  modelCacheDir: MODEL_CACHE_DIR,
});
api.route("/", searchApi);

const settingsApi = createSettingsApp({
  db,
  registryPath: REGISTRY_PATH,
  teamOsPath: join(RULES_DIR, "TEAM-OS.md"),
  appendAudit,
  onRegistryChanged: reloadRegistryFromDisk,
});
api.route("/", settingsApi);

const acceptanceApi = createAcceptanceRoutes({
  db,
  registryPath: REGISTRY_PATH,
  teamOsPath: join(RULES_DIR, "TEAM-OS.md"),
});
api.route("/", acceptanceApi);

const schedulerApi = createSchedulerRoutes({
  db,
  registeredAgentIds: () => new Set(agents.map((a) => a.id)),
  schedulerAcceptingJobs: () =>
    process.env.B3OS_SCHEDULER_ACCEPT_JOBS === "true" || process.env.B3OS_SCHEDULER_ENABLED === "true",
});
api.route("/", schedulerApi);

const approvalsApi = createApprovalsApp({ db });
api.route("/", approvalsApi);

// permissionGate 라우트 = codex 런타임 전용(op을 게이트로 라우팅하는 codex/b3os_native만 사용). 공개빌드에선
// codex·b3os_native가 미노출(영입/스왑 서버측 거부)이라 이 라우트는 무의미하고, 무인증 /check·DECIDE_TOKEN
// 표면(Demis #2/#4)을 공개에 남기지 않도록 미마운트한다. 라이브에서만 활성. (검증 후 공개시 재노출.)
const permissionGateApi = createPermissionGateRoutes({ db });
if (!PUBLIC_BUILD) api.route("/", permissionGateApi);

app.route("/api", api);

const PUBLIC_RULE_FILES = new Set(["TEAM-OS.md", "SHARED.md"]);

app.get("/docs/:file", (c) => {
  const file = c.req.param("file");
  if (file !== basename(file) || !/\.(md|txt|json)$/i.test(file)) return c.text("document not found", 404);
  const filePath = file === "agents.json" ? REGISTRY_PATH : join(DOCS_DIR, file);
  if (!existsSync(filePath)) return c.text("document not found", 404);
  const contentType = file.endsWith(".json") ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8";
  return new Response(Bun.file(filePath), {
    headers: {
      "content-type": contentType,
      "cache-control": "no-store, max-age=0, must-revalidate",
    },
  });
});

app.get("/rules/:file", (c) => {
  const file = c.req.param("file");
  if (!PUBLIC_RULE_FILES.has(file)) return c.text("rule not found", 404);
  const filePath = join(RULES_DIR, file);
  if (!existsSync(filePath)) return c.text("rule not found", 404);
  return new Response(Bun.file(filePath), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "no-store, max-age=0, must-revalidate",
    },
  });
});

app.get("/media/:file", (c) => {
  const file = c.req.param("file");
  const filePath = resolveMediaPath(DEFAULT_MEDIA_DIR, file);
  if (!filePath || !existsSync(filePath)) return c.text("media not found", 404);
  return new Response(Bun.file(filePath), {
    headers: {
      "content-type": contentTypeForMediaFile(filePath),
      "cache-control": "private, no-store, max-age=0, must-revalidate",
    },
  });
});

app.get(
  "/ws",
  upgradeWebSocket((_c) => ({
    onOpen(_evt, ws) {
      const handle = { send: (data: string) => ws.send(data) };
      sockets.add(handle);
      ws.send(
        JSON.stringify({
          type: "hello",
          agents: agents.map((a) => ({ ...a, off: isAgentOff(a.id) })),
          statuses: listStatuses(db),
        } satisfies WsEvent),
      );
      (ws as unknown as { __handle: typeof handle }).__handle = handle;
    },
    onClose(_evt, ws) {
      const handle = (ws as unknown as { __handle?: { send: (s: string) => void } }).__handle;
      if (handle) sockets.delete(handle);
    },
  })),
);

if (existsSync(DIST_WEB)) {
  app.get("/*", async (c) => {
    // c.req.url is the FULL URL — strip BASE_PATH prefix since the sub-app is mounted there.
    let reqPath = new URL(c.req.url).pathname;
    if (BASE_PATH && reqPath.startsWith(BASE_PATH)) {
      reqPath = reqPath.slice(BASE_PATH.length) || "/";
    }
    const rel = reqPath === "/" || reqPath === "" ? "/index.html" : reqPath;
    const filePath = join(DIST_WEB, rel);
    const isHashedAsset = /\/assets\/[^/]+-[A-Za-z0-9_-]+\.[a-z]+$/.test(rel);
    if (existsSync(filePath)) {
      const file = Bun.file(filePath);
      const ct =
        rel.endsWith(".html") ? "text/html; charset=utf-8"
        : rel.endsWith(".js") ? "application/javascript; charset=utf-8"
        : rel.endsWith(".css") ? "text/css; charset=utf-8"
        : rel.endsWith(".svg") ? "image/svg+xml"
        : rel.endsWith(".json") ? "application/json"
        : rel.endsWith(".ico") ? "image/x-icon"
        : rel.endsWith(".png") ? "image/png"
        : rel.endsWith(".woff2") ? "font/woff2"
        : "application/octet-stream";
      // Hashed assets: immutable long cache. Everything else (html): no-store.
      const cache = isHashedAsset
        ? "public, max-age=31536000, immutable"
        : "no-store, max-age=0, must-revalidate";
      return new Response(file, { headers: { "content-type": ct, "cache-control": cache } });
    }
    // SPA fallback — only for routes WITHOUT a file extension (real client-side routes).
    // Asset requests (anything with /assets/ or a known extension) that miss should 404.
    if (rel.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(rel)) {
      return c.text(`asset not found: ${rel}`, 404);
    }
    const indexPath = join(DIST_WEB, "index.html");
    if (existsSync(indexPath)) {
      return new Response(Bun.file(indexPath), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store, max-age=0, must-revalidate",
        },
      });
    }
    return c.text("not built — run `bun run build` or open Vite dev :5173", 404);
  });
} else {
  app.get("/*", (c) =>
    c.html(
      `<!doctype html><meta charset="utf-8"><title>team-collab</title>
<body style="font:14px/1.5 -apple-system,sans-serif;background:#0F172A;color:#F8FAFC;padding:48px;max-width:720px;margin:auto">
<h1 style="color:#22C55E">team-collab</h1>
<p>Phase 1 backend is running on port ${PORT}.</p>
<p>Frontend bundle not built yet. Run:</p>
<pre style="background:#020617;padding:16px;border-radius:8px">cd ~/Development/your-workspace/team-collab
bun install
bun run build</pre>
<p>Or open Vite dev server: <a href="http://localhost:5173${BASE_PATH}/" style="color:#22C55E">http://localhost:5173${BASE_PATH}/</a></p>
<h3>API health</h3>
<ul>
<li><a style="color:#22C55E" href="${BASE_PATH}/api/agents">${BASE_PATH}/api/agents</a></li>
<li><a style="color:#22C55E" href="${BASE_PATH}/api/metrics">${BASE_PATH}/api/metrics</a></li>
</ul>
</body>`,
    ),
  );
}

const rootApp = new Hono();
rootApp.get("/health", (c) => c.json({ ok: true }));
rootApp.route(BASE_PATH, app);

// 팀 결과물 포털 — /team 형제로 노출. 허브 next.config.ts rewrite 로 your-team.example.com/reports.
// (2026-06-07 OWNER: /research 취소 — 모든 팀 산출물을 /reports 에 category 로 구분해 통합.)
const portalDeps = { db, reportsDir: REPORTS_DIR, researchDir: RESEARCH_DIR, webDir: WEB_DIR };
rootApp.route("/reports", createReportsApp(portalDeps));
rootApp.get("/reports/", (c) => c.redirect("/reports"));

// ★포트 점유 가드 (fresh-user 막다름 방지)★ — Bun.serve 는 포트 사용중이면 EADDRINUSE 를 던진다.
//   무가드면 raw 스택트레이스로 즉사 → Claude Code 는 원인을 못 보고 사용자도 막힌다(BUG4류).
//   catch 해서 ★실행가능한 조치★를 출력하고 깨끗이 종료한다.
let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
    port: PORT,
    hostname: BIND,
    // ★idleTimeout 명시(Bun 기본 10s) — hermes 활성화(POST /ot/:id/activate)는 브리지 셋업 + poller/gateway
    //   게이트(기본 28s) + 첫 모델호출로 10s를 넘겨, 기본값이면 Bun이 소켓을 끊어 브라우저 "Failed to fetch"가 뜬다
    //   (핸들러는 계속 돌아 부분상태 잔존). claude는 poller가 몇 초라 우연히 통과. Bun 최대=255s. (BUG4, OWNER 맥북테스트 2026-07-03)
    idleTimeout: 255,
    fetch: rootApp.fetch,
    websocket,
  });
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if ((e as any)?.code === "EADDRINUSE" || /EADDRINUSE|in use|address already/i.test(msg)) {
    console.error(
      `\n[team-collab] ❌ 포트 ${PORT} 이(가) 이미 사용 중입니다.\n` +
        `  해결(둘 중 하나):\n` +
        `    1) .env 에 TEAM_HTTP_PORT=7900 등 다른 포트를 설정하고 다시 'bun run start'.\n` +
        `    2) lsof -nP -iTCP:${PORT} -sTCP:LISTEN 로 점유 프로세스를 확인해 종료 후 재시작.\n`,
    );
    process.exit(1);
  }
  throw e;
}

console.log(`[team-collab] listening http://${BIND}:${server.port}${BASE_PATH}`);
console.log(`[team-collab] registry: ${REGISTRY_PATH} (${agents.length} agents)`);
console.log(`[team-collab] db: ${DB_PATH}`);

const shutdown = () => {
  console.log("[team-collab] shutting down");
  stopTmuxFn();
  stopStatusFn();
  stopMaintenance();
  stopMetrics();
  stopSlackPoll();
  stopSlackSocket();
  stopScheduler();
  stopFollowupWorker();
  stopDmSync();
  stopDispatcher();
  server.stop();
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
