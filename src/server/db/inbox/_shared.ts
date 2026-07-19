import type { EnvelopeStored } from "../../../shared/envelopeSchema";

export function toIso(s: string | null | undefined): string | null {
  if (!s) return null;
  // SQLite datetime('now') returns UTC "YYYY-MM-DD HH:MM:SS". Present it in KST (+09:00) so
  // agents/dashboard show local time (agents were surfacing raw UTC like "13:20Z" — 2026-05-25).
  // The offset is explicit → consumers parse the SAME instant (frontend parseSqliteDate handles
  // "+", server logic reads the DB directly, so display-only change is safe).
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(s)) {
    const utc = new Date(s.replace(" ", "T") + "Z");
    if (Number.isNaN(utc.getTime())) return s.replace(" ", "T") + "Z";
    const kst = new Date(utc.getTime() + 9 * 60 * 60 * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${kst.getUTCFullYear()}-${p(kst.getUTCMonth() + 1)}-${p(kst.getUTCDate())}T${p(kst.getUTCHours())}:${p(kst.getUTCMinutes())}:${p(kst.getUTCSeconds())}+09:00`;
  }
  return s;
}

export interface MessageRow {
  id: string;
  thread_id: string;
  from_agent_id: string;
  to_agent_id: string;
  type: string;
  body: string;
  source: string;
  hop_count: number;
  in_reply_to: string | null;
  read_at: string | null;
  delivery_status: string;
  retry_count: number;
  expires_at: string | null;
  priority: string;
  dedupe_key: string | null;
  attachments_json: string | null;
  meta_json: string | null;
  created_at: string;
}

export function rowToEnvelope(r: MessageRow): EnvelopeStored {
  return {
    id: r.id,
    thread_id: r.thread_id,
    from_agent_id: r.from_agent_id,
    to_agent_id: r.to_agent_id,
    type: r.type as EnvelopeStored["type"],
    body: r.body,
    source: r.source as EnvelopeStored["source"],
    hop_count: r.hop_count,
    in_reply_to: r.in_reply_to,
    read_at: toIso(r.read_at),
    delivery_status: r.delivery_status as EnvelopeStored["delivery_status"],
    retry_count: r.retry_count,
    expires_at: toIso(r.expires_at),
    priority: r.priority as EnvelopeStored["priority"],
    dedupe_key: r.dedupe_key,
    attachments: r.attachments_json ? JSON.parse(r.attachments_json) : undefined,
    meta: r.meta_json ? JSON.parse(r.meta_json) : undefined,
    created_at: toIso(r.created_at) ?? new Date().toISOString(),
  };
}

export interface ThreadRow {
  id: string;
  title: string;
  kind: string;
  participants_json: string;
  moderator_agent_id: string | null;
  status: string;
  state: string;
  round_no: number;
  state_json: string | null;
  next_responder_agent_id: string | null;
  last_message_at: string | null;
  opened_by: string;
  opened_at: string;
  closed_at: string | null;
  summary: string | null;
}

// Just-arrived protection (Gemini #4): rows whose message is newer than this are
// never auto-resolved, so a click can't nuke messages that just landed.
// Shared by busMemberStatus (stats) and resolvePendingForAgent (lifecycle).
export const RESOLVE_GRACE_SECONDS = 30;
