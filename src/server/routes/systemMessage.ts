// 시스템 메시지는 source=system으로 저장한다. OP_MESSAGE_TOKEN이 없으면 503으로 비활성화하고 있으면 X-Op-Token을 확인한다.
// 공개 노출에는 별도의 CSRF·Origin·bind 가드 검토가 필요하다.
import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { acceptInbound, type InboundEnv } from "../db/inboxQueries";
import { appendAudit } from "../db/queries";
import { appendAuditFile } from "../lib/auditFile";
import { BODY_MAX_CHARS, recipientIdSchema } from "../../shared/envelopeSchema";
import { ok, err } from "../lib/apiResponse";
import type { WsEvent } from "../types";

const systemMessageSchema = z.object({
  to_agent_id: recipientIdSchema, // 특정 팀원 또는 "broadcast"
  body: z.string().min(1).max(BODY_MAX_CHARS),
  thread_id: z.string().min(4).max(32).optional(),
  type: z.enum(["system", "dm", "broadcast"]).default("system"),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
});
// source=system은 디스패처의 깨움 대상이 아니므로 수신함에만 적재한다. 이 엔드포인트는 dispatch 옵션을 받지 않는다.

// 상수시간 토큰 비교 (slack.ts:52·approvals argon2 선례와 일관). 길이 다르면 즉시 false.
function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

interface SystemMessageDeps {
  db: Database;
  broadcast: (e: WsEvent) => void;
  registeredAgentIds: () => Set<string>;
}

export function createSystemMessageRoutes(deps: SystemMessageDeps): Hono {
  const r = new Hono();

  // POST /api/system-message
  r.post("/system-message", async (c) => {
    const expected = process.env.OP_MESSAGE_TOKEN ?? "";
    if (!expected) return err(c, "system_message_disabled", 503, { hint: "비활성 상태" });
    if (!tokenMatches(c.req.header("x-op-token"), expected)) return err(c, "unauthorized", 401);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return err(c, "invalid_json", 400);
    }
    const parsed = systemMessageSchema.safeParse(raw);
    if (!parsed.success) return err(c, "schema_validation", 400, { issues: parsed.error.issues });
    const m = parsed.data;

    const known = deps.registeredAgentIds();
    if (m.to_agent_id !== "broadcast" && !known.has(m.to_agent_id)) {
      return err(c, "unknown_to_agent", 400, { id: m.to_agent_id });
    }

    const env: InboundEnv = {
      thread_id: m.thread_id,
      from_agent_id: "system",
      to_agent_id: m.to_agent_id,
      type: m.type,
      body: m.body,
      source: "system",
      hop_count: 0,
      priority: m.priority,
    };

    const accepted = acceptInbound(deps.db, env, {
      dedupeWindowSec: 60,
      broadcast: deps.broadcast,
      onInserted: (stored) => {
        const detail = { thread_id: stored.thread_id, to: m.to_agent_id, type: m.type };
        appendAudit(deps.db, "system", "op_message_posted", stored.id, detail);
        appendAuditFile("system", "op_message_posted", stored.id, detail);
      },
    });
    if (!accepted.ok) {
      return err(c, "duplicate", 409, { existing_message_id: accepted.duplicate });
    }
    return ok(c, { message: accepted.stored }, 201);
  });

  return r;
}
