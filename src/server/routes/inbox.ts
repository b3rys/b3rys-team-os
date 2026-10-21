import { createHash } from "node:crypto";
import { CogsDeliveryUnknown, sendCogsReply } from "../lib/cogsRelay";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  envelopeInboundSchema,
  type EnvelopeInbound,
} from "../../shared/envelopeSchema";
import {
  inboxFor,
  markRead,
  getThread,
  listThreads,
  findSlackMetaForThread,
  findCogsMetaForThread,
  agentActivity,
  acceptInbound,
  normalizeEscapedNewlines,
} from "../db/inboxQueries";
import { coordinatorId } from "../lib/capabilities";
import { appendAudit } from "../db/queries";
import { recordReportDelivery } from "../bus/deliveryRecord";
import { appendAuditFile } from "../lib/auditFile";
import { maybeCreatePendingFollowup, createSelfFollowup } from "../bus/followupTracker";
import { broadcastRecipientIds, isTeamOfficialMember } from "../lib/agentMembership";
import { ambientAgents } from "../lib/registry";
import { lateAnswerPush } from "../mcp/mcpAsk";

import { MAX_HOPS_DEFAULT, RESERVED_AGENT_IDS } from "../../shared/envelopeSchema";
import { loadAgentCreds } from "../lib/slack";
import { getCaptureGroupId } from "../lib/captureConfig";
import { getChannel } from "../channels/registry";
import type { WsEvent, AgentRecord } from "../types";
import { appendDeadReceiverNote, buildDeadReceiverNote, isTelegramChannel, isTelegramReceiverDown, pickReplyRecipient } from "../lib/deadReceiverNote";

interface InboxRouteDeps {
  db: Database;
  broadcast: (e: WsEvent) => void;
  registeredAgentIds: () => Set<string>;
  /** [B] 릴레이용 — 팀원 본인의 봇으로 텔레그램에 게시하려면 AgentRecord(토큰)가 필요하다. */
  agents?: () => AgentRecord[];
  /** direct_to_gd 릴레이 직전 발신자 텔레그램 수신 판정. 기본 = 런타임 essentials 의 poller 항목. 시험 주입용. */
  receiverDown?: (agent: AgentRecord) => boolean | Promise<boolean>;
  /** cogs 팀원끼리 대화 중계를 깨운다(그 thread 대조·전송). 없으면 아무 일도 없다 — 버스 동작과 무관한 부가 기능. */
  onCogsThreadActivity?: (threadId: string) => void;
}

/** 팀장 DM chat id (setting). 없으면 --direct-to-gd 릴레이 불가. */
function ownerDmChatId(db: Database): string | undefined {
  const row = db.prepare("SELECT value FROM setting WHERE key='owner_chat_id'").get() as { value?: string } | undefined;
  return row?.value || undefined;
}

