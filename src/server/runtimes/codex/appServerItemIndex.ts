/**
 * ★S2(#106) — 신세대 파일변경 승인의 '무엇을 바꾸는가' 를 알아내기 위한 turn 단위 알림 색인.★
 *
 * ■ 왜 필요한가
 * 구세대 `applyPatchApproval` 은 승인 요청 안에 `fileChanges` 가 들어 있었다. 그런데 신세대
 * `item/fileChange/requestApproval` 은 ★내용을 담지 않는다★ — params 는 {itemId, turnId, threadId,
 * startedAtMs, reason?, grantRoot?} 뿐이다(codex-cli 0.144.6 벤더 스키마 실측).
 * 그래서 지금은 그 승인이 통째로 '해석 실패' 로 떨어져, 사람이 ★무슨 파일을 바꾸는지 볼 수 없다.★
 *
 * ■ ★설계 정정(2026-07-29): '조회' 가 아니라 '기억' 이다★
 * 처음 계획은 "itemId 로 실제 변경을 조회한다" 였는데, ★벤더 프로토콜에 item 을 id 로 가져오는 요청이
 * 아예 없다★(ClientRequest 전수 확인). 대신 내용이 ★알림으로 먼저 온다★:
 *   item/started                 → item.type==="fileChange" 이면 item.changes 동봉
 *   item/fileChange/patchUpdated → changes 갱신본
 * 따라서 ★먼저 온 알림을 itemId 로 기억해 두었다가 승인 시점에 짝짓는다.★
 * (이 착각을 코드 다 쓰고 스위치 켠 뒤에 알았으면 훨씬 비쌌다 — '켜서 도는지 먼저 본다' 가 잡아줬다.)
 *
 * ■ ★안전 불변식 — 애매하면 통과가 아니라 ask★
 *  1. ★turn 이 다르면 짝이 아니다.★ 항목마다 turnId 를 함께 저장하고 조회 때 대조한다. 게다가 턴 시작마다
 *     통째로 비운다. 이전 턴의 변경 내용이 다음 턴 승인에 붙으면 ★사람이 승인한 것과 실행되는 것이 달라진다.★
 *  2. ★짝이 없으면 만들어내지 않는다.★ 알림을 못 봤거나 순서가 뒤집혔으면 null 을 돌려주고, 호출부는
 *     해석 실패 경로(매번 묻기)로 보낸다. 알림 도착 순서는 계약이 아니므로 ★못 볼 수 있다고 가정한다.★
 *  3. ★무한히 쌓지 않는다.★ 상한을 두고 오래된 것부터 버린다. 버려진 항목은 '짝 없음' 이 되어 ask 로
 *     떨어지므로 ★버리는 방향이 안전한 방향★ 이다.
 *
 * ★이 모듈은 순수 상태 컨테이너다 — I/O 없음. appServerClient 가 알림을 넣고 승인 시점에 꺼낸다.★
 */

/** 변경 한 건 — 벤더 FileUpdateChange {path, kind, diff} 를 우리 쪽 좁은 모양으로 정규화. */
export interface ObservedFileChange {
  path: string;
  /** add | delete | update | unknown — PatchChangeKind.type */
  kind: string;
  /** update 이면서 이동을 겸하는 경우의 목적지(move_path). 없으면 null. */
  movePath: string | null;
  /** unified diff 원문(상한 절단). 사람 표시가 아니라 ★내용 지문·줄수 계산용★. */
  diff: string;
}

/** 승인 요청보다 먼저 관측된 항목 하나. */
export interface ObservedItem {
  itemId: string;
  turnId: string | null;
  threadId: string | null;
  changes: ObservedFileChange[];
}

/** 한 diff 당 보관 상한(메모리 보호). 지문·줄수 계산에만 쓰므로 절단돼도 판단이 넓어지지 않는다. */
const MAX_DIFF_CHARS = 20_000;
/** 색인 항목 수 상한. 넘으면 ★가장 오래 전에 넣은 것부터★ 버린다(버려지면 ask 로 떨어진다 = 안전). */
const MAX_ITEMS = 256;

export class CodexTurnItemIndex {
  /** 삽입 순서가 보존되는 Map — 상한 초과 시 가장 앞(=가장 오래된) 것을 버린다. */
  private items = new Map<string, ObservedItem>();

  /**
   * 서버 알림 하나를 반영한다. 파일변경과 무관한 알림은 그냥 무시한다.
   * ★같은 itemId 로 다시 오면 최신 내용으로 갈아끼운다★ — patchUpdated 가 갱신본이기 때문.
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
    // ★빈 변경목록은 기억하지 않는다★ — 기억해두면 조회에 '성공' 하면서 내용이 없어,
    //   호출부가 '파일 0개 쓰기' 라는 ★내용 없는 승인★ 을 만들 수 있다. 없는 것으로 두면 ask 로 간다.
    if (normalized.length === 0) return;
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

  /**
   * 승인 요청과 짝지을 항목을 꺼낸다. ★turn 이 어긋나면 짝이 아니다.★
   *
   * turnId 대조를 하는 이유: 턴 경계 초기화만으로는 부족하다 — 초기화 신호(turn/started)를 놓치거나
   * 순서가 뒤집히면 ★이전 턴 내용이 살아남는다.★ 두 겹으로 막는다.
   * 승인 요청에 turnId 가 없으면(구세대·malformed) ★짝짓지 않는다★ — 대조할 수 없으면 통과가 아니라 ask.
   */
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

/** 벤더 changes 배열 → 좁은 모양. 모양이 어긋난 원소는 ★버린다★(추측해서 채우지 않는다). */
function normalizeChanges(raw: unknown): ObservedFileChange[] {
  if (!Array.isArray(raw)) return [];
  const out: ObservedFileChange[] = [];
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
    });
  }
  return out;
}
