import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FALLBACK_RUNTIME_OPTIONS, fetchRuntimeOptions, runtimeSetupHref, type RuntimeOption } from "./runtimeOptions";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
function mockFetch(payload: unknown, ok = true) {
  globalThis.fetch = (async () => ({ ok, json: async () => payload })) as unknown as typeof fetch;
}
const opt = (runtime: string): RuntimeOption => ({ runtime: runtime as RuntimeOption["runtime"], label: runtime, recommended: false, tier: "advanced_byo", disabled: false, reason: "", setup_ref: null });

test("Settings와 AgentConfig는 공용 runtime-options를 쓰고 fallback도 공개 3종만 둔다", () => {
  expect(FALLBACK_RUNTIME_OPTIONS.map((o) => o.runtime)).toEqual(["claude_channel", "hermes_agent", "openclaw"]);
  expect(FALLBACK_RUNTIME_OPTIONS.filter((o) => o.tier === "advanced_byo").every((o) => o.disabled && o.setup_ref)).toBe(true);
  for (const file of ["Settings.ts", "AgentConfig.ts"]) {
    const source = readFileSync(join(import.meta.dir, file), "utf8");
    expect(source).toContain("fetchRuntimeOptions");
  }
});

test("fetchRuntimeOptions 2차방어는 공개3종·내부3종+codex 두 형태만 통과시킨다", async () => {
  // 공개 3종 — 그대로 통과.
  mockFetch({ public_build: true, options: ["claude_channel", "hermes_agent", "openclaw"].map(opt) });
  expect((await fetchRuntimeOptions()).map((o) => o.runtime)).toEqual(["claude_channel", "hermes_agent", "openclaw"]);
  // 내부 4종(codex 포함) — 잘못 거부하지 않고 통과.
  mockFetch({ public_build: false, options: ["claude_channel", "hermes_agent", "openclaw", "codex"].map(opt) });
  expect((await fetchRuntimeOptions()).map((o) => o.runtime)).toEqual(["claude_channel", "hermes_agent", "openclaw", "codex"]);
  // 형태 위반(순서 뒤섞임/미지 런타임) — 보수적 fallback(공개 3종).
  mockFetch({ public_build: false, options: ["claude_channel", "b3os_native", "openclaw"].map(opt) });
  expect((await fetchRuntimeOptions()).map((o) => o.runtime)).toEqual(["claude_channel", "hermes_agent", "openclaw"]);
  // API 실패(non-ok) — fallback(Claude enabled + BYO disabled) 유지.
  mockFetch({}, false);
  const fb = await fetchRuntimeOptions();
  expect(fb).toBe(FALLBACK_RUNTIME_OPTIONS);
  expect(fb.find((o) => o.runtime === "claude_channel")?.disabled).toBe(false);
  expect(fb.filter((o) => o.tier === "advanced_byo").every((o) => o.disabled)).toBe(true);
});

test("온보딩 문서는 선택모드·BYO 체크리스트·Codex 제외 정책을 고정한다", () => {
  const root = join(import.meta.dir, "../../..");
  const skill = readFileSync(join(root, "skills/b3os/SKILL.md"), "utf8");
  const recruit = readFileSync(join(root, "skills/b3os/references/recruit.md"), "utf8");
  const setup = readFileSync(join(root, "skills/b3os/references/runtime-setup.md"), "utf8");
  expect(skill).toContain("런타임 선택 모드");
  expect(skill).toContain("이 세 가지 외 내부 런타임은 온보딩에 노출하지 않는다");
  expect(recruit).toContain("disabled+사유+연동 안내");
  expect(setup).toContain("macOS BYO 체크리스트");
  expect(setup).toContain("preflight recheck");
  expect(setup).toContain("pair-approve");
});

test("BYO 연동 안내 링크는 실제 서빙되는 runtime setup 문서로 향한다", () => {
  expect(runtimeSetupHref("skills/b3os/references/runtime-setup.md#hermes-agent")).toBe("/team/docs/runtime-setup.md#hermes-agent");
  expect(runtimeSetupHref("skills/b3os/references/runtime-setup.md#openclaw")).toBe("/team/docs/runtime-setup.md#openclaw");
});
