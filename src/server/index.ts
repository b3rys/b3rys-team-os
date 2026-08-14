import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import { existsSync, readFileSync, statSync, copyFileSync, unlinkSync } from "node:fs";
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
import { JOIN_FLAG_FILE, isLegacyJoinFlag } from "./lib/personaTemplates";
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
import { createCiStatusRoutes } from "./routes/ciStatus";
import { ensureDailyTaskReviewJobs, ensureWeeklySelfLearningJobs } from "./scheduler/core";
import { renderAndRepoint } from "./lib/teamOsRender";
import { installProgressHook, repairProgressHook, repairReplyGuardHook, ensureOwnerGateHook } from "./runtimes/claude/launcher";
import { writeMemberPersona, savePersonaFile } from "./lib/writeMemberPersona";
import { persistOwnerChatIdIfEmpty } from "./runtimes/codex/launcher";
import { createApprovalsApp } from "./routes/approvals";
import { createPermissionGateRoutes } from "./routes/permissionGate";
import { buildMcpHttpApp } from "./mcp/mcpHttpRoute";
import { configureLeadActorDb, leadActorId, trustedActorFromRequest } from "./lib/opAuth";
import { createHostGate } from "./lib/hostGate";
import { DEFAULT_MEDIA_DIR, contentTypeForMediaFile, resolveMediaPath } from "./lib/mediaStore";
import { captureServerIdentity, deploymentIdentity } from "./lib/deployIdentity";
import type { WsEvent } from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.TEAM_HTTP_PORT ?? 7878);
const BIND = process.env.TEAM_BIND ?? "127.0.0.1";
const BASE_PATH = (process.env.BASE_PATH ?? "/team").replace(/\/$/, "");
const DB_PATH = process.env.TEAM_DB_PATH ?? join(__dirname, "../../team.db");
const REGISTRY_PATH = process.env.TEAM_AGENT_REGISTRY ?? join(__dirname, "../../agents.json");
const OPENCLAW_URL = process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789";
const DIST_WEB = join(__dirname, "../../dist/web");
const REPO_ROOT_FOR_IDENTITY = join(__dirname, "../..");
/**
 * ★서버 층 신원은 기동 시 한 번 굳힌다.★ 이 값은 재시작해야 바뀌는 값이라(코드를 메모리에 올린 시점)
 * 요청마다 다시 읽으면 오히려 거짓말이 된다 — 트리가 먼저 앞서 나가도 ★돌고 있는 코드는 그대로다.★
 */
const SERVER_IDENTITY = captureServerIdentity(REPO_ROOT_FOR_IDENTITY, new Date());
const DOCS_DIR = join(__dirname, "../../docs");
const REPORTS_DIR = join(__dirname, "../../reports");
const RESEARCH_DIR = join(__dirname, "../../research");
const WEB_DIR = join(__dirname, "../web");
const RULES_DIR = join(__dirname, "../../rules");
const VECTOR_DIR = process.env.TEAM_SEARCH_VECTOR_DIR ?? join(__dirname, "../../var/team-search-vectors.lancedb");
const MODEL_CACHE_DIR = process.env.TEAM_SEARCH_MODEL_CACHE_DIR ?? join(__dirname, "../../var/models/fastembed");

const db = openDb(DB_PATH);
migrate(db);
ensureWeeklySelfLearningJobs(db);
ensureDailyTaskReviewJobs(db);
configureLeadActorDb(db);
initGroupOwnerStore(db); // 그룹 owner DB 영속화: db 핸들 주입 + 저장된 owner 복원(재시작 유지)
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
let stopCapture = startTelegramCapture({ agents: () => agents, db, broadcast });
// capture 워커 재init — Settings ▸ System OP 에서 capture 토큰/그룹을 저장하면 서버 재시작 없이 즉시 적용한다
// (워커가 토큰을 부팅 시 1회 읽으므로, 새 토큰으로 텔레그램에 다시 붙으려면 재init 필요).
const restartCapture = () => {
  try { stopCapture(); } catch { /* best-effort */ }
  stopCapture = startTelegramCapture({ agents: () => agents, db, broadcast });
};
// GD 1:1 DM sync 워커(준실시간 30초 폴링) — 각 런타임 저장소의 GD 1:1을 dm_message로 정규화 적재(recall용).
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
// owner_chat_id 자동저장 — 비어 있고 claude access.json(페어링) 등에서 도출되면 team.db 에 persist.
// 대시보드 도움말("claude 첫 팀원 영입 시 자동 채워집니다")과 실제 동작 일치 + hermes activate 가 안정 설정값을 읽게.
try {
  if (persistOwnerChatIdIfEmpty(db)) console.log("[owner-chat-id] 도출값 자동저장됨(설정 비어있던 상태)");
} catch { /* best-effort */ }

