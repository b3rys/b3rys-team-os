/**
 * 팀원별 채널 — 그 팀원의 봇이 붙는 메신저 서버(텔레그램 또는 b3chat).
 *
 * agents.json 의 팀원 항목에 `channel` 을 두면 그 팀원의 봇 API 호출이 그 주소로 간다:
 *   "channel": { "kind": "b3chat", "api_base": "https://…", "allow_from": ["12", "40"], "owner_chat": "12" }
 *   · kind       — telegram(기본) | b3chat
 *   · api_base   — 봇 API 주소. 경로는 텔레그램과 같다(/bot<token>/<method>, 파일은 /file/bot<token>/<path>)
 *   · allow_from — 말을 받을 방 id 목록(발신자 게이트). b3chat 은 1:1 방도 chat.id = 방 id 다(사용자 id 가 아니다)
 *   · owner_chat — 팀장에게 먼저 보낼 때(승인 요청)의 방 id. 인가 목록(allow_from)을 목적지로 쓰지 않는다
 *
 * ★channel 이 없는 팀원은 지금과 똑같다★ — kind=telegram, api_base=https://api.telegram.org,
 * allow_from·owner_chat 은 null(= 기존 팀 공통 시드·팀장 DM 해석을 그대로 쓴다).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./personaTemplates";

export const TELEGRAM_API_BASE = "https://api.telegram.org";

export type MemberChannelKind = "telegram" | "b3chat";

export interface MemberChannel {
  kind: MemberChannelKind;
  /** 끝 '/' 없는 봇 API 주소 */
  apiBase: string;
  /** null = 설정 없음(기존 시드를 쓴다) */
  allowFrom: string[] | null;
  /** null = 설정 없음(기존 팀장 DM 해석을 쓴다) */
  ownerChat: string | null;
  /**
   * 설정이 틀려 이 채널로 띄우면 안 된다(fail-closed). 지금은 b3chat 인데 api_base 가 없거나 형식 밖일 때.
   * ★텔레그램 주소로 떨어뜨리지 않는다★ — 그러면 b3chat 봇 토큰이 api.telegram.org 로 나간다.
   */
  error?: string;
}

export const B3CHAT_API_BASE_INVALID = "b3chat_api_base_invalid";

/** 받을 수 있는 api_base 인가 — https, 또는 같은 기계 시험용 http://127.0.0.1·localhost. */
function validApiBase(base: string): boolean {
  return /^https:\/\/[^\s/]+/.test(base) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(base);
}

/** 이 채널로 띄우면 안 되면 throw — 런처·릴레이·토큰 확인이 한 문구로 막는다. */
export function assertChannelUsable(ch: MemberChannel, who: string): void {
  if (ch.error) throw new Error(`${who}: 채널 설정 오류(${ch.error}) — b3chat 은 api_base(https://… 또는 http://127.0.0.1)가 있어야 한다. 띄우지 않는다.`);
}

export const DEFAULT_CHANNEL: MemberChannel = Object.freeze({
  kind: "telegram",
  apiBase: TELEGRAM_API_BASE,
  allowFrom: null,
  ownerChat: null,
}) as MemberChannel;

const ID_RE = /^-?\d+$/;

/** agents.json 의 `channel` 값(모양 미검증) → MemberChannel. 모양이 틀리면 그 칸은 기본값. */
export function parseMemberChannel(raw: unknown): MemberChannel {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_CHANNEL;
  const r = raw as Record<string, unknown>;
  const kind: MemberChannelKind = r.kind === "b3chat" ? "b3chat" : "telegram";
  const base = typeof r.api_base === "string" ? r.api_base.trim().replace(/\/+$/, "") : "";
  const allowFrom = Array.isArray(r.allow_from)
    ? r.allow_from.map((v) => String(v).trim()).filter((v) => ID_RE.test(v))
    : null;
  const owner = r.owner_chat == null ? "" : String(r.owner_chat).trim();
  const ownerChat = ID_RE.test(owner) ? owner : null;
  // https 만 받는다(같은 기계 시험용 http://127.0.0.1·localhost 는 허용).
  if (validApiBase(base)) return { kind, apiBase: base, allowFrom, ownerChat };
  // ★b3chat 은 텔레그램 주소로 떨어뜨리지 않는다(fail-closed).★ 텔레그램은 비었거나 틀리면 기본 주소 — 지금과 같다.
  if (kind === "b3chat") return { kind, apiBase: "", allowFrom, ownerChat, error: B3CHAT_API_BASE_INVALID };
  return { kind, apiBase: TELEGRAM_API_BASE, allowFrom, ownerChat };
}

