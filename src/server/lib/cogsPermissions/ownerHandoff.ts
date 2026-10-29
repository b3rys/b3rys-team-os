import type { Database } from "bun:sqlite";
import { decodeCogsOwner, fetchCogsOwner } from "./owner";
import { createCogsApproval, getBinding, handOffCogsApproval } from "./approvals";

/** Fresh getMe immediately precedes the synchronous claim. No cross-server lock is implied. */
export async function handOffWithCogsOwner(
  db: Database,
  input: Omit<Parameters<typeof handOffCogsApproval>[1], "currentOwner" | "currentOwnerUserId" | "nowMs" | "currentStamp">,
  transport: {apiBase: string; token: string; fetchFn?: typeof fetch; now?: () => number; currentStamp: () => string | null},
): Promise<boolean> {
  const issued = decodeCogsOwner(getBinding(db, input.requestId)?.owner_binding_json);
  const owner = await fetchCogsOwner(transport.apiBase, transport.token, issued, transport.fetchFn);
  return handOffCogsApproval(db, {...input, currentOwner: owner, currentOwnerUserId: owner?.userId,
    nowMs: (transport.now ?? Date.now)(), currentStamp: transport.currentStamp()});
}

/** Capture ownership at issuance; callback snapshots must never replace it. */
export async function createApprovalWithCogsOwner(
  db: Database,
  input: Omit<Parameters<typeof createCogsApproval>[1], "owner" | "nowMs" | "policyStamp">,
  transport: {apiBase: string; token: string; fetchFn?: typeof fetch; now?: () => number; currentStamp: () => string | null},
) {
  const owner = await fetchCogsOwner(transport.apiBase, transport.token, undefined, transport.fetchFn);
  const policyStamp = transport.currentStamp();
  if (!owner || !policyStamp) return null;
  return createCogsApproval(db, {...input, owner, policyStamp, nowMs: (transport.now ?? Date.now)()});
}
