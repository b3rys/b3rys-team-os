/**
 * 시험용 가짜 브리지 — 별도 프로세스로 뜬다(waitersIpc.test.ts).
 * 실제 bridge window + 실제 승인 대기를 격리 DB 로 돌리고, 결과를 stdout 한 줄(JSON)씩 낸다.
 * 인자: dbPath pidFile agentId processGen requestId[,requestId...]
 */
import { openDb } from "../../db/migrate";
import { startBridgeWindow } from "../../runtimes/codex/bridgeWindow";
import { createBridgeCogsApprovals } from "./waiters";

const [dbPath, pidFile, agentId, processGen, ids] = process.argv.slice(2);
const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);

const approvals = createBridgeCogsApprovals({ agentId: agentId!, openDb: () => openDb(dbPath!), processGen: processGen!, expirySlackMs: 20, report: (m) => out({ log: m }) });
let controls = 0;
const handle = await startBridgeWindow({
  agentId: agentId!,
  pidFile: pidFile!,
  enqueue: () => out({ unexpected: "turn" }),
  onControl: (req) => { controls++; out({ control: req.requestId ?? null, n: controls }); approvals.onControl(req); },
});
if (!handle) { out({ error: "no_window" }); process.exit(1); }
for (const id of (ids ?? "").split(",").filter(Boolean)) {
  void approvals.waiters.wait(id).then((o) => out({ id, outcome: o }));
}
out({ ready: handle.port, pid: process.pid });
process.on("SIGTERM", () => { approvals.close(); handle.close(); process.exit(0); });
