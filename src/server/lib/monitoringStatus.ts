// 모니터링 탭 데이터소스 (GD 2026-07-10, Bill 핸드오프) — 새 probe 0, 기존 소스만.
//   ① bot-liveness 상태: /tmp/bot-liveness-monitor.log 파싱(runs·마지막실행·정상여부·결과문구)
//   ② dm_message health: team.db 집계(dm-monitor.sh 로직 이식)
// ★방어적(Bill 요청): 로그 파일 없거나 형식 바뀌어도 크래시 X — 전부 try/catch + 안전 기본값.★
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

const LIVENESS_LOG = process.env.BOT_LIVENESS_LOG || "/tmp/bot-liveness-monitor.log";
const INGRESS_STATUS_FILE =
  process.env.OPENCLAW_TELEGRAM_STATUS_FILE ||
  join(homedir(), "Development/b3rys-team-os/var/openclaw-telegram-ingress-status.json");

export interface LivenessStatus {
  available: boolean; // 로그 파일 존재·파싱 성공
  runs: number; // START 라인 수
  lastRun: string | null; // 마지막 START 시각(문자열 그대로)
  healthy: boolean | null; // 마지막 결과가 정상인지(판정불가=null)
  lastResult: string | null; // 마지막 결과 문구
  logMtime: string | null; // 로그 파일 mtime(ISO)
}

export function readLivenessStatus(logPath: string = LIVENESS_LOG): LivenessStatus {
  const base: LivenessStatus = { available: false, runs: 0, lastRun: null, healthy: null, lastResult: null, logMtime: null };
  try {
    if (!existsSync(logPath)) return base;
    const lines = readFileSync(logPath, "utf-8").split("\n").filter((l) => l.trim());
    if (!lines.length) return { ...base, available: true };
    const starts = lines.filter((l) => /bot-liveness START/.test(l));
    const lastStart = starts.length ? starts[starts.length - 1]! : null;
    const lastRun = lastStart ? (lastStart.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/)?.[1] ?? null) : null;
    // 마지막 START 이후의 결과 라인(START 아닌 첫 비어있지않은 줄, 뒤에서부터)
    let lastResult: string | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/bot-liveness START/.test(lines[i]!)) break;
      if (lines[i]!.trim()) { lastResult = lines[i]!.trim(); break; }
    }
    let healthy: boolean | null = null;
    if (lastResult) {
      if (/이상 없음|정상|\bOK\b|healthy/i.test(lastResult)) healthy = true;
      else if (/이상|실패|error|재시작|down|무응답|죽|❌/i.test(lastResult)) healthy = false;
    }
    let logMtime: string | null = null;
    try { logMtime = new Date(statSync(logPath).mtimeMs).toISOString(); } catch { /* noop */ }
    return { available: true, runs: starts.length, lastRun, healthy, lastResult, logMtime };
  } catch {
    return base;
  }
}

export interface DmHealth {
  total: number;
  members: number;
  last1h: number;
  last24h: number;
  newest: string | null; // 최신 dm created_at (UTC)
  stale: boolean; // 최신 dm이 30분+ 전
  perMember: Array<{ memberId: string; runtime: string | null; count: number; newest: string | null; state: "ok" | "error" | "unknown"; lastSuccessAt: string | null; lastErrorAt: string | null; error: string | null }>;
}

