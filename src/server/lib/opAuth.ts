import { timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import { isPinSessionValid } from "./approvals";

export interface TrustedActor {
  actor: string;
  source: "pin_session" | "op_token" | "loopback_dashboard";
}

export interface AuthResult {
  ok: boolean;
  actor?: TrustedActor;
  error?: string;
  status?: number;
}

const ACTOR_RE = /^[a-z0-9_-]{1,40}$/i;
const LEAD_SETTING_RE = /^[a-z0-9_-]{1,40}$/;

let leadActorDb: Database | null = null;

export function configureLeadActorDb(db: Database): void {
  leadActorDb = db;
}

function leadActorSetting(db: Database | null): string | null {
  if (!db) return null;
  try {
    const row = db.prepare("SELECT value FROM setting WHERE key = 'lead_id'").get() as { value: string } | undefined;
    const value = row?.value?.trim() ?? "";
    return LEAD_SETTING_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function leadActorId(db?: Database): string {
  return leadActorSetting(db ?? leadActorDb) ?? process.env.LEAD_ACTOR_ID ?? "gd";
}

export function leadActorSource(db?: Database): "setting" | "env" | "default" {
  if (leadActorSetting(db ?? leadActorDb)) return "setting";
  if (process.env.LEAD_ACTOR_ID) return "env";
  return "default";
}

export function fallbackLeadActorId(): string {
  return process.env.LEAD_ACTOR_ID ?? "gd";
}

export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function trustedActorFromHeaders(headers: Headers): AuthResult {
  const pinSession = headers.get("x-pin-session") ?? undefined;
  if (isPinSessionValid(pinSession)) return { ok: true, actor: { actor: leadActorId(), source: "pin_session" } };

  const actor = String(headers.get("x-actor-id") ?? "").trim();
  if (!ACTOR_RE.test(actor)) return { ok: false, error: "x_actor_id_required", status: 403 };
  const provided = headers.get("x-op-token") ?? undefined;
  let expected = "";
  try {
    const bindings = JSON.parse(process.env.OP_MESSAGE_TOKEN_BINDINGS ?? "{}") as Record<string, unknown>;
    if (typeof bindings[actor] === "string") expected = bindings[actor] as string;
  } catch {
    return { ok: false, error: "op_auth_misconfigured", status: 503 };
  }
  if (!expected) {
    const legacyActor = (process.env.OP_MESSAGE_ACTOR_ID ?? "system").trim();
    if (actor === legacyActor) expected = process.env.OP_MESSAGE_TOKEN ?? "";
  }
  if (!expected) return { ok: false, error: "actor_token_unbound", status: 403 };
  if (!tokenMatches(provided, expected)) return { ok: false, error: "unauthorized", status: 401 };
  return { ok: true, actor: { actor, source: "op_token" } };
}

export function trustedActorFromRequest(
  request: Request,
  opts: { loopbackDashboardActor?: string } = {},
): AuthResult {
  const headers = request.headers;
  const hasExplicitAuth =
    headers.has("x-pin-session") ||
    headers.has("x-op-token") ||
    headers.has("x-actor-id");
  const fromHeaders = trustedActorFromHeaders(headers);
  if (fromHeaders.ok || hasExplicitAuth) return fromHeaders;
  const actor = opts.loopbackDashboardActor;
  if (actor && isLoopbackDashboardRequest(request) && ACTOR_RE.test(actor)) {
    return { ok: true, actor: { actor, source: "loopback_dashboard" } };
  }
  return fromHeaders;
}

function isLoopbackDashboardRequest(request: Request): boolean {
  const bind = process.env.TEAM_BIND ?? "127.0.0.1";
  if (!isLoopbackHost(bind)) return false;
  let urlHost = "";
  try {
    urlHost = new URL(request.url).hostname;
  } catch {
    return false;
  }
  const hostHeader = request.headers.get("host") ?? "";
  return isLoopbackHost(urlHost) && (!hostHeader || isLoopbackHost(hostHeaderName(hostHeader)));
}

function hostHeaderName(value: string): string {
  const v = value.trim();
  if (v.startsWith("[")) return v.slice(1, v.indexOf("]") >= 0 ? v.indexOf("]") : undefined);
  return v.split(":")[0] ?? "";
}

function isLoopbackHost(value: string): boolean {
  const v = value.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return v === "localhost" || v === "::1" || /^127(?:\.\d{1,3}){3}$/.test(v);
}
