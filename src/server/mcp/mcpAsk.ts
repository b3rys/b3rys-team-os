// MCP → 팀원에게 묻고 답을 받아오는 경로.
//
// ★새 표를 만들지 않는다★ — 방은 thread, 질문·답은 message, 짝짓기는 in_reply_to, 표시는 meta_json.
// 전부 이미 있는 칸이다(meta_json 은 실측 3,512/19,025 건이 이미 쓰고 있다).
//
// 설계 확정 근거(팀 리드 2026-08-06 · 빌·코덱스 리뷰):
//  ① 방은 사람마다 하나 — 팀원이 앞 대화를 기억해야 "직접 얘기"가 성립한다(빌).
//  ② 질문마다 번호 — 답이 어느 질문 것인지는 방이 아니라 번호가 정한다.
//  ③ ★번호 없는 답은 대기 중인 호출에 절대 붙이지 않는다★ — 그 추측이 사고의 원인이다(빌 MUST).
//  ④ 시간 초과는 ★기다림만★ 끝낸다. 요청 기록은 살아 있고 늦은 답은 원 번호에 귀속된다(코덱스).
import type { Database } from "bun:sqlite";
import { leadActorId } from "../lib/opAuth"; // ★이름만 재사용★ — 신뢰 규칙(루프백=리드)은 쓰지 않는다

/** MCP 로 들어온 질문임을 표시하는 값. 커서·클로드 코드 등 ★클라이언트 종류와 무관하게 'mcp'★. */
export const MCP_REPLY_ROUTE = "mcp";

/** thread.id 는 32자 상한이다(실측: 초과 시 send 가 실패했다). 방 이름은 그 안에 들어와야 한다. */
export const THREAD_ID_MAX = 32;

export interface AskResult {
  status: "answered" | "pending";
  /** 기다려도 안 오는 상태로 끝났을 때의 사유(막힘·배달실패·만료). 정상 시간 초과면 없다. */
  stuckReason?: string;
  /** 질문 message id = 요청 번호. pending 이어도 이 번호로 나중에 회수한다. */
  requestId: string;
  roomId: string;
  answer?: { id: string; body: string; from: string; at: string };
  waitedMs?: number;
}

/**
 * 고정 1:1 방 이름. `mcp-<리드>-<팀원>`.
 *
 * ★규칙으로 정하는 이유★ — 규칙이 있으면 "지금 방이 뭐였지"를 어디에도 기억해 둘 필요가 없다.
 * 상대 이름만 알면 방 이름이 나오고, 세션이 끊기든 서버가 재시작하든 같은 방으로 돌아온다.
 */
export function roomIdFor(lead: string, member: string): string {
  const id = `mcp-${lead}-${member}`;
  if (id.length <= THREAD_ID_MAX) return id;
  // 넘치면 팀원 쪽을 자른다(리드는 대개 짧고, 방을 구분하는 건 팀원 쪽이다).
  const keep = THREAD_ID_MAX - `mcp-${lead}-`.length;
  if (keep < 1) throw new Error(`방 이름을 만들 수 없다: lead='${lead}' 가 너무 길다`);
  return `mcp-${lead}-${member.slice(0, keep)}`;
}

/**
 * ★엄격 매칭★ — 이 방에서, 이 질문 번호에 달린, 그 팀원의 답만 답으로 인정한다.
 *
 * in_reply_to 가 없거나 다른 번호를 가리키면 ★답이 아니다.★ 여기서 "지금 기다리는 질문의
 * 답이겠지"로 넓히면 A 의 늦은 답이 C 자리에 뜨는 바로 그 사고가 난다(1절 시나리오).
 * 넓히고 싶은 유혹이 생기면: 실측으로 폴백을 넣었다가 오탐률 100% 가 나온 전례가 이 레포에 있다
 * (inbox/messages.ts 의 reply_address_wrong 주석).
 */
export function findAnswer(
  db: Database,
  roomId: string,
  questionId: string,
  from: string,
): AskResult["answer"] | null {
  const row = db
    .prepare(
      `SELECT id, body, from_agent_id, created_at
         FROM message
        WHERE thread_id = ? AND in_reply_to = ? AND from_agent_id = ?
        ORDER BY created_at ASC
        LIMIT 1`,
    )
    .get(roomId, questionId, from) as
    | { id: string; body: string; from_agent_id: string; created_at: string }
    | undefined;
  if (!row) return null;
  return { id: row.id, body: row.body, from: row.from_agent_id, at: row.created_at };
}