export function readDmHealth(db: Database): DmHealth {
  const base: DmHealth = { total: 0, members: 0, last1h: 0, last24h: 0, newest: null, stale: false, perMember: [] };
  const num = (sql: string): number => {
    try { return Number((db.prepare(sql).get() as { n?: number } | undefined)?.n ?? 0) || 0; } catch { return 0; }
  };
  try {
    let newest: string | null = null;
    try { newest = (db.prepare("SELECT MAX(created_at) n FROM dm_message").get() as { n?: string } | undefined)?.n ?? null; } catch { newest = null; }
    let perMember: DmHealth["perMember"] = [];
    try {
      perMember = db
        .prepare(`SELECT a.id AS memberId, a.runtime,
          COUNT(d.id) AS count, MAX(d.created_at) AS newest,
          COALESCE(h.state, 'unknown') AS state,
          h.last_success_at AS lastSuccessAt, h.last_error_at AS lastErrorAt, h.error
        FROM agent a
        LEFT JOIN dm_message d ON d.member_id=a.id
        LEFT JOIN dm_sync_health h ON h.member_id=a.id
        WHERE a.runtime IN ('claude_channel','openclaw','hermes_agent')
        GROUP BY a.id,a.runtime,h.state,h.last_success_at,h.last_error_at,h.error
        ORDER BY MAX(d.created_at) DESC`)
        .all() as DmHealth["perMember"];
    } catch { perMember = []; }
    return {
      total: num("SELECT COUNT(*) n FROM dm_message"),
      members: num("SELECT COUNT(DISTINCT member_id) n FROM dm_message"),
      last1h: num("SELECT COUNT(*) n FROM dm_message WHERE created_at > datetime('now','-1 hour')"),
      last24h: num("SELECT COUNT(*) n FROM dm_message WHERE created_at > datetime('now','-24 hours')"),
      newest,
      // DM 부재는 사용자 비활동일 수 있으므로 메시지 시각만으로 장애 판정하지 않는다.
      // 파서가 실제 실패했거나, 활성 roster 멤버가 한 번도 probe되지 않은 경우만 unhealthy다.
      stale: perMember.some((m) => m.state !== "ok"),
      perMember,
    };
  } catch {
    return base;
  }
}

export interface HermesRuntimeMember {
  id: string;
  displayName: string;
  state: string;
  pending: number;
  lastActivityAt: string | null;
  probedAt: string | null;
  lastLogLine: string | null;
}

export interface HermesRuntimeHealth {
  total: number;
  online: number;
  blocked: number;
  offline: number;
  pending: number;
  newestProbe: string | null;
  newestActivity: string | null;
  members: HermesRuntimeMember[];
}

export function readHermesRuntimeHealth(db: Database): HermesRuntimeHealth {
  const base: HermesRuntimeHealth = { total: 0, online: 0, blocked: 0, offline: 0, pending: 0, newestProbe: null, newestActivity: null, members: [] };
  try {
    type Row = {
      id: string;
      displayName: string;
      state: string | null;
      pending: number | null;
      lastActivityAt: string | null;
      probedAt: string | null;
      lastLogLine: string | null;
    };
    const rows = db.prepare(`
      SELECT
        a.id AS id,
        a.display_name AS displayName,
        s.state AS state,
        s.last_activity_at AS lastActivityAt,
        s.probed_at AS probedAt,
        s.last_log_line AS lastLogLine,
        COALESCE(p.pending, 0) AS pending
      FROM agent a
      LEFT JOIN agent_status s ON s.agent_id = a.id
      LEFT JOIN (
        SELECT agent_id, COUNT(*) AS pending
        FROM message_recipient
        WHERE recipient_state = 'open'
          AND delivery_state IN ('pending','dispatching','wake_dispatched')
        GROUP BY agent_id
      ) p ON p.agent_id = a.id
      WHERE a.runtime = 'hermes_agent'
      ORDER BY a.id
    `).all() as Row[];
    const members = rows.map((r) => ({
      id: r.id,
      displayName: r.displayName,
      state: r.state ?? "unknown",
      pending: safeNumber(r.pending),
      lastActivityAt: r.lastActivityAt,
      probedAt: r.probedAt,
      lastLogLine: r.lastLogLine,
    }));
    const newest = (values: Array<string | null>): string | null => {
      const found = values.filter((v): v is string => typeof v === "string" && v.trim().length > 0).sort();
      return found[found.length - 1] ?? null;
    };
    return {
      total: members.length,
      online: members.filter((m) => m.state === "idle" || m.state === "running").length,
      blocked: members.filter((m) => m.state === "blocked").length,
      offline: members.filter((m) => m.state === "offline" || m.state === "unknown").length,
      pending: members.reduce((sum, m) => sum + m.pending, 0),
      newestProbe: newest(members.map((m) => m.probedAt)),
      newestActivity: newest(members.map((m) => m.lastActivityAt)),
      members,
    };
  } catch {
    return base;
  }
}

export interface IngressFileState {
  stateFiles: number;
  pendingFiles: number;
  checkedDirs: string[];
}

export interface IngressTraffic {
  inbound24h: number;
  outbound24h: number;
  inboundPending: number;
  outboundPending: number;
  newestInbound: string | null;
  newestOutbound: string | null;
}

