import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AgentRecord, CodexSandboxMode } from "../types";
import { appendAuditFile } from "./auditFile";
import { enqueueApproval } from "./approvals";

export type PermissionTier = "allow" | "ask" | "deny";
export type PermissionAgent = Pick<AgentRecord, "id" | "workspace_path">;
export type PermissionDecision = "allow" | "deny" | "approval_required";
export type PermissionRequestStatus = "pending" | "allowed_once" | "allowed_always" | "denied" | "expired";
/**
 * `allow_session` = 이 세션 동안만 허용.
 *
 * ★status 로는 allow_once 와 구분되지 않는다.★ status 는 CHECK 로 값이 고정돼 있고 그 표는
 * 공개 코드가 모든 설치본에 만든다 — 값을 늘리려면 남의 DB 까지 재작성해야 해서 하지 않는다.
 * 대신 `decision_scope` 칸에 사람이 고른 범위를 그대로 적는다. 결정을 읽을 때는 두 칸을 같이 본다.
 *
 * ★grant 는 만들지 않는다.★ 세션 범위를 실제로 지키는 것은 런타임이고(codex 의 acceptForSession),
 * 우리 표는 사람이 무엇을 골랐는지를 적는 자리다.
 */
export type PermissionDecisionInput = "allow_once" | "allow_session" | "allow_always" | "deny";
/** 사람이 고른 범위 — status 와 함께 읽어야 결정이 온전해진다. */
export type PermissionDecisionScope = "once" | "session" | "always";

export type PermissionAction =
  | { kind: "sandbox"; sandbox: CodexSandboxMode; writableRoot?: string }
  | { kind: "network"; target: string; method?: string }
  | { kind: "mcp"; tool: string }
  | { kind: "bash"; cmd: string }
  | { kind: "read" | "write"; path: string };

export interface PermissionCheck {
  tier: PermissionTier;
  rule: string;
  reason: string;
  scope?: string;
}

export interface PermissionContext {
  grants?: ReadonlySet<string>;
  networkAllowlist?: readonly string[];
  workspaceRoot?: string | null;
}

export interface PermissionOperation {
  runtime: string;
  agent_id?: string | null;
  action: string;
  command?: string;
  path?: string;
  egress_url?: string;
  text?: string;
  requested_by?: string;
  provenance?: Record<string, unknown>;
}

export interface PermissionRequestRow {
  id: string;
  scope_key: string;
  runtime: string;
  agent_id: string | null;
  action: string;
  target: string;
  payload_json: string;
  status: PermissionRequestStatus;
  /** 사람이 고른 범위. 이 칸이 생기기 전에 결정된 행은 null 이다 — 없음을 '한번' 으로 읽지 않는다. */
  decision_scope: PermissionDecisionScope | null;
  requested_by: string;
  created_at: string;
  decided_at: string | null;
  approver: string | null;
  provenance_json: string | null;
}

export interface PermissionGrantRow {
  id: string;
  scope_key: string;
  runtime: string;
  agent_id: string | null;
  action: string;
  target: string;
  approver: string;
  provenance_json: string;
  created_at: string;
  expires_at: string | null;
}

const DENY: PermissionCheck = {
  tier: "deny",
  rule: "fail-closed",
  reason: "permission gate could not evaluate the action",
};

