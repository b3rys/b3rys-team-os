/**
 * b3chat 앱 [팀원 추가] — b3chat 서버가 같은 맥의 b3os 에 새 AI 팀원을 만들어 달라고 부르는 길.
 *
 * 흐름: b3chat 이 봇 계정·1:1 방을 만든 뒤 POST /members/b3chat {id, display_name, role, runtime, api_base, room_id, bot_token}
 *   → 202 {job_id} 즉시 → 뒤에서 recruit → channel·시험 팀원 표시·토큰·모델 → activate → (준비됨) → 첫 인사 한 턴.
 *   b3chat 은 GET /members/b3chat/:job_id 로 상태를 읽어 앱에 옮긴다.
 *
 * 사람 손을 거치지 않는다 — 토큰은 이 요청 본문으로만 오고 0600 파일로만 남는다(응답·로그·감사 기록에 안 싣는다).
 * 오류는 안정된 code 만 돌려준다(내부 문장은 넘기지 않는다 — 쉬운 말은 b3chat 이 code 로 만든다).
 * 실패하면 기존 퇴사 API 로 되돌린다(보관 외 부수효과 없음 확인: 런타임 정리·명단·버스·토큰·작업폴더 보관·OT·감사 기록뿐).
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LINK_HEADER, isDirectLocal, linkSecretMatches, readLinkKey } from "../lib/b3chatLink";
import { parseMemberChannel } from "../lib/memberChannel";
import { validateBotToken } from "../lib/rotateToken";
import { writeRegistrySafely } from "../lib/registrySafety";
import { codexBridgePaths, ensureCodexHome } from "../runtimes/codex/launcher";
import { teardownRuntime } from "../lib/activation";
import { MEMBERS_ROOT, memberPaths } from "../lib/personaTemplates";
import { removeAgentCreds, slackTokenFile } from "../lib/slack";
import { basename, isAbsolute } from "node:path";
import { renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hasGreetedFirstContact } from "../runtimes/codex/bridge";
import { callCodexBridge, type CodexBridgeCallResult } from "../lib/codexBridgeClient";
import type { BridgeWindowRequest } from "../runtimes/codex/bridgeWindow";

import { COGS_MODELS, readModel, saveModel, setModelLine } from "../lib/b3chatModels";
export { setModelLine } from "../lib/b3chatModels";
export const B3CHAT_TEAMMATE_MODEL = "gpt-6-luna";
const ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const TOKEN_RE = /^[1-9]\d*:[A-Za-z0-9_-]{30,}$/;
const ACTIVATE_TIMEOUT_MS = 180_000;

export type JobState = "creating" | "configuring" | "starting" | "ready" | "failed" | "removing" | "removed" | "remove_failed";
export type JobCode = "name_taken" | "ai_not_ready" | "bot_check_failed" | "start_failed" | "timeout" | "internal" | "teammate_busy" | "cleanup_failed";

export interface B3chatTeammateDeps {
  db: Database;
  /** 같은 서버의 설정 앱 — recruit·activate·퇴사를 그 경로 그대로 부른다(로직을 두 벌 두지 않는다). */
  settings: Hono;
  registryPath: string;
  onRegistryChanged?: () => void;
  /** 시험 주입 */
  linkKeyPath?: string;
  remoteAddress?: (c: Context) => string | null;
  validateToken?: typeof validateBotToken;
  /** 그 팀원 브리지 창구로 첫 인사를 넣는다 */
  callBridge?: (req: BridgeWindowRequest) => Promise<CodexBridgeCallResult>;
  /** 브리지가 첫 인사 턴을 마쳤나(첫 접촉 표시 파일) */
  greeted?: (id: string) => boolean;
  greetingWaitMs?: number;
  pollMs?: number;
  activateTimeoutMs?: number;
  /** 모델 설정 쓰기(기본: 그 팀원 CODEX_HOME 의 config.toml) — 시험은 실제 홈을 건드리지 않게 대신 넣는다 */
  prepareModel?: (id: string) => void;
  modelConfigPath?: (id: string) => string;
  /** 지운 뒤 남은 것(명단·launchd·프로세스·파일·작업폴더) — 기본은 실제 확인. 시험은 반드시 대신 넣는다. */
  inspectResidue?: (id: string, workspace: string) => Promise<Residue[]> | Residue[];
  /** 남은 것을 한 번 더 정리(명단 밖에서) — 기본은 실제 정리. 시험은 반드시 대신 넣는다. */
  cleanResidue?: (id: string, left: Residue[], workspace: string) => Promise<void> | void;
  /** 시험이 뒤 작업 완료를 기다릴 수 있게 */
  onJobSettled?: (jobId: string) => void;
}

