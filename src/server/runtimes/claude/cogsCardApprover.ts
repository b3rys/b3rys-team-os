import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import { createApprovalWithCogsOwner, handOffWithCogsOwner } from "../../lib/cogsPermissions/ownerHandoff";
import { recordCardMessage } from "../../lib/cogsPermissions/approvals";
import type { CogsApproverDeps } from "../codex/cogsApprover";
import type { ApprovalRequest, ReviewDecision } from "../codex/appServerClient";

export function createClaudeCardApprover(deps: CogsApproverDeps & { apiBase: string; token: string; fetchFn?: typeof fetch }) {
  return async (req: ApprovalRequest): Promise<ReviewDecision> => {
    let requestId: string | undefined;
    try {
      const { executionId, normalizedPath, candidate } = req.params as any;
      if (req.method !== "claude/permission" || !deps.roomId || typeof executionId !== "string"
        || typeof normalizedPath !== "string" || !isAbsolute(normalizedPath) || normalize(normalizedPath) !== normalizedPath
        || candidate?.tool_name !== "Write" || typeof candidate?.input?.content !== "string"
        || typeof candidate?.input?.file_path !== "string") return "denied";
      // This adapter is entered only after the gate checker allows the Write.
      // Never persist the input, even temporarily: failed cards also retain request rows.
      const operation = () => ({ runtime: "claude", agent_id: deps.agentId, action: "Write", path: normalizedPath,
        text: JSON.stringify({tool:"Write", contentBytes:Buffer.byteLength(candidate.input.content, "utf8"),
          inputDigest:createHash("sha256").update(JSON.stringify(candidate.input)).digest("hex"), checkerCode:"checker_allowed"}) });
      const op = operation();
      const contentBytes = Buffer.byteLength(candidate.input.content, "utf8");
      const sessionId = executionId; // PR1 never reuses a grant for another execution.
      const transport = { apiBase: deps.apiBase, token: deps.token, fetchFn: deps.fetchFn, currentStamp: deps.currentStamp };
      const db = deps.openDb();
      try {
        const created = await createApprovalWithCogsOwner(db, {op,roomId:deps.roomId,sessionId,processGen:deps.processGen,ttlMs:150_000,alwaysRule:null}, transport);
        if (!created) return "denied";
        requestId = created.request.id;
      } finally { db.close(); }
      const waiting = deps.waiters.wait(requestId);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const sent = await Promise.race([
          deps.sendCard({ requestId, operationCode:"edit_files", detail:`${normalizedPath} · ${contentBytes} bytes`, risks:[], allowAlways:false }),
          new Promise<{ok:false}>(resolve => { timer = setTimeout(() => resolve({ok:false}), 15_000); }),
        ]);
        if (!sent.ok) { deps.waiters.cancel(requestId, "card_failed"); return "denied"; }
        if ("messageId" in sent && sent.messageId !== undefined) {
          const db = deps.openDb(); try { recordCardMessage(db, requestId, sent.messageId); } finally { db.close(); }
        }
      } finally { if (timer) clearTimeout(timer); }
      if ((await waiting).kind !== "allowed") return "denied";
      const handoffDb = deps.openDb();
      try {
        return await handOffWithCogsOwner(handoffDb, {requestId,agentId:deps.agentId,sessionId,processGen:deps.processGen,executionOperation:operation()}, transport) ? "approved" : "denied";
      } finally { handoffDb.close(); }
    } catch { if (requestId) deps.waiters.cancel(requestId, "approval_error"); return "denied"; }
  };
}