/**
 * 번호가 안 붙은 채 이 방에 들어온 팀원 발언. ★답으로 쓰지 않는다★ — 따로 보여주기만 한다.
 * (빌: "격리해서 '번호 없는 답이 왔다'로 따로 보여줘라.")
 */
export function findUnlabeled(
  db: Database,
  roomId: string,
  from: string,
  sinceMessageId: string,
): Array<{ id: string; body: string; at: string }> {
  const rows = db
    .prepare(
      `SELECT id, body, created_at
         FROM message
        WHERE thread_id = ?
          AND from_agent_id = ?
          AND in_reply_to IS NULL
          AND created_at >= (SELECT created_at FROM message WHERE id = ?)
        ORDER BY created_at ASC
        LIMIT 5`,
    )
    .all(roomId, from, sinceMessageId) as Array<{ id: string; body: string; created_at: string }>;
  return rows.map((r) => ({ id: r.id, body: r.body, at: r.created_at }));
}

export interface PostQuestionDeps {
  /** 버스 입구. 기본은 이 서버 자신의 POST /api/inbox — ★모든 발신자가 쓰는 그 경로 그대로다.★ */
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

/**
 * 질문 한 줄을 버스에 넣는다. ★새 입구를 만들지 않는다★ — send.sh 가 쓰는 POST /api/inbox 를 그대로 쓴다.
 * (send.sh 자체를 부르지 않는 이유: send.sh 는 신원을 자기 워크스페이스에서 정한다(_me.sh).
 *  서버 프로세스에서 부르면 서버의 신원이 되지, 검증된 요청 신원이 되지 않는다.)
 *
 * 깨우기는 우리가 하지 않는다 — 행이 들어가면 ★디스패처가 알아서 깨운다.★
 */
/**
 * ★신원(actor) → 버스에 적히는 발신자★. 변환은 ★이 함수 하나★ 뿐이다.
 *
 * 왜 필요한가: 팀 리드는 ★agent 표에 없다★(일부러 — 등록하면 깨우기·헬스 대상이 된다).
 * 그래서 `from_agent_id: 'gd'` 로 넣으면 버스 입구가 `unknown_from_agent` 로 ★거부한다★
 * (2026-08-06 라이브 첫 호출에서 실제로 죽었다). 리드의 버스 신원은 예약어 `user` 다 —
 * `RESERVED_AGENT_IDS` 에 있어 레지스트리 검사를 건너뛰고, 텔레그램 캡처도 그 이름으로 넣는다.
 *
 * ★보낼 때와 소유권을 볼 때 반드시 같은 함수를 쓴다.★ 두 곳에서 각자 변환하면 언젠가 갈린다.
 *
 * ※ ★meta 에 신원을 심어 그걸로 권한을 정하지 않는다★ (빌 리뷰 2026-08-06):
 *   `envelopeSchema` 의 meta 는 `z.record(z.unknown())` — ★검증이 없다★. 그리고 `/api/inbox` 는
 *   팀원이면 누구나 부를 수 있다. 즉 아무나 `mcp_actor: 'gd'` 를 붙일 수 있고, 그러면
 *   ★번호만 알면 남의 답을 본다★ 는 우리가 방금 닫은 구멍이 다른 문으로 다시 열린다.
 *   meta 의 mcp_actor 는 ★기록용일 뿐이다. 신뢰 판정에 읽지 마라.★
 */
export function busIdentityFor(db: Database, actor: string): string {
  return actor === leadActorId(db) ? "user" : actor;
}

/** 버스에 적을 source. 리드는 사람이므로 'user', 팀원은 'agent'(레지스트리 검사와는 무관한 값). */
function busSourceFor(db: Database, actor: string): "agent" | "user" {
  return actor === leadActorId(db) ? "user" : "agent";
}

export async function postQuestion(
  deps: PostQuestionDeps,
  env: {
    from: string; source: "agent" | "user"; actor: string; to: string; body: string; roomId: string;
    client?: string;
    /** 사람이 친 원문인지, 클라이언트가 정리한 것인지. ★주장이지 증거가 아니다★ — 아래 주석 참고. */
    speaker?: "lead" | "client";
  },
): Promise<{ id: string; thread_id: string }> {
  // ★actor 는 버스 발신자와 다를 수 있다★ (리드 = user 로 나간다) — 그래서 신원을 meta 에 남긴다.
  // ★mcp_actor 는 기록용이다 — 권한 판정에 읽지 마라★ (위 busIdentityFor 주석). 누가 물었는지 사람이 볼 때만 쓴다.
  const meta: Record<string, unknown> = { reply_route: MCP_REPLY_ROUTE, mcp_actor: env.actor };
  // ★이건 클라이언트의 '주장' 이지 '증거' 가 아니다★ (2026-08-07 실사고):
  //   클라이언트가 본문 끝에 "— GD" 라고 서명한 적이 있고, 그걸 신원 증거로 읽어서 틀렸다.
  //   → 이 값으로 ★권한을 정하지 않는다.★ 사람이 오해하지 않게 ★보여주는 용도★ 다.
  if (env.speaker) meta.mcp_speaker = env.speaker;
  // 어느 클라이언트였는지는 ★기록용★이다. 동작은 reply_route 하나가 정한다.
  if (env.client) meta.mcp_client = env.client;
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(`${deps.baseUrl}/api/inbox`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from_agent_id: env.from,
      to_agent_id: env.to,
      // ★받는 사람이 보는 자리에 붙인다★ — meta 에만 두면 팀원은 못 본다.
      //   기본(표시 없음)은 건드리지 않는다. 명시적으로 client 일 때만 붙인다.
      body:
        env.speaker === "client"
          ? `[클라이언트가 정리한 말입니다 — 팀 리드 원문 아님]\n${env.body}`
          : env.body,
      type: "dm",
      priority: "normal",
      source: env.source,
      // ★이게 없으면 아무도 안 깨운다★ (2026-08-07 라이브): source='user' 는 dispatch 표시가 없으면
      //   수신자 행이 ★'completed' 로 박혀서 들어간다★(messages.ts:152) → 디스패처가 'pending' 만
      //   집으므로 ★영영 안 집는다.★ 메시지는 DB 에 멀쩡히 있는데 팀원은 모른다.
      //   대시보드 1:1 이 쓰는 그 표시와 같은 것이다(envelopeSchema:71 "채널-poller 없는 user 메시지").
      //   ★#279 에서 리드를 'user' 로 바꾸면서 이걸 같이 안 붙였다.★
      dispatch: true,
      thread_id: env.roomId,
      meta,
    }),
  });
  const json = (await res.json()) as { ok?: boolean; message?: { id: string; thread_id: string } };
  if (!json.ok || !json.message) {
    throw new Error(`질문 접수 실패: ${JSON.stringify(json)}`);
  }
  return json.message;
}

