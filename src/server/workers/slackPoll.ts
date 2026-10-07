import type { Database } from "bun:sqlite";
import { loadAgentCreds, allMentionedUsers } from "../lib/slack";
import { appendAudit } from "../db/queries";
import { handleAppMention, type SlackEvent } from "../routes/slack";
import type { AgentRecord, WsEvent } from "../types";
import { coordinatorId } from "../lib/capabilities";
import { ambientAgents } from "../lib/registry";

interface SlackPollDeps {
  db: Database;
  broadcast: (e: WsEvent) => void;
  agents: () => AgentRecord[];
}

interface SlackHistoryResponse {
  ok: boolean;
  error?: string;
  messages?: SlackHistoryMessage[];
}

interface SlackHistoryMessage {
  type?: string;
  user?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  reply_count?: number;
  latest_reply?: string;
}

const ENABLED = (process.env.TEAM_SLACK_POLL_ENABLED ?? "1") !== "0";
// 채널은 env로만 설정(기본 빈값). 실채널 id를 소스에 하드코딩하면 공개빌드에 내부 id 누출 + 기본으로 폴링이 켜짐.
// 채널 미설정 시 startSlackPoll가 no-op(아래 CHANNELS.length===0 가드). (하네스)
const CHANNELS = (process.env.TEAM_SLACK_POLL_CHANNELS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const INTERVAL_MS = Number(process.env.TEAM_SLACK_POLL_INTERVAL_MS ?? 20_000);
const START_LOOKBACK_SEC = Number(process.env.TEAM_SLACK_POLL_LOOKBACK_SEC ?? 3600);
// Slack 폴링 토큰 소유 agent — 미설정 시 coordinator(기본 owner). 이전 하드코딩 "codex" 대체.
function tokenAgentId(): string | undefined {
  return process.env.TEAM_SLACK_POLL_TOKEN_AGENT ?? coordinatorId(ambientAgents());
}

// 봇→봇 멘션 허용(cross-agent collaboration)에 따른 루프 백스톱: 채널당 "봇이 작성한" 트리거를
// 윈도우 내 N건으로 제한한다. 사람 멘션은 무제한. 작성자 자기제외 + 평문답신과 함께 무한 echo를 막는 backstop.
const BOT_LOOP_WINDOW_SEC = Number(process.env.TEAM_SLACK_BOT_LOOP_WINDOW_SEC ?? 60);
const BOT_LOOP_MAX = Number(process.env.TEAM_SLACK_BOT_LOOP_MAX ?? 5);
// 채널 → 최근 봇작성 트리거 ts 목록(모듈 스코프, tick 간 유지).
const botTriggerWindow = new Map<string, number[]>();

function tsToNumber(ts: string | undefined): number {
  const n = Number(ts ?? 0);
  return Number.isFinite(n) ? n : 0;
}

// 이 폴러의 모든 채널이 메서드별 예산을 공유한다. Tier 3(50+/분) 아래로 제한하고
// 429의 Retry-After 동안 재요청하지 않는다. 다른 Slack 클라이언트의 호출은 이 예산 밖이다.
const CALLS_PER_MINUTE = 40;
type SlackGet = (method: string, params: Record<string, string>) => Promise<SlackHistoryResponse>;

export function createSlackGetter(): SlackGet {
  const calls = new Map<string, number[]>();
  const retryAt = new Map<string, number>();
  return async (method, params) => {
    const now = Date.now();
    if (now < (retryAt.get(method) ?? 0)) return { ok: false, error: "rate_limit_backoff" };
    const recent = (calls.get(method) ?? []).filter((ts) => ts > now - 60_000);
    calls.set(method, recent);
    if (recent.length >= CALLS_PER_MINUTE) return { ok: false, error: "rate_budget_exhausted" };
    const tokenAgent = tokenAgentId();
    const creds = tokenAgent ? loadAgentCreds(tokenAgent) : null;
    if (!creds) return { ok: false, error: `missing_creds_for_${tokenAgent ?? "unknown"}` };
    recent.push(now);
    const url = new URL(`https://slack.com/api/${method}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${creds.bot_token}` } });
    if (res.status === 429) {
      const seconds = Number(res.headers.get("Retry-After") ?? 60);
      retryAt.set(method, now + (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000);
      return { ok: false, error: "ratelimited" };
    }
    return (await res.json()) as SlackHistoryResponse;
  };
}

const slackGet = createSlackGetter();

async function fetchHistory(channel: string, oldest: number, get: SlackGet): Promise<SlackHistoryResponse> {
  return get("conversations.history", {
    channel,
    limit: "50",
    oldest: String(oldest),
    inclusive: "false",
  });
}

