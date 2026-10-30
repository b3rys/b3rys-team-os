import { createHash } from "node:crypto";
import type { ApprovalRequest } from "./appServerClient";

/** Some CLI command requests offer accept/cancel but no acceptForSession.
 * Remember only the exact request within this member's thread, without writing execpolicy rules. */
export class FolderSessionApprovals {
  private grants = new Map<string, Set<string>>();
  private key(req: ApprovalRequest): string | null {
    if (req.method !== "item/commandExecution/requestApproval" || typeof req.params.threadId !== "string") return null;
    const available = req.params.availableDecisions;
    if (!Array.isArray(available) || available.includes("acceptForSession") || !available.includes("accept")) return null;
    const params = { ...req.params };
    for (const field of ["turnId", "itemId", "startedAtMs", "availableDecisions", "proposedExecpolicyAmendment"]) delete params[field];
    const stable = (value: any): any => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
    return createHash("sha256").update(JSON.stringify(stable({method:req.method,params}))).digest("hex");
  }
  has(agentId: string, req: ApprovalRequest): boolean {
    const key = this.key(req);
    return key !== null && Boolean(this.grants.get(agentId)?.has(key));
  }
  remember(agentId: string, req: ApprovalRequest): boolean {
    const key = this.key(req);
    if (key === null) return false;
    const grants = this.grants.get(agentId) ?? new Set<string>();
    // Bounded memory; evicting requires asking again, never widens permission.
    if (grants.size >= 1000) grants.delete(grants.values().next().value!);
    grants.add(key); this.grants.set(agentId, grants);
    return true;
  }
  clear(agentId: string): void { this.grants.delete(agentId); }
}
