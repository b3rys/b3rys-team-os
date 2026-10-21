/**
 * cogs 권한 이벤트 — 정책 바뀜·승인 결정·승인 무효화.
 *
 * 한 프로세스 안의 구독 경계일 뿐이다. 보안 판정은 이벤트에 기대지 않는다:
 * 결정 저장·실행 인계 때 원본 revision 을 다시 읽는다(approvals.ts). 이벤트가 늦거나 빠져도 옛 승인은 실행되지 않는다.
 * 구독자 하나가 던져도 다른 구독자와 발신자는 계속 간다.
 */
export type CogsPermissionEvent =
  | { type: "policy_changed"; change_id: string; agent_id: string; old_revision: number; new_revision: number; narrowed: boolean }
  | { type: "approval_decided"; request_id: string; agent_id: string; status: string }
  | { type: "approval_invalidated"; request_id: string; agent_id: string; room_id: string; card_message_id: number | null; reason: string };

type Handler = (e: CogsPermissionEvent) => void | Promise<void>;

export interface CogsPermissionEvents {
  on(handler: Handler): () => void;
  emit(e: CogsPermissionEvent): void;
}

const SEEN_LIMIT = 256;

export function createCogsPermissionEvents(report: (msg: string) => void = (m) => console.warn(m)): CogsPermissionEvents {
  const handlers = new Set<Handler>();
  // 같은 정책 변경이 두 번 와도 한 번만 처리한다(change_id).
  const seen: string[] = [];
  return {
    on(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    emit(e) {
      if (e.type === "policy_changed") {
        if (seen.includes(e.change_id)) return;
        seen.push(e.change_id);
        if (seen.length > SEEN_LIMIT) seen.shift();
      }
      for (const h of [...handlers]) {
        try {
          const r = h(e);
          if (r && typeof (r as Promise<void>).catch === "function") {
            (r as Promise<void>).catch((err) => report(`[cogs-permissions] 구독자 실패 ${e.type}: ${err instanceof Error ? err.message : err}`));
          }
        } catch (err) {
          report(`[cogs-permissions] 구독자 실패 ${e.type}: ${err instanceof Error ? err.message : err}`);
        }
      }
    },
  };
}