// history는 부모 ts 순이다. 부모 탐색 범위와 답글 활동 범위를 분리한다.
// 90일 안의 부모를 최대 5쪽(쪽당 200개) 읽고 최근 7일 내 답글이 있는 것만 반환한다.
// 90일 밖 또는 페이지 상한 뒤의 부모는 못 읽는다. 상한으로 잘린 스캔은 audit에 남긴다.
const THREAD_WINDOW_SEC = Number(process.env.TEAM_SLACK_POLL_THREAD_WINDOW_SEC ?? 7 * 24 * 3600);
const THREAD_PARENT_LOOKBACK_SEC = Number(process.env.TEAM_SLACK_POLL_THREAD_PARENT_LOOKBACK_SEC ?? 90 * 24 * 3600);
const THREAD_MAX_PAGES = Number(process.env.TEAM_SLACK_POLL_THREAD_MAX_PAGES ?? 5);
const THREAD_MAX_REPLIES = 10; // 채널당 tick에서 조회할 스레드 수. 전역 메서드 예산도 적용한다.

interface SlackPagedResponse extends SlackHistoryResponse {
  response_metadata?: { next_cursor?: string };
}

async function fetchThreadParents(deps: SlackPollDeps, channel: string, get: SlackGet): Promise<SlackHistoryResponse> {
  const now = Date.now() / 1000;
  const since = now - Math.max(THREAD_PARENT_LOOKBACK_SEC, THREAD_WINDOW_SEC);
  const activeSince = now - THREAD_WINDOW_SEC;
  const all: SlackHistoryMessage[] = [];
  let cursor = "";
  for (let page = 0; page < THREAD_MAX_PAGES; page++) {
    const params: Record<string, string> = { channel, limit: "200", oldest: String(since) };
    if (cursor) params.cursor = cursor;
    const res = (await get("conversations.history", params)) as SlackPagedResponse;
    if (!res.ok) return res;
    all.push(...(res.messages ?? []).filter((p) => tsToNumber(p.latest_reply) >= activeSince));
    cursor = res.response_metadata?.next_cursor?.trim() ?? "";
    if (!cursor) break;
  }
  if (cursor) {
    appendAudit(deps.db, "system", "slack_poll_thread_scan_capped", null, {
      channel, max_pages: THREAD_MAX_PAGES, parent_lookback_sec: now - since,
      thread_window_sec: THREAD_WINDOW_SEC,
    });
  }
  return { ok: true, messages: all };
}

async function fetchReplies(channel: string, threadTs: string, oldest: number, get: SlackGet): Promise<SlackHistoryResponse> {
  return get("conversations.replies", {
    channel,
    ts: threadTs,
    oldest: String(oldest),
    inclusive: "false",
    limit: "100",
  });
}

/**
 * 댓글을 새로 읽어야 할 쓰레드 — 댓글이 있고, 가장 최근 댓글이 그 쓰레드에서 마지막으로 본 시각(없으면 floor)보다 뒤인 것.
 * floor = 폴링을 시작한 시각 - lookback. 그 전 댓글은 다시 처리하지 않는다(재시작마다 옛 멘션이 되살아나지 않게).
 */
export function threadsDue(
  parents: Pick<SlackHistoryMessage, "ts" | "reply_count" | "latest_reply">[],
  threadCursors: Map<string, number>,
  floor: number,
): { threadTs: string; oldest: number }[] {
  const due: { threadTs: string; oldest: number }[] = [];
  for (const p of parents) {
    if (!p.ts || !p.reply_count || !p.latest_reply) continue;
    const seen = Math.max(threadCursors.get(p.ts) ?? floor, floor);
    if (tsToNumber(p.latest_reply) > seen) due.push({ threadTs: p.ts, oldest: seen });
  }
  return due;
}

