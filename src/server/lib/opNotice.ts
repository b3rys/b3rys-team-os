// team op(시스템) 상황 알림 — health 워커가 "감지했는데 아무도 못 듣는" 문제를 고친다.
//
// 왜 필요했나 (2026-07-30 실측 사고):
//   08:03:37 health 가 `runtime_essentials_missing | lisa | missing:["poller:claude bot.pid"]` 를
//   정확히 잡았다. 그런데 healthCheck 는 appendAudit 으로 ★audit_event 테이블에만★ 썼다.
// message 테이블에 아무것도 안 넣으므로 팀장님 텔레그램·그룹방·팀원 누구에게도 안 갔고,
// 리사는 28분간 무응답이었다. 팀장님이 직접 "리사가 응답이 없어" 라고 알려줘야 했다.
//   → 감지는 되어 있었다. 없던 건 ★알림 경로★ 다. 이 모듈이 그 경로다.
//
// 설계 원칙
//   1) ★부팅 오탐을 내지 않는다★ — 부팅 직후엔 정상 멤버도 poller 가 잠깐 없다(실측: jane 도
//      08:03:37 에 같은 항목이 잡혔고 34초 뒤 스스로 회복). 그래서 연속 N tick 유지될 때만 알린다.
//   2) ★알림은 살아있는 사람에게 간다★ — 고장난 멤버 본인에게 보내면 블랙홀이다(그 멤버가 못 듣는
//      상태가 바로 사고). coordinator 우선, 없으면 다른 아무 멤버.
//   3) ★상태 전이에만 1회★ — 매 tick 반복 알림 금지(스팸). 회복도 1회 알린다.
//   4) ★best-effort★ — 알림 실패가 health 워커를 절대 죽이지 않는다.
import type { Database } from "bun:sqlite";
import type { AgentRecord } from "../types";
import { appendAudit } from "../db/queries";
import { ensureThread, insertMessage } from "../db/inbox/messages";

/** 알림 전까지 연속으로 미충족이 유지돼야 하는 tick 수. 기본 3 (30s tick → 약 90초). */
export const OP_NOTICE_AFTER_TICKS = Number(process.env.OP_NOTICE_AFTER_TICKS ?? 3);

const RESERVED = new Set(["user", "system", "moderator", "broadcast"]);

/**
 * op 알림을 받을 멤버를 고른다 — ★단순 규칙: coordinator 우선, 없으면 등록 순서 첫 멤버★.
 *   고장난 본인만 제외한다(못 듣는 상태가 사고 본체이므로 블랙홀 방지).
 *   받을 사람이 아무도 없으면 null → 호출부는 audit 만 남긴다.
 *
 * ★가중치 방식을 쓰지 않는다 — 팀장님 결정(2026-07-30)★
 *   한때 점수제(down 여부 +4 / coordinator +2 / 다른 런타임 +1)를 넣었다. 동기는 리사 리뷰 R4 였다:
 *   근본 경합(bun binlink)은 lisa·jane 사이에서 대칭이라 둘이 동시에 탈락할 수 있고(08:03:37 실측),
 *   그러면 알림이 죽은 쪽으로 들어가 아무도 못 읽는다. 그래서 다른 런타임(clo·herm)을 폴백으로
 *   선호하게 만들었다.
 * 그런데 그 점수제가 ★coordinator 기본 라우팅을 뒤집는 사고★ 를 냈고(B1), 팀장님이
 *   "coordinator 기본은 건드리지 마라 / lisa 가 죽으면 jane 으로, 그냥 원래대로 가라" 로 정리했다.
 *   ★알려진 트레이드오프★: lisa·jane 이 ★동시에★ 죽으면 알림이 죽은 jane 에게 가서 아무도 못 읽는다.
 * 팀장님이 이 경우를 직접 처리하겠다고 명시했다("정 안되면 내가 처리하면 돼"). 그래서 단순 규칙이
 * 의도된 동작이며, 이걸 '버그' 로 보고 점수제를 되살리지 마라 — 되살리려면 팀장님 승인이 필요하다.
 */
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
 * ★POST /api/system-message 와 다른 경로다★ — 저쪽은 OP_MESSAGE_TOKEN 미설정 시 503(safe-by-default,
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
      // ★reply_to 를 비워두지 않는다★ — notifyCardOwner 주석의 교훈: 받는 쪽이 'system 에게 답해라'
      //   로 읽으면 --to system = 블랙홀이 된다. op 알림은 답장 대상이 아니라 ★행동 지시★ 이므로
      // 수신자가 팀장님께 직보하도록 본문에서 명시한다.
      meta: { op_notice: true },
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
  /** 멤버별 ★첫 미충족 관측 시각(ms)★ — 본문에 쓸 실경과를 계산하려면 이게 필요하다. */
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

  /**
   * ★첫 미충족 관측 이후 실제 경과 초★.
   * afterTicks × interval 로 계산하면 ★항상 90★ 이 나오는데, tick 에 `if (ticking) return` 가드가
   * 있어 스킵된 tick 동안 streak 는 안 늘고 실경과는 더 길다. 특히 autofix 가 restartAgent 를
   * await 하며 최대 (acquire + settle)초를 잡으면 그 사이 tick 이 통째로 드롭된다.
   * 틀린 수치는 사람에게 ★오보★ 로 읽히므로 실측값을 쓴다. (리사 리뷰 N3, 2026-07-30)
   */
  elapsedSecOf(agentId: string): number {
    const t0 = this.firstSeen.get(agentId);
    if (t0 == null) return 0;
    return Math.max(0, Math.round((this.now() - t0) / 1000));
  }
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
    `조치(claude 멤버의 poller:claude bot.pid 인 경우):`,
    `  src/server/runtimes/claude/start-telegram-channel.sh ${opts.agentId} --force`,
    `  ※ --force 없이 재실행하면 'Session already running' no-op 으로 빠져 복구되지 않습니다.`,
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
