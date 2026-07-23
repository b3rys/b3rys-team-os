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
  canApproveTier,
  getNormalApprovers,
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

  app.get("/approvals/actions", (c) =>
    c.json(listActions().map((a) => ({ key: a.key, label: a.label, description: a.description, danger: a.danger, paramHints: a.paramHints ?? [] }))),
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

  // 승인 v2(GD 2026-07-08): 에이전트(승인자 풀)가 merge_to_main 을 승인/거절하는 경로(GD 텔레그램 탭과 별개).
  //   보안: canApproveTier(자기승인 금지·풀 멤버십). merge_to_main 전용 — 다른 액션은 GD 탭 유지(일반 승인시스템 불변).
  //   승인 성공 시 executeApproval(GD 탭과 동일 실행경로 — merge-to-main.sh nonce 흐름 재사용) + 신청자 버스 통지.
  app.post("/approvals/:id/agent-approve", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const approver = String(body.approver ?? "").trim().toLowerCase();
    if (!approver) return c.json({ ok: false, error: "approver required" }, 400);
    const row = getApproval(db, id);
    if (!row) return c.json({ ok: false, error: "not found" }, 404);
    if (row.action_key !== "merge_to_main") return c.json({ ok: false, error: "이 경로는 merge_to_main 전용(다른 승인은 GD 탭)" }, 400);
    if (row.status !== "pending") return c.json({ ok: false, error: `이미 처리됨(${row.status})`, status: row.status }, 400);
    const params = safeParse(row.params_json);
    const author = String(params.author ?? row.requested_by).toLowerCase();
    // ★Devon 리뷰 #1: params.tier 를 실제로 읽는다. core 머지는 풀이 승인 불가(GD --lead 직접머지 경로). tier 고정 금지.
    const tier = params.tier === "core" ? "core" : "normal";
    if (tier === "core") return c.json({ ok: false, error: "core tier 머지는 풀 승인 불가 — GD 직접머지(--lead) 경로" }, 403);
    const auth = canApproveTier({ tier, approver, author, isLead: false, normalApprovers: getNormalApprovers(db) });
    if (!auth.ok) return c.json({ ok: false, error: auth.reason ?? "승인 권한 없음" }, 403);
    // ★Devon 리뷰 #5: 원자적 claim — pending→approved 를 조건부 UPDATE 로. 동시 두 승인 중 하나만 승리(changes=1),
    //   나머지는 409. read-then-write race + executeApproval executing 재사용 경합 예방.
    const prev = safeParse(row.result ?? "{}");
    const claim = db
      .prepare("UPDATE approval_request SET status='approved', decided_at=datetime('now'), result=? WHERE id=? AND status='pending'")
      .run(JSON.stringify({ ...prev, approver }), id); // ④실제 승인자 보존
    if (claim.changes !== 1) return c.json({ ok: false, error: "동시 처리됨(경합)", status: getApproval(db, id)?.status }, 409);
    const ex = await executeApproval(db, id);
    notifyRequesterBus(db, row.requested_by, `✅ 머지 승인·처리됨 — ${row.title}\n승인: ${approver}`);
    return c.json({ ok: ex.ok, status: ex.ok ? "done" : "failed", approver, output: ex.output });
  });

  app.post("/approvals/:id/agent-reject", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const approver = String(body.approver ?? "").trim().toLowerCase();
    const row = getApproval(db, id);
    if (!row) return c.json({ ok: false, error: "not found" }, 404);
    if (row.action_key !== "merge_to_main") return c.json({ ok: false, error: "merge_to_main 전용" }, 400);
    if (row.status !== "pending") return c.json({ ok: false, error: `이미 처리됨(${row.status})` }, 400);
    const params = safeParse(row.params_json);
    const author = String(params.author ?? row.requested_by).toLowerCase();
    const tier = params.tier === "core" ? "core" : "normal"; // Devon 리뷰 #1: tier 실제 반영
    if (tier === "core") return c.json({ ok: false, error: "core tier 머지는 풀 처리 불가 — GD 경로" }, 403);
    const auth = canApproveTier({ tier, approver, author, isLead: false, normalApprovers: getNormalApprovers(db) });
    if (!auth.ok) return c.json({ ok: false, error: auth.reason ?? "권한 없음" }, 403);
    // Devon 리뷰 #5: 원자적 claim(동시 거절/승인 경합 예방)
    const claim = db
      .prepare("UPDATE approval_request SET status='rejected', decided_at=datetime('now'), result=? WHERE id=? AND status='pending'")
      .run(JSON.stringify({ approver }), id);
    if (claim.changes !== 1) return c.json({ ok: false, error: "동시 처리됨(경합)", status: getApproval(db, id)?.status }, 409);
    notifyRequesterBus(db, row.requested_by, `❌ 머지 거절 — ${row.title}\n거절: ${approver}\n사유·재요청은 ${approver}에게 문의하세요.`);
    return c.json({ ok: true, status: "rejected", approver });
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