const HARD_DENY_PATTERNS: Array<{ rule: string; re: RegExp; reason: string }> = [
  { rule: "tier-d.rm-rf", re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, reason: "recursive forced delete is hard-denied" },
  { rule: "tier-d.rm-root", re: /\brm\s+.*\s\/\s*$/i, reason: "root delete is hard-denied" },
  { rule: "tier-d.privilege", re: /\b(sudo|doas)\b|\bsu\b\s/i, reason: "privilege escalation is hard-denied" },
  { rule: "tier-d.disk", re: /\bdd\b.*(?:if=|of=|bs=|count=|conv=)|\bmkfs|>\s*\/dev\/(?:sd|nvme|disk)|\b(?:shred|fdisk)\b/i, reason: "raw disk mutation is hard-denied" },
  { rule: "tier-d.service", re: /\b(?:launchctl|systemctl|service)\b|\b(?:shutdown|reboot|halt|poweroff)\b|\bkillall\b|\bkill\s+-9\s+1\b/i, reason: "system service or host shutdown mutation is hard-denied" },
  { rule: "tier-d.chmod-777", re: /\bchmod\s+777\b/i, reason: "world-writable permission change is hard-denied" },
  { rule: "tier-d.chown-root", re: /\bchown\s+root\b/i, reason: "root ownership change is hard-denied" },
  { rule: "tier-d.remote-exec", re: /\b(?:curl|wget)\b.*\|\s*(?:sh|bash|zsh)|\beval\b.*\$\(/i, reason: "remote or dynamic code execution is hard-denied" },
  { rule: "tier-d.agent-session", re: /\btmux\b.*\b(?:kill|send)\b.*\b(?:claude|codex|hermes|openclaw)-/i, reason: "mutating another agent session is hard-denied" },
];

const TIER_D_REASON_IDS: Record<string, string> = {
  "tier-d.rm-rf": "rm_rf",
  "tier-d.rm-root": "rm_root",
  "tier-d.privilege": "sudo",
  "tier-d.disk": "dd",
  "tier-d.service": "launchctl",
  "tier-d.chmod-777": "chmod_777",
  "tier-d.chown-root": "chown_root",
  "tier-d.remote-exec": "remote_exec",
  "tier-d.agent-session": "agent_session",
};

const OP_TIER_D_PATTERNS: Array<{ id: string; re: RegExp }> = HARD_DENY_PATTERNS.map((p) => ({
  id: TIER_D_REASON_IDS[p.rule] ?? p.rule.replace(/^tier-d\./, "").replace(/-/g, "_"),
  re: p.re,
}));
const SECRET_READ_RE = /(?:^|[;&|()\s])(?:cat|less|more|tail|head|sed|awk|grep|rg|strings)\s+[^;&|]*(?:\.env|id_rsa|id_ed25519|token|secret|credential|keychain|\.pem|\.p12|\.key)\b/i;
const EGRESS_RE = /(?:^|[;&|()\s])(?:curl|wget|scp|sftp|ftp|nc|ncat|openssl\s+s_client|python3?\s+-c|node\s+-e)\b|https?:\/\//i;
const SECRET_PATH = /(^|\/)(\.env[^/]*|.*credential.*|.*secret.*|.*\.(key|pem))$|^~\/\.(ssh|aws)(\/|$)/i;

export function grantKey(agentId: string, scope: string): string {
  return `perm.grant.${agentId}.${scope}`;
}

export function safeCheckPermission(
  agent: PermissionAgent,
  action: PermissionAction,
  ctx: PermissionContext = {},
): PermissionCheck {
  try {
    return checkPermission(agent, action, ctx);
  } catch {
    return DENY;
  }
}

export function checkPermission(
  agent: PermissionAgent,
  action: PermissionAction,
  ctx: PermissionContext = {},
): PermissionCheck {
  if (!agent?.id) throw new Error("agent id required");
  const hard = hardDeny(action, ctx);
  if (hard) return hard;
  const ask = askRule(agent, action, ctx);
  if (ask) {
    return ctx.grants?.has(grantKey(agent.id, ask.scope ?? ask.rule))
      ? { tier: "allow", rule: `${ask.rule}.grant`, reason: "explicit grant matched", scope: ask.scope }
      : ask;
  }
  return { tier: "allow", rule: "tier-allow.readonly", reason: "read-only scoped action is allowed" };
}

function hardDeny(action: PermissionAction, ctx: PermissionContext): PermissionCheck | null {
  if (action.kind === "sandbox" && action.sandbox === "danger-full-access") {
    return { tier: "deny", rule: "tier-d.danger-full-access", reason: "danger-full-access cannot be granted by app approval", scope: "sandbox:danger-full-access" };
  }
  if (action.kind === "bash") {
    for (const p of HARD_DENY_PATTERNS) {
      if (p.re.test(action.cmd)) return { tier: "deny", rule: p.rule, reason: p.reason };
    }
    if (SECRET_READ_RE.test(action.cmd) && EGRESS_RE.test(action.cmd)) {
      return { tier: "deny", rule: "tier-d.secret-read-plus-egress", reason: "secret read combined with network egress is hard-denied" };
    }
  }
  if ((action.kind === "read" || action.kind === "write") && isSecurityConfigPath(action.path)) {
    return { tier: "deny", rule: "tier-d.security-config", reason: "credential or auth configuration writes/reads require terminal-only handling", scope: `path:${action.path}` };
  }
  if (action.kind === "write" && !isWithinWorkspace(action.path, ctx.workspaceRoot)) {
    return { tier: "deny", rule: "tier-d.outside-workspace-write", reason: "writes outside the dedicated workspace are hard-denied", scope: `path:${action.path}` };
  }
  return null;
}

function askRule(agent: PermissionAgent, action: PermissionAction, ctx: PermissionContext): PermissionCheck | null {
  if (action.kind === "sandbox" && action.sandbox === "workspace-write") {
    const root = action.writableRoot ?? ctx.workspaceRoot ?? agent.workspace_path;
    return { tier: "ask", rule: "tier-a.workspace-write", reason: "workspace-write requires an explicit scoped grant", scope: `workspace-write:${root}` };
  }
  if (action.kind === "network") {
    if (isNetworkAllowed(action.target, ctx.networkAllowlist ?? [])) return null;
    return { tier: "ask", rule: "tier-a.network-egress", reason: "network egress requires an allowlisted target", scope: `net:${action.target}` };
  }
  if (action.kind === "mcp") {
    return { tier: "ask", rule: "tier-a.mcp", reason: "MCP tools run behind ask-gate by default", scope: `mcp:${action.tool}` };
  }
  if (action.kind === "read" && SECRET_PATH.test(action.path)) {
    return { tier: "ask", rule: "tier-a.secret-read", reason: "secret metadata reads require approval and must not expose values", scope: `path:${action.path}` };
  }
  return null;
}

function isNetworkAllowed(target: string, allowlist: readonly string[]): boolean {
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(target)) return true;
  return allowlist.some((allowed) => target === allowed || target.endsWith(`.${allowed}`));
}