export interface IngressAudit {
  stuck24h: number;
  stuck7d: number;
  newestStuck: string | null;
}

export interface OpenClawTelegramIngressStatus {
  available: boolean;
  generated_at: string | null;
  as_of: string | null;
  account: string;
  bot_username: string;
  state: string;
  last_state_at: string | null;
  last_inbound_at: string | null;
  last_inbound_age_sec: number;
  restart_count: number;
  backlog_latency_sec: number;
  stale_threshold_sec: number;
  cooldown_sec: number;
  auto_recover_enabled: number;
  detected: boolean;
  reason: string;
  source_log: string | null;
  status_mtime: string | null;
  files: IngressFileState;
  traffic: IngressTraffic;
  audit: IngressAudit;
}

function safeNumber(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function safeString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function countIngressFiles(account: string): IngressFileState {
  const envDirs = (process.env.OPENCLAW_TELEGRAM_INGRESS_SPOOL_DIRS || process.env.OPENCLAW_TELEGRAM_INGRESS_SPOOL_DIR || "")
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean);
  const candidates = [
    ...envDirs,
    join(homedir(), ".openclaw", `ingress-spool-${account}`),
    join(homedir(), ".openclaw/telegram", `ingress-spool-${account}`),
    join(homedir(), "Library/Application Support/openclaw", `ingress-spool-${account}`),
    join("/tmp", `ingress-spool-${account}`),
  ];
  const checkedDirs: string[] = [];
  let stateFiles = 0;
  let pendingFiles = 0;
  for (const dir of Array.from(new Set(candidates))) {
    try {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
      checkedDirs.push(dir);
      for (const name of readdirSync(dir)) {
        if (name.endsWith(".state")) stateFiles++;
        if (name.endsWith(".pending")) pendingFiles++;
      }
    } catch {
      // Missing/unreadable spool dirs should never break monitoring.
    }
  }
  return { stateFiles, pendingFiles, checkedDirs };
}

function readIngressTraffic(db: Database): IngressTraffic {
  const base: IngressTraffic = { inbound24h: 0, outbound24h: 0, inboundPending: 0, outboundPending: 0, newestInbound: null, newestOutbound: null };
  const num = (sql: string): number => {
    try { return safeNumber((db.prepare(sql).get() as { n?: number } | undefined)?.n); } catch { return 0; }
  };
  const str = (sql: string): string | null => {
    try { return (db.prepare(sql).get() as { n?: string | null } | undefined)?.n ?? null; } catch { return null; }
  };
  try {
    return {
      inbound24h: num("SELECT COUNT(*) n FROM message WHERE to_agent_id IN (SELECT id FROM agent WHERE runtime='openclaw') AND created_at > datetime('now','-24 hours')"),
      outbound24h: num("SELECT COUNT(*) n FROM message WHERE from_agent_id IN (SELECT id FROM agent WHERE runtime='openclaw') AND created_at > datetime('now','-24 hours')"),
      inboundPending: num("SELECT COUNT(*) n FROM message_recipient mr JOIN agent a ON a.id=mr.agent_id WHERE a.runtime='openclaw' AND mr.recipient_state='open' AND mr.delivery_state IN ('pending','dispatching','wake_dispatched')"),
      outboundPending: num("SELECT COUNT(*) n FROM message m JOIN message_recipient mr ON mr.message_id=m.id WHERE m.from_agent_id IN (SELECT id FROM agent WHERE runtime='openclaw') AND mr.recipient_state='open' AND mr.delivery_state IN ('pending','dispatching','wake_dispatched')"),
      newestInbound: str("SELECT MAX(created_at) n FROM message WHERE to_agent_id IN (SELECT id FROM agent WHERE runtime='openclaw')"),
      newestOutbound: str("SELECT MAX(created_at) n FROM message WHERE from_agent_id IN (SELECT id FROM agent WHERE runtime='openclaw')"),
    };
  } catch {
    return base;
  }
}