interface JobRow {
  id: string; member_id: string; display_name: string; room_id: string; state: JobState;
  stage: string; code: string | null; retryable: number; greeting: string | null;
  cleanup: string | null; token_hash: string | null; created_at: string; updated_at: string;
}

/** unverified = 확인 명령이 실패해 있는지 없는지 모른다 — 없음으로 치지 않는다. */
export type Residue = "registry" | "launchd" | "process" | "files" | "workdir" | "unverified";

export interface ResidueProbe {
  registryHas: (id: string) => boolean;
  /** 확인 자체가 실패하면 던진다(없음과 구분). */
  launchdLoaded: (label: string) => boolean;
  /** 그 팀원 CODEX_HOME 으로 도는 프로세스(브리지·app-server). 이름이 같은 남의 프로세스와 env 로 가른다. 확인 실패면 던진다. */
  envPids: (codexHome: string) => number[];
  exists: (path: string) => boolean;
}

/** 지운 뒤 남은 것을 종류별로 센다 — 하나라도 있으면 removed 가 아니다. */
export function residueOf(id: string, probe: ResidueProbe, workspace = memberPaths(id, "codex").workspace_path): Residue[] {
  const p = codexBridgePaths(id);
  const out: Residue[] = [];
  const check = (kind: Residue, f: () => boolean) => {
    try { if (f()) out.push(kind); } catch { if (!out.includes("unverified")) out.push("unverified"); }
  };
  check("registry", () => probe.registryHas(id));
  check("launchd", () => probe.launchdLoaded(p.label));
  check("process", () => probe.envPids(p.codexHome).length > 0);
  const files = [p.plist, p.wrapper, p.tokenFile, p.pidFile, join(dirname(p.pidFile), `${id}.window.json`), p.log, p.codexHome, slackTokenFile(id)];
  check("files", () => files.some((f) => probe.exists(f)));
  check("workdir", () => probe.exists(workspace));
  return out;
}

/** ps 의 env 열에서 CODEX_HOME=<home> 인 프로세스만 — 값은 이 함수 밖으로 내보내지 않는다. macOS ps 는 대시 없는 axeww 여야 env 가 붙는다(-axeww 는 안 붙는다, 실측). */
export function pidsWithCodexHome(psOutput: string, codexHome: string): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);
    if (!m) continue;
    // env 낱말 단위로 정확히 CODEX_HOME=<값> 인 것만 — ORIGINAL_CODEX_HOME·OTHER_CODEX_HOME 은 다른 변수다.
    const words = (m[2] ?? "").split(" ");
    if (words.some((w) => w.startsWith("CODEX_HOME=") && w.slice("CODEX_HOME=".length) === codexHome)) pids.push(Number(m[1]));
  }
  return pids;
}

export function realProbe(readIds: () => string[]): ResidueProbe {
  return {
    registryHas: (id) => readIds().includes(id),
    launchdLoaded: (label) => {
      // 0 = 로드됨, 113 = 그런 서비스 없음(실측). 그 밖의 실패는 모른다 → 던진다.
      try { execFileSync("launchctl", ["print", `gui/${process.getuid?.() ?? 501}/${label}`], { stdio: "ignore" }); return true; } catch (e) {
        if ((e as { status?: number }).status === 113) return false;
        throw e;
      }
    },
    envPids: (home) => pidsWithCodexHome(execFileSync("ps", ["axeww", "-o", "pid=,command="], { encoding: "utf-8", maxBuffer: 64 << 20 }), home),
    exists: existsSync,
  };
}