function isSecurityConfigPath(path: string): boolean {
  return /(^|\/)(access\.json|auth\.json|.*token.*|.*credential.*)$/i.test(path) || /bus-wake-extra\.txt$/i.test(path);
}

function isWithinWorkspace(path: string, workspaceRoot?: string | null): boolean {
  if (!workspaceRoot) return false;
  const root = resolve(workspaceRoot);
  const p = resolve(path);
  return p === root || p.startsWith(`${root}/`);
}

function normalizeText(input: string | undefined): string {
  return (input ?? "").replace(/\s+/g, " ").trim();
}

function operationText(op: PermissionOperation): string {
  return [op.command, op.path, op.egress_url, op.text].filter(Boolean).join(" ");
}

export function tierDReasons(op: PermissionOperation): string[] {
  const text = normalizeText(operationText(op));
  const reasons = OP_TIER_D_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.id);
  if (SECRET_READ_RE.test(text) && EGRESS_RE.test(text)) reasons.push("secret_read_plus_egress");
  return [...new Set(reasons)];
}

export function targetForOperation(op: PermissionOperation): string {
  if (op.command) return normalizeText(op.command).slice(0, 240);
  if (op.path) return op.path.slice(0, 240);
  if (op.egress_url) return op.egress_url.slice(0, 240);
  if (op.text) return normalizeText(op.text).slice(0, 240);
  return op.action.slice(0, 240);
}

