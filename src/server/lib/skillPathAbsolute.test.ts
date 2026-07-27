// 팀원 지시문의 스킬 경로가 ★절대경로★ 인지 — 2026-07-27 발신자 감지 사고 회귀.
//
// 사고: AGENTS.md 가 workspace-relative `skills/b3os-team-inbox/scripts/send.sh` 를 시켰는데
// ★팀원 워크스페이스엔 skills/ 가 없다.★ 그래서 모델이 공용 team-os 폴더로 cd 한 뒤 실행했고,
// 거기서는 _me.sh 가 "현재 폴더 ↔ workspace_path" 매칭으로 신원을 못 찾아 ★발신자 해석이 실패★했다.
// 모델은 문서대로 한 것이다 — ★문서가 존재하지 않는 경로를 가리킨 게 원인.★
import { test, expect } from "bun:test";
import { buildAgentsMd, buildPersona, REPO_ROOT } from "./personaTemplates";

const HOME = process.env.HOME ?? "";
const tilde = (p: string) => (HOME && p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p);
const ROOT = tilde(REPO_ROOT);

const agents = buildAgentsMd({ id: "ames", display_name: "Ames", role: "dev", runtime: "hermes_agent" });
const claude = buildPersona({ id: "steve", display_name: "Steve", role: "dev", runtime: "claude_channel" });

test("★send.sh 호출을 절대경로로 안내한다★ (워크스페이스 상대경로 금지)", () => {
  expect(agents).toContain(`${ROOT}/skills/b3os-team-inbox/scripts/send.sh`);
  // ★상대경로 지시가 남아 있으면 안 된다★ — 그게 이번 사고의 원인이다.
  expect(agents).not.toContain("use `skills/b3os-team-inbox/scripts/send.sh");
});

test("스킬 카탈로그도 절대경로 (양 런타임)", () => {
  for (const [name, md] of [["AGENTS", agents], ["CLAUDE", claude]] as const) {
    expect(md, name).toContain(`${ROOT}/docs/B3OS_SKILLS.md`);
    // 상대 `docs/B3OS_SKILLS.md` 단독 언급이 남아 있으면 안 된다(절대경로의 꼬리는 허용).
    const relOnly = md.split("\n").filter((l) => l.includes("`docs/B3OS_SKILLS.md`"));
    expect(relOnly, `${name}: 상대경로 카탈로그 지시 잔존`).toEqual([]);
  }
});

test("★머신 고정 경로를 박지 않는다★ — REPO_ROOT 파생이라 이식 가능해야 한다", () => {
  for (const [name, md] of [["AGENTS", agents], ["CLAUDE", claude]] as const) {
    // HOME 밑이면 `~/` 로 나와야 한다. 사용자명이 그대로 박히면 다른 머신에서 무의미하다.
    if (HOME) expect(md, name).not.toContain(`${HOME}/`);
    // 렌더 실패로 치환이 안 된 흔적(리터럴 ${...})이 남으면 안 된다 — 실제로 한 번 밟았다.
    expect(md, name).not.toContain("${tilde(");
    expect(md, name).not.toContain("${REPO_ROOT}");
  }
});

test("가리키는 경로가 실재한다 — 안내가 죽은 주소를 주지 않는다", async () => {
  const { existsSync } = await import("node:fs");
  const abs = (p: string) => (p.startsWith("~/") ? `${HOME}/${p.slice(2)}` : p);
  for (const p of [`${ROOT}/skills/b3os-team-inbox/scripts/send.sh`, `${ROOT}/docs/B3OS_SKILLS.md`, `${ROOT}/skills`]) {
    expect(existsSync(abs(p)), `${p} 가 없다`).toBe(true);
  }
});
