/**
 * ★팀원의 봇으로 텔레그램에 직접 보낸다 (Bot API).★ (2026-07-14 — 팀장 보고가 유실되고 있었다)
 *
 * ═══ 무슨 일이 있었나 ═══
 *   [B] 전환으로 `--direct-to-gd` 를 ★서버가 그 팀원의 봇으로 릴레이★ 하게 만들었다.
 *   그런데 채널 어댑터(channels/telegram.ts)는 ★openclaw 가 아니면 전부 `postTelegramAsHermes`★ 를 불렀다 —
 *   ★그건 hermes CLI 를 띄우는 함수다.★ claude 팀원(steve·lui·dbak·demis)은 hermes 런타임이 아니다.
 *   → ★telegram_send_failed.★ ★완성된 보고가 팀장께 안 갔다.★ (실측: 서귀포 날씨 보고 통째로 유실)
 *
 *   ★"팀원이 직접 보낸다" 로 바꿨으면, ★모든 런타임이 실제로 보낼 수 있어야 한다.★★
 *   claude 팀원에게 릴레이를 시켜놓고 ★보낼 수단을 안 준 것★ — 오늘도 그 패턴이다.
 *
 * ═══ 어떻게 ═══
 *   각 봇 토큰은 ★파일에만★ 있다. ★그런데 런타임마다 두는 자리가 다르다★:
 *     claude_channel : ~/.claude/channels/telegram-<id>/.env  의 TELEGRAM_BOT_TOKEN=...
 *     codex          : <repo>/var/secrets/<id>.bot-token      ★raw 토큰 한 줄★ (0600)
 *   ★값을 로그·에러메시지에 절대 싣지 않는다★ — 세션 로그에 영구 기록된다(팀 보안룰).
 *
 * ═══ 2026-07-29 — ★같은 사고가 codex 차례로 왔다★ (Demis S7 이 잡음) ═══
 *   위 머리말이 "모든 런타임이 실제로 보낼 수 있어야 한다" 고 적어놨는데,
 *   ★정작 이 함수는 claude 경로 하나만 봤다.★ codex 팀원(dex)은 토큰이 var/secrets 에 있어
 *   botTokenFor 가 null → hermes CLI 폴백 → ★dex 는 hermes 가 아니라 실패★ → telegram_send_failed.
 *   ★dex 가 아무리 좋은 결과를 내도 팀장 화면에는 안 떴다.★ 2026-07-14 과 ★같은 문장, 다른 런타임★ 이다.
 *
 *   ★hermes 계열은 일부러 그대로 둔다★ — forin·ames 는 var/secrets 에 토큰이 있지만
 *   지금 hermes CLI 경로로 ★정상 동작 중★ 이다. 여기서 폴백을 열면 그 둘이 조용히 Bot API 로
 *   갈아탄다. ★고장 안 난 것을 이 수정으로 건드리지 않는다.★ (열려면 별건으로 검증하고 연다)
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { AgentRecord } from "../types";
import { REPO_ROOT } from "./personaTemplates";

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

/** codex 규약: <repo>/var/secrets/<id>.bot-token — ★raw 토큰 한 줄★ (launcher.ts:233 이 그렇게 쓴다).
 *
 *  ★루트를 인자로 받는다 — 여기서 process.env 를 다시 읽지 않는다.★
 *  lib/paths.ts 머리말이 "★process.env 는 여기서 한 번만 읽는다(단일 출처)★" 를 못박고,
 *  REPO_ROOT 를 재정의 없이 personaTemplates 것으로 re-export 한다(divergence 방지).
 *  호출부에서 env 를 또 읽으면 ★값은 같아도 규약 밖★ 이고, 다음 사람이 "여기서도 읽어도 되는구나"
 *  로 따라 하는 순간 갈린다. 테스트는 root 를 직접 주고, 운영은 정본 상수 기본값을 쓴다.
 *  (Demis 리뷰 2026-07-29 — 내가 처음에 없는 이름 B3OS_REPO_ROOT 를 만들어 쓴 것과 같은 계열이다)
 *
 *  ★경로는 반드시 쓰는 쪽과 같은 출처로 구한다★ — codexBridgePaths 가 personaTemplates 의 REPO_ROOT 로
 *  이 파일을 쓰므로, 읽는 쪽도 같은 REPO_ROOT 를 쓴다. 여기서 cwd 나 다른 env 로 따로 구하면
 *  ★서버가 다른 디렉토리에서 뜨는 순간 조용히 어긋난다★ — 오늘 아침 launchd plist 가 코드 기본값을
 *  덮어 '체인 8' 이 안 먹던 것과 같은 계열의 사고다(설정처가 둘이면 언젠가 갈린다). */
function codexSecretToken(agentId: string, root: string = REPO_ROOT): string | null {
  const p = `${root}/var/secrets/${agentId}.bot-token`;
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch { /* 읽기 실패 = 토큰 없음으로 취급 */ }
  return null;
}

/** 이 팀원의 봇 토큰. 없으면 null. ★값은 반환만 하고 절대 로깅하지 않는다.★
 *  ★런타임별로 두는 자리가 다르다★ — claude 경로를 먼저 보고, codex 런타임일 때만 var/secrets 를 본다.
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
 * 팀원의 봇으로 chat 에 게시한다. ★토큰 값은 어떤 경로로도 밖에 안 나간다.★
 * 실패해도 throw 하지 않는다 — 호출부가 배달기록을 남길 수 있게 boolean 만 돌려준다.
 */
export async function sendAsAgentBot(
  agent: AgentRecord,
  chatId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  const token = botTokenFor(agent);
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
