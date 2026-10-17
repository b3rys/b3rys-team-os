// audit 기록만으로는 알림이 전달되지 않아 message 경로가 필요하다. 부팅 중 일시 누락은 무시하고 지속·회복 전이에만 알리며 실패가 health 워커를 중단하지 않게 한다.
import type { Database } from "bun:sqlite";
import type { AgentRecord } from "../types";
import { appendAudit } from "../db/queries";
import { ensureThread, insertMessage } from "../db/inbox/messages";

/** 알림 전까지 연속으로 미충족이 유지돼야 하는 tick 수. 기본 3 (30s tick → 약 90초). */
export const OP_NOTICE_AFTER_TICKS = Number(process.env.OP_NOTICE_AFTER_TICKS ?? 3);

const RESERVED = new Set(["user", "system", "moderator", "broadcast"]);

// 고장난 본인을 제외하고 coordinator를 우선한다. 수신자도 장애 상태일 수 있으며 후보가 없으면 audit만 남긴다.
export function pickOpNoticeRecipient(
  agents: AgentRecord[],
  affectedId: string,
): string | null {
  const eligible = agents.filter((a) => a.id !== affectedId && !RESERVED.has(a.id));
  const coordinator = eligible.find((a) => (a.capabilities ?? []).includes("coordinator"));
  return coordinator?.id ?? eligible[0]?.id ?? null;
}

/**
 * op 상황 메시지를 message 테이블에 적재한다(source:'system').
 * POST /api/system-message 와 다른 경로다 — 저쪽은 OP_MESSAGE_TOKEN 미설정 시 503(safe-by-default,
 * 외부 노출 표면 0)이라 서버 내부 워커가 쓸 수 없다. 내부 워커는 tasks.ts notifyCardOwner 와 같은
 * 직접 insert 경로를 쓴다(기존 선례와 동일 계약).
 * @returns 적재된 message id, 실패·수신자 없음이면 null
 */
export function emitOpNotice(
  db: Database,
  opts: { to: string; body: string; threadKey: string; priority?: "low" | "normal" | "high" },
): string | null {
  try {
    const exists = db.prepare(`SELECT id FROM agent WHERE id = ?`).get(opts.to);
    if (!exists) return null; // registry 에 없는 id — 깨울 대상이 없다
    const { thread_id } = ensureThread(db, {
      thread_id: opts.threadKey,
      from_agent_id: "system",
      to_agent_id: opts.to,
      type: "dm",
      body: opts.body,
    });
    const stored = insertMessage(db, {
      from_agent_id: "system",
      to_agent_id: opts.to,
      type: "dm",
      body: opts.body,
      source: "system",
      // reply_to 를 비워두지 않는다 — notifyCardOwner 주석의 교훈: 받는 쪽이 'system 에게 답해라'
      //   로 읽으면 --to system = 블랙홀이 된다. op 알림은 답장 대상이 아니라 행동 지시 이므로
      // 수신자가 팀장님께 직보하도록 본문에서 명시한다.
      meta: { op_notice: true, no_wake: true },
      hop_count: 0,
      priority: opts.priority ?? "high",
      thread_id,
    });
    return stored.id;
  } catch (e) {
    console.error("[health] op notice insert failed:", (e as Error).message);
    return null;
  }
}

/** 미충족 연속 tick 추적 + 알림 1회 발행을 담당하는 상태기. 워커가 tick 마다 호출한다. */
export class EssentialsOpNotifier {
  private streak = new Map<string, number>();
  private notified = new Set<string>();
  /** 멤버별 첫 미충족 관측 시각(ms) — 본문에 쓸 실경과를 계산하려면 이게 필요하다. */
  private firstSeen = new Map<string, number>();

  constructor(
    private readonly afterTicks: number = OP_NOTICE_AFTER_TICKS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * 한 멤버의 이번 tick 결과를 넣는다.
   * @returns 발행할 알림 종류 — "down" | "recovered" | null(아무것도 안 함)
   */
  observe(agentId: string, missing: string[] | null): "down" | "recovered" | null {
    if (missing && missing.length > 0) {
      const n = (this.streak.get(agentId) ?? 0) + 1;
      this.streak.set(agentId, n);
      if (!this.firstSeen.has(agentId)) this.firstSeen.set(agentId, this.now());
      if (n >= this.afterTicks && !this.notified.has(agentId)) {
        this.notified.add(agentId);
        return "down";
      }
      return null;
    }
    // 정상 — 부팅 중 잠깐 미충족이었다면 조용히 리셋(오탐 억제).
    this.streak.delete(agentId);
    this.firstSeen.delete(agentId);
    if (this.notified.has(agentId)) {
      this.notified.delete(agentId);
      return "recovered";
    }
    return null;
  }

  /** 현재 미충족 연속 tick (테스트·디버그용) */
  streakOf(agentId: string): number {
    return this.streak.get(agentId) ?? 0;
  }

  // tick은 실행 중 건너뛸 수 있어 횟수×간격이 실제 대기시간과 다르다. 첫 미충족 이후의 실경과 초를 사용한다.
  elapsedSecOf(agentId: string): number {
    const t0 = this.firstSeen.get(agentId);
    if (t0 == null) return 0;
    return Math.max(0, Math.round((this.now() - t0) / 1000));
  }
}

function teamBase(): string {
  return (process.env.TEAM_BASE_URL ?? "http://127.0.0.1:7878/team").replace(/\/$/, "");
}

/** 사람이 읽고 바로 조치할 수 있는 본문. 조치 명령까지 실어 보낸다. */
export function buildEssentialsDownBody(opts: {
  agentId: string;
  runtime: string;
  missing: string[];
  elapsedSec: number;
}): string {
  return [
    `[team op] ${opts.agentId} 가 ${Math.round(opts.elapsedSec)}초째 필수 런타임 항목이 없습니다 — 메시지를 못 받는 상태일 수 있습니다.`,
    `  runtime : ${opts.runtime}`,
    `  missing : ${opts.missing.join(", ")}`,
    ``,
    `조치 — 서버의 재시작 API 로 다시 띄운다(작업 폴더·대화 기록 유지):`,
    `  curl -s -X POST ${teamBase()}/api/members/${opts.agentId}/restart -H 'content-type: application/json' -d '{"fresh":false}'`,
    `  ※ 기동 스크립트를 손으로 실행하지 마세요 — 서버가 넘기는 작업 폴더·resume 설정이 없어 다른 폴더에서 대화 기록 없이 새로 뜹니다.`,
    `확인: 응답 detail 에 'poller 기동 확인' 또는 'poller 복구' 가 있고, 1분 안에 이 스레드로 '정상으로 돌아왔습니다' 회복 알림이 오면 복구된 것입니다.`,
    ``,
    `확인 후 팀장님께 직접 보고해 주세요(이 알림은 system 발신이라 회신 대상이 없습니다).`,
  ].join("\n");
}

/** 회복 알림 — 앞서 down 을 보냈을 때만 나간다. */
export function buildEssentialsRecoveredBody(agentId: string): string {
  return `[team op] ${agentId} 필수 런타임 항목이 정상으로 돌아왔습니다. 앞서 보낸 down 알림은 해소된 것으로 보면 됩니다.`;
}

/** audit 기록 — 알림이 실제로 나갔는지(또는 못 나갔는지)를 남긴다. */
export function auditOpNotice(
  db: Database,
  action: "op_notice_sent" | "op_notice_no_recipient",
  subject: string,
  detail: Record<string, unknown>,
): void {
  try {
    appendAudit(db, "health", action, subject, detail);
  } catch {
    /* best-effort */
  }
}