// {{OWNER}} 렌더본 부팅 시 갱신 + claude_channel 에이전트 심링크 재지정 (렌더본 누락 시 룰 깨짐 방지).
try {
  const ownerRow = db.query("SELECT value FROM setting WHERE key = 'owner_name'").get() as { value: string } | null;
  const claudeIds = agents.filter((a) => a.runtime === "claude_channel").map((a) => a.id);
  const rr = renderAndRepoint(ownerRow?.value ?? null, claudeIds);
  console.log(`[teamos-render] owner='${rr.owner}' repointed=${rr.repointed.join(",") || "none"}`);

  // ★팀 학습 로그도 없으면 만든다★ — TEAM-OS.md 와 같은 방식(템플릿만 track, 실사용 파일은 생성).
  //   #148 이 rules/SHARED.md 를 추적 제외하면서, 그 커밋을 pull 한 ★기존 설치본에서 파일이 삭제★ 됐다
  //   (채워둔 팀은 git 이 막아주지만, 템플릿 그대로였던 팀은 fast-forward 로 지워진다).
  //   그런데 문서화된 업데이트 절차는 `git pull → build → restart` 라 ★install.sh 를 다시 돌지 않는다★ →
  //   설치 스크립트에만 생성 로직을 두면 기존 설치본은 영영 파일이 없고, TEAM-OS 의 "교훈은 SHARED.md 로"
  //   안내가 없는 파일을 가리킨다. 재시작은 어차피 하므로 여기서 덮는다. (steve 교차검증)
  //   ★이미 있으면 절대 건드리지 않는다★ — 팀이 쌓아온 기록이다.
  try {
    const sharedPath = join(RULES_DIR, "SHARED.md");
    const sharedTemplate = join(RULES_DIR, "SHARED.template.md");
    if (!existsSync(sharedPath) && existsSync(sharedTemplate)) {
      copyFileSync(sharedTemplate, sharedPath);
      console.log("[teamos-render] rules/SHARED.md 생성(템플릿 복사) — 팀 학습 로그, 추적되지 않습니다");
    }
  } catch (e) {
    console.warn("[teamos-render] SHARED.md 생성 실패(계속):", e instanceof Error ? e.message : e);
  }
  // ★이미 깔린 progress 훅 배선 수리 — 게이트 밖★ (공개·라이브 공통).
  //   위 백필은 `PUBLIC_BUILD` 뒤에 있어 라이브에서는 안 돈다. 그래서 ★이미 깔린 배선이 낡아도
  //   아무도 안 고쳤고★, 훅 커맨드가 옛것으로 남아 owner-skip 이 fail-open 으로 돌았다.
  //   여기서는 ★배선이 이미 있는 멤버만★ 저장소 기준으로 되맞춘다(새로 깔지 않으므로 실멤버 보호 유지).
  for (const cid of claudeIds) {
    try { repairProgressHook(cid); } catch { /* best-effort */ }
    try { repairReplyGuardHook(cid); } catch { /* best-effort */ }
    // ★owner-gate 만 "없으면 깐다" 다★ — 위 둘과 목적이 반대다(주석은 launcher 쪽에).
    try { ensureOwnerGateHook(cid); } catch { /* best-effort */ }
  }
  // ★옛 합류 깃발 정리 (일회성 전환, 전 환경)★ — 2026-08-05 이전 영입은 `.b3os-just-joined` 에
  //   지시 없이 `joined` 한 줄만 들어 있다. 지금 룰은 "있으면 읽고·따르고·지워라" 라
  //   ★따를 게 없는 파일★ 이 남아 있으면 팀원이 무엇을 할지 지어낼 여지가 생긴다.
  // ★한 번뿐인 전환을 룰 문장으로 나르지 않는다★ — 룰은 그대로 두고 여기서 치운다.
  //   지우는 조건을 ★옛 마커와 정확히 일치할 때★ 로 좁힌다 — 방금 영입된 팀원의 ★지시서★ 를 지우면
  //   그 사람은 자기소개 절차를 영영 못 받는다.
  for (const a of agents) {
    try {
      const flag = join(a.workspace_path, JOIN_FLAG_FILE);
      if (existsSync(flag) && isLegacyJoinFlag(readFileSync(flag, "utf8"))) {
        unlinkSync(flag);
        console.log(`[teamos-render] legacy join flag cleared: ${a.id}`);
      }
    } catch { /* best-effort */ }
  }
  // 공개 빌드 부팅 백필(PUBLIC_BUILD 게이트) — 공개 사용자가 git 업데이트를 pull 한 뒤 재시작하면 기존
  //   멤버도 재영입 없이 최신을 받게. 라이브(PUBLIC_BUILD=false)는 글로벌 배선/실멤버 보호로 skip.
  if (PUBLIC_BUILD) {
    // ① progress("작업 중 ⏳") 훅 — claude 전용(글로벌 telegram-progress.sh 배선 대체).
    for (const cid of claudeIds) {
      try { installProgressHook(cid); } catch { /* best-effort */ }
    }
    // ② 룰 로딩파일(CLAUDE.md/AGENTS.md) 재생성 — pull 한 룰 업데이트(예: First contact 자기소개)를 기존
    //    멤버에도 반영. skip-if-unchanged 라 멱등, SOUL.md(persona)는 안 건드림. b3os_native 는 정책 미확정이라 제외.
    const teamName = (db.query("SELECT value FROM setting WHERE key = 'team_name'").get() as { value: string } | null)?.value ?? undefined;
    for (const a of agents) {
      if (a.runtime === "b3os_native") continue;
      try {
        writeMemberPersona({
          id: a.id, display_name: a.display_name, role: a.role, runtime: a.runtime,
          bot_username: a.telegram_bot_username ?? undefined,
          workspace_path: a.workspace_path, persona_file: a.persona_file,
          owner_name: ownerRow?.value ?? undefined, team_name: teamName,
          team_collect_enabled: false,
        });
      } catch { /* best-effort */ }
    }
  }
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
  // ★대시보드 persona 칸 = SOUL.md. 그게 전부다.★
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
  // ★savePersonaFile 로 단일화★ (2026-07-27, Codex 리뷰 적발): 여기서 writeFileSync 로 직행하면
  //   live-fs 가드도 backup-first(.bak)도 건너뛴다. persona 를 쓰는 통로가 둘이면 한쪽만 지켜진다.
  try {
    savePersonaFile(agent.persona_file, body.content);
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

// CI 결과는 ★읽기 전용★ — 여기서 테스트를 돌리지 않는다(routes/ciStatus.ts 주석 참고).
const ciStatusApi = createCiStatusRoutes();
api.route("/", ciStatusApi);

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
  restartCapture, // capture 토큰/그룹 저장 시 서버 재시작 없이 즉시 적용
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
    process.env.B3OS_SCHEDULER_ACCEPT_JOBS === "true" || process.env.B3OS_SCHEDULER_ENABLED !== "false",
});
api.route("/", schedulerApi);