/**
 * ★지금 이 순간 어떤 호출이 답을 기다리고 있는 질문들★ (프로세스 안 메모리).
 *
 * 늦은 답 밀어주기가 이걸 본다 — 기다리는 호출이 ★있으면★ 그 호출이 화면에 띄우므로 밀지 않고,
 * ★없으면★(이미 접수로 끝났으면) 평소 채널로 민다. 둘 다 하면 같은 답이 두 번 간다.
 *
 * 경계에서의 선택: 기다림을 끝내기 ★전에★ 목록에서 뺀다. 그래서 아슬아슬하게 늦은 답은
 * ★밀린다★(잃는 쪽이 아니라 겹치는 쪽으로 기운다). 잃는 것보다 두 번 보는 게 낫다.
 */
const awaiting = new Set<string>();
export function isAwaited(requestId: string): boolean {
  return awaiting.has(requestId);
}

/**
 * 이 메시지가 ★MCP 질문에 대한 답★ 이고 ★기다리는 호출이 없어서 밀어야 하는가★.
 * 아니면 null. (순수 판정 — 실제 발송은 호출부가 한다.)
 */
export type LateAnswer =
  | { requestId: string; question: string; lead: string; text: string }
  /** 밀 곳을 모르는 경우. ★조용히 사라지지 않게★ 호출부가 감사기록을 남긴다. */
  | { skipped: "non_lead"; requestId: string; asker: string };