async function handleMessage(
  deps: SlackPollDeps,
  agents: AgentRecord[],
  knownMentionIds: Set<string | null | undefined>,
  channel: string,
  msg: SlackHistoryMessage,
): Promise<void> {
  const ts = tsToNumber(msg.ts);
  // 작성자(slack user id) — 사람·봇 모두 chat.postMessage가 user를 채운다(확인: 봇 메시지도 user=봇 user_id).
  // 더 이상 bot_id 메시지를 전면 차단하지 않는다(그게 봇→봇 멘션을 막던 원인). 대신 아래에서 작성자 자신을
  // 타깃에서 제외(self-trigger/relay echo 방지)하고, 답신은 평문이라 자동 멘션이 없으며, 봇작성 트리거엔
  // 채널 단위 루프 백스톱을 적용한다.
  const authorUserId = msg.user;
  const targets = allMentionedUsers(msg.text ?? "").filter(
    (id) => knownMentionIds.has(id) && id !== authorUserId,
  );
  if (targets.length === 0) return;

  // 봇이 작성한 멘션이면 루프 백스톱(사람 멘션은 통과). 윈도우 내 cap 초과 시 skip + audit.
  if (msg.bot_id) {
    const recent = (botTriggerWindow.get(channel) ?? []).filter((t) => t > ts - BOT_LOOP_WINDOW_SEC);
    if (recent.length >= BOT_LOOP_MAX) {
      appendAudit(deps.db, "system", "slack_bot_loop_guard", null, {
        channel,
        window_sec: BOT_LOOP_WINDOW_SEC,
        max: BOT_LOOP_MAX,
      });
      botTriggerWindow.set(channel, recent);
      return;
    }
    recent.push(ts);
    botTriggerWindow.set(channel, recent);
  }

  const ev: SlackEvent = {
    type: "app_mention",
    user: msg.user,
    text: msg.text,
    channel,
    ts: msg.ts,
    thread_ts: msg.thread_ts,
    bot_id: msg.bot_id,
  };
  await handleAppMention({ db: deps.db, broadcast: deps.broadcast, agents }, ev);
}

export async function pollOnce(
  deps: SlackPollDeps,
  cursors: Map<string, number>,
  threadCursors: Map<string, Map<string, number>>,
  floor: number,
  get: SlackGet = slackGet,
): Promise<void> {
  const agents = deps.agents();
  const knownMentionIds = new Set(agents.map((a) => a.slack_bot_user_id).filter(Boolean));

  for (const channel of CHANNELS) {
    const oldest = cursors.get(channel) ?? floor;
    const history = await fetchHistory(channel, oldest, get);
    if (!history.ok) {
      appendAudit(deps.db, "system", "slack_poll_failed", null, { channel, error: history.error });
      continue;
    }

    const messages = [...(history.messages ?? [])].sort((a, b) => tsToNumber(a.ts) - tsToNumber(b.ts));
    let newest = oldest;
    for (const msg of messages) {
      const ts = tsToNumber(msg.ts);
      if (ts <= oldest) continue;
      newest = Math.max(newest, ts);
      await handleMessage(deps, agents, knownMentionIds, channel, msg);
    }
    cursors.set(channel, newest);

    // 쓰레드 댓글 — 최상위 글과 같은 멘션 처리. 실패해도 최상위 처리는 이미 끝났다.
    const parents = await fetchThreadParents(deps, channel, get);
    if (!parents.ok) {
      appendAudit(deps.db, "system", "slack_poll_failed", null, { channel, error: parents.error, step: "thread_parents" });
      continue;
    }
    const tc = threadCursors.get(channel) ?? new Map<string, number>();
    threadCursors.set(channel, tc);
    // 미조회 스레드(floor)를 먼저 읽어, 이미 읽은 활성 스레드가 예산을 독점하지 않게 한다.
    const due = threadsDue(parents.messages ?? [], tc, floor).sort((a, b) => a.oldest - b.oldest);
    if (due.length > THREAD_MAX_REPLIES) {
      appendAudit(deps.db, "system", "slack_poll_thread_replies_capped", null, {
        channel, due: due.length, max_threads: THREAD_MAX_REPLIES,
      });
    }
    for (const { threadTs, oldest: since } of due.slice(0, THREAD_MAX_REPLIES)) {
      const replies = await fetchReplies(channel, threadTs, since, get);
      if (!replies.ok) {
        appendAudit(deps.db, "system", "slack_poll_failed", null, { channel, error: replies.error, step: "thread_replies" });
        continue;
      }
      let seen = since;
      const items = [...(replies.messages ?? [])].sort((a, b) => tsToNumber(a.ts) - tsToNumber(b.ts));
      for (const r of items) {
        const ts = tsToNumber(r.ts);
        if (ts <= since || r.ts === threadTs) continue; // 첫 글(부모)은 최상위 처리 몫
        seen = Math.max(seen, ts);
        await handleMessage(deps, agents, knownMentionIds, channel, { ...r, thread_ts: r.thread_ts ?? threadTs });
      }
      tc.set(threadTs, seen);
    }
  }
}

export function startSlackPoll(deps: SlackPollDeps): () => void {
  if (!ENABLED || CHANNELS.length === 0) return () => {};
  const cursors = new Map<string, number>();
  const threadCursors = new Map<string, Map<string, number>>();
  const floor = Date.now() / 1000 - START_LOOKBACK_SEC;
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await pollOnce(deps, cursors, threadCursors, floor);
    } catch (e) {
      appendAudit(deps.db, "system", "slack_poll_failed", null, {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      running = false;
    }
  };

  void tick();
  const interval = setInterval(() => void tick(), INTERVAL_MS);
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
