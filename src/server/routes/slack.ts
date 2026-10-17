// Slack adapter routes:
//   POST /api/slack/events — receives Slack Events API webhooks
//     - url_verification: returns the challenge token
//     - event_callback (app_mention): converts to envelope + inserts via inbox
//   POST /api/slack/post — admin helper to post a message to Slack as a given agent
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { ensureThread, insertMessage, acceptInbound } from "../db/inboxQueries";
import { appendAudit } from "../db/queries";
import { appendAuditFile } from "../lib/auditFile";
import {
  loadAgentCreds,
  verifySlackSignature,
  postMessage,
  cleanSlackText,
  firstMentionedUser,
  allMentionedUsers,
} from "../lib/slack";
import { injectPrompt } from "../lib/tmuxInject";
import { getLocale } from "../lib/captureConfig";
import { runOpenclawSlackTurn } from "../lib/openclawBridge";
import { runHermesTeamTurn } from "../lib/hermesBridge";
import { recordReportDelivery } from "../bus/deliveryRecord";
import { buildDedupeKey } from "../../shared/envelopeSchema";
import type { AgentRecord, WsEvent } from "../types";

interface SlackRouteDeps {
  db: Database;
  broadcast: (e: WsEvent) => void;
  agents: () => AgentRecord[];
}

// In-memory map: slack thread_ts → internal thread_id (avoid duplicate thread per Slack thread).
const slackThreadIndex = new Map<string, string>();

export function createSlackRoutes(deps: SlackRouteDeps): Hono {
  const r = new Hono();

  r.post("/slack/events", async (c) => {
    // Slack signature verification requires the RAW body text (not parsed JSON).
    const rawBody = await c.req.text();
    const sig = c.req.header("x-slack-signature") ?? "";
    const ts = c.req.header("x-slack-request-timestamp") ?? "";

    // We need to know WHICH app this came from to look up its signing secret.
    // Slack puts the api_app_id in the JSON payload, so parse first then verify.
    let payload: { type?: string; challenge?: string; api_app_id?: string; event?: SlackEvent };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    // URL verification handshake (Slack sends this once when Request URL is set).
    if (payload.type === "url_verification" && payload.challenge) {
      return c.text(payload.challenge);
    }

    // Lookup agent by app_id; fall back to mention-based lookup later.
    const allAgents = deps.agents();
    const candidateAgent = payload.api_app_id
      ? allAgents.find((a) => loadAgentCreds(a.id)?.app_id === payload.api_app_id)
      : null;

    // Signature verification per the candidate (if known + has secret).
    if (candidateAgent) {
      const creds = loadAgentCreds(candidateAgent.id);
      if (creds?.signing_secret) {
        const ok = verifySlackSignature({
          signingSecret: creds.signing_secret,
          timestamp: ts,
          body: rawBody,
          signature: sig,
        });
        if (!ok) {
          console.warn(`[slack] signature mismatch for ${candidateAgent.id}`);
          return c.json({ error: "signature_invalid" }, 401);
        }
      } else {
        console.warn(`[slack] no signing secret configured for ${candidateAgent.id} — verification skipped (dev mode)`);
      }
    }

    if (payload.type === "event_callback" && payload.event) {
      const ev = payload.event;
      if (ev.type === "app_mention") {
        await handleAppMention({ db: deps.db, broadcast: deps.broadcast, agents: allAgents }, ev);
      }
      return c.json({ ok: true });
    }

    return c.json({ ok: true, ignored: payload.type });
  });

  // Admin helper: post a message to Slack as a given agent.
  // body: { agent_id, channel, text, thread_ts? }
  r.post("/slack/post", async (c) => {
    const schema = z.object({
      agent_id: z.string().min(1),
      channel: z.string().min(1),
      text: z.string().min(1).max(40000),
      thread_ts: z.string().optional(),
    });
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: "validation", issues: parsed.error.issues }, 400);
    const { agent_id, channel, text, thread_ts } = parsed.data;
    const creds = loadAgentCreds(agent_id);
    if (!creds) return c.json({ error: "no_creds_for_agent", agent_id }, 404);
    const result = await postMessage({ bot_token: creds.bot_token, channel, text, thread_ts });
    if (!result.ok) {
      appendAudit(deps.db, agent_id, "slack_post_failed", null, { error: result.error });
      return c.json({ ok: false, error: result.error }, 502);
    }
    appendAudit(deps.db, agent_id, "slack_post_sent", null, { channel, thread_ts, ts: result.ts });
    return c.json({ ok: true, ts: result.ts });
  });

  return r;
}

