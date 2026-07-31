/**
 * 규칙 정본이 공개 템플릿과 벌어졌는지 본다.
 *
 * `rules/TEAM-OS.md` 는 추적 대상이 아니라 업데이트와 함께 오지 않는다. 템플릿만 온다.
 * 그래서 규칙이 바뀌어도 받는 쪽은 모른다 — 실제로 한 기계만 옛 규칙으로 돈 적이 있다.
 *
 * ★한 방향만 센다★ — 템플릿에만 있는 줄(= 아직 안 받은 새 규칙).
 * 정본에만 있는 줄은 그 팀이 의도적으로 더한 규칙일 수 있으므로 차이로 세지 않는다.
 */
export function missingFromLive(live: string, template: string): string[] {
  const liveLines = new Set(live.split("\n"));
  return template.split("\n").filter((l) => l.trim().length > 0 && !liveLines.has(l));
}
