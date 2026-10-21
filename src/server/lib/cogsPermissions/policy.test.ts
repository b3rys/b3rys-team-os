import { describe, expect, test } from "bun:test";
import { defaultPolicy, isExactAbsolutePath, isNarrowing, nextPolicy, policyRuntimeOf, readPolicy, type CogsPolicy } from "./policy";

const claude = (allow: string[], revision = 1): CogsPolicy => ({ runtime: "claude", schema_version: 1, revision, mode: "auto", allow });
const codex = (p: Partial<{ full: boolean; network: boolean; writable_roots: string[] }> = {}, revision = 1): CogsPolicy =>
  ({ runtime: "codex", schema_version: 1, revision, full: false, network: true, writable_roots: [], ...p });

describe("readPolicy — 없음·정상·깨짐을 가른다", () => {
  test("없으면 absent(옛 팀원)", () => {
    expect(readPolicy(undefined, "claude")).toEqual({ state: "absent" });
    expect(readPolicy(null, "codex")).toEqual({ state: "absent" });
  });
  test("정상 값은 그대로 돌아온다", () => {
    expect(readPolicy(claude(["Bash(git push:*)"], 3), "claude")).toEqual({ state: "valid", policy: claude(["Bash(git push:*)"], 3) });
    expect(readPolicy(codex({ writable_roots: ["/Users/x/proj"] }), "codex")).toEqual({ state: "valid", policy: codex({ writable_roots: ["/Users/x/proj"] }) });
  });
  const cases: Array<[string, unknown, "claude" | "codex"]> = [
    ["not_object", [], "claude"],
    ["runtime_mismatch", codex(), "claude"],
    ["schema_version", { ...claude([]), schema_version: 2 }, "claude"],
    ["revision", { ...claude([]), revision: 0 }, "claude"],
    ["revision", { ...claude([]), revision: 1.5 }, "claude"],
    ["unknown_field", { ...claude([]), extra: true }, "claude"],
    ["mode", { ...claude([]), mode: "bypass" }, "claude"],
    ["allow", claude(["Bash(rm\n-rf)"]), "claude"],
    ["allow", claude(["Read", "Read"]), "claude"],
    ["full", { ...codex(), full: "yes" }, "codex"],
    ["writable_roots", codex({ writable_roots: ["relative/path"] }), "codex"],
    ["writable_roots", codex({ writable_roots: ["/a/../b"] }), "codex"],
  ];
  for (const [reason, raw, rt] of cases) {
    test(`깨짐: ${reason} ${JSON.stringify(raw).slice(0, 60)}`, () => {
      expect(readPolicy(raw, rt)).toEqual({ state: "invalid", reason });
    });
  }
});

describe("nextPolicy — 사람이 바꾸는 칸만 받는다", () => {
  test("revision 은 서버가 +1", () => {
    expect(nextPolicy({ mode: "auto", allow: ["WebFetch"] }, "claude", 4)).toEqual({ ok: true, policy: claude(["WebFetch"], 5) });
  });
  test("revision·runtime 을 보내면 거절(서버가 정한다)", () => {
    expect(nextPolicy({ mode: "auto", allow: [], revision: 9 }, "claude", 1)).toEqual({ ok: false, code: "unsupported_field" });
    expect(nextPolicy({ full: true, network: true, writable_roots: [], runtime: "codex" }, "codex", 1)).toEqual({ ok: false, code: "unsupported_field" });
  });
  test("집행 미확인 칸(폴더 밖 읽기·명령)은 없다", () => {
    expect(nextPolicy({ full: false, network: true, writable_roots: [], read_outside: true }, "codex", 1)).toEqual({ ok: false, code: "unsupported_field" });
  });
  test("형식이 틀리면 bad_policy", () => {
    expect(nextPolicy({ mode: "auto", allow: "Read" }, "claude", 1)).toEqual({ ok: false, code: "bad_policy" });
    expect(nextPolicy(null, "codex", 1)).toEqual({ ok: false, code: "bad_policy" });
  });
});

describe("isNarrowing — 확실히 넓어진 것만 false", () => {
  test("클로드: 규칙을 빼면 축소, 더하기만 하면 아님", () => {
    const before = { state: "valid", policy: claude(["Read", "WebFetch"]) } as const;
    expect(isNarrowing(before, claude(["Read"]))).toBe(true);
    expect(isNarrowing(before, claude(["Read", "WebFetch", "Bash(ls:*)"]))).toBe(false);
  });
  test("코덱스: 전체 허용·인터넷 끄기, 경로 빼기는 축소", () => {
    const before = { state: "valid", policy: codex({ full: true, network: true, writable_roots: ["/a"] }) } as const;
    expect(isNarrowing(before, codex({ full: false, network: true, writable_roots: ["/a"] }))).toBe(true);
    expect(isNarrowing(before, codex({ full: true, network: false, writable_roots: ["/a"] }))).toBe(true);
    expect(isNarrowing(before, codex({ full: true, network: true, writable_roots: [] }))).toBe(true);
    expect(isNarrowing(before, codex({ full: true, network: true, writable_roots: ["/a", "/b"] }))).toBe(false);
  });
  test("이전이 없거나 깨졌으면 축소로 본다", () => {
    expect(isNarrowing({ state: "absent" }, claude([]))).toBe(true);
    expect(isNarrowing({ state: "invalid", reason: "x" }, claude(["Read"]))).toBe(true);
  });
});

test("기본값과 런타임 이름", () => {
  expect(defaultPolicy("claude")).toEqual(claude([]));
  expect(defaultPolicy("codex")).toEqual(codex());
  expect(policyRuntimeOf("claude_channel")).toBe("claude");
  expect(policyRuntimeOf("codex")).toBe("codex");
  expect(policyRuntimeOf("openclaw")).toBeNull();
});

test("정확한 절대경로만", () => {
  expect(isExactAbsolutePath("/Users/x/proj")).toBe(true);
  for (const p of ["/", "/a/", "a/b", "/a//b", "/a/./b", "/a/../b"]) expect(isExactAbsolutePath(p)).toBe(false);
});
