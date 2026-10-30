import { createHash } from "node:crypto";
import type { ApprovalRequest } from "./appServerClient";

/** Folder approvals bind the complete operation, including proposed rules. Unknown content is denied. */
export function folderOperationDigest(req: ApprovalRequest): string | null {
  const p = req.params;
  const command = req.method === "execCommandApproval" || req.method === "item/commandExecution/requestApproval";
  if (command) {
    if (!(typeof p.command === "string" ? p.command.trim().length > 0 : Array.isArray(p.command) && p.command.length > 0 && p.command.every(v => typeof v === "string") && p.command.join(" ").trim().length > 0)) return null;
  } else if (req.method === "item/fileChange/requestApproval") {
    if (!req.observedItem?.changes.length || req.observedItem.changes.some(c => typeof c.diff !== "string" || c.contentKnown === false)) return null;
  } else if (req.method === "applyPatchApproval") {
    if (!p.fileChanges || typeof p.fileChanges !== "object" || Array.isArray(p.fileChanges)) return null;
    const changes = Object.values(p.fileChanges) as Record<string, unknown>[];
    if (!changes.length || changes.some(c => !c || !(c.type === "update" ? typeof c.unified_diff === "string" : (c.type === "add" || c.type === "delete") && typeof c.content === "string"))) return null;
  } else return null;
  const params = { ...p };
  // Request identity is recorded separately in correlation; proposals remain part of the operation.
  for (const field of ["threadId", "turnId", "itemId", "callId", "startedAtMs"]) delete params[field];
  const stable = (v: any): any => Array.isArray(v) ? v.map(stable) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
  try {
    return createHash("sha256").update(JSON.stringify(stable({method:req.method,params,changes:req.observedItem?.changes.map(c => ({...c,fullDiffDigest:c.fullDiffDigest ?? null})) ?? null}))).digest("hex");
  } catch { return null; }
}

export interface FolderSessionGrant { requestId: string; delivery: { owner_id: string; chat_id: string; message_id: number } }
/** Local memory never emits native session approval or writes execpolicy. */
export class FolderSessionApprovals {
  private grants = new Map<string, Map<string, FolderSessionGrant>>();
  private key(agentId: string, req: ApprovalRequest): string | null {
    const digest = folderOperationDigest(req);
    return digest && typeof req.params.threadId === "string" ? JSON.stringify([agentId,req.params.threadId,digest]) : null;
  }
  get(agentId: string, req: ApprovalRequest): FolderSessionGrant | undefined {
    const key = this.key(agentId,req);
    return key ? this.grants.get(agentId)?.get(key) : undefined;
  }
  has(agentId: string, req: ApprovalRequest): boolean { return Boolean(this.get(agentId,req)); }
  remember(agentId: string, req: ApprovalRequest, grant?: FolderSessionGrant): boolean {
    const key = this.key(agentId,req);
    if (!key || !grant) return false;
    const grants = this.grants.get(agentId) ?? new Map<string, FolderSessionGrant>();
    if (grants.size >= 1000) grants.delete(grants.keys().next().value!);
    grants.set(key,structuredClone(grant)); this.grants.set(agentId,grants); return true;
  }
  clear(agentId: string): void { this.grants.delete(agentId); }
}
