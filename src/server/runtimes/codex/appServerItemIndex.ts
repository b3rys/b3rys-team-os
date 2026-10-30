import { createHash } from "node:crypto";
/** 파일변경 승인에는 내용이 없고 ID 조회 요청도 없으므로 먼저 받은 started·patchUpdated 알림을 기억해 짝짓는다.
 * 턴마다 비우고 조회 때도 turnId를 대조한다. 짝이 없거나 상한으로 버린 항목은 내용을 추정하지 않고 매번 묻는다. */

/** 변경 한 건 — 벤더 FileUpdateChange {path, kind, diff} 를 우리 쪽 좁은 모양으로 정규화. */
export interface ObservedFileChange {
  path: string;
  /** add | delete | update | unknown — PatchChangeKind.type */
  kind: string;
  /** update 이면서 이동을 겸하는 경우의 목적지(move_path). 없으면 null. */
  movePath: string | null;
  /** unified diff 원문(상한 절단). 사람 표시가 아니라 content digest·줄수 계산용. */
  diff: string;
  /** Full source digest and presence survive display truncation. */
  fullDiffDigest?: string;
  contentKnown?: boolean;
}

/** 승인 요청보다 먼저 관측된 항목 하나. */
export interface ObservedItem {
  itemId: string;
  turnId: string | null;
  threadId: string | null;
  changes: ObservedFileChange[];
}

/** 한 diff 당 보관 상한(메모리 보호). operation hash ·줄수 계산에만 쓰므로 절단돼도 판단이 넓어지지 않는다. */
const MAX_DIFF_CHARS = 20_000;
/** 색인 항목 수 상한. 넘으면 가장 오래 전에 넣은 것부터 버린다(버려지면 ask 로 떨어진다 = 안전). */
const MAX_ITEMS = 256;

export class CodexTurnItemIndex {
  /** 삽입 순서가 보존되는 Map — 상한 초과 시 가장 앞(=가장 오래된) 것을 버린다. */
  private items = new Map<string, ObservedItem>();

  /**
   * 서버 알림 하나를 반영한다. 파일변경과 무관한 알림은 그냥 무시한다.
   * 같은 itemId 로 다시 오면 최신 내용으로 갈아끼운다 — patchUpdated 가 갱신본이기 때문.
   */
  observe(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, any>;
    if (method === "item/fileChange/patchUpdated") {
      this.put(p.itemId, p.turnId, p.threadId, p.changes);
      return;
    }
    if (method === "item/started") {
      const item = p.item as Record<string, any> | undefined;
      if (item?.type === "fileChange") this.put(item.id, p.turnId, p.threadId, item.changes);
      return;
    }
    if (method === "item/completed") {
      // 완료본도 changes 를 싣는다. 승인은 보통 완료 전에 오지만, 갱신되면 최신을 쓴다.
      const item = p.item as Record<string, any> | undefined;
      if (item?.type === "fileChange") this.put(item.id, p.turnId, p.threadId, item.changes);
    }
  }

  private put(itemId: unknown, turnId: unknown, threadId: unknown, changes: unknown): void {
    if (typeof itemId !== "string" || !itemId) return;
    const normalized = normalizeChanges(changes);
    // 빈 변경목록은 기억하지 않는다 — 기억해두면 조회에 '성공' 하면서 내용이 없어,
    //   호출부가 '파일 0개 쓰기' 라는 내용 없는 승인 을 만들 수 있다. 없는 것으로 두면 ask 로 간다.
    if (normalized.length === 0) { this.items.delete(itemId); return; }
    if (this.items.has(itemId)) this.items.delete(itemId); // 재삽입 = 최신으로 취급(순서도 갱신)
    this.items.set(itemId, {
      itemId,
      turnId: typeof turnId === "string" ? turnId : null,
      threadId: typeof threadId === "string" ? threadId : null,
      changes: normalized,
    });
    while (this.items.size > MAX_ITEMS) {
      const oldest = this.items.keys().next();
      if (oldest.done) break;
      this.items.delete(oldest.value);
    }
  }

  /** 턴 초기화 알림을 놓쳐도 이전 내용이 붙지 않도록 조회 때 turnId를 다시 대조한다. turnId가 없으면 짝짓지 않고 확인을 요구한다. */
  lookup(itemId: unknown, turnId: unknown): ObservedItem | null {
    if (typeof itemId !== "string" || !itemId) return null;
    const hit = this.items.get(itemId);
    if (!hit) return null;
    if (typeof turnId !== "string" || !turnId) return null;
    if (hit.turnId !== turnId) return null;
    return hit;
  }

  /** 턴 시작 — 이전 턴 관측을 통째로 버린다. */
  beginTurn(): void {
    this.items.clear();
  }

  /** 관측 항목 수(테스트·진단용). */
  get size(): number {
    return this.items.size;
  }
}

/** 벤더 changes 배열 → 좁은 모양. 모양이 어긋난 원소는 버린다(추측해서 채우지 않는다). */
function normalizeChanges(raw: unknown): ObservedFileChange[] {
  if (!Array.isArray(raw)) return [];
  const out: ObservedFileChange[] = [];
  const contentKnown = raw.every((v: any) => v && typeof v === "object" && typeof v.path === "string" && v.path && typeof v.diff === "string" && ["add", "delete", "update"].includes(v.kind?.type));
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const rec = c as Record<string, any>;
    if (typeof rec.path !== "string" || !rec.path) continue;
    const kindObj = rec.kind;
    const kind = kindObj && typeof kindObj === "object" && typeof kindObj.type === "string" ? kindObj.type : "unknown";
    const movePath = kindObj && typeof kindObj === "object" && typeof kindObj.move_path === "string" ? kindObj.move_path : null;
    out.push({
      path: rec.path,
      kind,
      movePath,
      diff: typeof rec.diff === "string" ? rec.diff.slice(0, MAX_DIFF_CHARS) : "",
      fullDiffDigest: typeof rec.diff === "string" ? createHash("sha256").update(rec.diff).digest("hex") : undefined,
      contentKnown,
    });
  }
  return out;
}
