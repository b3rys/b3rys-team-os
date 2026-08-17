/**
 * ★진행 중인 턴에 말을 끼워 넣기 위한 등록부.★
 *
 * 왜 필요한가 — 실측 2026-08-12:
 *   dex 가 74초짜리 작업을 하는 동안 보낸 메시지가 ★20번 연기되다가 blocked 로 끝났다.★
 *   (message_recipient.last_error = deferred_cap_exceeded:count=20)
 *   턴도 안 생겼고 답도 없었다. 게다가 recipient_state 는 'acknowledged/activity_assumed' —
 *   ★그 팀원이 활동 중이라는 이유로 '봤다' 고 처리★ 됐다. 실제로는 아무도 못 봤다.
 *
 * codex app-server 는 진행 중 턴에 끼어드는 길을 갖고 있다(turn/steer, expectedTurnId 필수).
 * 그 길을 쓰려면 ★지금 도는 클라이언트를 찾을 수 있어야★ 해서 이 등록부를 둔다.
 */
export interface SteerableTurn {
  steer(text: string): Promise<void>;
  readonly currentTurnId: string | null;
}

const active = new Map<string, SteerableTurn>();

/** 턴 시작 시 등록. 같은 팀원의 앞 등록은 덮는다(한 팀원=한 턴 계약). */
export function registerActiveTurn(agentId: string, turn: SteerableTurn): void {
  if (agentId) active.set(agentId, turn);
}

/** 턴 종료 시 해제. ★등록한 그 턴일 때만★ 지운다(늦게 끝난 앞 턴이 새 턴을 지우지 않게). */
export function unregisterActiveTurn(agentId: string, turn: SteerableTurn): void {
  if (active.get(agentId) === turn) active.delete(agentId);
}

/**
 * 진행 중 턴에 말을 끼워 넣는다. 성공하면 true.
 * ★turnId 가 없으면 아직 턴이 안 붙은 것★ 이라 넣지 않는다(codex 가 expectedTurnId 를 요구한다).
 */
export async function steerActiveTurn(agentId: string, text: string): Promise<boolean> {
  const turn = active.get(agentId);
  if (!turn || !turn.currentTurnId) return false;
  try {
    await turn.steer(text);
    return true;
  } catch {
    return false; // 실패하면 기존 defer 경로로 되돌아간다(조용히 삼키지 않는다)
  }
}

/** 시험·진단용 — 지금 끼어들 수 있는 팀원. */
export function activeTurnAgents(): string[] {
  return [...active.keys()];
}
