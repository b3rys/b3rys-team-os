// 팀원 워크스페이스에는 skills 폴더가 없을 수 있어 절대경로가 필요하다. 실행 폴더를 바꾸면 발신자 감지도 실패할 수 있다.
import { test, expect } from "bun:test";
import { buildAgentsMd, buildPersona, REPO_ROOT } from "./personaTemplates";

const HOME = process.env.HOME ?? "";
const tilde = (p: string) => (HOME && p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p);
const ROOT = tilde(REPO_ROOT);

const agents = buildAgentsMd({ id: "ames", display_name: "Ames", role: "dev", runtime: "hermes_agent" });
const claude = buildPersona({ id: "steve", display_name: "Steve", role: "dev", runtime: "claude_channel" });

test("★send.sh 호출을 절대경로로 안내한다★ (워크스페이스 상대경로 금지)", () => {
  expect(agents).toContain(`${ROOT}/skills/b3os-team-inbox/scripts/send.sh`);
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
    // 렌더가 완료되지 않으면 리터럴 ${...} 경로가 남아 실행할 수 없으므로 치환 누락을 검사한다.
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