export interface SlackEvent {
  type: string;
  user?: string;
  text?: string;
  channel?: string;
  thread_ts?: string;
  ts?: string;
  bot_id?: string;
  team?: string;
}

export async function handleAppMention(
  deps: { db: Database; broadcast: (e: WsEvent) => void; agents: AgentRecord[] },
  ev: SlackEvent,
): Promise<void> {
  // 봇 작성 이벤트도 협업 멘션 대상이다. 작성자를 수신 대상에서 제외해 자기 발신 재주입을 막는다.
  const authorUserId = ev.user;
  const text = ev.text ?? "";
  if (!ev.channel) return;
  const slackChannel = ev.channel;
  const cleanBody = cleanSlackText(text);
  if (!cleanBody) return;

  // 한 webhook에서 모든 알려진 멘션 대상을 처리해 일부 봇의 구독 누락을 보완한다. 여러 webhook의 중복은 60초 지문으로 제거한다.
  const mentionedIds = allMentionedUsers(text);
  const targetAgents = mentionedIds
    .map((uid) => deps.agents.find((a) => a.slack_bot_user_id === uid))
    .filter((a): a is AgentRecord => !!a)
    // 작성자 자신은 타깃에서 제외 — 봇이 자기 자신을 멘션하거나 자기 relay 답신이 자신을 재트리거하는 echo 방지.
    .filter((a) => a.slack_bot_user_id !== authorUserId);

  if (targetAgents.length === 0) {
    const first = firstMentionedUser(text);
    if (first) console.warn(`[slack] mention for unknown bot user ${first}`);
    return;
  }

  // Map Slack thread to internal envelope thread — shared across all targets in this webhook.
  const slackThreadKey = `${slackChannel}:${ev.thread_ts ?? ev.ts}`;
  const existingThread = slackThreadIndex.get(slackThreadKey);
  // Use the first target's id only to seed thread creation; thread is shared regardless.
  const seedTarget = targetAgents[0]!;
  const { thread_id } = ensureThread(deps.db, {
    thread_id: existingThread,
    from_agent_id: "user",
    to_agent_id: seedTarget.id,
    type: "dm",
    body: cleanBody,
  });
  if (!existingThread) slackThreadIndex.set(slackThreadKey, thread_id);

  for (const targetAgent of targetAgents) {
    await processMentionForAgent({
      deps,
      ev,
      slackChannel,
      cleanBody,
      thread_id,
      targetAgent,
    });
  }
}

