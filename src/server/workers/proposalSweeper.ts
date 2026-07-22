// Proposal 정체 안전망 워커 (OWNER 2026-07-04) — 담당자 무응답으로 파이프라인이 멈추지 않게
// 주기적으로 정체 제안을 시스템이 스스로 진행시킨다. 핵심 로직 = routes/proposals.ts sweepStaleProposals.
//   - 5분 tick, 부팅 직후 30초 지연(재시작 thundering herd 방지).
//   - 한 tick 처리량은 sweepStaleProposals 내부 LIMIT 로 제한.
import type { Database } from "bun:sqlite";
import { sweepStaleProposals } from "../routes/proposals";
import { ambientAgents } from "../lib/registry";

const POLL_INTERVAL_MS = 5 * 60_000;
const INITIAL_DELAY_MS = 30_000;

export function startProposalSweeper(db: Database): () => void {
  const tick = (): void => {
    try {
      const r = sweepStaleProposals(db, ambientAgents());
      if (r.advanced.length || r.reassigned.length || r.degraded.length) {
        console.log(
          `[proposalSweeper] advanced=${r.advanced.length} reassigned=${r.reassigned.length} degraded=${r.degraded.length}`,
        );
      }
    } catch (e) {
      console.error("[proposalSweeper] tick failed:", e);
    }
  };
  const startTimer = setTimeout(tick, INITIAL_DELAY_MS);
  const interval = setInterval(tick, POLL_INTERVAL_MS);
  return () => {
    clearTimeout(startTimer);
    clearInterval(interval);
  };
}
