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
  agentActivity,
  acceptInbound,
} from "../db/inboxQueries";
import { appendAudit } from "../db/queries";
import { recordReportDelivery } from "../bus/deliveryRecord";
import { appendAuditFile } from "../lib/auditFile";
import { maybeCreatePendingFollowup, createSelfFollowup } from "../bus/followupTracker";

import { MAX_HOPS_DEFAULT } from "../../shared/envelopeSchema";
import { loadAgentCreds } from "../lib/slack";
import { getCaptureGroupId } from "../lib/captureConfig";
import { getChannel } from "../channels/registry";
import type { WsEvent, AgentRecord } from "../types";

interface InboxRouteDeps {
  db: Database;
  broadcast: (e: WsEvent) => void;
  registeredAgentIds: () => Set<string>;
  /** ★[B] 릴레이용★ — 팀원 본인의 봇으로 텔레그램에 게시하려면 AgentRecord(토큰)가 필요하다. */
  agents?: () => AgentRecord[];
}

/** 팀장 DM chat id (setting). 없으면 --direct-to-owner 릴레이 불가. */
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
    let env: EnvelopeInbound = parsed.data;
    // Validate agent ids against registry (except special values)
    const known = deps.registeredAgentIds();
    const reserved = new Set(["user", "system", "moderator", "broadcast"]);
    if (!reserved.has(env.from_agent_id) && !known.has(env.from_agent_id)) {
      return c.json({ error: "unknown_from_agent", id: env.from_agent_id }, 400);
    }
    if (!reserved.has(env.to_agent_id) && !known.has(env.to_agent_id)) {
      return c.json({ error: "unknown_to_agent", id: env.to_agent_id }, 400);
    }
    // ★★받을 수 없는 주소를 '정상' 이라고 받아주지 않는다.★★ (하네스 D1 — 실측 40건 증발)
    //   `system`·`moderator` 는 ★사람이 아니다★ — 수신자 행이 안 생긴다 → ★아무도 못 받는다.★
    //   그런데 reserved 목록에 있다는 이유로 위 검사를 ★건너뛰어 201 ok★ 가 나갔다.
    //   ★라이브 재현★: 서버가 hermes 에게 `--to bill` 이라고 정확히 말했는데도 hermes 는 습관대로
    //   `--to system` 을 썼고 ★서버가 받아줬다.★ → ★룰만 고치면 모델은 옛 습관으로 쓴다. 문이 막아야 한다.★
    //   ★거절만 하지 않는다★ — next 로 ★어디로 보내야 하는지★ 를 준다(막다른 길을 만들지 않는다).
    //   broadcast(방)·user(팀장 경로)는 막지 않는다.
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
    // ★프로토콜 에러 — 오용을 그 자리에서 잡아 고치게 한다.★ (OWNER 2026-07-15: "에러 + 올바른 법")
    //   send.sh 는 서버가 ok:false 로 돌려주면 그 detail 을 발신자에게 그대로 보여준다(전 런타임 공통).
    {
      const replyMode = (env as { meta?: { reply_mode?: string } }).meta?.reply_mode;
      // ① 자기 자신에게 보고 (codex→codex 2026-07-15) — direct_to_gd 여도 막는다. 자기 전송은 어디에도 안 간다.
      if (env.from_agent_id === env.to_agent_id) {
        appendAudit(deps.db, env.from_agent_id, "protocol_self_report", null, { to: env.to_agent_id });
        return c.json({
          ok: false,
          error: "protocol_self_report",
          detail: `✖ 프로토콜 오류: 자기 자신(${env.to_agent_id})에게는 보고할 수 없습니다 — 어디에도 안 갑니다(메모일 뿐). ` +
            `→ 종합/보고는 요청자에게 \`--to <요청자>\`, 또는 OWNER께 \`--direct-to-owner\` 로 보내세요.`,
        }, 400);
      }
      // ② 위임에 direct_to_gd (hermes 2026-07-15) — direct_to_gd 보고는 받은 요청에 '답' 하므로 in_reply_to 를 단다.
      //    in_reply_to 없이 direct_to_gd 면 = 새 위임에 잘못 붙였거나 보고 형식이 틀린 것. → 잡아서 고치게 한다.
      if (replyMode === "direct_to_gd" && !env.in_reply_to) {
        appendAudit(deps.db, env.from_agent_id, "protocol_direct_to_gd_on_delegation", null, { to: env.to_agent_id });
        return c.json({
          ok: false,
          error: "protocol_direct_to_gd_on_delegation",
          detail: `✖ 프로토콜 오류: \`--direct-to-owner\` 는 OWNER께 하는 '최종 보고' 전용입니다(받은 요청에 답 = --in-reply-to 필요). ` +
            `이게 ${env.to_agent_id} 에게 보내는 '위임' 이라면 → 플래그를 빼고 \`--to ${env.to_agent_id}\` 로 보내세요. ` +
            `"OWNER께 직접 보고하라"는 지시는 본문에 쓰고, 그 보고는 ${env.to_agent_id} 가 자기 답에 \`--direct-to-owner\` 를 붙입니다.`,
        }, 400);
      }
    }

    // Phase 2a: hop_count enforcement (defense-in-depth beyond zod max)
    const maxHop = env.max_hop ?? MAX_HOPS_DEFAULT;
    if ((env.hop_count ?? 0) > maxHop) {
      appendAudit(deps.db, env.from_agent_id, "hop_limit_exceeded", null, { hop: env.hop_count });
      return c.json({ error: "ttl_exceeded", max_hops: maxHop, your_hop: env.hop_count }, 400);
    }

    // v1.1 anti-pingpong server-side hop correction (issue 1 server-side booster):
    // If this is an agent reply (source='agent') with in_reply_to set, look up the parent
    // message's hop_count and correct ours to parent+1. Defends against agents that forget
    // to increment (LLM hallucination / skill version skew). Does not override if the
    // agent-supplied value is already >= parent+1.
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
    // Reply threading (2026-05-27 OWNER): no explicit thread_id + in_reply_to set → inherit the
    // parent message's thread so replies stay in the same conversation. Prevents orphaned new
    // threads (a reply was landing in a fresh thread and the recipient couldn't find it).
    if (!env.thread_id && env.in_reply_to) {
      const parentThread = deps.db
        .prepare(`SELECT thread_id FROM message WHERE id = ?`)
        .get(env.in_reply_to) as { thread_id: string } | undefined;
      if (parentThread?.thread_id) env = { ...env, thread_id: parentThread.thread_id };
    }
    // Phase 2a: dedupe(60s) + ensureThread + insertMessage + (audit) + broadcast → 공통 acceptInbound (P2)
    // audit는 onInserted(insert직후·broadcast직전)에 둬 기존 insert→audit→broadcast 순서 보존(Steve·Codex 리뷰 ②).
    const accepted = acceptInbound(deps.db, env, {
      dedupeWindowSec: 60,
      broadcast: deps.broadcast,
      onInserted: (stored) => {
        const auditDetail = { thread_id: stored.thread_id, to: env.to_agent_id, type: env.type };
        appendAudit(deps.db, env.from_agent_id, "message_sent", stored.id, auditDetail);
        appendAuditFile(env.from_agent_id, "message_sent", stored.id, auditDetail);
        // ★배달 기록 (ingress) — 에이전트가 ★자기 발신 도구로★ 보낸 것도 남긴다.★ (2026-07-13)
        //
        // ★왜 필요한가★: 서버가 대신 발송하는 런타임(게이트웨이 hermes·openclaw)만 배달 기록이 남았다.
        //   ★claude(tmux) 처럼 자기가 보내는 런타임은 report_delivered 가 ★0건★ 이다★ (실측: bill = 0).
        //   → ★게이트웨이와 상시세션(tmux)을 ★같은 자로 잴 수 없다.★★ A/B 비교가 불가능하다.
        //   그리고 ★상시세션으로 전환하면 모든 런타임이 이 상태가 된다★ → ★관측이 통째로 사라진다.★
        //
        // ★불변식(팀장·Bill 확정): "어떤 경로로 보내든 무엇을 누구에게 보냈나는 반드시 서버에 남는다."★
        //   send.sh 는 POST /inbox 를 지난다 → ★여기가 그 불변식이 실제로 지켜지는 지점이다.★
        //
        // ★사람/시스템 발신은 제외★ — 이건 '에이전트가 내보낸 것' 의 기록이다.
        // 어댑터가 직접 insert 하는 경로(게이트웨이 답변)는 ★여기를 안 지난다★ → ★이중 기록 없음.★
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

    // Pending follow-up tracker (requester-flagged, deterministic — 2026-07-10): if the sender
    // flagged this as a team-lead-destined report (meta.reply_mode='direct_to_gd') WITH
    // meta.expect_report_by AND the recipient is a one-shot runtime (openclaw/hermes — resolved from
    // the agent registry), record a follow-up so a missing report gets re-woken once. Member↔member
    // requests (no direct_to_gd) and non-one-shot recipients (claude/codex/unknown) never create a row.
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



    // Phase 2b: if this is an agent → user reply on a Slack-originated thread,
    // auto-post to the Slack thread using the agent's bot token (fire-and-forget).
    // ★이 스레드가 슬랙 스레드인가★ — 아래 텔레그램 릴레이에서도 쓴다(한 스레드의 방은 ★하나★ 다).
    const slackThread = findSlackMetaForThread(deps.db, stored.thread_id);
    if (env.source === "agent" && env.from_agent_id !== "user" && env.from_agent_id !== "system") {
      const slackMeta = slackThread;
      if (slackMeta) {
        const creds = loadAgentCreds(env.from_agent_id);
        if (creds) {
          void getChannel("slack")
            .send({
              botToken: creds.bot_token,
              target: slackMeta.channel,
              text: env.body,
              threadRef: slackMeta.thread_ts,
            })
            .then((r) => {
              appendAudit(deps.db, env.from_agent_id, r.ok ? "slack_relay_sent" : "slack_relay_failed", stored.id, {
                ok: r.ok,
                ts: r.ts,
                error: r.error,
              });
            });
        } else {
          appendAudit(deps.db, env.from_agent_id, "slack_relay_skipped_no_creds", stored.id, null);
        }
      }
    }

    // ★[B] — 팀원이 방·팀장께 ★직접★ 말하는 통로.★ (OWNER 2026-07-13 승인: "팀원한테 맡겨. 다 빼.")
    //
    // ═══ 이게 없어서 모든 게 꼬였다 ═══
    //   지금까지 팀원이 단톡방에서 말하는 ★유일한 길★ 은 ★서버가 턴 본문을 대신 게시하는 것★ 이었다.
    //   그래서 ★"말 안 하기" 가 불가능★ 해졌고 → `[NO_REPLY]` 라는 우회로가 생겼고 → 발행 지점마다 가드가
    //   붙었고 → 가드 하나를 놓치자 ★팀장 단톡방에 `[NO_REPLY]` 가 그대로 찍혔다.★ (2026-07-13 라이브)
    //   ★없는 능력을 우회로로 때운 것이 근본이었다.★ (오늘 하루 종일 나온 그 패턴)
    //   ★슬랙엔 이미 같은 릴레이가 있다(바로 위 블록). 텔레그램에만 없어서 반쪽이었다.★
    //
    // ═══ 새 불변식 ═══  ★"보낸 것만 말한 것이다."★
    //   · 방에 말하기   → `--to broadcast` (텔레그램 그룹 thread 에서) → ★여기서 단톡방에 게시★
    //   · 팀장께 보고   → `--direct-to-owner`                            → ★여기서 팀장 DM 에 게시★
    //   · 팀원에게      → `--to <id>`  = 버스. ★방엔 안 나간다 — 그게 맞다★ (팀원끼리는 함수호출)
    //   턴에 뭘 쓰든 그건 ★본인 메모★ 다. 안 보내면 아무 말도 안 한 것이다. → 침묵에 토큰이 필요없다.
    if (env.source === "agent" && env.from_agent_id !== "user" && env.from_agent_id !== "system") {
      const agent = deps.agents?.().find((a) => a.id === env.from_agent_id);
      if (agent) {
        const mode = (env as { meta?: { reply_mode?: string } }).meta?.reply_mode;
        // ★설정을 두 군데서 읽으면 언젠가 갈린다 (하네스 리뷰 2026-07-14).★
        //   캡처봇은 getCaptureGroupId() — ★파일(var/capture-group-id.txt) 먼저, env 는 폴백★ — 을 쓰는데
        //   여기만 ★env 만★ 읽었다. 팀장님이 대시보드에서 그룹을 바꾸면 파일만 바뀐다
        //   → ★캡처는 새 그룹을 읽고, 릴레이는 조용히 꺼진다★ (groupId="" → dest=null → DB 에만 남고 방엔 안 뜸).
        //   에러도 경고도 없다. → ★같은 함수를 쓴다.★
        const groupId = getCaptureGroupId() ?? "";
        let dest: { chatId: string; kind: "telegram_group" | "telegram_dm" } | null = null;
        if (mode === "direct_to_gd") {
          // ★위임에 direct_to_gd 오마킹은 여기 오기 전에 거부된다★ (프로토콜 에러, 위 조기검증 —
          //   direct_to_gd + in_reply_to 없음 → 400). 그래서 여기 오는 direct_to_gd 는 ★정상 보고★(in_reply_to 있음)뿐.
          const dm = ownerDmChatId(deps.db);
          if (dm) dest = { chatId: dm, kind: "telegram_dm" };
          // ★★슬랙 스레드의 답을 텔레그램 단톡방에 게시하지 않는다★★ (codex 리뷰 — ★내가 오늘 만든 유출★)
          //   아침까지는 텔레그램 릴레이가 `thread_id.startsWith("tg-")` 조건이라 슬랙 스레드가 ★자동 제외★ 됐다.
          //   내가 그 조건을 없애면서(맞는 방향이었다) ★슬랙 답이 팀장님 텔레그램 방으로도 새게 됐다.★
          //   ★한 스레드의 방은 하나다.★ 슬랙 스레드의 방은 슬랙이다 — 위에서 이미 슬랙으로 보냈다.
          //   (이건 이름 앞글자 추론이 아니다: findSlackMetaForThread 는 ★DB 조회★ = 사실이다.)
          // ★★env 가 아니라 stored 를 본다★★ (codex 리뷰 2026-07-14 — 배포 블로커였다)
          //   insertMessage 는 ★잘못 온 broadcast 답변을 원 요청자에게 directed 로 보정★ 한다
          //   (messages.ts:63-71 — hermes 가 수집 질문에 `--to broadcast` 로 답하는 습관이 있어서).
          //   그런데 여기서 원본 env 를 보면: ★DB 엔 비공개(directed)로 저장되는데 단톡방엔 게시★ 된다.
          //   = 수집 답변(팀원끼리 주고받는 사적 내용)이 ★팀장님 방으로 유출★ 된다.
          //   ★저장된 것과 보낸 것이 달라지면 안 된다.★ stored 가 유일한 진실이다.
        } else if (stored.to_agent_id === "broadcast" && !slackThread) {
          // ★broadcast 는 "방에 말한다" 는 뜻이다. 뜻이 하나다.★ (OWNER 2026-07-14 "기본부터 다지자")
          //
          //   예전엔 여기에 `&& stored.thread_id.startsWith("tg-")` 가 있었다. 근거는
          //   "안 그러면 팀원끼리 쓰는 브로드캐스트가 전부 팀장 방으로 쏟아진다" 였다.
          //   ★실측으로 반증됐다★ (14일): 그룹 게시 102건 vs ★조용히 사라진 것 36건(26%)★.
          //   그 36건은 스팸이 아니라 ★팀원이 팀에 하려던 말★ 이었다(대부분 hermes 의 카드 답변).
          //   ★본인은 "말했다" 고 믿고, 아무도 못 들었다.★ 하루 2.5건 — 쏟아진 적이 없다.
          //
          //   ★이게 오늘 하루 종일 쫓던 그 병이다★: 룰은 "--to broadcast 로 방에 말해라" 라고 하는데
          //   코드는 스레드 이름을 보고 조용히 버린 뒤 ★201 ok:true★ 를 돌려줬다(아래 fall-through).
          //   룰 어디에도 "tg- 로 시작해야 한다" 는 말이 없다. ★코드가 혼자 만든 개념이었다.★
          //   → ★그 개념을 지운다.★ 팀원끼리 조용히 말하는 건 이미 `--to <id>`(버스) 가 한다.
          if (!groupId) {
            // 그룹이 설정 안 됐으면 ★조용히 성공이라고 하지 않는다.★ 그게 36건을 삼킨 방식이다.
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
        }
        if (dest) {
          const d = dest;
          // ★DB 에는 고쳐진 본문이 들어갔는데, 텔레그램엔 ★원본★ 을 보내고 있었다.★ (2026-07-14 실측)
          //   acceptInbound 가 리터럴 "\n" 을 진짜 개행으로 펴서 ★저장★ 한다 — 그런데 여기서는
          //   ★고치기 전 변수(env.body)★ 를 그대로 발송했다 → ★팀장 화면에만 "\n" 이 문자로 찍혔다.★
          //   ★DB 는 깨끗한데 사람이 보는 화면만 깨진다 — 그래서 로그만 봐선 안 잡힌다.★
          //   → ★저장된 본문(stored.body)을 보낸다.★ "보낸 것 = 저장된 것" 이 유일한 진실이다.
          // ★★"보냈다" 를 팀원에게 거짓으로 말하지 않는다 (하네스 리뷰 2026-07-14) ★★
          //
          //   예전엔 이 send 를 ★void★ 로 던지고 아래에서 바로 201 을 돌려줬다.
          //   → send.sh 는 "✓ sent" 를 찍는다. ★그런데 텔레그램 게시는 아직 시작도 안 했다.★
          //   → 게시가 실패해도 팀원은 ★성공★ 을 받고 떠난다. 아무도 모른다.
          //   실제로 오늘 3건 실패했다(lui 2 · steve 1) — 발신자는 몰랐다.
          //
          //   ★오늘 하루가 전부 이 병이었다★: openclaw 가 "started" 라고 하고 턴을 안 돌리고,
          //   서버가 "sent" 라고 하고 안 보내고. ★성공 응답을 확인 없이 믿었다.★
          //   → ★기다린다.★ 게시 결과를 팀원에게 그대로 돌려준다. (0.2~1초 느려질 뿐이다)
          //
          //   ★재시도는 하지 않는다★ (OWNER 2026-07-14): 실패 → 팀원이 다시 send.sh → 또 실패 → 무한루프.
          //   룰은 "실패하면 재시도하지 말고 팀장님께 1:1 DM 으로 알려라" 다. 1:1 은 서버를 안 거친다.
          const r = await getChannel("telegram").send({ agent, target: d.chatId, text: stored.body });
          appendAuditFile(env.from_agent_id, r.ok ? "telegram_relay_sent" : "telegram_relay_failed", stored.id, {
            target: d.chatId,
            kind: d.kind,
            // ★실패 이유를 버리지 않는다★ — 오늘 실패한 3건이 ★왜★ 실패했는지 알 수가 없었다.
            //   (telegramBotSend 는 토큰이 안 섞이게 에러 문자열을 만든다 — 그대로 실어도 안전하다)
            error: r.ok ? null : (r.error ?? "unknown"),
          });
          recordReportDelivery(deps.db, {
            actor: env.from_agent_id,
            channel: d.kind,
            recipient: d.kind === "telegram_dm" ? "owner" : d.chatId,
            threadId: stored.thread_id,
            refId: stored.id,
            body: stored.body,   // ★기록도 실제로 보낸 것과 같아야 한다★
            ok: r.ok,
            error: r.ok ? null : (r.error ?? "telegram_send_failed"),
          });
          if (!r.ok) {
            // ★DB 에는 남기고(기록은 사실이다), 팀원에게는 '게시 실패' 를 알린다.★
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

  // ★응답가드 자가등록 (OWNER 2026-07-18)★ — 턴기반 팀원이 "긴 작업, 팀장 보고 잊지 않기" 를 스스로 건다.
  // 기존 pending_followup 파이프라인(60s 워커·1회성·보고감지·GC) 재사용 — 등록 진입점만 신설.
  // 게이트 탈락은 422 + reason 으로 ★명시적으로★ 거절한다 (조용한 no-op = 어제 유형의 침묵 실패).
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
    return c.json({ message: m });
  });

  return r;
}