/** 작업폴더 보관 — 명단에 적혀 있던 위치 그대로. 기본 위치가 아니어도 이름이 그 팀원 id 인 절대경로만 옮긴다(엉뚱한 폴더 이동 방지). */
export function archiveWorkspaceAt(id: string, workspace: string, archiveRoot = `${MEMBERS_ROOT}/.archived`): string | null {
  if (!existsSync(workspace)) return null;
  if (!isAbsolute(workspace) || basename(workspace) !== id || !/^[a-z][a-z0-9_-]{1,31}$/.test(id)) return null;
  mkdirSync(archiveRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  let dest = `${archiveRoot}/${id}-${stamp}`;
  for (let n = 1; existsSync(dest); n++) dest = `${archiveRoot}/${id}-${stamp}-${n}`;
  renameSync(workspace, dest);
  return dest;
}

function ensureJobTable(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS b3chat_teammate_job (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    room_id TEXT NOT NULL,
    state TEXT NOT NULL,
    stage TEXT NOT NULL,
    code TEXT,
    retryable INTEGER NOT NULL DEFAULT 0,
    greeting TEXT,
    cleanup TEXT,
    token_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
  )`);
}

/** 같은 요청의 재전송인지 가리는 지문 — 토큰 자체는 저장하지 않는다. */
function requestFingerprint(token: string, roomId: string, apiBase: string): string {
  return createHash("sha256").update(`${token}\n${roomId}\n${apiBase}`).digest("hex");
}

function defaultRemoteAddress(c: Context): string | null {
  try { return getConnInfo(c).remote.address ?? null; } catch { return null; }
}

/** 첫 인사 요청 — 새 팀원 브리지가 평소 1:1 처리로 받는다(서버가 대신 말하지 않는다). */
export function greetingPrompt(displayName: string, role: string): string {
  return [
    `(b3chat 앱에서 방금 팀장과의 1:1 방이 열렸습니다. 당신은 새 AI 팀원 "${displayName}", 역할은 ${role || "범용 팀원"} 입니다.)`,
    "팀장에게 첫 인사를 한국어 2~3문장으로 해 주세요 — 이름·역할·도울 수 있는 일. 도구는 쓰지 마세요.",
  ].join("\n");
}

/** 그 팀원 config.toml 의 model 을 고정한다. 없을 때만 시드 — activate 는 이미 있는 config 를 덮지 않는다. */

function writeTeammateModel(id: string): void {
  const p = codexBridgePaths(id);
  ensureCodexHome(p);
  const cfg = join(p.codexHome, "config.toml");
  writeFileSync(cfg, setModelLine(existsSync(cfg) ? readFileSync(cfg, "utf-8") : "", B3CHAT_TEAMMATE_MODEL), "utf-8");
}

export function createB3chatTeammateRoutes(deps: B3chatTeammateDeps): Hono {
  const app = new Hono();
  const { db, settings, registryPath } = deps;
  ensureJobTable(db);
  try { db.run("ALTER TABLE b3chat_teammate_job ADD COLUMN token_hash TEXT"); } catch { /* 이미 있음 */ }
  try { db.run("ALTER TABLE b3chat_teammate_job ADD COLUMN workspace TEXT"); } catch { /* 이미 있음 */ }
  const keyPath = deps.linkKeyPath ?? join(dirname(registryPath), "var", "secrets", "b3chat-link.key");
  const remote = deps.remoteAddress ?? defaultRemoteAddress;
  const validate = deps.validateToken ?? validateBotToken;
  const callBridge = deps.callBridge ?? ((req: BridgeWindowRequest) => callCodexBridge(req, { pidFile: codexBridgePaths(req.agentId).pidFile }));
  const greeted = deps.greeted ?? hasGreetedFirstContact;
  const greetingWait = deps.greetingWaitMs ?? 150_000;
  const pollMs = deps.pollMs ?? 2_000;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const activateTimeout = deps.activateTimeoutMs ?? ACTIVATE_TIMEOUT_MS;
  const prepareModel = deps.prepareModel ?? writeTeammateModel;
  const inspectResidue = deps.inspectResidue ?? ((id: string, ws: string) => residueOf(id, realProbe(() => readList().map((a) => a?.id)), ws));
  const cleanResidue = deps.cleanResidue ?? (async (id: string, left: Residue[], ws: string) => {
    // 명단에 남았으면 여기서 손대지 않는다 — 명단 제거는 퇴사 API 한 곳에서만(다음 재시도가 그 API 를 다시 부른다).
    if (left.includes("registry")) return;
    const home = codexBridgePaths(id).codexHome;
    const probe = realProbe(() => []);
    if (left.some((k) => k === "launchd" || k === "process" || k === "files")) {
      await teardownRuntime(id, "codex", undefined, { codexBridgePids: () => probe.envPids(home) });
    }
    if (left.includes("files")) { try { removeAgentCreds(id); } catch { /* 다시 세어 판정 */ } }
    if (left.includes("workdir")) archiveWorkspaceAt(id, ws);
  });

  const fail = (c: Context, status: 400 | 403 | 404 | 409 | 500, code: JobCode | "forbidden" | "bad_request" | "not_found", stage: string, retryable = false) =>
    c.json({ ok: false, code, retryable, stage }, status);

  // ── 인증: 같은 기계 직접 + 공유 비밀. 둘 다 아니면 무엇이 틀렸는지도 말하지 않는다. ──
  const guard = async (c: Context, next: () => Promise<void>) => {
    if (!isDirectLocal(remote(c), c.req.raw.headers) || !linkSecretMatches(c.req.header(LINK_HEADER), readLinkKey(keyPath))) {
      return fail(c, 403, "forbidden", "auth");
    }
    await next();
  };
  app.use("/members/b3chat", guard);
  app.use("/members/b3chat/*", guard);

  const setJob = (id: string, patch: Partial<Pick<JobRow, "state" | "stage" | "code" | "retryable" | "greeting" | "cleanup">>) => {
    const cols = Object.keys(patch);
    if (!cols.length) return;
    db.query(`UPDATE b3chat_teammate_job SET ${cols.map((k) => `${k} = ?`).join(", ")}, updated_at = strftime('%Y-%m-%d %H:%M:%S','now') WHERE id = ?`)
      .run(...cols.map((k) => (patch as Record<string, unknown>)[k] as string | number | null), id);
  };

  const readList = (): any[] => {
    const raw = JSON.parse(readFileSync(registryPath, "utf-8")) as unknown;
    return Array.isArray(raw) ? raw : ((raw as { agents?: any[] }).agents ?? []);
  };

  const memberModel = async (c: Context) => {
    const id = c.req.param("memberId");
    if (!id || !ID_RE.test(id)) return c.json({code:"not_found"},404);
    const member = readList().find(a => a.id === id);
    if (!member || member.team_official_member !== false || member.channel?.kind !== "b3chat") return c.json({code:"not_found"},404);
    // Claude provisioning is handled by its own runtime adapter.
    if (member.runtime !== "codex") return c.json({code:"unsupported_runtime"},400);
    const path = deps.modelConfigPath?.(id) ?? join(codexBridgePaths(id).codexHome,"config.toml");
    try {
      if (c.req.method === "PUT") {
        const body = await c.req.json();
        if (!body || typeof body.model !== "string" || !(COGS_MODELS.codex as readonly string[]).includes(body.model)) return c.json({code:"unsupported_model"},400);
        saveModel(path,"codex",body.model);
      }
      return c.json({runtime:"codex",model:readModel(path),models:COGS_MODELS.codex,restart_required:false,applies:"next_request"});
    } catch { return c.json({code:"model_unavailable"},503); }
  };
  app.get("/members/b3chat/member/:memberId/model",memberModel);
  app.put("/members/b3chat/member/:memberId/model",memberModel);

  app.post("/members/b3chat", async (c) => {
    let body: Record<string, unknown>;
    try { body = await c.req.json(); } catch { return fail(c, 400, "bad_request", "input"); }
    const id = typeof body.id === "string" ? body.id.trim() : "";
    const displayName = typeof body.display_name === "string" ? body.display_name.trim() : "";
    const role = typeof body.role === "string" ? body.role.trim().slice(0, 80) : "";
    const roomId = body.room_id == null ? "" : String(body.room_id).trim();
    const token = typeof body.bot_token === "string" ? body.bot_token.trim() : "";
    const channel = parseMemberChannel({ kind: "b3chat", api_base: body.api_base, allow_from: [roomId], owner_chat: roomId });
    if (!ID_RE.test(id) || !displayName || displayName.length > 40 || body.runtime !== "codex"
      || !/^[1-9]\d*$/.test(roomId) || channel.error || !TOKEN_RE.test(token)) {
      return fail(c, 400, "bad_request", "input");
    }
    // ★같은 요청의 재전송이면 같은 작업을 돌려준다(응답 유실 대비 — 멱등).★
    //   같음 = 같은 id + 같은 토큰·방·주소(지문). 실패로 끝난 작업은 되돌림이 끝났으니 새 작업으로 다시 한다.
    const fp = requestFingerprint(token, roomId, channel.apiBase);
    const prev = db.query("SELECT * FROM b3chat_teammate_job WHERE member_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(id) as JobRow | null;
    if (prev && prev.state !== "failed" && prev.state !== "removed") {
      if (prev.token_hash === fp) return c.json({ ok: true, job_id: prev.id, member_id: id, state: prev.state, duplicate: true }, 200);
      return fail(c, 409, "name_taken", "input");
    }
    // 이름(id) 충돌 — 이 경로로 만든 게 아닌 팀원이 이미 그 id 를 쓰고 있으면.
    let exists = false;
    try { exists = readList().some((a) => a?.id === id); } catch { return fail(c, 500, "internal", "input", true); }
    if (exists) return fail(c, 409, "name_taken", "input");
    // 봇이 그 서버에서 살아 있나 — 토큰은 그 채널 주소로만 보낸다.
    const live = await validate(token, channel.apiBase);
    if (!live.ok) return fail(c, 400, "bot_check_failed", "input", live.error === "getme_failed");

    const jobId = `b3t_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    db.query("INSERT INTO b3chat_teammate_job (id, member_id, display_name, room_id, state, stage, token_hash) VALUES (?, ?, ?, ?, 'creating', 'accepted', ?)")
      .run(jobId, id, displayName, roomId, fp);
    void runJob({ jobId, id, displayName, role, roomId, token, apiBase: channel.apiBase })
      .catch(() => setJob(jobId, { state: "failed", stage: "internal", code: "internal", retryable: 1 }))
      .finally(() => deps.onJobSettled?.(jobId));
    return c.json({ ok: true, job_id: jobId, member_id: id, state: "creating" }, 202);
  });

  const jobView = (c: Context, row: JobRow | null) => {
    if (!row) return fail(c, 404, "not_found", "status");
    return c.json({
      ok: row.state !== "failed" && row.state !== "remove_failed",
      job_id: row.id, member_id: row.member_id, room_id: row.room_id,
      state: row.state, stage: row.stage, code: row.code, retryable: row.retryable === 1,
      greeting: row.greeting, cleanup: row.cleanup,
    });
  };
  // 팀원 id 로도 읽는다 — b3chat 이 job_id 를 못 받았을 때(응답 유실) 결과를 되찾게. 가장 최근 작업.
  app.get("/members/b3chat/member/:member_id", (c) =>
    jobView(c, db.query("SELECT * FROM b3chat_teammate_job WHERE member_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(c.req.param("member_id")) as JobRow | null));
  app.get("/members/b3chat/:job_id", (c) =>
    jobView(c, db.query("SELECT * FROM b3chat_teammate_job WHERE id = ?").get(c.req.param("job_id")) as JobRow | null));

  // ── 지우기 — b3chat 앱 [팀원 지우기]. 이 경로로 만든 팀원만(작업 기록이 있는 팀원만) 지운다. ──
  //   202 removing 즉시 → 뒤에서 기존 퇴사 API(런타임 끄기·종료 확인·파일·명단) → removed | remove_failed.
  //   상태는 GET /members/b3chat/member/:member_id 로 읽는다. 같은 요청을 다시 보내도 퇴사는 한 번만 돈다.
  const removing = new Set<string>();
  app.delete("/members/b3chat/member/:member_id", (c) => {
    const id = c.req.param("member_id");
    const row = db.query("SELECT * FROM b3chat_teammate_job WHERE member_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(id) as JobRow | null;
    if (!row) return fail(c, 404, "not_found", "remove");
    if (row.state === "removed") return c.json({ ok: true, member_id: id, state: "removed" }, 200);
    if (removing.has(id)) return c.json({ ok: true, member_id: id, state: "removing" }, 202);
    // removing 인데 도는 작업이 없다 = 서버가 중간에 재시작됐다. 다시 시작한다(퇴사 API 는 이미 지운 팀원에 404 → removed).
    if (row.state !== "ready" && row.state !== "failed" && row.state !== "remove_failed" && row.state !== "removing") return fail(c, 409, "teammate_busy", "remove");
    removing.add(id);
    setJob(row.id, { state: "removing", stage: "remove", code: null, retryable: 0 });
    void removeMember(row.id, id)
      .catch(() => setJob(row.id, { state: "remove_failed", stage: "remove", code: "cleanup_failed", retryable: 1 }))
      .finally(() => { removing.delete(id); deps.onJobSettled?.(row.id); });
    return c.json({ ok: true, member_id: id, state: "removing" }, 202);
  });

  async function removeMember(jobId: string, id: string): Promise<void> {
    const failed = (cleanup: string) => setJob(jobId, { state: "remove_failed", stage: "remove", code: "cleanup_failed", retryable: 1, cleanup });
    let target: any;
    try { target = readList().find((a) => a?.id === id); } catch { return failed("registry_unreadable"); }
    // 명단을 지우기 전에 복구에 필요한 것(작업폴더 위치)을 작업 기록에 남긴다 — 명단이 사라진 뒤 재시도도 같은 곳을 센다.
    if (target) {
      db.query("UPDATE b3chat_teammate_job SET workspace = ? WHERE id = ?")
        .run(typeof target.workspace_path === "string" && target.workspace_path ? target.workspace_path : memberPaths(id, "codex").workspace_path, jobId);
    }
    const ws = (db.query("SELECT workspace FROM b3chat_teammate_job WHERE id = ?").get(jobId) as { workspace: string | null } | null)?.workspace
      ?? memberPaths(id, "codex").workspace_path;
    // 1) 명단에 있으면 기존 퇴사 API(명단·OT·슬랙·작업폴더 보관·감사까지 한 경로). ★200 이어도 정리 완료의 증거가 아니다★ —
    //    그 API 는 종료 미확인·파일 삭제 오류에도 200 을 준다. 그래서 아래 2) 에서 남은 것을 직접 센다.
    if (target) {
      const r = await settings.request(`/members/${id}`, {
        method: "DELETE", headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm_name: target.display_name }),
      });
      if (!r.ok && r.status !== 404) return failed(`offboard_${r.status}`);
    }
    // 2) 남은 것 → 있으면 한 번 더 정리 → 다시 센다. 명단이 이미 없어도(지난번 중간에 멈춤) 여기서 이어서 치운다.
    let left = await inspectResidue(id, ws);
    if (left.length) {
      try { await cleanResidue(id, left, ws); } catch { /* 다시 세어 판정 */ }
      left = await inspectResidue(id, ws);
    }
    if (left.length) return failed(`left:${left.join(",")}`);
    setJob(jobId, { state: "removed", stage: "removed", code: null, retryable: 0, cleanup: "removed" });
  }

  async function runJob(j: { jobId: string; id: string; displayName: string; role: string; roomId: string; token: string; apiBase: string }): Promise<void> {
    const { jobId, id } = j;
    let recruited = false;
    // ★failed 는 되돌림이 끝난 뒤에 적는다★ — b3chat 이 failed 를 보고 봇을 끄는 순간 b3os 쪽 등록도 이미 없어야 한다.
    const failJob = async (stage: string, code: JobCode, retryable: boolean) => {
      let cleanup: string | null = null;
      if (recruited) {
        // 되돌림 = 기존 퇴사 API — 런타임 정리·명단·토큰·작업폴더 보관까지 한 경로로.
        setJob(jobId, { stage: `${stage}_cleanup` });
        try {
          const r = await settings.request(`/members/${id}`, {
            method: "DELETE", headers: { "content-type": "application/json" },
            body: JSON.stringify({ confirm_name: j.displayName }),
          });
          cleanup = r.ok ? "removed" : `remove_failed_${r.status}`;
        } catch {
          cleanup = "remove_failed";
        }
      }
      setJob(jobId, { state: "failed", stage, code, retryable: retryable ? 1 : 0, cleanup });
    };

    // 1) 등록
    setJob(jobId, { state: "configuring", stage: "recruit" });
    const rec = await settings.request("/members/recruit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, display_name: j.displayName, role: j.role || "AI 팀원", runtime: "codex" }),
    });
    const recBody = (await rec.json().catch(() => ({}))) as { ok?: boolean; ot_id?: string; error?: string };
    if (rec.status === 409) return failJob("recruit", "name_taken", false);
    if (!rec.ok || !recBody.ot_id) return failJob("recruit", "internal", true);
    recruited = true;

    // 2) 채널·시험 팀원 표시 — 같은 파일 형식·같은 안전 쓰기로
    setJob(jobId, { stage: "channel" });
    try {
      const list = readList();
      const t = list.find((a) => a?.id === id);
      if (!t) return failJob("channel", "internal", true);
      t.channel = { kind: "b3chat", api_base: j.apiBase, allow_from: [j.roomId], owner_chat: j.roomId };
      t.team_official_member = false;
      writeRegistrySafely(registryPath, list);
      deps.onRegistryChanged?.();
    } catch {
      return failJob("channel", "internal", true);
    }

    // 3) 토큰(0600, activate 가 읽는 자리) · 모델
    setJob(jobId, { stage: "token" });
    try {
      const dir = join(dirname(registryPath), "var", "secrets");
      mkdirSync(dir, { recursive: true });
      const tp = join(dir, `${id}.bot-token`);
      writeFileSync(tp, j.token, { mode: 0o600 });
      chmodSync(tp, 0o600);
    } catch {
      return failJob("token", "internal", true);
    }
    setJob(jobId, { stage: "model" });
    try {
      prepareModel(id);
    } catch {
      return failJob("model", "internal", true);
    }

    // 4) 기동
    setJob(jobId, { state: "starting", stage: "activate" });
    let act: { ok?: boolean; error?: string } = {};
    try {
      const timer = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), activateTimeout));
      const res = await Promise.race([settings.request(`/ot/${recBody.ot_id}/activate`, { method: "POST" }), timer]);
      if (res === "timeout") return failJob("activate", "timeout", true);
      act = (await res.json().catch(() => ({}))) as typeof act;
    } catch {
      return failJob("activate", "start_failed", true);
    }
    if (act.error === "runtime_auth_required") return failJob("activate", "ai_not_ready", true);
    if (act.ok !== true) return failJob("activate", "start_failed", true);
    setJob(jobId, { state: "ready", stage: "ready" });

    // 5) 첫 인사 — 준비됨과 따로 기록한다(인사 실패 ≠ 기동 실패).
    //    ★새 팀원 브리지 창구로 넣는다★ — 브리지·세션·봇이 다 살아야 방에 뜬다. 그게 "돌고 있다" 의 증거다.
    setJob(jobId, { greeting: "requested" });
    const req: BridgeWindowRequest = {
      agentId: id, groupId: j.roomId, threadId: `b3c-greeting-${id}`, messageId: `greet-${jobId}`,
      body: greetingPrompt(j.displayName, j.role), kind: "greeting",
    };
    let queued = false;
    for (let i = 0; i < 10 && !queued; i++) { // 창구는 브리지 기동 직후 열린다 — 잠깐 늦을 수 있다
      try { const r = await callBridge(req); queued = r.ok; } catch { queued = false; }
      if (!queued) await sleep(pollMs);
    }
    if (!queued) { setJob(jobId, { greeting: "failed" }); return; }
    const deadline = Date.now() + greetingWait;
    while (Date.now() < deadline) {
      if (greeted(id)) { setJob(jobId, { greeting: "sent" }); return; }
      await sleep(pollMs);
    }
    setJob(jobId, { greeting: "failed" });
  }

  return app;
}
