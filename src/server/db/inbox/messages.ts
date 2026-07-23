import type { Database } from "bun:sqlite";
import { nanoid } from "nanoid";
import type { EnvelopeInbound, EnvelopeStored } from "../../../shared/envelopeSchema";
import { MAX_HOPS_DEFAULT } from "../../../shared/envelopeSchema";
import { type MessageRow, type ThreadRow, rowToEnvelope } from "./_shared";
import { appendAuditFile } from "../../lib/auditFile";
import { applyAckClose, applyActivityAutoAck } from "../../bus/ackClose";

export function ensureThread(
  db: Database,
  opts: {
    thread_id?: string;
    from_agent_id: string;
    to_agent_id: string;
    type: string;
    body: string;
  },
): { thread_id: string; created: boolean } {
  if (opts.thread_id) {
    const exists = db
      .prepare("SELECT id FROM thread WHERE id = ?")
      .get(opts.thread_id) as { id: string } | undefined;
    if (exists) return { thread_id: opts.thread_id, created: false };
  }
  const id = opts.thread_id ?? nanoid(8);
  const title = opts.body.slice(0, 80);
  const participantsRaw = [opts.from_agent_id, opts.to_agent_id].filter(
    (a) => a !== "broadcast" && a !== "system",
  );
  const participants = Array.from(new Set(participantsRaw));
  const kind =
    opts.type === "broadcast" || opts.to_agent_id === "broadcast"
      ? "broadcast"
      : opts.type.startsWith("meeting")
        ? "meeting"
        : "dm";
  db.prepare(
    `INSERT INTO thread (id, title, kind, participants_json, opened_by, last_message_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
  ).run(id, title, kind, JSON.stringify(participants), opts.from_agent_id);
  return { thread_id: id, created: true };
}

export function insertMessage(
  db: Database,
  env: EnvelopeInbound & { thread_id: string; explicit_recipients?: string[] },
): EnvelopeStored {
  const id = nanoid(12);
  const attachments_json = env.attachments ? JSON.stringify(env.attachments) : null;
  const meta_json = env.meta ? JSON.stringify(env.meta) : null;
  // v1.2 issue 3 (anti-pingpong fix): parent_message_id is used by countAutoRounds to
  // trace the bot↔bot chain. Previously it was left NULL when agents only set in_reply_to.
  // We now derive parent_message_id from in_reply_to when not explicitly set: agents that
  // follow the skill convention (set in_reply_to) will automatically build the chain.
  // Explicit parent_message_id in the envelope takes precedence (if caller sets both).
  const parentMessageId = (env as Record<string, unknown>).parent_message_id as string | null | undefined
    ?? env.in_reply_to
    ?? null;

  // ★★서버는 팀원이 쓴 주소를 고치지 않는다. 기록만 한다.★★ (GD 2026-07-14)
  //
  //   ★GD:★ "보정을 하면 안된다니깐.. 근본이 아니잖아. 그냥 기록만 추가하고 삭제해.
  //          보정 자체가 룰대로 동작을 안한건데.. 그걸 다른 반창고로 자꾸 덮으려는 그 접근을 바꿔."
  //
  //   ═══ 예전 (2026-06-05 ~ 2026-07-14) ═══
  //   팀원이 1:1 질문에 `--to broadcast` 로 답하면 서버가 ★몰래 원 요청자에게 되돌려★ 저장했다.
  //   30일 98건이 그렇게 고쳐졌는데 ★감사로그엔 한 줄도 없었다.★
  //   → 누가 주소를 틀리는지 볼 수가 없었고, ★6주 동안 아무도 hermes 가 틀린다는 걸 몰랐다.★
  //   → 그 사이 진짜 원인(주입문이 "팀장께 답하라" 라고 시킴)은 ★그대로 살아 있었다.★
  //   → 그리고 그 보정이 오늘 ★유출★ 까지 낳았다 (DB엔 1:1 로 적히는데 릴레이는 방에 띄움).
  //
  //   ★반창고가 근본을 가리고, 그 위에 또 반창고가 붙었다.★
  //
  //   ═══ 지금 ═══
  //   주소가 틀리면 ★그대로 둔다.★ 대신 ★기록한다.★
  //   · 틀린 답은 방(broadcast)에 뜬다 → ★보인다.★ 조용히 사라지지 않는다.
  //   · 로그에 누가·언제·어느 스레드가 남는다 → ★그 런타임의 주입문을 고친다.★
  //   ★서버 코드가 아니라 룰(주입문)이 고쳐져야 한다.★ 그래야 다시 안 틀린다.
  //
  //   (근본은 2026-07-14 에 고쳤다: 주입문이 답 주소를 ★호출부가 준 사실 그대로★ 한 줄로 말한다.
  //    98건 중 96건이 hermes_agent 였고 그 주입문을 고쳤다 → 이 로그는 ★0 에 수렴해야 한다.★)
  //
  //   ★서버는 추측하지 않는다. 모델이 말한 사실만 쓴다.★ (GD 2026-07-14)
  //
  //   한 번 ★폴백을 넣었다가 데이터가 죽였다★: "--in-reply-to 가 3~4할만 붙는다" 는 게 걱정돼서,
  //   없으면 ★"이 스레드에서 이 사람에게 1:1 로 온 질문"★ 을 찾아 상관지으려 했다.
  //   그건 ★조회처럼 보이지만 사실은 추측★ 이었다 — "그 broadcast 는 그 질문의 답일 것이다".
  //   ★실측이 반증했다★ (30일): 폴백이 잡았을 3건 = ★전부 오탐★ (codex 의 정당한 팀 리뷰 요청).
  //   오탐률 ★100%★. 계기판이 아니라 ★노이즈 생성기★ 였다. → 삭제.
  //
  //   ★남긴 것 = 모델이 스스로 "이건 X 에 대한 답이다" 라고 말한 경우뿐이다.★ 그건 사실이다.
  //   실측(30일) 이 경로가 잡는 진짜 오배송: hermes 30 · dex 2 · ames 1 = ★33건, 오탐 0.★
  //   3~4할이 --in-reply-to 를 안 달고 온다 → 그건 ★룰(스킬)을 고쳐서★ 해결한다. 서버가 메꾸지 않는다.
  //   (안 달고 온 오배송도 ★방에 뜬다 = 보인다.★ 로그에 귀속만 안 될 뿐 조용히 사라지지 않는다.)
  if (env.in_reply_to && (env.to_agent_id === "broadcast" || env.type === "broadcast")) {
    const orig = db
      .prepare(`SELECT from_agent_id, to_agent_id FROM message WHERE id = ?`)
      .get(env.in_reply_to) as { from_agent_id: string; to_agent_id: string } | undefined;
    const RESERVED_TARGETS = new Set(["user", "system", "moderator", "broadcast"]);
    if (orig && orig.to_agent_id === env.from_agent_id && !RESERVED_TARGETS.has(orig.from_agent_id)) {
      appendAuditFile(env.from_agent_id, "reply_address_wrong", env.in_reply_to, {
        sent_to: "broadcast",
        should_be: orig.from_agent_id, // 1:1 로 물어본 사람 — 답은 여기로 갔어야 한다
        thread_id: env.thread_id,
        note: "서버가 고치지 않는다. 이 런타임의 주입문/룰을 고칠 것.",
      });
    }
  }

  db.prepare(
    `INSERT INTO message
       (id, thread_id, from_agent_id, to_agent_id, type, body, source, hop_count,
        in_reply_to, parent_message_id, delivery_status, retry_count, expires_at, priority, sync, dedupe_key,
        attachments_json, meta_json, max_hop)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'delivered', 0, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    env.thread_id,
    env.from_agent_id,
    env.to_agent_id,
    env.type ?? "dm",
    env.body,
    env.source ?? "agent",
    env.hop_count ?? 0,
    env.in_reply_to ?? null,
    parentMessageId,
    env.expires_at ?? null,
    env.priority ?? "normal",
    (env as { sync?: string }).sync ?? "none",
    env.dedupe_key ?? null,
    attachments_json,
    meta_json,
    (env as { max_hop?: number }).max_hop ?? MAX_HOPS_DEFAULT, // hop cap 명시(컬럼 default 5 대신 16) — 정당한 다단계/handoff 차단 방지
  );
  // Broadcast fan-out: keep one message row (to_agent_id='broadcast') for the thread/audit
  // view, plus a per-recipient row in message_recipient so the broadcast lands in each
  // agent's inbox with independent read tracking. inboxFor filters by to_agent_id, so
  // without this a broadcast reaches no inbox (observed 2026-05-25: a team broadcast was
  // never delivered to anyone).
  // If explicit_recipients is provided (e.g. from router decision), only those agents get
  // a recipient row. Otherwise, fall back to all registered agents except the sender.
  if (env.to_agent_id === "broadcast" || env.type === "broadcast") {
    // user/telegram messages are delivered directly by the telegram channel, not woken by the
    // bus dispatcher — mark their recipient rows 'completed' on insert so they never pile up as
    // stale 'pending' (2026-05-30). inboxFor() filters by read_at (not delivery_state), so inbox
    // visibility is unchanged. Agent messages stay 'pending' for the dispatcher to deliver.
    const rcptState = env.source === "user" && !env.dispatch ? "completed" : "pending";
    // broadcast complete 로직 (GD 2026-06-22): broadcast(@all/announce)는 FYI다 — 비응답자도 inbox에
    // 영구 'open'(action-required)으로 쌓이면 안 됨(개별 응답은 선택). 그래서 수신행을 'acknowledged'
    // (close_reason='broadcast_fyi')로 생성해 InboxView action-required(=open/needs_match_review)에서 제외.
    // 깨우기(wake)는 delivery_state로 굴러가니 영향 없고, directed/@멘션 = 응답필요는 그대로 'open' 유지.
    const insertRcpt = db.prepare(
      `INSERT OR IGNORE INTO message_recipient (message_id, agent_id, delivery_state, recipient_state, close_reason, state_source)
       VALUES (?, ?, ?, 'acknowledged', 'broadcast_fyi', 'system')`,
    );
    if (env.explicit_recipients && env.explicit_recipients.length > 0) {
      for (const agentId of env.explicit_recipients) {
        if (agentId !== env.from_agent_id) insertRcpt.run(id, agentId, rcptState);
      }
    } else {
      const recipients = db
        .prepare(`SELECT id FROM agent WHERE id != ?`)
        .all(env.from_agent_id) as Array<{ id: string }>;
      for (const a of recipients) insertRcpt.run(id, a.id, rcptState);
    }
  } else {
    // Team Bus v1: also insert a message_recipient row for direct (non-broadcast) messages
    // so the wake dispatcher can detect and dispatch them. Only for known agents
    // (not 'user', 'system', 'moderator', 'broadcast').
    const RESERVED = new Set(["user", "system", "moderator", "broadcast"]);
    if (!RESERVED.has(env.to_agent_id)) {
      const agentExists = db
        .prepare(`SELECT id FROM agent WHERE id = ?`)
        .get(env.to_agent_id) as { id: string } | undefined;
      if (agentExists) {
        // see rcptState note above — user msgs are completed-on-insert, agent msgs stay pending.
        // ★direct_to_gd 보고는 ingress [B] 릴레이(inbox.ts:275)가 이미 GD DM 에 배달한다★ → 수신자(to_agent_id)를
        //   ★또 깨우지 않는다★('completed' 로 삽입 = wake 후보 자체가 안 생김). 안 그러면 ①이중배달 +
        //   ②N건이 한 수신자로 몰리면 그 수신자가 릴레이하며 ★병합★ (steve 개별보고 2건 병합, 2026-07-16
        //   하네스 2대 검증). 2026-07-15 프로토콜 게이트로 direct_to_gd 는 무조건 '답'(in_reply_to 有)이라
        //   ingress 가 항상 배달 → 옛 case-6 수신자-릴레이는 순수 잉여. (수집 기여자 답은 plain 이라 무영향)
        const isDirectToGd = (env.meta as { reply_mode?: string } | undefined)?.reply_mode === "direct_to_gd";
        const directState = (env.source === "user" && !env.dispatch) || isDirectToGd ? "completed" : "pending";
        db.prepare(
          `INSERT OR IGNORE INTO message_recipient (message_id, agent_id, delivery_state) VALUES (?, ?, ?)`,
        ).run(id, env.to_agent_id, directState);
      }

    }
  }
  // 자동 ack-close (SLG cycle1 A, 2026-06-13): 2026-06-10 naive 버전 교체.
  // OLD: agent reply 면 *내용불문* 원본 recipient 를 delivery_state='completed' 로 박음 →
  //      ack-only '네 볼게요'·되묻기까지 '완료'로 오독 = false-green 생산자.
  // NEW: reply 를 분류(ack_only/substantive/explicit_done) + 매칭(in_reply_to>task_link>thread)
  //      후 semantic recipient_state 로만 전이. delivery_state(transport)는 안 건드림 —
  //      reply 만으론 completed 안 됨(명시 완료의도/task done 만 completed). audit 동반.
  if (env.source === "agent") {
    // 1) explicit reply → targeted recipient_state transition (in_reply_to/task match).
    applyAckClose(db, {
      id,
      from_agent_id: env.from_agent_id,
      body: env.body,
      thread_id: env.thread_id,
      in_reply_to: env.in_reply_to ?? null,
      source: env.source,
      type: env.type ?? "dm",
    });
    // 2) Inbox-refined: the sender just showed activity → auto-ack their OTHER stale 'open'
    //    received rows as 'activity_assumed' (silent-ack / answered-out-of-band cleanup),
    //    distinct from the real reply above. The message handled in step 1 is no longer
    //    'open', so the recipient_state='open' filter excludes it naturally.
    applyActivityAutoAck(db, env.from_agent_id, id);
  }
  db.prepare("UPDATE thread SET last_message_at = datetime('now') WHERE id = ?").run(env.thread_id);
  const row = db
    .prepare(`SELECT * FROM message WHERE id = ?`)
    .get(id) as MessageRow;
  return rowToEnvelope(row);
}