/** 팀원 기록(이미 읽은 agents.json 항목) → 채널. 서버 프로세스 쪽(릴레이·토큰 확인)에서 쓴다. */
export function memberChannel(agent: { channel?: unknown } | null | undefined): MemberChannel {
  return parseMemberChannel(agent?.channel);
}

/** agents.json 에서 id 로 찾아 채널을 읽는다. 파일이 없거나 깨졌으면 기본값(= 지금 동작). */
export function readMemberChannel(id: string, registryPath = process.env.TEAM_AGENT_REGISTRY ?? join(REPO_ROOT, "agents.json")): MemberChannel {
  try {
    const raw = JSON.parse(readFileSync(registryPath, "utf-8")) as unknown;
    const list = Array.isArray(raw) ? raw : (raw as { agents?: unknown[] })?.agents ?? [];
    const hit = (list as Array<{ id?: unknown; channel?: unknown }>).find((a) => a?.id === id);
    return memberChannel(hit);
  } catch {
    return DEFAULT_CHANNEL;
  }
}

/** 브리지 프로세스 쪽 — 런처 wrapper 가 넣어 준 env 에서 읽는다(없으면 기본값). */
export function channelFromEnv(env: Record<string, string | undefined> = process.env): MemberChannel {
  const kind = env.CODEX_CHANNEL_KIND === "b3chat" ? "b3chat" : "telegram";
  const base = (env.TELEGRAM_API_BASE ?? "").trim().replace(/\/+$/, "");
  const owner = (env.CODEX_OWNER_CHAT ?? "").trim();
  const ownerChat = ID_RE.test(owner) ? owner : null;
  // 브리지의 허용 목록은 CODEX_ALLOW_FROM 이 정본(런처가 이미 채널 값으로 채운다)
  if (kind === "b3chat" && !validApiBase(base)) return { kind, apiBase: "", allowFrom: null, ownerChat, error: B3CHAT_API_BASE_INVALID };
  return { kind, apiBase: base || TELEGRAM_API_BASE, allowFrom: null, ownerChat };
}

/** 받은 메시지의 chat 이 그룹인가. 텔레그램 type 은 private/group/supergroup/channel — ★private 가 아니면 그룹★.
 *  type 이 없으면(옛 기록) 예전 판정(음수 id)을 그대로 쓴다. */
export function isGroupChat(chat: { type?: unknown; id?: unknown } | null | undefined): boolean {
  if (!chat) return false;
  if (typeof chat.type === "string" && chat.type !== "") return chat.type !== "private";
  return typeof chat.id === "number" && chat.id < 0;
}

/** wrapper 에 넣을 env 줄 — 채널 설정이 있을 때만(없으면 wrapper 는 지금과 바이트까지 같다). */
export function channelEnvLines(ch: MemberChannel): string[] {
  assertChannelUsable(ch, "wrapper");
  if (ch.kind === "telegram" && ch.apiBase === TELEGRAM_API_BASE && ch.ownerChat == null) return [];
  const q = (v: string) => `"${v.replace(/(["\\$`])/g, "\\$1")}"`;
  const lines = [`export CODEX_CHANNEL_KIND=${q(ch.kind)}`, `export TELEGRAM_API_BASE=${q(ch.apiBase)}`];
  if (ch.ownerChat) lines.push(`export CODEX_OWNER_CHAT=${q(ch.ownerChat)}`);
  return lines;
}