async function processMentionForAgent(opts: {
  deps: { db: Database; broadcast: (e: WsEvent) => void; agents: AgentRecord[] };
  ev: SlackEvent;
  slackChannel: string;
  cleanBody: string;
  thread_id: string;
  targetAgent: AgentRecord;
}): Promise<void> {
  const { deps, ev, slackChannel, cleanBody, thread_id, targetAgent } = opts;

  const slackMessageTs = ev.ts;
  if (slackMessageTs) {
    const priorForSlackMessage = deps.db
      .prepare(
        `SELECT id FROM message
         WHERE to_agent_id = ?
           AND source = 'user'
           AND (meta_json LIKE ? OR meta_json LIKE ?)
         LIMIT 1`,
      )
      .get(
        targetAgent.id,
        `%"message_ts":"${slackMessageTs}"%`,
        `%"thread_ts":"${slackMessageTs}"%`,
      );
    if (priorForSlackMessage) return;
  }

  // dedupe(60s) + insertMessage + broadcast → 공통 acceptInbound (P2 ChannelAdapter).
  // thread_id는 상단(handleAppMention)에서 ensure됨 → acceptInbound 내부 재호출은 idempotent reuse.
  const accepted = acceptInbound(
    deps.db,
    {
      thread_id,
      from_agent_id: "user",
      to_agent_id: targetAgent.id,
      body: cleanBody,
      type: "dm",
      source: "user",
      hop_count: 0,
      priority: "normal",
      dedupe_key: buildDedupeKey("user", targetAgent.id, cleanBody),
      meta: {
        slack: {
          channel: slackChannel,
          thread_ts: ev.thread_ts ?? ev.ts,
          message_ts: ev.ts,
          slack_user_id: ev.user,
          team: ev.team,
        },
      },
    },
    {
      dedupeWindowSec: 60,
      broadcast: deps.broadcast,
      onInserted: (stored) => {
        // 감사 기록은 삽입 후·방송 전에 남긴다.
        appendAudit(deps.db, "slack:user", "slack_mention_received", stored.id, {
          target: targetAgent.id,
          channel: slackChannel,
        });
        appendAuditFile("slack:user", "slack_mention_received", stored.id, {
          target: targetAgent.id,
          channel: ev.channel,
        });
      },
    },
  );
  if (!accepted.ok) return; // Slack often resends; also collapses cross-webhook fan-out.
  const stored = accepted.stored;

  // Auto-inject into the target's tmux session so the running Claude Code session processes immediately.
  if (targetAgent.runtime === "claude_channel" && targetAgent.tmux_session) {
    const injected = await injectPrompt({
      session: targetAgent.tmux_session,
      fromLabel: ev.user ? `slack:${ev.user}` : "slack:user",
      locale: getLocale(deps.db),
      threadId: thread_id,
      messageId: stored.id,
      body: cleanBody,
      source: "slack",
      kind: "slack", // 슬랙 봉투 kind는 slack이다. 팀원은 broadcast로 답하고 릴레이가 원래 채널에 전달한다.
      agentId: targetAgent.id,
    });
    // injectPrompt는 객체를 반환하므로 객체의 참 여부가 아니라 ok를 검사해야 실패를 감지할 수 있다.
    appendAudit(deps.db, "system", injected.ok ? "tmux_inject_ok" : "tmux_inject_failed", stored.id, {
      session: targetAgent.tmux_session,
      maybePartial: injected.maybePartial ?? false,
    });
  } else if (targetAgent.runtime === "openclaw") {
    void runOpenclawSlackTurn({
      agent: targetAgent,
      slackUserId: ev.user,
      channel: slackChannel,
      locale: getLocale(deps.db),
      threadId: thread_id,
      messageId: stored.id,
      body: cleanBody,
    })
      .then(async (reply) => {
        // 턴 본문은 자동 게시하지 않는다. 팀원이 POST /team/api/inbox로 보낸 메시지만 슬랙 스레드에 릴레이한다.
        appendAuditFile(targetAgent.id, "turn_completed_no_autopost", stored.id, {
          thread_id, surface: "slack", chars: reply.length,
        });
      })
      .catch((e) => {
        const detail = {
          agent: targetAgent.id,
          error: e instanceof Error ? e.message : String(e),
        };
        appendAudit(deps.db, "system", "openclaw_inject_failed", stored.id, detail);
        appendAuditFile("system", "openclaw_inject_failed", stored.id, detail);
      });
  } else if (targetAgent.runtime === "hermes_agent") {
    // Hermes 게이트웨이는 Telegram 직결이므로 Slack 멘션은 별도 팀 턴 경로로 전달한다.
    // runHermesTeamTurn(headless hermes CLI one-shot)으로 응답 생성 → slack thread로 relay. (openclaw 분기와 동일 패턴.)
    void runHermesTeamTurn({
      agent: targetAgent,
      fromLabel: ev.user ?? "slack",
      // Slack 유저 ID는 팀원 주소가 아니므로 답장 수신자로 만들지 않는다. 이 스레드로 보낸 버스 답장을 원래 채널에 릴레이한다.
      replyRoute: { kind: "slack" },
      locale: getLocale(deps.db),
      threadId: thread_id,
      messageId: stored.id,
      body: cleanBody,
    })
      .then(async (reply) => {
        // 턴 본문은 자동 게시하지 않는다. 팀원이 POST /team/api/inbox로 보낸 메시지만 슬랙 스레드에 릴레이한다.
        appendAuditFile(targetAgent.id, "turn_completed_no_autopost", stored.id, {
          thread_id, surface: "slack", chars: reply.length,
        });
      })
      .catch((e) => {
        const detail = { agent: targetAgent.id, error: e instanceof Error ? e.message : String(e) };
        appendAudit(deps.db, "system", "hermes_inject_failed", stored.id, detail);
        appendAuditFile("system", "hermes_inject_failed", stored.id, detail);
      });
  }
}