export function lateAnswerPush(
  db: Database,
  stored: { id: string; from_agent_id: string; in_reply_to?: string | null; body: string },
): LateAnswer | null {
  if (!stored.in_reply_to) return null; // 번호가 없으면 답이 아니다 — 여기서도 추측하지 않는다
  const q = db
    .prepare(`SELECT from_agent_id, to_agent_id, body, meta_json FROM message WHERE id = ?`)
    .get(stored.in_reply_to) as
    | { from_agent_id: string; to_agent_id: string; body: string; meta_json: string | null }
    | undefined;
  if (!q || !q.meta_json) return null;
  let route: unknown;
  try {
    route = (JSON.parse(q.meta_json) as { reply_route?: unknown }).reply_route;
  } catch {
    return null;
  }
  if (route !== MCP_REPLY_ROUTE) return null; // MCP 로 들어온 질문이 아니다
  if (q.to_agent_id !== stored.from_agent_id) return null; // 물어본 상대가 답한 게 아니다
  if (isAwaited(stored.in_reply_to)) return null; // ★기다리는 호출이 있다 — 그쪽이 띄운다★
  // ★물어본 사람에게 간다 — 아니면 안 간다★ (리뷰 P1 2회차, bill).
  //   미는 곳이 팀 리드 DM 하나뿐이라, 리드가 아닌 신원이 물으면
  //   ★물어본 사람은 답을 못 받고 팀 리드가 남의 대화를 받는다.★
  //   오늘은 매핑에 리드뿐이라 안 터진다 — 방금 닫은 P1 과 ★같은 모양★ 이다.
  //   지금은 fail-closed 로 둔다: 리드가 아닌 신원이 없으니 "그 사람 채널로 보내기" 는
  //   ★검증할 대상이 없다.★ 검증 못 하는 경로를 미리 짓지 않는다.
  // ★같은 번역 함수로 판정한다★ — 리드의 질문은 버스에 user 로 적혀 있다.
  const lead = leadActorId(db);
  if (q.from_agent_id !== busIdentityFor(db, lead)) {
    return { skipped: "non_lead", requestId: stored.in_reply_to, asker: q.from_agent_id };
  }
  const clip = (s: string) => (s.length > 60 ? s.slice(0, 60) + "…" : s);
  return {
    requestId: stored.in_reply_to,
    question: q.body,
    lead,
    // 어느 질문의 답인지 같이 보여준다 — 번호만으로는 사람이 못 알아본다
    text: `[MCP 답 · ${stored.from_agent_id}]\n(질문: ${clip(q.body)})\n\n${stored.body}`,
  };
}

/**
 * ★진행 상황을 '몇 초' 대신 '어디까지 왔나' 로 말한다★ (팀 리드 2026-08-07:
 * "그냥 몇초가 지났다는 것만 나오니깐.. 별로다").
 *
 * 근거는 ★수신자 행 두 칸★ 이다 — delivery_state(전달이 어디까지) · recipient_state(그 사람이 어디까지).
 * ★런타임과 무관하다★: 터미널 화면이 있는 팀원은 5명뿐이고 나머지 7명은 화면 자체가 없다.
 * 이 두 칸은 ★12명 전부 똑같이★ 남으므로 누구에게 물어도 같은 말이 나온다.
 *
 * ★막힌 것을 알려주는 게 이 함수의 값이다★ — blocked·dead_letter 는 ★영영 안 온다★.
 * 그걸 모르면 사용자는 상한까지 기다린 뒤에야 실패를 안다.
 */
/**
 * ★done 필드를 두지 않는다★ (빌 리뷰 2026-08-07). 처음엔 넣었는데 ★아무도 안 읽었고★,
 * 그냥 죽은 필드가 아니라 ★장전된 총★ 이었다: acknowledged 에 done=true 를 주고 있었는데
 * 우리 코드는 그 상태를 ★"engaged, not done"★ 이라고 못박아 뒀다(ackClose.ts:122).
 * ★이름은 done 인데 값은 '아직 안 끝났다' 일 때 true★ 라, 다음 사람이 "done 이면 기다림 끝" 으로
 * 읽으면 ★답이 오기 전에 끊는다.★ 안 쓰는 값을 남기지 않는다.
 */