export function inboxFor(db: Database, agent_id: string, limit = 50): EnvelopeStored[] {
  // Direct messages addressed to the agent (unread) + broadcasts delivered to the agent
  // via message_recipient (unread per-agent). The latter is how team broadcasts reach an
  // individual inbox — see the fan-out in insertMessage.
  // 받는이-단일화 (2026-06-13 GD 데이터모델 정리): inbox 멤버십은 message_recipient(받는이 테이블)
  // 하나로만 판정한다. 1:1(N=1)·단체(N>1) 모두 받는이 행으로 통일 — message-level read_at 분기는
  // 중복이라 제거(1:1 도 결국 받는이 1행). directed-to-agent 메시지는 전부 받는이 행을 갖는다
  // (insertMessage 가 신규 생성 + directedRecipientRowBackfill 이 옛 메시지 보정).
  const rows = db
    .prepare(
      `SELECT m.* FROM message m
       WHERE m.id IN (SELECT message_id FROM message_recipient WHERE agent_id = ? AND read_at IS NULL)
       ORDER BY m.created_at DESC
       LIMIT ?`,
    )
    .all(agent_id, limit) as MessageRow[];
  return rows.map(rowToEnvelope);
}

export function markRead(db: Database, message_id: string, agent_id?: string): boolean {
  // For a broadcast, "read" is per-agent: mark this agent's message_recipient row.
  // (Caller passes agent_id; falls through to the message-level read for direct messages.)
  // 받는이-단일화 (2026-06-13 GD): agent 의 읽음은 message_recipient(받는이 행)에만 기록한다.
  // inboxFor 가 받는이 행만 보므로 message-level read_at 동기화는 불필요(직전 잔류-fix 패치 제거).
  if (agent_id) {
    const rc = db
      .prepare(
        `UPDATE message_recipient SET read_at = datetime('now')
         WHERE message_id = ? AND agent_id = ? AND read_at IS NULL`,
      )
      .run(message_id, agent_id);
    if (rc.changes > 0) return true;
    // 받는이 행이 없는 경우(예: user/system 같은 예약 대상 메시지)만 아래 message-level 로 폴백.
  }
  const result = db
    .prepare(`UPDATE message SET read_at = datetime('now') WHERE id = ? AND read_at IS NULL`)
    .run(message_id);
  return result.changes > 0;
}

