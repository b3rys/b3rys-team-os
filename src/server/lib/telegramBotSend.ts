/**
 * ★팀원의 봇으로 텔레그램에 직접 보낸다 (Bot API).★ (2026-07-14 — 팀장 보고가 유실되고 있었다)
 *
 * ═══ 무슨 일이 있었나 ═══
 *   [B] 전환으로 `--direct-to-owner` 를 ★서버가 그 팀원의 봇으로 릴레이★ 하게 만들었다.
 *   그런데 채널 어댑터(channels/telegram.ts)는 ★openclaw 가 아니면 전부 `postTelegramAsHermes`★ 를 불렀다 —
 *   ★그건 hermes CLI 를 띄우는 함수다.★ claude 팀원(steve·lui·dbak·demis)은 hermes 런타임이 아니다.
 *   → ★telegram_send_failed.★ ★완성된 보고가 팀장께 안 갔다.★ (실측: 서귀포 날씨 보고 통째로 유실)
 *
 *   ★"팀원이 직접 보낸다" 로 바꿨으면, ★모든 런타임이 실제로 보낼 수 있어야 한다.★★
 *   claude 팀원에게 릴레이를 시켜놓고 ★보낼 수단을 안 준 것★ — 오늘도 그 패턴이다.
 *
 * ═══ 어떻게 ═══
 *   각 봇 토큰은 ★파일에만★ 있다 (~/.claude/channels/telegram-<id>/.env).
 *   ★값을 로그·에러메시지에 절대 싣지 않는다★ — 세션 로그에 영구 기록된다(팀 보안룰).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { AgentRecord } from "../types";

/** ~/.claude/channels/telegram-<id>/.env 의 TELEGRAM_BOT_TOKEN. 없으면 null. ★값은 반환만 하고 절대 로깅하지 않는다.★ */
function botTokenFor(agentId: string): string | null {
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

/** 이 팀원이 자기 봇으로 보낼 수 있나 (토큰이 있나). */
export function canSendAsBot(agentId: string): boolean {
  return botTokenFor(agentId) !== null;
}

/**
 * 팀원의 봇으로 chat 에 게시한다. ★토큰 값은 어떤 경로로도 밖에 안 나간다.★
 * 실패해도 throw 하지 않는다 — 호출부가 배달기록을 남길 수 있게 boolean 만 돌려준다.
 */
export async function sendAsAgentBot(
  agent: AgentRecord,
  chatId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  const token = botTokenFor(agent.id);
  if (!token) return { ok: false, error: "no_bot_token" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // ★4096자 제한★ — 넘으면 텔레그램이 통째로 거절한다(=보고 유실). 잘라서라도 보낸다.
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
    });
    if (res.ok) return { ok: true };
    // ★에러 본문에 토큰이 없다★ (텔레그램은 description 만 준다) — 그대로 남겨도 안전하다.
    const body = (await res.text()).slice(0, 200);
    return { ok: false, error: `telegram_${res.status}:${body}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 120) : "send_failed" };
  }
}
