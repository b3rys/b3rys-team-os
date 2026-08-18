/**
 * 1:1 대화의 codex 세션을 ★재시작 넘어★ 기억한다.
 *
 * 왜 필요한가(실측 2026-08-18): 브리지는 대화→세션 지도를 ★메모리에만★ 들고 있었다
 * (`chatThreads` Map). 그래서 브리지가 재시작될 때마다 그 지도가 비고, 다음 턴은
 * `resumeSessionId` 없이 시작한다 = ★사람 쪽에서는 앞 대화를 잊은 것으로 보인다.★
 *
 * 저장 자리는 이미 있었다 — `codex_session_map`. 다만 전 52행이 전부 `surface=team_bus` 였고
 * 브리지는 그 표를 ★한 번도 참조하지 않았다★(브리지 파일 내 참조 0건).
 * 버스로 온 일은 맥락이 이어지고 사람이 직접 건 대화는 안 이어지던 것이 그 차이다.
 *
 * 여기서는 그 표에 `surface="telegram_dm"` 으로 같이 적는다. 버스 쪽 행과 섞이지 않는다.
 */
import { Database } from "bun:sqlite";
import { CodexSessionStore } from "./state";

/** 이 표에서 1:1 대화가 쓰는 surface. 버스(team_bus)와 갈라 둔다. */
export const DM_SURFACE = "telegram_dm";

export interface DmSessionStore {
  /** 이 대화의 지난 세션. 없으면 undefined(새 대화로 시작). */
  get: (chatId: number) => string | undefined;
  /** 턴이 성공하면 그 세션을 적는다. */
  save: (chatId: number, sessionId: string) => void;
  /** 세션이 죽었을 때 지운다 — 죽은 세션을 계속 resume 하면 매번 실패한다. */
  clear: (chatId: number) => void;
}

/** 아무것도 저장하지 않는 구현(시험·주입용 기본값). */
export const NOOP_DM_SESSION_STORE: DmSessionStore = {
  get: () => undefined,
  save: () => {},
  clear: () => {},
};

/**
 * team.db 를 여는 실제 구현.
 * ★DB 문제가 대화를 막지 않는다★ — 읽기 실패는 '지난 세션 없음', 쓰기 실패는 조용히 넘긴다.
 * 맥락이 끊기는 것은 불편이지만, 답을 못 하는 것은 고장이다.
 */
export function makeDmSessionStore(agentId: string, dbPath: string): DmSessionStore {
  let db: Database | null = null;
  const open = (): Database | null => {
    if (db) return db;
    try {
      db = new Database(dbPath);
      return db;
    } catch {
      return null;
    }
  };
  const store = (): CodexSessionStore | null => {
    const d = open();
    return d ? new CodexSessionStore(d) : null;
  };
  return {
    get: (chatId) => {
      try {
        return store()?.get(agentId, DM_SURFACE, String(chatId));
      } catch {
        return undefined;
      }
    },
    save: (chatId, sessionId) => {
      try {
        store()?.save({
          agentId,
          surface: DM_SURFACE,
          conversationKey: String(chatId),
          codexSessionId: sessionId,
        });
      } catch { /* 기억 실패가 답을 막지 않는다 */ }
    },
    clear: (chatId) => {
      try {
        open()?.prepare(
          `DELETE FROM codex_session_map WHERE agent_id = ? AND surface = ? AND conversation_key = ?`,
        ).run(agentId, DM_SURFACE, String(chatId));
      } catch { /* 지우기 실패가 답을 막지 않는다 */ }
    },
  };
}
