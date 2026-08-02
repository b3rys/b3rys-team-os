import type { StopResult } from "../../server/lib/agentControl";

/**
 * "전원 정지" 결과에서 ★실제로 정지된 팀원 id★ 만 고른다.
 *
 * ★이름으로 거르지 않는다.★ 예전에는 `x.id !== "bill"` 이었는데, 그건 두 가지로 틀린다:
 *   · 코디네이터가 바뀌면 ★엉뚱한 사람이 유지된 것으로 표시★ 되고 원래 코디가 정지 목록에 뜬다
 *   · ★그런 이름이 아예 없는 설치(공개 사용자)★ 에서는 아무도 안 걸러진다
 * 서버가 `kept` 로 표시하므로 그걸 읽는다 — ★누가 코디인지는 명부가 정한다.★
 */
export function stoppedIds(results: ReadonlyArray<StopResult>): string[] {
  return results.filter((x) => x.ok && !x.kept).map((x) => x.id);
}

/**
 * 스레드에서 보낼 상대를 정한다. ★못 정하면 null 이다 — 아무에게나 보내지 않는다.★
 *
 * 예전에는 `recipients[0] ?? "bill"` 이라 ★받는 사람을 못 찾으면 특정 팀원에게 보냈다.★
 * 공개 설치에는 그런 id 가 없어서 ★존재하지 않는 상대로 발신★ 된다.
 * 아무에게나 보내는 것보다 ★안 보내고 알려주는 쪽★ 이 낫다 — 잘못 간 메시지는 되돌릴 수 없다.
 */
export function threadRecipient(participants: ReadonlyArray<string> | undefined): string | null {
  return (participants ?? []).find((p) => p !== "user") ?? null;
}

/** 정지에서 ★실제로 제외된★ 팀원 id. 화면이 "누가 유지됐나" 를 추측하지 않게 서버 결과를 그대로 읽는다. */
export function keptIds(results: ReadonlyArray<StopResult>): string[] {
  return results.filter((x) => x.kept).map((x) => x.id);
}
