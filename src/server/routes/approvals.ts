// approvals — GD 승인 큐 API. 권한 액션을 PIN 승인으로 처리(터미널 0). (2026-06-10 GD)
//   GET  /approvals            대기/최근 승인 목록
//   GET  /approvals/actions    미리 정의된 안전 액션 카탈로그
//   POST /approvals            권한 액션 enqueue (관리/서버 내부용)
//   POST /approvals/:id/approve {pin}  PIN 검증 → 승인(Stage1: 실행 OFF)
//   POST /approvals/:id/reject         거절
//   GET  /approvals/pin        PIN 설정 여부(값 X)
//   POST /approvals/pin {pin}  admin PIN 설정/변경(첫 1회 또는 admin)
// 보안: 액션은 ACTIONS 화이트리스트만, 승인엔 PIN, PIN 값/해시 노출 안 함.
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

// 승인 v2(GD 2026-07-08): 에이전트(승인자 풀)가 merge 승인/거절 시 신청자에게 버스 통지(읽기전용).
//   ★Devon 리뷰 #4: wake 안 나는 이유는 source:"system" 이다 — dispatcher pendingDispatch 가 source IN(agent,user)
//   만 wake 큐에 올려서(inbox/dispatch.ts) system 은 세션 wake·답장 유발 안 함. (expected_response 는 insertMessage
//   가 컬럼에 안 넣으므로 no-op 이라 제거.) unread inbox 항목만 남음 = 통지라 OK.
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

  // 제시되는 것 = 실행 가능한 것만. 제외된 건 ★숨기되 침묵하지 않는다★ — 이유를 함께 준다.
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
    // ★보안: 이미 PIN이 설정돼 있으면 *기존 PIN(current_pin) 검증* 후에만 변경 허용.
    // (없으면 누구나 덮어써 가드 무력화 — 첫 설정만 무인증.)
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