// ★approvals(승인큐)는 공개빌드에서 "지원하지 않는" 기능이다★. 공개 메뉴에서 /approve 를
//   내리는 것으로 1차 정리하고, ★라우트는 지금 그대로 둔다★ — 아래가 그 이유와, 손대려면 무엇이 선행돼야
//   하는지다. 여기를 고치러 온 사람은 반드시 먼저 읽을 것.
//
//   ■ 왜 공개에서 지원하지 않나 — ★PIN 은 신원의 대체재가 될 수 없다★
//   PIN 은 채팅에 신원이 없어서 신원 '대신' 쓴 장치인데, ★PIN 을 처음 발급하는 행위에는 신원이 없다.★
//   그래서 approvals.ts 가 스스로 적어둔 대로 "첫 설정만 무인증" 이고, 이건 버그가 아니라 그 구조의
//   필연이다. 승인을 안 쓰는 공개 설치본은 PIN 이 영영 미설정이므로 ★먼저 잡는 쪽이 승인 권한을 갖는다.★
//   TEAM_BIND 로 바인딩을 열 수 있어(폰에서 대시보드 보기 등) "로컬 전용이라 괜찮다" 도 성립하지 않는다.
//
// ■ 왜 지금 라우트를 안 막나 — ★기능 안정화 우선★
//   제대로 된 해법은 라우트 한 줄이 아니라 ★신원·인증 설계 자체★ 다: 대시보드 로그인(소셜 등), PIN 발급·
//   재설정 경로, 그리고 ★로그인을 강제할 수 없는 채팅에서 어디까지 허용할지★ 의 경계. 그건 별도 프로젝트다.
//   제안된 기준선: ★채팅 = 조회·상태·본인 범위 / 로그인된 대시보드 = 실행·신뢰 설정 변경.★
//   이 기준이면 /approve 는 PIN 을 어떻게 고치든 채팅에 둘 물건이 아니다.
//
//   ■ 실사용 데이터 (2026-07-26 approval_request 조회)
//   총 29건인데 ★마지막 사용이 7/10, 16일째 0건★ 이다. 사용량의 22/29 를 만든 deploy_public·merge_to_main
//   이 둘 다 액션 목록에서 빠졌기 때문이다(merge_to_main 은 PR#61). 남은 건 위저드로 대체된
//   activate_openclaw 1건과 테스트용뿐 — ★라이브에서도 사실상 휴면 상태다.★
//
//   ■ 참고: 대시보드는 이 API 를 호출하지 않는다(호출 지점 0). 유일한 소비자가 텔레그램 /approve 다.
//   같은 계열 선례 = 바로 아래 permissionGate(무인증 표면을 이유로 공개 미마운트).
const approvalsApi = createApprovalsApp({ db });
api.route("/", approvalsApi);

