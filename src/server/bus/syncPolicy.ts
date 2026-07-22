/**
 * Team Bus v1 — Sync policy (delivery ≠ visibility).
 *
 * sync levels:
 *   none    → no telegram mirror
 *   status  → "[A→B] 보냄" (short, no body)
 *   handoff → "[A→B] <body summary, ≤120 chars>"
 *   result  → "[A] 결과: <body summary, ≤120 chars>"
 *
 * Mirror failure MUST NOT fail delivery — fire-and-forget.
 */

import type { SyncLevel, PendingDispatchRow } from "./types";
import { appendAuditFile } from "../lib/auditFile";

const SUMMARY_MAX = 120;

function summarize(body: string, max = SUMMARY_MAX): string {
  const cleaned = body.replace(/\n+/g, " ").trim();
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max - 1) + "…";
}

function buildMirrorText(level: SyncLevel, row: PendingDispatchRow): string | null {
  switch (level) {
    case "none":
      return null;
    case "status":
      return `[팀버스] ${row.from_agent_id}→${row.agent_id} 메시지 전송`;
    case "handoff":
      return `[팀버스] ${row.from_agent_id}→${row.agent_id}: ${summarize(row.body)}`;
    case "result":
      return `[팀버스] ${row.from_agent_id} 결과: ${summarize(row.body)}`;
  }
}

export interface SyncPolicyDeps {
  groupId: string;       // CAPTURE_GROUP_ID
  botToken: string;      // TEAM_BUS_MIRROR_BOT_TOKEN, never CAPTURE_BOT_TOKEN
}

/**
 * Post a telegram mirror message if the sync level calls for it.
 * Errors are swallowed (mirror failure ≠ delivery failure).
 * Returns true if a mirror was posted, false if skipped.
 */
export async function applySync(
  row: PendingDispatchRow,
  deps: SyncPolicyDeps,
): Promise<boolean> {
  const level = (row.sync ?? "none") as SyncLevel;
  const text = buildMirrorText(level, row);
  if (!text) return false;

  try {
    const url = `https://api.telegram.org/bot${deps.botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: deps.groupId, text }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      appendAuditFile("bus_sync", "mirror_failed", row.message_id, {
        status: res.status,
        body: body.slice(0, 200),
        level,
      });
      return false;
    }
    return true;
  } catch (e) {
    appendAuditFile("bus_sync", "mirror_error", row.message_id, {
      error: e instanceof Error ? e.message : String(e),
      level,
    });
    return false;
  }
}

/**
 * Post a "delivery failed" status mirror (used when a message hits dead_letter).
 */
export async function mirrorDeadLetter(
  row: PendingDispatchRow,
  deps: SyncPolicyDeps,
): Promise<void> {
  const text = `[팀버스] 전달 실패 ${row.from_agent_id}→${row.agent_id}: ${row.last_error?.slice(0, 100) ?? "unknown error"}`;
  try {
    const url = `https://api.telegram.org/bot${deps.botToken}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: deps.groupId, text }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    // ignore — mirror failure never affects delivery
  }
}
