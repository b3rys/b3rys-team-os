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

const DISCOVERED_GROUPS_KEY = "capture_discovered_groups";
const GROUP_CHAT_ID_RE = /^-?\d{1,20}$/;
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
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return null;
  const id = chat.id != null ? String(chat.id) : "";
  if (!GROUP_CHAT_ID_RE.test(id)) return null;
  const entry: DiscoveredTelegramGroup = { id, type: chat.type, title: chat.title ?? null, seen_at: nowIso };
  const existing = listDiscoveredGroups(db).filter((group) => group.id !== id);
  setSetting(db, DISCOVERED_GROUPS_KEY, JSON.stringify([entry, ...existing].slice(0, MAX_DISCOVERED_GROUPS)));
  return entry;
}

export function listDiscoveredGroups(db: Database): DiscoveredTelegramGroup[] {
  const raw = getSetting(db, DISCOVERED_GROUPS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (group): group is DiscoveredTelegramGroup =>
        !!group && typeof (group as any).id === "string" && GROUP_CHAT_ID_RE.test((group as any).id),
    );
  } catch {
    return [];
  }
}