// permissionGate 라우트 = codex 런타임 전용(op을 게이트로 라우팅하는 codex/b3os_native만 사용). 공개빌드에선
// codex·b3os_native가 미노출(영입/스왑 서버측 거부)이라 이 라우트는 무의미하고, 무인증 /check·DECIDE_TOKEN
// 표면(Demis #2/#4)을 공개에 남기지 않도록 미마운트한다. 라이브에서만 활성. (검증 후 공개시 재노출.)
const permissionGateApi = createPermissionGateRoutes({ db });
if (!PUBLIC_BUILD) api.route("/", permissionGateApi);

app.route("/api", api);

// ★MCP HTTP 창구 — BASE_PATH 밑의 /mcp (기본값이면 /team/mcp).★
// 반드시 아래쪽 SPA catch-all(`app.get("/*")`) ★보다 먼저★ 등록해야 한다. 뒤에 두면 화면이 이 주소를
// 가로채서 MCP 클라이언트가 HTML 을 받고 "왜 안 되지" 가 된다.
// 인증은 mcpAuth(Cloudflare Access JWT) 전용 — 대시보드 opAuth("루프백이면 lead")를 쓰지 않는다.
// 공개 빌드에는 노출하지 않는다(permissionGate 와 같은 기준).
if (!PUBLIC_BUILD) app.route("/", buildMcpHttpApp(db));

const PUBLIC_RULE_FILES = new Set(["TEAM-OS.md", "SHARED.md"]);
const PUBLIC_DOC_ALIASES: Record<string, string> = {
  "runtime-setup.md": join(__dirname, "../../skills/b3os/references/runtime-setup.md"),
};

