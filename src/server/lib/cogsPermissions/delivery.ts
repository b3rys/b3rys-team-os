/**
 * 서버 → 브리지 제어 신호. 서버 프로세스에서 일어난 결정·무효화·정책 변경을 그 팀원 브리지에 알린다.
 *
 * 신호는 "DB 다시 봐" 뿐이다(waiters.ts). 그래서 실패해도 안전하다 — 브리지는 만료 타이머로 결국 DB 를 본다.
 * 실패는 숨기지 않고 남긴다. 새 주기 polling 은 만들지 않는다.
 */
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import type { BridgeControlRequest } from "../../runtimes/codex/bridgeWindow";
import type { CodexBridgeControlResult } from "../codexBridgeClient";
import type { CogsPermissionEvent, CogsPermissionEvents } from "./events";

export type SendControl = (req: BridgeControlRequest) => Promise<CodexBridgeControlResult>;

export interface BridgeDeliveryDeps {
  send: SendControl;
  report?: (msg: string) => void;
}

const newEventId = () => `cev_${randomBytes(8).toString("hex")}`;

function controlFor(e: CogsPermissionEvent): BridgeControlRequest {
  const requestId = e.type === "policy_changed" ? undefined : e.request_id;
  return { agentId: e.agent_id, kind: "cogs_permission", eventId: newEventId(), ...(requestId ? { requestId } : {}) };
}

/** 이벤트마다 그 팀원 브리지에 신호 하나. 보내기는 기다리지 않는다(발신자를 막지 않는다). */
export function subscribeBridgeDelivery(events: CogsPermissionEvents, deps: BridgeDeliveryDeps): () => void {
  const report = deps.report ?? ((m: string) => console.warn(m));
  return events.on(async (e) => {
    const req = controlFor(e);
    const r = await deps.send(req);
    if (!r.ok && r.reason !== "no_window") {
      report(`[cogs-permissions] 브리지 신호 실패 agent=${req.agentId} event=${req.eventId} reason=${r.reason}${r.status ? ` status=${r.status}` : ""} attempts=${r.attempts}`);
    }
  });
}

/**
 * 서버 재시작 — 아직 대기자가 있을 수 있는 팀원 브리지마다 "전부 다시 봐" 를 보낸다. 서버가 죽어 있던 사이 신호를 놓쳤을 수 있다.
 * 대상은 상태가 아니라 기한으로 정한다: 거절·무효화로 끝난 요청도 브리지 쪽 대기는 아직 남아 있을 수 있다.
 * 브리지 대기는 만료 시각에 스스로 닫히므로, 만료 전 결합이 있는 팀원이면 충분하다.
 */
export async function pokeBridgesWithOpenApprovals(db: Database, deps: BridgeDeliveryDeps & { nowMs?: number }): Promise<number> {
  const agents = db.prepare(
    `SELECT DISTINCT agent_id FROM cogs_permission_binding WHERE handed_off_at_ms IS NULL AND expires_at_ms > ?`,
  ).all(deps.nowMs ?? Date.now()) as Array<{ agent_id: string }>;
  const results = await Promise.all(agents.map((a) => deps.send({ agentId: a.agent_id, kind: "cogs_permission", eventId: newEventId() })));
  return results.filter((r) => r.ok).length;
}