function readIngressAudit(db: Database): IngressAudit {
  const num = (sql: string): number => {
    try { return safeNumber((db.prepare(sql).get() as { n?: number } | undefined)?.n); } catch { return 0; }
  };
  let newestStuck: string | null = null;
  try {
    newestStuck = (db.prepare("SELECT MAX(at) n FROM audit_event WHERE action='openclaw_telegram_ingress_stuck'").get() as { n?: string | null } | undefined)?.n ?? null;
  } catch {
    newestStuck = null;
  }
  return {
    stuck24h: num("SELECT COUNT(*) n FROM audit_event WHERE action='openclaw_telegram_ingress_stuck' AND at > datetime('now','-24 hours')"),
    stuck7d: num("SELECT COUNT(*) n FROM audit_event WHERE action='openclaw_telegram_ingress_stuck' AND at > datetime('now','-7 days')"),
    newestStuck,
  };
}

export function readOpenClawTelegramIngressStatus(db: Database, statusPath: string = INGRESS_STATUS_FILE): OpenClawTelegramIngressStatus {
  const empty = (account = "default"): OpenClawTelegramIngressStatus => ({
    available: false,
    generated_at: null,
    as_of: null,
    account,
    bot_username: "",
    state: "unknown",
    last_state_at: null,
    last_inbound_at: null,
    last_inbound_age_sec: 0,
    restart_count: 0,
    backlog_latency_sec: 0,
    stale_threshold_sec: 0,
    cooldown_sec: 0,
    auto_recover_enabled: 0,
    detected: false,
    reason: "status file missing or unreadable",
    source_log: null,
    status_mtime: null,
    files: countIngressFiles(account),
    traffic: readIngressTraffic(db),
    audit: readIngressAudit(db),
  });
  try {
    if (!existsSync(statusPath)) return empty();
    const raw = JSON.parse(readFileSync(statusPath, "utf-8")) as Record<string, unknown>;
    const account = safeString(raw.account) ?? "default";
    let statusMtime: string | null = null;
    try { statusMtime = new Date(statSync(statusPath).mtimeMs).toISOString(); } catch { /* noop */ }
    return {
      available: true,
      generated_at: safeString(raw.generated_at),
      as_of: safeString(raw.as_of),
      account,
      bot_username: safeString(raw.bot_username) ?? "",
      state: safeString(raw.state) ?? "unknown",
      last_state_at: safeString(raw.last_state_at),
      last_inbound_at: safeString(raw.last_inbound_at),
      last_inbound_age_sec: safeNumber(raw.last_inbound_age_sec),
      restart_count: safeNumber(raw.restart_count),
      backlog_latency_sec: safeNumber(raw.backlog_latency_sec),
      stale_threshold_sec: safeNumber(raw.stale_threshold_sec),
      cooldown_sec: safeNumber(raw.cooldown_sec),
      auto_recover_enabled: safeNumber(raw.auto_recover_enabled),
      detected: raw.detected === true || raw.detected === "true",
      reason: safeString(raw.reason) ?? "unknown",
      source_log: safeString(raw.source_log),
      status_mtime: statusMtime,
      files: countIngressFiles(account),
      traffic: readIngressTraffic(db),
      audit: readIngressAudit(db),
    };
  } catch {
    return empty();
  }
}

// ── 멤버별 홉 카운트 (GD 2026-07-10 "1턴1홉" 계측) ──────────────────────────
// 팀원끼리 버스 왕복 홉 수를 from_agent_id별로 집계 → avg/min/max. 낮을수록 효율(1홉), 높으면 루프 의심.
// read-only, 새 probe 0. user/system/broadcast 발신은 제외(팀원 루프만 계측).
export interface HopMemberStat {
  memberId: string;
  avg: number;
  min: number;
  max: number;
  count: number;
}
export interface HopMetrics {
  window24h: HopMemberStat[];
  window7d: HopMemberStat[];
}

export function readHopMetrics(db: Database): HopMetrics {
  const q = (since: string): HopMemberStat[] => {
    try {
      return db
        .prepare(
          `SELECT from_agent_id AS memberId,
                  ROUND(AVG(hop_count), 1) AS avg, MIN(hop_count) AS min, MAX(hop_count) AS max, COUNT(*) AS count
             FROM message
            WHERE hop_count IS NOT NULL
              AND from_agent_id IS NOT NULL
              AND from_agent_id NOT IN ('user', 'system', 'broadcast')
              AND created_at > datetime('now', ?)
            GROUP BY from_agent_id
            ORDER BY avg DESC, count DESC`,
        )
        .all(since) as HopMemberStat[];
    } catch {
      return [];
    }
  };
  return { window24h: q("-24 hours"), window7d: q("-7 days") };
}
