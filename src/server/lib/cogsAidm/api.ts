/**
 * cogs 봇 API(AI DM 2단계) HTTP 어댑터. 각 팀원은 자기 봇 토큰으로만 부른다 — 발신자는 서버가 토큰으로 정한다.
 * 메서드 이름·인자는 cogs 서버 계약(clo/aidm-work)과 맞춘다. sendMessage 응답 유실은 CogsDeliveryUnknown.
 */
import { readMemberChannel } from "../memberChannel";
import { claudeCogsPaths } from "../../runtimes/claude/cogsLauncher";
import { codexBridgePaths } from "../../runtimes/codex/launcher";
import type { AgentRecord } from "../../types";
import { cogsCall, cogsInbox, cogsToken } from "../cogsRelay";
import type { CogsAidmApi, CogsIdentity } from "./relay";

const inbox = (i: CogsIdentity) => ({ api_base: i.apiBase });

export const httpCogsAidmApi: CogsAidmApi = {
  async botId(i) {
    const r = await cogsCall(inbox(i), i.token, "getMe", {});
    if (!Number.isSafeInteger(r?.id)) throw new Error("cogs_bad_response");
    return r.id;
  },
  async openPair(i, peerBotId) {
    const r = await cogsCall(inbox(i), i.token, "openAIDirectChat", { peer_bot_id: peerBotId });
    const id = r?.id ?? r?.chat?.id;
    if (id === undefined || id === null) throw new Error("cogs_bad_response");
    return String(id);
  },
  async startWork(i, a) {
    const r = await cogsCall(inbox(i), i.token, "startAIWork", a);
    const id = r?.work_id ?? r?.id;
    if (!Number.isSafeInteger(id)) throw new Error("cogs_bad_response");
    return id;
  },
  async send(i, a) {
    // Bus delivery already wakes the peer; its cogs copy must never wake again.
    const r = await cogsCall(inbox(i), i.token, "sendMessage", {...a,no_wake:true});
    if (!Number.isSafeInteger(r?.message_id)) throw new Error("cogs_bad_response");
    return r.message_id;
  },
  async complete(i, a) {
    await cogsCall(inbox(i), i.token, "completeAIWork", a);
  },
};

/** 팀원의 cogs 계정. cogs_inbox 가 있는 팀원만(그 밖은 null — 중계 대상이 아니다). 설정·토큰 문제도 null. */
export function cogsIdentityOf(agent: AgentRecord | undefined): CogsIdentity | null {
  if (!agent) return null;
  try {
    const cfg = cogsInbox(agent);
    if (cfg) return { apiBase: cfg.api_base, token: cogsToken(cfg) };
    if (agent.enabled === false || !["codex","claude_channel"].includes(agent.runtime)) return null;
    const channel=readMemberChannel(agent.id);
    if (channel.kind !== "b3chat") return null;
    const p=agent.runtime === "codex" ? codexBridgePaths(agent.id) : claudeCogsPaths(agent.id);
    return {apiBase:channel.apiBase,token:cogsToken({token_file:p.tokenFile})};
  } catch { return null; }
}
