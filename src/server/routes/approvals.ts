// 승인 큐는 허용된 액션과 PIN 검증을 사용한다. 실제 실행은 별도 실행 게이트가 켜진 경우에만 허용한다.
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import {
  ACTIONS,
  listActions,
  listUnavailableActions,
  missingRequirements,
  enqueueApproval,
  listApprovals,
  getApproval,
  setApprovalStatus,
  approveAndMaybeExecute,
  isExecutionEnabled,
  isPinSet,
  setPin,
  verifyPin,
  verifyPinIssueSession,
  executeApproval,
} from "../lib/approvals";
import { ensureThread, insertMessage } from "../db/inboxQueries";

// 에이전트 신청자의 승인·거절 결과는 source=system 버스 통지로 남긴다.
// 디스패처는 agent·user만 깨우므로 이 통지는 세션을 깨우지 않고 수신함에만 남는다.
function notifyRequesterBus(db: Database, requestedBy: string, text: string): void {
  try {
    if (!requestedBy || requestedBy === "system" || requestedBy.startsWith("telegram:")) return; // 에이전트 대상만
    const agentId = requestedBy.trim().toLowerCase();
    const { thread_id } = ensureThread(db, { from_agent_id: "system", to_agent_id: agentId, type: "dm", body: text });
    insertMessage(db, {
      thread_id, from_agent_id: "system", to_agent_id: agentId, type: "dm", body: text,
      source: "system", hop_count: 0, priority: "normal",
    } as any);
  } catch { /* best-effort — 승인/거절 처리엔 영향 없음 */ }
}

export interface ApprovalsDeps {
  db: Database;
}

export function createApprovalsApp(deps: ApprovalsDeps): Hono {
  const { db } = deps;
  const app = new Hono();

  // 제시되는 것 = 실행 가능한 것만. 제외된 건 숨기되 침묵하지 않는다 — 이유를 함께 준다.
  app.get("/approvals/actions", (c) =>
    c.json({
      actions: listActions().map((a) => ({ key: a.key, label: a.label, description: a.description, danger: a.danger, paramHints: a.paramHints ?? [] })),
      unavailable: listUnavailableActions().map(({ action, missing }) => ({ key: action.key, label: action.label, reason: "missing_files", missing })),
    }),
  );

  app.get("/approvals", (c) => {
    const status = c.req.query("status") as any;
    const rows = listApprovals(db, status).map((r) => ({
      ...r,
      params: safeParse(r.params_json),
    }));
    return c.json({ approvals: rows, execution_enabled: isExecutionEnabled() });
  });

  app.post("/approvals", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const action_key = String(body.action_key ?? "");
    if (!ACTIONS[action_key]) return c.json({ error: `unknown action_key: ${action_key}` }, 400);
    // 실행 대상이 없는 액션은 큐에 넣지 않는다(눌러도 실패하는 항목을 만들지 않는다).
    const missing = missingRequirements(ACTIONS[action_key]);
    if (missing.length > 0) {
      return c.json({ error: "action_unavailable", action_key, missing, hint: "실행 스크립트가 없다. 파일이 생기면 자동으로 다시 제시된다." }, 409);
    }
    const params = isPlainObject(body.params) ? sanitizeParams(body.params) : {};
    const row = enqueueApproval(db, {
      action_key,
      params,
      title: typeof body.title === "string" ? body.title.slice(0, 200) : undefined,
      requested_by: typeof body.requested_by === "string" ? body.requested_by.slice(0, 64) : "system",
    });
    return c.json({ ok: true, approval: { ...row, params: safeParse(row.params_json) } }, 201);
  });

  app.post("/approvals/:id/approve", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const pin = String(body.pin ?? "");
    const res = await approveAndMaybeExecute(db, id, pin);
    if (!res.ok) return c.json({ ok: false, error: res.error, status: res.status }, 400);
    return c.json({ ok: true, status: res.status, executed: res.executed, execution_enabled: isExecutionEnabled() });
  });

  app.post("/approvals/:id/reject", (c) => {
    const id = c.req.param("id");
    const row = getApproval(db, id);
    if (!row) return c.json({ error: "not found" }, 404);
    if (row.status !== "pending") return c.json({ error: `이미 처리됨(${row.status})` }, 400);
    setApprovalStatus(db, id, "rejected");
    return c.json({ ok: true, status: "rejected" });
  });

  app.get("/approvals/pin", (c) => c.json({ set: isPinSet() }));

  app.post("/approvals/pin", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const pin = String(body.pin ?? "");
    // PIN 변경은 기존 PIN을 확인해야 임의 덮어쓰기로 승인 보호가 무력화되지 않는다. 첫 설정만 무인증이다.
    if (isPinSet()) {
      const current = String(body.current_pin ?? "");
      const v = await verifyPin(current);
      if (!v.ok) return c.json({ ok: false, error: "current_pin_required", detail: v.error }, 403);
    }
    const res = await setPin(pin);
    if (!res.ok) return c.json({ ok: false, error: res.error }, 400);
    return c.json({ ok: true });
  });

  // PIN per-session — 검증 1회 후 토큰 발급. 이후 민감작업은 pin 대신 pin_session 토큰으로(재요구 X).
  app.post("/approvals/pin/verify", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const pin = String(body.pin ?? "");
    const res = await verifyPinIssueSession(pin);
    if (!res.ok) return c.json({ ok: false, error: res.error }, 403);
    return c.json({ ok: true, token: res.token, expires_in_min: 30 });
  });

  return app;
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return isPlainObject(v) ? v : {};
  } catch {
    return {};
  }
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
// params 는 string 값만, 키 짧게 — 화이트리스트 액션이 env 로 쓰므로 안전하게 정제.
function sanitizeParams(o: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    if (/^[a-z_][a-z0-9_]{0,31}$/.test(k) && (typeof v === "string" || typeof v === "number")) {
      out[k] = String(v).slice(0, 256);
    }
  }
  return out;
}