/**
 * owner-gate 훅이 telegram message_id 로 capture 의 라우팅 결정(reason/targets)을 조회.
 * capture 가 적재한 그룹 메시지 meta.route 를 그대로 반환 → reply/sticky 까지 반영된 결정 재사용
 * (빌 경로 A의 reply-blindness 보완). 아직 적재 전이면 null(호출측이 재시도/폴백).
 */
export function findRouteByTgMessageId(
  db: Database,
  tgMessageId: string,
): { reason: string; targets: string[] } | null {
  const rows = db
    .prepare(
      `SELECT meta_json FROM message WHERE from_agent_id = 'user' AND meta_json LIKE ? ORDER BY created_at DESC LIMIT 5`,
    )
    .all(`%"message_id":"${tgMessageId}"%`) as Array<{ meta_json: string | null }>;
  for (const r of rows) {
    if (!r.meta_json) continue;
    try {
      const meta = JSON.parse(r.meta_json) as {
        telegram?: { message_id?: string };
        route?: { reason?: string; targets?: string[] };
      };
      if (meta.telegram?.message_id === tgMessageId && meta.route) {
        return { reason: meta.route.reason ?? "", targets: meta.route.targets ?? [] };
      }
    } catch {
      // ignore parse errors
    }
  }
  return null;
}