export function scopeKeyForOperation(op: PermissionOperation): string {
  const normalized = JSON.stringify({
    runtime: op.runtime,
    agent_id: op.agent_id ?? null,
    action: op.action,
    target: targetForOperation(op),
  });
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * ★우리가 판정하지 않는다 — 사람이 판정한다.★
 *
 * 전에는 여기서 Tier-D 목록(sudo·rm -rf·dd 등 정규식 9개)에 걸리면 ★팝업조차 안 만들고 deny★ 했다.
 * 그 목록은 ★우리 코드에 하드코딩★ 되어 있어 사람이 열어볼 수도, 팀원별로 다르게 줄 수도 없었다.
 *
 * ★다른 팀원과 비교하면 이것만 달랐다★ (2026-08-13 실측 — 우리 코드의 차단목록 참조 파일 수):
 *   claude 0 · hermes 0 · openclaw 0 · b3osNative 0 · ★codex 6★
 * 다른 팀원은 그 도구 자체 설정(클로드 settings.json · 헤르메스 자체 기능)을 쓰거나 아예 없다.
 * codex 도 같은 원칙으로 간다 — ★경계는 codex 설정이 정하고, 그 밖은 사람이 승인창에서 정한다.★
 *
 * `tierDReasons` 는 지우지 않는다 — 팝업 본문에 "왜 위험한지" 를 적는 ★표시용★ 으로는 값이 있다.
 * 판정에서만 뺀다.
 */
export function evaluatePermission(db: Database, op: PermissionOperation): { decision: PermissionDecision; reasons: string[]; grant?: PermissionGrantRow } {
  const scope_key = scopeKeyForOperation(op);
  const grant = db
    .prepare(
      `SELECT * FROM permission_grant
       WHERE scope_key = ? AND (expires_at IS NULL OR expires_at > datetime('now'))
       LIMIT 1`,
    )
    .get(scope_key) as PermissionGrantRow | undefined;
  if (grant) return { decision: "allow", reasons: [], grant };
  return { decision: "approval_required", reasons: [] };
}

export function requestPermission(db: Database, op: PermissionOperation): { decision: PermissionDecision; reasons: string[]; request?: PermissionRequestRow; grant?: PermissionGrantRow } {
  const evalResult = evaluatePermission(db, op);
  const scope_key = scopeKeyForOperation(op);
  const target = targetForOperation(op);
  if (evalResult.decision === "allow") return evalResult;

  const id = `prm_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
  db.prepare(
    `INSERT INTO permission_request(id, scope_key, runtime, agent_id, action, target, payload_json, status, requested_by, provenance_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    id,
    scope_key,
    op.runtime,
    op.agent_id ?? null,
    op.action,
    target,
    JSON.stringify({ command: op.command, path: op.path, egress_url: op.egress_url, text: op.text }),
    op.requested_by ?? op.agent_id ?? op.runtime,
    JSON.stringify(op.provenance ?? {}),
  );
  const request = getPermissionRequest(db, id)!;
  // ★팀원 요청은 op 방 대기열에 넣지 않는다.★
  //   "팀원들이 승인을 받을 때는 각자방에 떠야지. op방에 뜨는 건 시스템 알림종류야."
  //   op 대기열(approval_request)에 들어가면 op 방 승인 목록에 렌더된다 — 그게 팀원 승인이
  //   팀 리드 방으로 올라가던 경로였다. 팀원 것은 그 팀원 방으로 간다
  //   (codex 런타임: appServerPopup.sendApprovalToMemberRoom → 브리지가 버튼 처리).
  //   agent_id 가 없는 것 = 특정 팀원의 일이 아닌 시스템 작업 → op 방이 맞다.
  //   ★감사기록은 어느 쪽이든 남긴다★ — 아래 enqueue 만 건너뛴다(기록까지 빠지면 팀원 요청은 흔적이 없다).
  if (belongsToMemberRoom(op)) {
    appendPermissionAudit(db, { request_id: id, scope_key, op, target, decision: "requested", approver: null, provenance: op.provenance ?? {} });
    return { decision: "approval_required", reasons: [], request };
  }
  enqueueApproval(db, {
    action_key: "permission_gate",
    params: {
      permission_request_id: id,
      scope_key,
      runtime: op.runtime,
      ...(op.agent_id ? { agent_id: op.agent_id } : {}),
      action: op.action,
      target,
    },
    title: `권한 요청: ${op.runtime}${op.agent_id ? `/${op.agent_id}` : ""} ${op.action}`,
    requested_by: op.requested_by ?? op.agent_id ?? op.runtime,
  });
  appendPermissionAudit(db, { request_id: id, scope_key, op, target, decision: "requested", approver: null, provenance: op.provenance ?? {} });
  return { decision: "approval_required", reasons: [], request };
}

/**
 * ★이 승인이 어디에 뜨는가 — 판정은 여기 한 곳뿐이다.★ (리뷰 지적)
 *
 *
 * 같은 판단이 두 곳에 있으면 ★한쪽만 고치고 '완료' 가 된다★ — 그러면 행이 두 방에 뜨거나
 * 아무 데도 안 뜬다. 그리고 조용하다 — 이 모양으로 3건이 관측됐다.
 * requestPermission 과 telegramCapture 가 ★둘 다 이 함수를 부른다.★
 */
export function belongsToMemberRoom(row: { agent_id: string | null } | { agent_id?: string | null }): boolean {
  return Boolean(row.agent_id);
}

export function getPermissionRequest(db: Database, id: string): PermissionRequestRow | undefined {
  return db.prepare("SELECT * FROM permission_request WHERE id = ?").get(id) as PermissionRequestRow | undefined;
}

export function listPermissionRequests(db: Database, status?: PermissionRequestStatus): PermissionRequestRow[] {
  const rows = status
    ? db.prepare("SELECT * FROM permission_request WHERE status = ? ORDER BY created_at DESC LIMIT 50").all(status)
    : db.prepare("SELECT * FROM permission_request ORDER BY created_at DESC LIMIT 50").all();
  return rows as PermissionRequestRow[];
}

export function decidePermissionRequest(
  db: Database,
  id: string,
  decision: PermissionDecisionInput,
  opts: { approver: string; provenance?: Record<string, unknown> },
): { ok: boolean; status?: PermissionRequestStatus; error?: string } {
  const row = getPermissionRequest(db, id);
  if (!row) return { ok: false, error: "permission request not found" };
  if (row.status !== "pending") return { ok: false, status: row.status, error: `already handled (${row.status})` };

  const payload = safeParse(row.payload_json);
  const op: PermissionOperation = {
    runtime: row.runtime,
    agent_id: row.agent_id,
    action: row.action,
    command: stringOrUndefined(payload.command),
    path: stringOrUndefined(payload.path),
    egress_url: stringOrUndefined(payload.egress_url),
    text: stringOrUndefined(payload.text),
  };
  // ★사람이 누른 것을 우리가 뒤집지 않는다.★
  //   전에는 Tier-D 목록에 걸리면 ★사람이 허용을 눌러도 거부★ 했다("Tier D cannot be approved").
  //   그 목록은 우리 코드에 하드코딩돼 있어 사람이 볼 수도, 고칠 수도 없었다.
  //   위험 사유는 ★팝업 본문에 적어 사람이 보고 판단★ 하게 한다 — 대신 정하지 않는다.
  const tierD = tierDReasons(op);
  if (tierD.length) {
    // 판정은 안 하되 ★무엇이 걸렸는지는 남긴다★ — 나중에 "왜 그때 허용했나" 를 볼 수 있어야 한다.
    appendPermissionAudit(db, { request_id: id, scope_key: row.scope_key, op, target: row.target, decision: `risk_noted:${decision}`, approver: opts.approver, provenance: { ...(opts.provenance ?? {}), reasons: tierD } });
  }

  // 세션은 ★지속되는 허가를 남기지 않는다★ — 그 점에서 allowed_once 와 같다. 무엇을 골랐는지는
  // decision_scope 가 말한다. 거절은 범위가 없으므로 null 이다.
  const status: PermissionRequestStatus =
    decision === "allow_always" ? "allowed_always" : decision === "deny" ? "denied" : "allowed_once";
  const scope: PermissionDecisionScope | null =
    decision === "allow_once" ? "once"
    : decision === "allow_session" ? "session"
    : decision === "allow_always" ? "always"
    : null;
  const changed = db.prepare(
    `UPDATE permission_request
       SET status = ?, decision_scope = ?, decided_at = datetime('now'), approver = ?, provenance_json = ?
     WHERE id = ? AND status = 'pending'`,
  ).run(status, scope, opts.approver, JSON.stringify(opts.provenance ?? {}), id).changes;
  if (changed !== 1) return { ok: false, error: "permission request changed concurrently" };

  // ★'항상 허용' 에 기한을 둔다 — 무기한이 아니다.★ (2026-08-13)
  //
  //   전에는 `expires_at = NULL`(무기한) 이었다. 그 행이 있으면 `evaluatePermission` 이 grant 조회에서
  //   곧장 allow 를 돌려줘 ★팝업조차 안 뜬다.★ Tier-D 판정을 걷어낸 뒤에는 ★위험 명령도 이 경로에 도달한다★
  //   — 탭 한 번이 ★영구 자동승인★ 이 된다. (하네스 2개가 독립적으로 같은 지점을 지목했다.
  //   예전에는 Tier-D 가 grant 조회 ★앞줄★ 에서 막아 이 상태가 도달 불가였다.)
  //
  //   이 표에는 ★취소 경로가 코드에 없다★(`DELETE FROM permission_grant` 0건). 무기한 + 취소불가는
  //   되돌릴 수 없는 조합이다. 기한을 두면 ★가만히 둬도 스스로 닫힌다.★
  //   codex 자신도 세션 단위로만 기억한다(`acceptForSession`) — 우리만 영구를 들고 있을 이유가 없다.
  const GRANT_TTL_HOURS = 24;
  if (decision === "allow_always") {
    db.prepare(
      `INSERT INTO permission_grant(id, scope_key, runtime, agent_id, action, target, approver, provenance_json, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+' || ? || ' hours'))
       ON CONFLICT(scope_key) DO UPDATE SET
         approver = excluded.approver,
         provenance_json = excluded.provenance_json,
         created_at = datetime('now'),
         expires_at = excluded.expires_at`,
    ).run(
      `pgr_${randomUUID().replace(/-/g, "").slice(0, 18)}`,
      row.scope_key, row.runtime, row.agent_id, row.action, row.target,
      opts.approver, JSON.stringify(opts.provenance ?? {}), GRANT_TTL_HOURS,
    );
  }
  appendPermissionAudit(db, { request_id: id, scope_key: row.scope_key, op, target: row.target, decision, approver: opts.approver, provenance: opts.provenance ?? {} });
  appendAuditFile("permission_gate", decision, id, { approver: opts.approver, scope_key: row.scope_key });
  return { ok: true, status };
}

function appendPermissionAudit(
  db: Database,
  input: { request_id: string | null; scope_key: string; op: PermissionOperation; target: string; decision: string; approver: string | null; provenance: Record<string, unknown> },
): void {
  db.prepare(
    `INSERT INTO perm_request_audit(request_id, scope_key, runtime, agent_id, action, target, decision, approver, provenance_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(input.request_id, input.scope_key, input.op.runtime, input.op.agent_id ?? null, input.op.action, input.target, input.decision, input.approver, JSON.stringify(input.provenance));
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
