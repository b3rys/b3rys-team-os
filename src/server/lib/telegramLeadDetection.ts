import type { Database } from "bun:sqlite";

const LAST_SENDER_ID_KEY = "capture_last_non_bot_sender_id";
const LAST_SENDER_USERNAME_KEY = "capture_last_non_bot_sender_username";
const LAST_SENDER_FIRST_NAME_KEY = "capture_last_non_bot_sender_first_name";
const TELEGRAM_ID_RE = /^\d{1,20}$/;

function setSetting(db: Database, key: string, value: string) {
  db.query(
    "INSERT INTO setting (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
  ).run(key, value);
}

function getSetting(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM setting WHERE key = ?").get(key) as { value: string } | null;
  return row ? row.value : null;
}

export type CapturedTelegramSender = {
  id: string;
  username: string | null;
  first_name: string | null;
};

export function rememberCaptureNonBotSender(
  db: Database,
  from: { id?: number | string; is_bot?: boolean; username?: string; first_name?: string } | undefined,
): CapturedTelegramSender | null {
  if (!from || from.is_bot) return null;
  const id = from.id != null ? String(from.id) : "";
  if (!TELEGRAM_ID_RE.test(id)) return null;
  const username = from.username ?? "";
  const firstName = from.first_name ?? "";
  setSetting(db, LAST_SENDER_ID_KEY, id);
  setSetting(db, LAST_SENDER_USERNAME_KEY, username);
  setSetting(db, LAST_SENDER_FIRST_NAME_KEY, firstName);
  return { id, username: username || null, first_name: firstName || null };
}

export function latestCaptureNonBotSender(db: Database): CapturedTelegramSender | null {
  const id = getSetting(db, LAST_SENDER_ID_KEY) ?? "";
  if (!TELEGRAM_ID_RE.test(id)) return null;
  return {
    id,
    username: getSetting(db, LAST_SENDER_USERNAME_KEY) || null,
    first_name: getSetting(db, LAST_SENDER_FIRST_NAME_KEY) || null,
  };
}

// ── 그룹(팀방) 자동발견 ──────────────────────────────────────────────
// 첫 세팅의 chicken-and-egg: System OP 를 켜려면 그룹 chat_id 가 필요한데,
// 그걸 알아낼 방법이 없었다(직접 getUpdates 는 토큰당 단일 poller 와 경합).
// 캡처 워커가 그룹 미설정(shadow) 상태에서 관찰한 그룹 chat 을 여기 기록해두면
// detect-group 이 latestCaptureNonBotSender 와 같은 방식(경합 없이 setting 읽기)으로 꺼낸다.
const DISCOVERED_GROUPS_KEY = "capture_discovered_groups";
const GROUP_CHAT_ID_RE = /^-?\d{1,20}$/; // 그룹/슈퍼그룹 chat_id(음수 포함)
const MAX_DISCOVERED_GROUPS = 10;

export type DiscoveredTelegramGroup = {
  id: string;
  type: string;
  title: string | null;
  seen_at: string;
};

export function rememberDiscoveredGroup(
  db: Database,
  chat: { id?: number | string; type?: string; title?: string } | undefined,
  nowIso: string,
): DiscoveredTelegramGroup | null {
  if (!chat) return null;
  if (chat.type !== "group" && chat.type !== "supergroup") return null; // 그룹만(1:1 DM 제외)
  const id = chat.id != null ? String(chat.id) : "";
  if (!GROUP_CHAT_ID_RE.test(id)) return null;
  const entry: DiscoveredTelegramGroup = { id, type: chat.type, title: chat.title ?? null, seen_at: nowIso };
  const existing = listDiscoveredGroups(db).filter((g) => g.id !== id);
  const next = [entry, ...existing].slice(0, MAX_DISCOVERED_GROUPS); // 최근 관찰이 앞
  setSetting(db, DISCOVERED_GROUPS_KEY, JSON.stringify(next));
  return entry;
}

export function listDiscoveredGroups(db: Database): DiscoveredTelegramGroup[] {
  const raw = getSetting(db, DISCOVERED_GROUPS_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (g): g is DiscoveredTelegramGroup =>
        !!g && typeof (g as any).id === "string" && GROUP_CHAT_ID_RE.test((g as any).id),
    );
  } catch {
    return [];
  }
}
