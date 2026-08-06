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

/** MCP 로 들어온 질문임을 표시하는 값. 커서·클로드 코드 등 ★클라이언트 종류와 무관하게 'mcp'★. */
export const MCP_REPLY_ROUTE = "mcp";

/** thread.id 는 32자 상한이다(실측: 초과 시 send 가 실패했다). 방 이름은 그 안에 들어와야 한다. */
export const THREAD_ID_MAX = 32;

export interface AskResult {
  status: "answered" | "pending";
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
export async function postQuestion(
  deps: PostQuestionDeps,
  env: { from: string; to: string; body: string; roomId: string; client?: string },
): Promise<{ id: string; thread_id: string }> {
  const meta: Record<string, unknown> = { reply_route: MCP_REPLY_ROUTE };
  // 어느 클라이언트였는지는 ★기록용★이다. 동작은 reply_route 하나가 정한다.
  if (env.client) meta.mcp_client = env.client;
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(`${deps.baseUrl}/api/inbox`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from_agent_id: env.from,
      to_agent_id: env.to,
      body: env.body,
      type: "dm",
      priority: "normal",
      source: "agent",
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
export function lateAnswerPush(
  db: Database,
  stored: { id: string; from_agent_id: string; in_reply_to?: string | null; body: string },
): { requestId: string; question: string; lead: string; text: string } | null {
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
  const clip = (s: string) => (s.length > 60 ? s.slice(0, 60) + "…" : s);
  return {
    requestId: stored.in_reply_to,
    question: q.body,
    lead: q.from_agent_id,
    // 어느 질문의 답인지 같이 보여준다 — 번호만으로는 사람이 못 알아본다
    text: `[MCP 답 · ${stored.from_agent_id}]\n(질문: ${clip(q.body)})\n\n${stored.body}`,
  };
}

export interface AskOptions {
  waitMs: number;
  pollMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
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
  env: { from: string; to: string; body: string; client?: string },
  opts: AskOptions,
): Promise<AskResult> {
  const roomId = roomIdFor(env.from, env.to);
  const sent = await postQuestion(deps, { ...env, roomId });
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = opts.now ?? (() => Date.now());
  const started = now();

  awaiting.add(sent.id);
  try {
    // 넣자마자 한 번 본다 — 아주 빠른 답(캐시된 상태 질의 등)이 첫 대기를 통째로 기다리지 않게.
    for (;;) {
      const answer = findAnswer(db, roomId, sent.id, env.to);
      if (answer) {
        return { status: "answered", requestId: sent.id, roomId, answer, waitedMs: now() - started };
      }
      if (now() - started >= opts.waitMs) break;
      await sleep(opts.pollMs);
    }
    return { status: "pending", requestId: sent.id, roomId, waitedMs: now() - started };
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
    .prepare(`SELECT thread_id, to_agent_id, from_agent_id FROM message WHERE id = ?`)
    .get(requestId) as { thread_id: string; to_agent_id: string; from_agent_id: string } | undefined;
  if (!q) return { found: false, roomId: null, to: null, unlabeled: [] };
  // ★번호를 안다고 남의 답을 볼 수는 없다★ (리뷰 P1, bill).
  //   ask 는 첫 줄에서 신원을 막는데 fetch 만 안 막으면, ★번호만 알면 남의 대화가 열린다.★
  //   오늘은 매핑에 리드 하나뿐이라 "남" 이 없어서 안 터진다 — ★그래서 더 위험하다.★
  //   read 신원을 하나 추가하는 순간 조용히 열린다. 지금 닫는다.
  if (q.from_agent_id !== actor) {
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