app.get("/docs/:file", (c) => {
  const file = c.req.param("file");
  if (file !== basename(file) || !/\.(md|txt|json)$/i.test(file)) return c.text("document not found", 404);
  const filePath = file === "agents.json" ? REGISTRY_PATH : (PUBLIC_DOC_ALIASES[file] ?? join(DOCS_DIR, file));
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

// public=source 런타임 토글: 서버 빌드모드(B3OS_LIVE)를 대시보드 HTML에 주입 → 클라이언트 LIVE_ONLY_OPS
// 가 이 전역을 읽어 라이브 전용 UI(핵심룰 재적용·런타임 swap)를 표시/숨김한다. 기본=공개(플래그 없으면 false).
const LIVE_MODE = process.env.B3OS_LIVE === "1";
function injectBuildMode(html: string): string {
  const tag = `<script>window.__B3OS_LIVE__=${LIVE_MODE};</script>`;
  return html.includes("</head>") ? html.replace("</head>", `${tag}</head>`) : `${tag}${html}`;
}

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
      if (rel.endsWith(".html")) {
        return new Response(injectBuildMode(await file.text()), { headers: { "content-type": ct, "cache-control": cache } });
      }
      return new Response(file, { headers: { "content-type": ct, "cache-control": cache } });
    }
    // SPA fallback — only for routes WITHOUT a file extension (real client-side routes).
    // Asset requests (anything with /assets/ or a known extension) that miss should 404.
    if (rel.startsWith("/assets/") || /\.[a-z0-9]+$/i.test(rel)) {
      return c.text(`asset not found: ${rel}`, 404);
    }
    const indexPath = join(DIST_WEB, "index.html");
    if (existsSync(indexPath)) {
      return new Response(injectBuildMode(await Bun.file(indexPath).text()), {
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

// 바깥 감시용. ★관문 위에 둔다 — 이 한 줄이 유일한 예외이고, 예외라는 사실이 위치로 드러난다.★
// ★`ok` 는 그대로 둔다★ — 바깥 감시(`scripts/bot-liveness-monitor.sh`)는 본문을 파싱하지 않고
//   응답 여부만 본다. 필드 추가는 호환되지만, 있던 키를 바꾸면 그 순간 깨진다.
// 층별 신원을 같이 싣는다: 서버는 기동 시 굳힌 값, 웹은 빌드 표식을 ★요청 시점에★ 읽은 값
// (화면은 재시작 없이 바뀌므로 캐시하면 옛 값을 말한다). 자세한 이유는 lib/deployIdentity.ts.
rootApp.get("/health", (c) => c.json({ ok: true, ...deploymentIdentity(SERVER_IDENTITY, DIST_WEB) }));

/**
 * ★신뢰하지 않는 주소는 여기 한 곳에서 막는다 — 읽기까지.★
 *
 *  판정과 응답 형태는 lib/hostGate.ts 에 있다. 여기서는 "어디에 거는가" 만 정한다.
 *
 *  ★들어오는 모든 요청이 지나는 자리는 여기 하나다.★ 대시보드도 API 도 포털도 전부 이 아래에 붙는다.
 *  앞서는 app 과 reports 두 군데에 각각 걸었는데, 그건 붙일 곳이 늘어날 때마다 또 붙여야 하는 모양이다.
 *
 *  ★순서가 곧 규칙이다.★ Hono 는 등록 순서대로 매칭하므로 이 줄 ★위★ 는 통과하고 ★아래★ 는 전부 막힌다.
 *  2026-07-30 실측: `/health` 를 app 안에 두고 관문을 그 뒤에 뒀더니 배포 후에도 200 을 돌려줬다
 *  (port·base_path·팀원 수 노출). ★시험도 교차검증 2인도 못 봤다★ — 시험은 자기 앱을 따로 만들고,
 *  사람은 코드를 읽으면서 순서를 안 본다. 배포 후 라이브를 찔러서야 나왔다.
 */
function requestIsTrusted(request: Request): boolean {
  return trustedActorFromRequest(request, { loopbackDashboardActor: leadActorId(db) }).ok;
}

rootApp.use("*", createHostGate({ isTrusted: requestIsTrusted }));

rootApp.route(BASE_PATH, app);

// 팀 결과물 포털 — /team 형제로 노출. 허브 next.config.ts rewrite 로 your-team.example.com/reports.
// (2026-06-07 GD: /research 취소 — 모든 팀 산출물을 /reports 에 category 로 구분해 통합.)
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
    // (핸들러는 계속 돌아 부분상태 잔존). claude는 poller가 몇 초라 우연히 통과. Bun 최대=255s. (BUG4, GD 맥북테스트 2026-07-03)
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