/**
 * Phase 2b: find Slack metadata for a thread by scanning its messages for the first
 * envelope carrying meta.slack (set by the Slack adapter when the thread was created).
 */
export function findSlackMetaForThread(
  db: Database,
  thread_id: string,
): { channel: string; thread_ts: string } | null {
  const rows = db
    .prepare(
      `SELECT meta_json FROM message WHERE thread_id = ? AND meta_json IS NOT NULL ORDER BY created_at ASC`,
    )
    .all(thread_id) as Array<{ meta_json: string }>;
  for (const r of rows) {
    try {
      const meta = JSON.parse(r.meta_json) as { slack?: { channel?: string; thread_ts?: string } };
      const ch = meta?.slack?.channel;
      const ts = meta?.slack?.thread_ts;
      if (ch && ts) return { channel: ch, thread_ts: ts };
    } catch {
      // ignore parse errors
    }
  }
  return null;
}

export function getThread(db: Database, thread_id: string): {
  thread: ThreadRow;
  messages: EnvelopeStored[];
} | null {
  const thread = db.prepare(`SELECT * FROM thread WHERE id = ?`).get(thread_id) as ThreadRow | undefined;
  if (!thread) return null;
  const rows = db
    .prepare(`SELECT * FROM message WHERE thread_id = ? ORDER BY created_at ASC`)
    .all(thread_id) as MessageRow[];
  return { thread, messages: rows.map(rowToEnvelope) };
}

/**
 * 공유 스레드의 최근 메시지 (가시성 Stage C) — 최근 limit건, sinceHours 이내, 시간순(오래된→최신).
 * injection 시 깨어나는 에이전트에게 동봉할 '팀 버스 맥락'으로 사용.
 */
export function recentThreadMessages(
  db: Database,
  thread_id: string,
  limit = 10,
  sinceHours = 6,
): EnvelopeStored[] {
  const rows = db
    .prepare(
      `SELECT * FROM message
       WHERE thread_id = ? AND created_at > datetime('now','-${sinceHours} hours')
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(thread_id, limit) as MessageRow[];
  return rows.map(rowToEnvelope).reverse();
}