export type AskProgress = { label: string; stuck: boolean };

/** 그 팀원이 지금 무엇을 하고 있나 — 화면이 있는 런타임만 값이 있다(없으면 null). */
function activityOf(db: Database, agentId: string): string | null {
  try {
    const r = db.prepare(`SELECT activity_line FROM agent_status WHERE agent_id = ?`).get(agentId) as
      | { activity_line: string | null }
      | undefined;
    return r?.activity_line?.trim() || null;
  } catch {
    return null; // 컬럼이 아직 없는 DB(구버전)에서도 진행 표시가 죽지 않는다
  }
}

export function askProgress(db: Database, requestId: string, to: string): AskProgress {
  const row = db
    .prepare(`SELECT delivery_state, recipient_state FROM message_recipient WHERE message_id = ? AND agent_id = ?`)
    .get(requestId, to) as { delivery_state: string; recipient_state: string } | undefined;
  if (!row) return { label: `${to} 에게 전달 준비 중`, stuck: false };

  // ★막힘이 먼저다★ — 이 상태들은 기다려도 안 온다. 초를 세는 것보다 이걸 말해야 한다.
  if (row.delivery_state === "blocked") return { label: `${to} 에게 배달이 막혔습니다 (더 기다려도 안 옵니다)`, stuck: true };
  if (row.delivery_state === "dead_letter") return { label: `${to} 에게 배달 실패로 종료됐습니다`, stuck: true };
  if (row.delivery_state === "expired") return { label: `${to} 에게 보낸 것이 시간이 지나 만료됐습니다`, stuck: true };

  // 그 사람이 어디까지 갔나 — 이쪽이 전달 상태보다 뒤에 있으므로 먼저 본다.
  if (row.recipient_state === "acknowledged" || row.recipient_state === "completed") {
    return { label: `${to} 가 답을 쓰는 중입니다`, stuck: false };
  }
  if (row.recipient_state === "in_progress") {
    // ★막힘 상태에는 안 붙인다★ — 그건 '지금 하는 일' 이 아니라 결론이다.
    const act = activityOf(db, to);
    return { label: act ? `${to} 가 읽고 작업 중입니다 · ${act}` : `${to} 가 읽고 작업 중입니다`, stuck: false };
  }

  // 아직 안 읽음 — 전달이 어디까지 갔는지로 나눈다.
  if (row.delivery_state === "pending" || row.delivery_state === "dispatching") {
    return { label: `${to} 에게 전달 중입니다`, stuck: false };
  }
  return { label: `${to} 가 아직 열어보지 않았습니다`, stuck: false };
}

export interface AskOptions {
  waitMs: number;
  pollMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * 기다리는 동안 매 폴링마다 불린다. ★연결을 조용히 두지 않기 위한 것★ —
   * 조용한 연결은 Cloudflare 가 30초에 끊는다(2026-08-06 실측). 여기서 진행 알림을 보내
   * 바이트를 흘리면 연결이 살아 있고, 부수적으로 사용자 화면에 "준비 중" 이 보인다.
   * ★알림 실패가 기다림을 깨지 않는다★ — 던져도 삼킨다(알림은 부가 기능이다).
   */
  onWait?: (elapsedMs: number, requestId: string) => void | Promise<void>;
}

/**
 * 묻고 기다린다. 답이 오면 답을, 안 오면 ★번호와 함께 pending★ 을 돌려준다.
 *
 * ★시간 초과는 요청을 버리지 않는다★ — 질문 행은 그대로 남아 있고 번호도 살아 있다.
 * 나중에 fetchAnswer(번호) 로 회수하거나, 늦은 답이 평소 채널로 밀려간다.
 */
