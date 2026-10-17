/** 대화→세션 지도를 영속 저장해 브리지 재시작 뒤에도 앞 대화를 resume한다. DM은 telegram_dm surface로 기록해 버스 행과 구분한다. */
import { Database } from "bun:sqlite";
import { CodexSessionStore } from "./state";

/** 이 표에서 1:1 대화가 쓰는 surface. 버스(team_bus)와 갈라 둔다. */
export const DM_SURFACE = "telegram_dm";

/** 그룹은 DM과 별도 surface를 사용해야 대화 종류와 세션 생성 시각을 구분할 수 있다. */
export const GROUP_SURFACE = "telegram_group";

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
 * DB 문제가 대화를 막지 않는다 — 읽기 실패는 '지난 세션 없음', 쓰기 실패는 조용히 넘긴다.
 * 맥락이 끊기는 것은 불편이지만, 답을 못 하는 것은 고장이다.
 */
export function makeDmSessionStore(agentId: string, dbPath: string, surface: string = DM_SURFACE): DmSessionStore {
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
        return store()?.get(agentId, surface, String(chatId));
      } catch {
        return undefined;
      }
    },
    save: (chatId, sessionId) => {
      try {
        store()?.save({
          agentId,
          surface,
          conversationKey: String(chatId),
          codexSessionId: sessionId,
        });
      } catch { /* 기억 실패가 답을 막지 않는다 */ }
    },
    clear: (chatId) => {
      try {
        open()?.prepare(
          `DELETE FROM codex_session_map WHERE agent_id = ? AND surface = ? AND conversation_key = ?`,
        ).run(agentId, surface, String(chatId));
      } catch { /* 지우기 실패가 답을 막지 않는다 */ }
    },
  };
}

/** 대화 종류에 따라 surface를 주입해 저장 로직을 중복하지 않고 그룹을 DM으로 잘못 기록하지 않는다. */
export function makeChatSessionStore(agentId: string, dbPath: string): DmSessionStore {
  const dm = makeDmSessionStore(agentId, dbPath, DM_SURFACE);
  const group = makeDmSessionStore(agentId, dbPath, GROUP_SURFACE);
  const pick = (chatId: number): DmSessionStore => (chatId < 0 ? group : dm);
  return {
    get: (chatId) => pick(chatId).get(chatId),
    save: (chatId, sessionId) => pick(chatId).save(chatId, sessionId),
    clear: (chatId) => pick(chatId).clear(chatId),
  };
}