export function createInboxRoutes(deps: InboxRouteDeps): Hono {
  const r = new Hono();

  // POST /api/inbox — validate envelope, ensure thread, insert message
  r.post("/inbox", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const parsed = envelopeInboundSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "schema_validation", issues: parsed.error.issues }, 400);
    }
    let env: EnvelopeInbound & { explicit_recipients?: string[] } = parsed.data;
    // Validate agent ids against registry (except special values)
    const known = deps.registeredAgentIds();
    const reserved = RESERVED_AGENT_IDS; // 단일 출처(shared/envelopeSchema) — 가짜 입구도 같은 것을 쓴다
    if (!reserved.has(env.from_agent_id) && !known.has(env.from_agent_id)) {
      return c.json({ error: "unknown_from_agent", id: env.from_agent_id }, 400);
    }
    if (!reserved.has(env.to_agent_id) && !known.has(env.to_agent_id)) {
      return c.json({ error: "unknown_to_agent", id: env.to_agent_id }, 400);
    }
    // system·moderator에는 수신자 행이 생기지 않으므로 거절하고 올바른 답장 주소를 안내한다. 방과 팀장 경로는 허용한다.
    if (env.source === "agent" && (env.to_agent_id === "system" || env.to_agent_id === "moderator")) {
      appendAudit(deps.db, env.from_agent_id, "send_to_nonperson_blocked", null, { to: env.to_agent_id });
      return c.json(
        {
          error: "not_a_recipient",
          id: env.to_agent_id,
          detail: `'${env.to_agent_id}' 은(는) 사람이 아니라 받을 수 없다. 알림에는 답하는 게 아니다.`,
          next: "이 일을 시킨 사람에게 보내라 — 알림이 답 주소를 이미 알려줬다(주입문의 '답:' 줄). 알림 자체엔 답하지 않는다.",
        },
        400,
      );
    }
    // 프로토콜 에러 — 오용을 그 자리에서 잡아 고치게 한다.
    //   send.sh 는 서버가 ok:false 로 돌려주면 그 detail 을 발신자에게 그대로 보여준다(전 런타임 공통).
    {
      const replyMode = (env as { meta?: { reply_mode?: string } }).meta?.reply_mode;
      // 자기 전송은 실제 수신자가 없으므로 direct_to_gd여도 거절한다.
      if (env.from_agent_id === env.to_agent_id) {
        appendAudit(deps.db, env.from_agent_id, "protocol_self_report", null, { to: env.to_agent_id });
        return c.json({
          ok: false,
          error: "protocol_self_report",
          detail: `✖ 프로토콜 오류: 자기 자신(${env.to_agent_id})에게는 보고할 수 없습니다 — 어디에도 안 갑니다(메모일 뿐). ` +
            `→ 종합/보고는 요청자에게 \`--to <요청자>\`, 또는 GD께 \`--direct-to-gd\` 로 보내세요.`,
        }, 400);
      }
      // direct_to_gd는 받은 요청에 대한 보고이므로 in_reply_to가 필요하다. 연결 없는 위임·잘못된 보고는 거절한다.
      if (replyMode === "direct_to_gd" && !env.in_reply_to) {
        appendAudit(deps.db, env.from_agent_id, "protocol_direct_to_gd_on_delegation", null, { to: env.to_agent_id });
        return c.json({
          ok: false,
          error: "protocol_direct_to_gd_on_delegation",
          detail: `✖ 프로토콜 오류: \`--direct-to-gd\` 는 GD께 하는 '최종 보고' 전용입니다(받은 요청에 답 = --in-reply-to 필요). ` +
            `이게 ${env.to_agent_id} 에게 보내는 '위임' 이라면 → 플래그를 빼고 \`--to ${env.to_agent_id}\` 로 보내세요. ` +
            `"GD께 직접 보고하라"는 지시는 본문에 쓰고, 그 보고는 ${env.to_agent_id} 가 자기 답에 \`--direct-to-gd\` 를 붙입니다.`,
        }, 400);
      }
    }

    // Phase 2a: hop_count enforcement (defense-in-depth beyond zod max)
    const maxHop = env.max_hop ?? MAX_HOPS_DEFAULT;
    if ((env.hop_count ?? 0) > maxHop) {
      appendAudit(deps.db, env.from_agent_id, "hop_limit_exceeded", null, { hop: env.hop_count });
      return c.json({ error: "ttl_exceeded", max_hops: maxHop, your_hop: env.hop_count }, 400);
    }

    // 답장의 hop_count는 부모+1 이상이어야 하므로 누락된 증가분을 서버에서 보정한다. 더 큰 발신 값은 유지한다.
    if (env.source === "agent" && env.in_reply_to) {
      const parentRow = deps.db
        .prepare(`SELECT hop_count FROM message WHERE id = ?`)
        .get(env.in_reply_to) as { hop_count: number } | undefined;
      if (parentRow) {
        const correctedHop = parentRow.hop_count + 1;
        if ((env.hop_count ?? 0) < correctedHop) {
          env = { ...env, hop_count: correctedHop };
        }
      }
    }
    // thread_id가 없는 답장은 부모 스레드를 이어받아 같은 대화의 이력이 갈라지지 않게 한다.
    if (!env.thread_id && env.in_reply_to) {
      const parentThread = deps.db
        .prepare(`SELECT thread_id FROM message WHERE id = ?`)
        .get(env.in_reply_to) as { thread_id: string } | undefined;
      if (parentThread?.thread_id) env = { ...env, thread_id: parentThread.thread_id };
    }
    let allHandsEligibleRecipients: string[] | null = null;

    // all_hands는 발신 source와 무관하게 사유와 정식·활성 명부 자격을 검사한다. 이는 발신자 인증을 대신하지 않는다.
    // 슬랙 답장은 broadcast가 유일한 릴레이 경로이므로 제외하며, 팀장 @all은 별도 라우터에서 판정한다.
    if (env.to_agent_id === "broadcast" && env.all_hands) {
      const roster = deps.agents?.() ?? ambientAgents();
      const sender = roster.find((agent) => agent.id === env.from_agent_id);
      if (!sender) {
        const detail = { reason: env.all_hands, error: "sender_missing_from_registry", identity_basis: "claimed_from_agent_id" };
        appendAudit(deps.db, env.from_agent_id, "agent_all_hands_blocked", null, detail);
        appendAuditFile(env.from_agent_id, "agent_all_hands_blocked", null, detail);
        return c.json({
          error: "all_hands_roster_unavailable",
          detail: "전체공지 발신자 자격을 명부에서 확인할 수 없습니다. 명부를 복구한 뒤 다시 보내세요.",
        }, 503);
      }
      if (!isTeamOfficialMember(sender) || sender.enabled === false) {
        const detail = {
          reason: env.all_hands,
          team_official_member: isTeamOfficialMember(sender),
          enabled: sender.enabled !== false,
          identity_basis: "claimed_from_agent_id",
        };
        appendAudit(deps.db, env.from_agent_id, "agent_all_hands_blocked", null, detail);
        appendAuditFile(env.from_agent_id, "agent_all_hands_blocked", null, detail);
        return c.json({
          error: "all_hands_sender_ineligible",
          detail: "전체공지는 정식·활성 팀원만 보낼 수 있습니다.",
        }, 403);
      }
      allHandsEligibleRecipients = broadcastRecipientIds(roster, env.from_agent_id);
      env = { ...env, explicit_recipients: allHandsEligibleRecipients };
    }

    // 답 대상 원글의 Slack 주소가 명시된 경우 버스 thread보다 우선한다.
    const parentMetaRow = env.in_reply_to ? deps.db
      .prepare("SELECT meta_json FROM message WHERE id = ?")
      .get(env.in_reply_to) as { meta_json: string | null } | undefined : undefined;
    let parentSlack: ReturnType<typeof findSlackMetaForThread> = null;
    try {
      const slack = JSON.parse(parentMetaRow?.meta_json ?? "null")?.slack;
      if (typeof slack?.channel === "string" && slack.channel &&
          typeof slack?.thread_ts === "string" && slack.thread_ts) {
        parentSlack = slack;
      }
    } catch { /* 잘못된 원글 meta는 기존 thread 조회로 처리한다. */ }
    const cogsMetaForGate = parentSlack ? null : findCogsMetaForThread(deps.db, env.thread_id ?? "", env.in_reply_to);
    if (cogsMetaForGate && env.source === "agent" && (env.meta?.reply_mode === "direct_to_gd" || env.all_hands)) {
      return c.json({ ok: false, error: "cogs_reply_mode_invalid", detail: "cogs → --to broadcast" }, 400);
    }
    const slackMetaForGate = parentSlack ?? findSlackMetaForThread(deps.db, env.thread_id ?? "");
    if (env.source === "agent" && env.to_agent_id === "broadcast" && !slackMetaForGate && !cogsMetaForGate) {
      // 팀원 broadcast에 broadcast로 답하는 것은 발신자의 역량·역할과 무관하게 차단해 연쇄를 끊는다.
      if (env.in_reply_to) {
        const parent = deps.db
          .prepare(`SELECT to_agent_id, source, from_agent_id FROM message WHERE id = ?`)
          .get(env.in_reply_to) as { to_agent_id?: string; source?: string; from_agent_id?: string } | undefined;
        // 부모가 팀장(source=user)이면 방 답장을 허용한다. 팀원 broadcast에 대한 답장만 연쇄 차단 대상이다.
        const parentIsLeadCall = parent?.source === "user";
        if (parent?.to_agent_id === "broadcast" && !parentIsLeadCall) {
          return c.json({
            error: "broadcast_reply_to_broadcast",
            detail: "broadcast 에 대한 답은 broadcast 로 보내지 않습니다. 발신자에게 --to <이름>, 팀장님께는 --direct-to-gd 로 보내십시오.",
          }, 403);
        }
      }
    }

    // cogs idempotency is scoped to the original room/message, never caller-supplied keys.
    if (cogsMetaForGate && env.source === "agent" && env.to_agent_id === "broadcast") {
      const key = "cogs-reply:" + createHash("sha256").update(JSON.stringify([
        env.from_agent_id, cogsMetaForGate.agent_id, cogsMetaForGate.chat_id,
        cogsMetaForGate.message_id, normalizeEscapedNewlines(env.body),
      ])).digest("hex");
      const prior = deps.db.query(`SELECT id, meta_json FROM message WHERE dedupe_key = ?
        AND (json_extract(meta_json, '$.cogs_delivery.state') IN ('pending','unknown')
          OR created_at > datetime('now', '-60 seconds')) ORDER BY rowid DESC LIMIT 1`)
        .get(key) as { id: string; meta_json: string } | null;
      if (prior) {
        const state = JSON.parse(prior.meta_json).cogs_delivery?.state;
        return c.json({ ok: false, posted: state === "sent", existing_message_id: prior.id,
          error: state === "unknown" ? "cogs_delivery_unknown" : state === "pending" ? "cogs_delivery_pending" : "duplicate" }, 409);
      }
      env = { ...env, dedupe_key: key, meta: { ...env.meta, cogs_delivery: { state: "pending" } } };
    }

    // 감사 기록은 삽입 직후·방송 직전에 남겨 insert→audit→broadcast 순서를 유지한다.
    const accepted = acceptInbound(deps.db, env, {
      dedupeWindowSec: 60,
      broadcast: deps.broadcast,
      onInserted: (stored) => {
        // 팀원끼리 대화 중계(부가): 저장 직후 빠른 길. 실패·누락은 주기 대조가 채운다.
        try { deps.onCogsThreadActivity?.(stored.thread_id); } catch { /* 버스 저장을 막지 않는다 */ }
        const auditDetail = { thread_id: stored.thread_id, to: env.to_agent_id, type: env.type };
        appendAudit(deps.db, env.from_agent_id, "message_sent", stored.id, auditDetail);
        appendAuditFile(env.from_agent_id, "message_sent", stored.id, auditDetail);
        if (allHandsEligibleRecipients) {
          const recipientIds = (deps.db
            .prepare(`SELECT agent_id FROM message_recipient WHERE message_id = ? ORDER BY agent_id`)
            .all(stored.id) as Array<{ agent_id: string }>).map((row) => row.agent_id);
          const zeroReason = recipientIds.length > 0
            ? null
            : allHandsEligibleRecipients.length === 0
              ? "sender_only"
              : "registry_db_out_of_sync";
          const allHandsDetail = {
            reason: env.all_hands,
            recipient_ids: recipientIds,
            recipient_count: recipientIds.length,
            eligible_recipient_count: allHandsEligibleRecipients.length,
            zero_reason: zeroReason,
            identity_basis: "claimed_from_agent_id",
          };
          appendAudit(deps.db, env.from_agent_id, "agent_broadcast_all_hands", stored.id, allHandsDetail);
          appendAuditFile(env.from_agent_id, "agent_broadcast_all_hands", stored.id, allHandsDetail);
        }
        // 발신 도구를 통해 보내는 에이전트의 전달 기록도 남겨 런타임 간 관측 기준을 맞춘다.
        // 직접 삽입하는 어댑터는 이 경로를 지나지 않아 이중 기록되지 않는다.
        if (env.source === "agent") {
          recordReportDelivery(deps.db, {
            actor: env.from_agent_id,
            channel: "bus",
            recipient: env.to_agent_id,
            threadId: stored.thread_id,
            refId: stored.id,
            body: env.body,
            ok: true,
          });
        }
      },
    });
    if (!accepted.ok) {
      return c.json({ error: "duplicate", existing_message_id: accepted.duplicate, dedupe_window_sec: 60 }, 409);
    }
    const stored = accepted.stored;

    // direct_to_gd·expect_report_by가 있고 수신자가 단발 런타임이면 미보고 1회 재알림을 등록한다. 일반 팀원 요청과 상시 세션은 제외한다.
    {
      const meta = (env as { meta?: { expect_report_by?: unknown; reply_mode?: unknown } }).meta;
      const expectReportBy = meta?.expect_report_by;
      const replyMode = typeof meta?.reply_mode === "string" ? meta.reply_mode : null;
      if (typeof expectReportBy === "string" && expectReportBy.trim() !== "") {
        try {
          const pfId = maybeCreatePendingFollowup(deps.db, {
            toAgentId: env.to_agent_id,
            threadId: stored.thread_id,
            sourceMessageId: stored.id,
            expectReportBy,
            replyMode,
          });
          if (pfId) {
            appendAudit(deps.db, env.from_agent_id, "followup_tracked", stored.id, {
              followup_id: pfId,
              recipient: env.to_agent_id,
              expect_report_by: expectReportBy,
            });
          }
        } catch (e) {
          // never fail the send because follow-up bookkeeping errored
          appendAudit(deps.db, env.from_agent_id, "followup_track_failed", stored.id, {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }



    // cogs threads never fall through to Telegram, including malformed reply modes.
    if (cogsMetaForGate && env.source === "agent" && stored.to_agent_id === "broadcast") {
      const setDelivery = (state: "sent" | "failed" | "unknown", messageId?: number) => {
        stored.meta = { ...stored.meta, cogs_delivery: messageId !== undefined ? { state, message_id: messageId } : { state } };
        deps.db.query("UPDATE message SET meta_json = ?, dedupe_key = CASE WHEN ? = 'failed' THEN NULL ELSE dedupe_key END WHERE id = ?")
          .run(JSON.stringify(stored.meta), state, stored.id);
      };
      // Until success is durably recorded, a lost acknowledgement must not permit a resend.
      let acknowledged = false;
      try {
        const agent = (deps.agents?.() ?? ambientAgents()).find((a) => a.id === env.from_agent_id);
        const postedId = await sendCogsReply(agent, cogsMetaForGate, stored.body);
        acknowledged = true;
        setDelivery("sent", postedId);
        // 팀원끼리 대화 중계: 원래 담당의 답이 방에 올라갔다 = 종료 사건. 대조·전송을 깨운다(실패해도 답은 이미 갔다).
        try { deps.onCogsThreadActivity?.(stored.thread_id); } catch { /* 부가 기능 */ }
        appendAudit(deps.db, env.from_agent_id, "cogs_relay_sent", stored.id, { chat_id: cogsMetaForGate.chat_id });
        return c.json({ ok: true, message: stored, posted: true, channel: "cogs" }, 201);
      } catch (error) {
        const unknown = acknowledged || error instanceof CogsDeliveryUnknown;
        setDelivery(unknown ? "unknown" : "failed");
        appendAudit(deps.db, env.from_agent_id, "cogs_relay_failed", stored.id, { chat_id: cogsMetaForGate.chat_id, state: unknown ? "unknown" : "failed" });
        return c.json({ ok: false, message: stored, posted: false,
          error: unknown ? "cogs_delivery_unknown" : "cogs_relay_failed" }, 502);
      }
    }

    // Slack 게시 완료를 확인한 뒤 성공을 반환한다. 같은 답을 Telegram으로도 보내지 않는다.
    const slackThread = slackMetaForGate ?? findSlackMetaForThread(deps.db, stored.thread_id);
    if (env.source === "agent" && env.from_agent_id !== "user" && env.from_agent_id !== "system") {
      const slackMeta = slackThread;
      if (slackMeta && stored.to_agent_id === "broadcast" && env.meta?.reply_mode !== "direct_to_gd") {
        try {
          const creds = loadAgentCreds(env.from_agent_id);
          if (!creds) throw new Error("slack_credentials_missing");
          // 슬랙 멘션은 채널 발송 직전에 붙여 저장 본문을 채널 중립으로 둔다.
          // slack_mentions는 외부 입력이므로 배열 여부를 확인해 저장 후 예외가 나는 것을 막는다.
          const rawMentions = (env as { meta?: { slack_mentions?: unknown } }).meta?.slack_mentions;
          // 개수 상한: 멘션 하나가 알림 하나다. 상한이 없으면 한 메시지로 워크스페이스 전체를 울릴 수 있다.
          const MAX_MENTIONS = 10;
          const prefix = [slackMeta.slack_user_id, ...(Array.isArray(rawMentions) ? rawMentions : [])]
            .filter((m): m is string => typeof m === "string" && /^[UW][A-Z0-9]+$/.test(m))
            .filter((id, i, arr) => arr.indexOf(id) === i)    // 같은 사람을 두 번 부르지 않는다
            .filter((id) => !env.body.includes(`<@${id}>`))   // 본문에 이미 있으면 중복 안 붙인다
            .slice(0, MAX_MENTIONS)
            .map((id) => `<@${id}>`)
            .join(" ");
          // 멘션은 자기 줄에 — 같은 줄이면 본문이 ``` 로 시작할 때 여는 펜스가 줄 맨 앞이 아니게 된다.
          const slackText = prefix ? `${prefix}\n${env.body}` : env.body;
          const posted = await getChannel("slack")
            .send({
              botToken: creds.bot_token,
              target: slackMeta.channel,
              text: slackText,
              threadRef: slackMeta.thread_ts,
            });
          if (!posted.ok || !posted.ts) throw new Error(posted.error ?? "slack_post_missing_ts");
          stored.meta = { ...stored.meta, slack_ts: posted.ts };
          deps.db.prepare("UPDATE message SET meta_json = ? WHERE id = ?")
            .run(JSON.stringify(stored.meta), stored.id);
          appendAudit(deps.db, env.from_agent_id, "slack_relay_sent", stored.id, {
            ok: true, ts: posted.ts, channel: slackMeta.channel, thread_ts: slackMeta.thread_ts,
            mentions: prefix,
          });
          return c.json({ ok: true, message: stored, posted: true }, 201);
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          appendAudit(deps.db, env.from_agent_id, "slack_relay_failed", stored.id, {
            ok: false, error, channel: slackMeta.channel, thread_ts: slackMeta.thread_ts,
          });
          return c.json({ ok: false, message: stored, posted: false,
            error: "slack_relay_failed", detail: error }, 502);
        }
      }
    }

    // broadcast는 설정된 방에, direct_to_gd는 팀장 DM에 게시한다. 팀원 directed 메시지는 버스에서만 전달한다.
    // 턴 본문은 자동 게시하지 않으며, 채널 발송은 이 명시적 전송 경로를 사용한다.
    if (env.source === "agent" && env.from_agent_id !== "user" && env.from_agent_id !== "system") {
      const agent = deps.agents?.().find((a) => a.id === env.from_agent_id);
      if (agent) {
        const mode = (env as { meta?: { reply_mode?: string } }).meta?.reply_mode;
        // 캡처와 릴레이는 getCaptureGroupId를 공유해야 대시보드에서 바꾼 그룹 파일을 함께 읽는다. 파일이 env보다 우선이다.
        const groupId = getCaptureGroupId() ?? "";
        let dest: { chatId: string; kind: "telegram_group" | "telegram_dm" } | null = null;
        // 기본은 stored.body 다 ("저장된 것 = 보낸 것"). MCP 늦은 답만 원 질문을 앞에 덧붙인다 —
        //   번호만으로는 사람이 "무슨 질문의 답인지" 를 못 알아본다.
        let relayText: string | null = null;
        if (mode === "direct_to_gd") {
          // 위임에 direct_to_gd 오마킹은 여기 오기 전에 거부된다 (프로토콜 에러, 위 조기검증 —
          //   direct_to_gd + in_reply_to 없음 → 400). 그래서 여기 오는 direct_to_gd 는 정상 보고(in_reply_to 있음)뿐.
          const dm = ownerDmChatId(deps.db);
          if (dm) {
            dest = { chatId: dm, kind: "telegram_dm" };
            // 텔레그램 발신 봇의 수신이 중단되면 답장을 못 받으므로 게시 텍스트에만 경고를 붙인다.
            // 저장 본문은 보존하고 판정 실패는 경고 없이 처리한다. 다른 채널은 텔레그램 poller 검사에서 제외한다.
            const down = isTelegramChannel(agent) && await Promise.resolve()
              .then(() => (deps.receiverDown ?? isTelegramReceiverDown)(agent))
              .catch(() => false);
            if (down) {
              const replyTo = pickReplyRecipient(deps.agents?.() ?? [], agent.id);
              relayText = appendDeadReceiverNote(stored.body, buildDeadReceiverNote(agent, replyTo));
              appendAuditFile(env.from_agent_id, "direct_to_gd_receiver_down_note", stored.id, { reply_to: replyTo?.id ?? null });
            }
          }
          // 슬랙 스레드는 이미 슬랙으로 릴레이했으므로 텔레그램에 중복 게시하지 않는다.
          // 게시 대상은 요청 원본이 아니라 저장된 수신자·스레드를 기준으로 판단해 버스와 채널의 전달 범위를 맞춘다.
        } else if (stored.to_agent_id === "broadcast" && !slackThread) {
          // broadcast는 스레드 이름과 무관하게 설정된 그룹으로 게시한다. 이름 접두사로 제한하면 저장 성공에도 채널 전달이 누락된다.
          if (!groupId) {
            // 그룹이 설정 안 됐으면 조용히 성공이라고 하지 않는다. 그게 36건을 삼킨 방식이다.
            appendAuditFile(env.from_agent_id, "telegram_relay_failed", stored.id, {
              kind: "telegram_group",
              error: "capture_group_not_configured",
            });
            return c.json(
              { ok: false, message: stored, posted: false, error: "capture_group_not_configured", next: "재시도 금지. 단톡방 게시가 실패했습니다 — 팀장님께 1:1 DM 으로 알리세요." },
              502,
            );
          }
          dest = { chatId: groupId, kind: "telegram_group" };
        } else {
          // MCP 호출 종료 후 도착한 답만 mcpAsk.lateAnswerPush에서 판정해 평소 채널로 보낸다.
          // 원 질문의 MCP 경로·지정 응답자를 확인하며, 대기 호출이 있으면 중복 push하지 않는다.
          const late = lateAnswerPush(deps.db, stored);
          if (late && "skipped" in late) {
            // 리드가 아닌 요청자의 늦은 답을 리드 DM에 보내지 않는다. 감사 기록을 남기며 b3os_fetch_answer로 회수할 수 있다.
            appendAuditFile(env.from_agent_id, "mcp_late_answer_skipped", stored.id, {
              request_id: late.requestId,
              asker: late.asker,
              reason: "asker_is_not_lead",
            });
          } else if (late) {
            const dm = ownerDmChatId(deps.db);
            if (dm) {
              dest = { chatId: dm, kind: "telegram_dm" };
              relayText = late.text;
            } else {
              // 조용히 삼키지 않는다 — DM 이 설정 안 됐으면 답이 어디에도 안 뜬다(회수는 여전히 가능).
              appendAuditFile(env.from_agent_id, "mcp_late_answer_undeliverable", stored.id, {
                request_id: late.requestId,
                error: "owner_dm_not_configured",
              });
            }
          }
        }
        if (dest) {
          const d = dest;
          // 개행 정규화가 반영된 stored.body를 보내고 게시 결과를 기다려 저장 성공과 채널 전달 성공을 구분한다.
          // 실패는 응답에 알리며 자동 재시도하지 않는다. 발신자는 반복 전송 대신 팀장에게 별도 DM으로 알린다.
          const r = await getChannel("telegram").send({ agent, target: d.chatId, text: relayText ?? stored.body });
          appendAuditFile(env.from_agent_id, r.ok ? "telegram_relay_sent" : "telegram_relay_failed", stored.id, {
            target: d.chatId,
            kind: d.kind,
            // 실패 사유를 응답에 포함해야 게시 실패의 원인을 확인할 수 있다. telegramBotSend는 토큰을 제외한 오류 문자열을 반환한다.
            error: r.ok ? null : (r.error ?? "unknown"),
          });
          recordReportDelivery(deps.db, {
            actor: env.from_agent_id,
            channel: d.kind,
            recipient: d.kind === "telegram_dm" ? "gd" : d.chatId,
            threadId: stored.thread_id,
            refId: stored.id,
            body: stored.body,   // 기록도 실제로 보낸 것과 같아야 한다
            ok: r.ok,
            error: r.ok ? null : (r.error ?? "telegram_send_failed"),
          });
          if (!r.ok) {
            // DB 에는 남기고(기록은 사실이다), 팀원에게는 '게시 실패' 를 알린다.
            return c.json(
              { ok: false, message: stored, posted: false, error: r.error ?? "telegram_send_failed", next: "재시도 금지. 단톡방 게시가 실패했습니다 — 팀장님께 1:1 DM 으로 알리세요." },
              502,
            );
          }
          return c.json({ ok: true, message: stored, posted: true }, 201);
        }
      }
    }

    return c.json({ ok: true, message: stored }, 201);
  });

  // 자가등록도 기존 pending_followup의 1회성 재알림·보고 감지·정리를 사용한다. 게이트 탈락은 422와 reason으로 알린다.
  r.post("/followup/self", async (c) => {
    const body = await c.req.json().catch(() => null);
    const agentId = typeof body?.agent_id === "string" ? body.agent_id.trim() : "";
    const threadId = typeof body?.thread_id === "string" ? body.thread_id.trim() : "";
    if (!agentId || !threadId) return c.json({ ok: false, reason: "agent_id_and_thread_id_required" }, 400);
    if (!deps.db.prepare("SELECT 1 FROM agent WHERE id = ?").get(agentId))
      return c.json({ ok: false, reason: "unknown_agent" }, 404);
    const duration = typeof body?.duration === "string" ? body.duration : null;
    const result = createSelfFollowup(deps.db, { agentId, threadId, duration });
    if (!result.ok) return c.json(result, 422);
    appendAudit(deps.db, agentId, "followup_self_registered", result.id, {
      thread_id: threadId,
      deadline_at: result.deadlineAt,
    });
    return c.json(result, 201);
  });

  // 명시적 취소 — 보고를 마쳤거나 필요 없어졌을 때 스스로 정리한다 (미발화 자가등록 row 만 삭제).
  r.delete("/followup/self", async (c) => {
    const body = await c.req.json().catch(() => null);
    const agentId = typeof body?.agent_id === "string" ? body.agent_id.trim() : "";
    const threadId = typeof body?.thread_id === "string" ? body.thread_id.trim() : "";
    if (!agentId || !threadId) return c.json({ ok: false, reason: "agent_id_and_thread_id_required" }, 400);
    const res = deps.db
      .prepare(
        `DELETE FROM pending_followup
         WHERE recipient_agent_id = ? AND thread_id = ? AND fired = 0 AND source_message_id LIKE 'selfreg_%'`,
      )
      .run(agentId, threadId);
    return c.json({ ok: true, cancelled: res.changes });
  });

  // GET /api/inbox/:agent_id — unread for that agent
  r.get("/inbox/:agent_id", (c) => {
    const id = c.req.param("agent_id");
    const limitParam = z.coerce.number().int().min(1).max(200).default(50).safeParse(c.req.query("limit"));
    const limit = limitParam.success ? limitParam.data : 50;
    const messages = inboxFor(deps.db, id, limit);
    return c.json({ agent_id: id, count: messages.length, messages });
  });

  // PATCH /api/inbox/:message_id/read?agent_id=<id>
  // agent_id is required to ack a broadcast (per-agent read); optional for direct messages.
  r.patch("/inbox/:message_id/read", (c) => {
    const id = c.req.param("message_id");
    const agentId = c.req.query("agent_id") || undefined;
    const ok = markRead(deps.db, id, agentId);
    if (!ok) return c.json({ ok: false, error: "not_found_or_already_read" }, 404);
    appendAudit(deps.db, "system", "message_read", id, null);
    deps.broadcast({ type: "message_read", message_id: id });
    return c.json({ ok: true });
  });

  // GET /api/threads
  r.get("/threads", (c) => {
    const limitParam = z.coerce.number().int().min(1).max(200).default(50).safeParse(c.req.query("limit"));
    const limit = limitParam.success ? limitParam.data : 50;
    const threads = listThreads(deps.db, limit);
    return c.json({
      count: threads.length,
      threads: threads.map((t) => ({
        ...t,
        participants: JSON.parse(t.participants_json),
        participants_json: undefined,
        state_json: t.state_json ? JSON.parse(t.state_json) : null,
      })),
    });
  });

  // GET /api/threads/:id — thread + all messages
  r.get("/threads/:id", (c) => {
    const id = c.req.param("id");
    const t = getThread(deps.db, id);
    if (!t) return c.json({ error: "not_found" }, 404);
    return c.json({
      thread: {
        ...t.thread,
        participants: JSON.parse(t.thread.participants_json),
        participants_json: undefined,
        state_json: t.thread.state_json ? JSON.parse(t.thread.state_json) : null,
      },
      messages: t.messages,
    });
  });

  // GET /api/messages/:id — 단일 메시지 조회. reply.sh 가 message_id 만으로 from(답장 대상)·thread 를
  // 해석해 올바른 주소(to=요청자 + in_reply_to)로 답장하게 한다(팀 커뮤니케이션 V1.0 — 주소 정확히).
  r.get("/messages/:id", (c) => {
    const id = c.req.param("id");
    const m = deps.db
      .prepare(
        `SELECT id, thread_id, from_agent_id, to_agent_id, type, body, in_reply_to, created_at
         FROM message WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!m) return c.json({ error: "not_found", id }, 404);
    // 비동기 디스패처의 실제 배달 판정은 수신자별 delivery_state와 last_error로 확인한다. delivery_status·recipient_state는 미배달에도 성공처럼 기록될 수 있다.
    const recipients = deps.db
      .prepare(
        `SELECT agent_id, delivery_state, last_error, retry_count
         FROM message_recipient WHERE message_id = ? ORDER BY agent_id`,
      )
      .all(id) as Array<Record<string, unknown>>;
    // 빈 recipients는 수신자 0명을 뜻한다. 버스 밖 전달은 채널 수락 후 기록된 감사 결과를 함께 제공하되, 읽음 여부까지 보장하지 않는다.
    const deliveries = deps.db
      .prepare(
        `SELECT actor, action, detail_json, at
         FROM audit_event
         WHERE target = ? AND action IN ('report_delivered', 'report_delivery_failed')
         ORDER BY at, id`,
      )
      .all(id) as Array<{ actor: string; action: string; detail_json: string | null; at: string }>;
    return c.json({
      message: m,
      recipients,
      deliveries: deliveries.map((d) => {
        let detail: { channel?: string; to?: string; error?: string } = {};
        try { detail = d.detail_json ? JSON.parse(d.detail_json) : {}; } catch { /* 기록이 깨져도 나머지는 준다 */ }
        return {
          actor: d.actor,
          channel: detail.channel ?? null,
          to: detail.to ?? null,
          ok: d.action === "report_delivered",
          error: detail.error ?? null,
          at: d.at,
        };
      }),
    });
  });

  return r;
}
