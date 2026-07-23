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
}

const ENABLED = (process.env.TEAM_SLACK_POLL_ENABLED ?? "1") !== "0";
// 채널은 env로만 설정(기본 빈값). 실채널 id를 소스에 하드코딩하면 공개빌드에 내부 id 누출 + 기본으로 폴링이 켜짐.
// 채널 미설정 시 startSlackPoll가 no-op(아래 CHANNELS.length===0 가드). (하네스, GD 2026-07-02)
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

async function fetchHistory(channel: string, oldest: number): Promise<SlackHistoryResponse> {
  const tokenAgent = tokenAgentId();
  const creds = tokenAgent ? loadAgentCreds(tokenAgent) : null;
  if (!creds) return { ok: false, error: `missing_creds_for_${tokenAgent ?? "unknown"}` };
  const url = new URL("https://slack.com/api/conversations.history");
  url.searchParams.set("channel", channel);
  url.searchParams.set("limit", "50");
  url.searchParams.set("oldest", String(oldest));
  url.searchParams.set("inclusive", "false");
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${creds.bot_token}` },
  });
  return (await res.json()) as SlackHistoryResponse;
}

async function pollOnce(deps: SlackPollDeps, cursors: Map<string, number>): Promise<void> {
  const agents = deps.agents();
  const knownMentionIds = new Set(agents.map((a) => a.slack_bot_user_id).filter(Boolean));

  for (const channel of CHANNELS) {
    const oldest = cursors.get(channel) ?? Date.now() / 1000 - START_LOOKBACK_SEC;
    const history = await fetchHistory(channel, oldest);
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

      // 작성자(slack user id) — 사람·봇 모두 chat.postMessage가 user를 채운다(확인: 봇 메시지도 user=봇 user_id).
      // 더 이상 bot_id 메시지를 전면 차단하지 않는다(그게 봇→봇 멘션을 막던 원인). 대신 아래에서 작성자 자신을
      // 타깃에서 제외(self-trigger/relay echo 방지)하고, 답신은 평문이라 자동 멘션이 없으며, 봇작성 트리거엔
      // 채널 단위 루프 백스톱을 적용한다.
      const authorUserId = msg.user;
      const targets = allMentionedUsers(msg.text ?? "").filter(
        (id) => knownMentionIds.has(id) && id !== authorUserId,
      );
      if (targets.length === 0) continue;

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
          continue;
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
    cursors.set(channel, newest);
  }
}

export function startSlackPoll(deps: SlackPollDeps): () => void {
  if (!ENABLED || CHANNELS.length === 0) return () => {};
  const cursors = new Map<string, number>();
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await pollOnce(deps, cursors);
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