export async function askTeammate(
  db: Database,
  deps: PostQuestionDeps,
  env: { from: string; to: string; body: string; client?: string; speaker?: "lead" | "client" },
  opts: AskOptions,
): Promise<AskResult> {
  // ★방 이름은 신원으로 짓는다★(mcp-gd-bill) — 버스 발신자가 user 여도 방은 리드의 방이다.
  const roomId = roomIdFor(env.from, env.to);
  const sent = await postQuestion(deps, {
    ...env,
    from: busIdentityFor(db, env.from),
    source: busSourceFor(db, env.from),
    actor: env.from,
    roomId,
  });
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = opts.now ?? (() => Date.now());
  const started = now();

  awaiting.add(sent.id);
  try {
    // 넣자마자 한 번 본다 — 아주 빠른 답(캐시된 상태 질의 등)이 첫 대기를 통째로 기다리지 않게.
    let stuckReason: string | undefined;
    for (;;) {
      const answer = findAnswer(db, roomId, sent.id, env.to);
      if (answer) {
        return { status: "answered", requestId: sent.id, roomId, answer, waitedMs: now() - started };
      }
      // ★막힌 걸 알면서 상한까지 세지 않는다★ — blocked·dead_letter·expired 는 기다려도 안 온다.
      //   (판정을 만들어놓고 안 쓰면 그건 계산만 한 것이다 — 빌이 #279 에서 잡은 그 모양.)
      const prog = askProgress(db, sent.id, env.to);
      if (prog.stuck) {
        stuckReason = prog.label;
        break;
      }
      if (now() - started >= opts.waitMs) break;
      // ★알림을 먼저, 그다음 잠깐 잔다★ — 순서를 바꾸면 첫 알림이 pollMs 만큼 늦어진다.
      if (opts.onWait) {
        try {
          await opts.onWait(now() - started, sent.id);
        } catch {
          /* 알림 실패가 기다림을 깨지 않는다 */
        }
      }
      await sleep(opts.pollMs);
    }
    return { status: "pending", requestId: sent.id, roomId, waitedMs: now() - started, stuckReason };
  } finally {
    // ★예외로 빠져나가도 반드시 지운다★ — 남으면 그 질문의 늦은 답이 영원히 안 밀린다(조용한 손실).
    awaiting.delete(sent.id);
  }
}

/**
 * 나중에 번호로 회수. 호출이 이미 끝난 뒤에도 답은 DB 에 남아 있으므로 언제든 꺼낼 수 있다.
 * 답이 아직 없으면 ★번호 없는 발언이 있었는지★ 도 같이 알려준다(붙이지는 않는다).
 */
export function fetchAnswer(
  db: Database,
  requestId: string,
  actor: string,
): { found: true; answer: NonNullable<AskResult["answer"]>; roomId: string }
  | { found: false; denied?: true; roomId: string | null; to: string | null; unlabeled: Array<{ id: string; body: string; at: string }> } {
  const q = db
    .prepare(`SELECT thread_id, to_agent_id, from_agent_id, meta_json FROM message WHERE id = ?`)
    .get(requestId) as
    | { thread_id: string; to_agent_id: string; from_agent_id: string; meta_json: string | null }
    | undefined;
  if (!q) return { found: false, roomId: null, to: null, unlabeled: [] };
  // ★번호를 안다고 남의 답을 볼 수는 없다★ (리뷰 P1, bill).
  //   ask 는 첫 줄에서 신원을 막는데 fetch 만 안 막으면, ★번호만 알면 남의 대화가 열린다.★
  //   오늘은 매핑에 리드 하나뿐이라 "남" 이 없어서 안 터진다 — ★그래서 더 위험하다.★
  //   read 신원을 하나 추가하는 순간 조용히 열린다. 지금 닫는다.
  // ★같은 번역 함수로 비교한다★ — 리드는 user 로 나가므로 actor 를 그대로 비교하면 본인도 막힌다.
  //   meta 를 읽지 않는 이유는 busIdentityFor 주석 참고(검증 없는 필드로 권한을 정하지 않는다).
  if (q.from_agent_id !== busIdentityFor(db, actor)) {
    return { found: false, denied: true, roomId: null, to: null, unlabeled: [] };
  }
  const answer = findAnswer(db, q.thread_id, requestId, q.to_agent_id);
  if (answer) return { found: true, answer, roomId: q.thread_id };
  return {
    found: false,
    roomId: q.thread_id,
    to: q.to_agent_id,
    unlabeled: findUnlabeled(db, q.thread_id, q.to_agent_id, requestId),
  };
}
