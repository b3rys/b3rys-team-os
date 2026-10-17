// 런타임별 저장 규약으로 봇 토큰을 읽어 Bot API로 전송한다. 토큰값은 로그·오류에 남기지 않으며 Hermes 전송 경로는 별도로 유지한다.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { AgentRecord } from "../types";
import { REPO_ROOT } from "./personaTemplates";
import { memberChannel } from "./memberChannel";

/** 토큰을 찾을 때 필요한 최소 정보. AgentRecord 전체를 요구하지 않는다(테스트가 쉬워진다). */
export interface BotTokenLookup {
  id: string;
  runtime?: string;
}

/** claude 규약: ~/.claude/channels/telegram-<id>/.env 의 TELEGRAM_BOT_TOKEN. */
function claudeChannelToken(agentId: string): string | null {
  const envPath = `${homedir()}/.claude/channels/telegram-${agentId}/.env`;
  if (!existsSync(envPath)) return null;
  try {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = /^\s*TELEGRAM_BOT_TOKEN\s*=\s*(.+?)\s*$/.exec(line);
      if (m?.[1]) return m[1].replace(/^["']|["']$/g, "");
    }
  } catch { /* 읽기 실패 = 토큰 없음으로 취급 */ }
  return null;
}

// 토큰을 쓰는 codexBridgePaths와 같은 REPO_ROOT를 사용해야 서버 실행 위치에 따라 읽기·쓰기 경로가 갈리지 않는다. 테스트는 루트를 주입한다.
function codexSecretToken(agentId: string, root: string = REPO_ROOT): string | null {
  const p = `${root}/var/secrets/${agentId}.bot-token`;
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch { /* 읽기 실패 = 토큰 없음으로 취급 */ }
  return null;
}

/** 이 팀원의 봇 토큰. 없으면 null. 값은 반환만 하고 절대 로깅하지 않는다.
 *  런타임별로 두는 자리가 다르다 — claude 경로를 먼저 보고, codex 런타임일 때만 var/secrets 를 본다.
 *  hermes 계열을 여기 넣지 않는 이유는 파일 머리말 참고(지금 CLI 경로로 정상 동작 중이라 안 건드린다). */
function botTokenFor(agent: BotTokenLookup, root: string = REPO_ROOT): string | null {
  return claudeChannelToken(agent.id)
    ?? (agent.runtime === "codex" ? codexSecretToken(agent.id, root) : null);
}

/** 이 팀원이 자기 봇으로 보낼 수 있나 (토큰이 있나). */
export function canSendAsBot(agent: BotTokenLookup, root: string = REPO_ROOT): boolean {
  return botTokenFor(agent, root) !== null;
}

/**
 * 팀원의 봇으로 chat 에 게시한다. 토큰 값은 어떤 경로로도 밖에 안 나간다.
 * 실패해도 throw 하지 않는다 — 호출부가 배달기록을 남길 수 있게 boolean 만 돌려준다.
 */
/** 게시 텍스트 상한(UTF-16 단위). 텔레그램 4096 제한보다 여유를 둔다 — 넘는 부분은 잘려 나간다. */
export const TELEGRAM_SEND_LIMIT = 4000;

export async function sendAsAgentBot(
  agent: AgentRecord,
  chatId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  // 채널 설정이 틀리면 보내지 않는다(토큰을 엉뚱한 서버로 보내지 않는다) — 토큰을 읽기도 전에.
  const ch = memberChannel(agent);
  if (ch.error) return { ok: false, error: `channel_invalid:${ch.error}` };
  const token = botTokenFor(agent);
  if (!token) return { ok: false, error: "no_bot_token" };
  try {
    // 그 팀원 채널의 봇 API(b3chat 등). channel 이 없으면 텔레그램 — 지금과 같다.
    const res = await fetch(`${ch.apiBase}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 4096자 제한 — 넘으면 텔레그램이 통째로 거절한다(=보고 유실). 잘라서라도 보낸다.
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, TELEGRAM_SEND_LIMIT), disable_web_page_preview: true }),
    });
    if (res.ok) return { ok: true };
    // 에러 본문에 토큰이 없다 (텔레그램은 description 만 준다) — 그대로 남겨도 안전하다.
    const body = (await res.text()).slice(0, 200);
    return { ok: false, error: `telegram_${res.status}:${body}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 120) : "send_failed" };
  }
}
