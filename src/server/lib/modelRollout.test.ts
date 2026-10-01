// 팀원 모델 전환 — 실제 설정·서비스는 건드리지 않는다. 임시 HOME + 가짜 실행기로 잰다.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyAll, checkMember, classifyFailure, listMembers, readCurrent, tomlTopGet, tomlTopSet, writeModel, yamlGet, yamlSet,
  type Env, type Member, type Runner,
} from "./modelRollout";

const HERMES_YAML = `model:
  provider: openai-codex
  default: gpt-6-astra
agent:
  verify_on_stop: false
  reasoning_effort: medium
delegation:
  default: other
`;
const CODEX_TOML = `model = "gpt-6-astra"
model_reasoning_effort = "medium"

[mcp_servers.x]
model = "do-not-touch"
`;

describe("설정 읽기·쓰기", () => {
  test("yaml: 블록 안의 key 만 본다(다른 블록의 같은 이름은 무시)", () => {
    expect(yamlGet(HERMES_YAML, "model", "default")).toBe("gpt-6-astra");
    expect(yamlGet(HERMES_YAML, "agent", "reasoning_effort")).toBe("medium");
    const out = yamlSet(HERMES_YAML, "model", "default", "gpt-6.1-sol")!;
    expect(yamlGet(out, "model", "default")).toBe("gpt-6.1-sol");
    expect(yamlGet(out, "delegation", "default")).toBe("other");
    expect(out.split("\n").length).toBe(HERMES_YAML.split("\n").length);
  });
  test("yaml: 줄이 없으면 null(끼워 넣지 않는다)", () => {
    expect(yamlSet("model:\n  provider: x\n", "model", "default", "m")).toBeNull();
    expect(yamlSet("other:\n  a: b\n", "model", "default", "m")).toBeNull();
  });
  test("toml: 첫 [표] 앞의 최상위 키만", () => {
    expect(tomlTopGet(CODEX_TOML, "model")).toBe("gpt-6-astra");
    const out = tomlTopSet(CODEX_TOML, "model", "gpt-6.1-sol")!;
    expect(tomlTopGet(out, "model")).toBe("gpt-6.1-sol");
    expect(out).toContain('model = "do-not-touch"');
    expect(tomlTopSet('[a]\nmodel = "x"\n', "model", "y")).toBeNull();
  });
  test("writeModel + readCurrent 가 왕복한다", () => {
    const h: Member = { id: "h", runtime: "hermes_agent", configPath: "", serviceLabel: "", handle: "h" };
    const c: Member = { id: "c", runtime: "codex", configPath: "", serviceLabel: "", handle: "/x" };
    expect(readCurrent(h, writeModel(h, HERMES_YAML, "gpt-6.1-sol", "high")!)).toEqual({ model: "gpt-6.1-sol", effort: "high" });
    expect(readCurrent(c, writeModel(c, CODEX_TOML, "gpt-6.1-sol", null)!)).toEqual({ model: "gpt-6.1-sol", effort: "medium" });
  });
  test("openclaw 는 entry.model(문자열·primary) 을 읽고 openai/ 접두를 뗀다", () => {
    const o: Member = { id: "devon", runtime: "openclaw", configPath: "", serviceLabel: "", handle: "devon" };
    const cfg = { agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } }, entries: { devon: { model: "openai/gpt-6-astra" }, x: {} } } };
    expect(readCurrent(o, JSON.stringify(cfg)).model).toBe("gpt-6-astra");
    expect(readCurrent({ ...o, handle: "x" }, JSON.stringify(cfg)).model).toBe("gpt-5.6-sol");
  });
});

describe("실패 분류 — 인증·한도·시간초과는 '지원 안 됨' 이 아니다", () => {
  const table: Array<[number, string, string]> = [
    [142, "", "시간 초과(미확인)"],
    [1, "HTTP 401 token_invalidated", "인증(미확인)"],
    [1, "usage limit reached", "한도(미확인)"],
    [1, "Unknown model: openai/x", "모델을 모름"],
    [3, "boom", "실패(exit 3)"],
  ];
  for (const [code, text, want] of table) test(`${code} ${text || "(빈)"} → ${want}`, () => expect(classifyFailure({ code, stdout: "", stderr: text })).toBe(want));
});

let home: string;
let env: Env;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rollout-home-"));
  env = { home, uid: 501, launchdPrefix: "com.test", codexBin: "codex", hermesPython: "python", openclawBin: "openclaw" };
  mkdirSync(join(home, ".hermes/profiles/hp"), { recursive: true });
  writeFileSync(join(home, ".hermes/profiles/hp/config.yaml"), HERMES_YAML);
  mkdirSync(join(home, ".codex-agents/dx"), { recursive: true });
  writeFileSync(join(home, ".codex-agents/dx/config.toml"), CODEX_TOML);
  mkdirSync(join(home, ".openclaw"), { recursive: true });
  writeFileSync(join(home, ".openclaw/openclaw.json"), JSON.stringify({ agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } }, entries: { devon: { model: "openai/gpt-6-astra" }, family: {} } } }));
  writeFileSync(join(home, "agents.json"), JSON.stringify([
    { id: "herm", runtime: "hermes_agent", hermes_profile: "hp" },
    { id: "dx", runtime: "codex" },
    { id: "off", runtime: "hermes_agent", enabled: false },
    { id: "cl", runtime: "claude_channel" },
  ]));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("팀원 목록", () => {
  test("hermes·codex 는 명단에서, openclaw 는 openclaw.json 의 모델이 있는 에이전트만", () => {
    const ms = listMembers(join(home, "agents.json"), env);
    expect(ms.map((m) => `${m.id}:${m.runtime}`)).toEqual(["herm:hermes_agent", "dx:codex", "devon:openclaw"]);
    expect(ms[0]!.serviceLabel).toBe("ai.hermes.gateway-hp");
    expect(ms[0]!.provider).toBe("openai-codex");
    expect(ms[1]!.serviceLabel).toBe("com.test.codex-bridge-dx");
  });
});

/** 가짜 실행기: hermes 는 usage 파일, codex 는 세션 기록을 '실제 응답 모델' 로 남긴다. */
function fakeRunner(opts: { model?: (cmd: string[]) => string | null; restartFails?: boolean; ocModels?: Array<{ key: string; available: boolean | null }> }) {
  const calls: string[][] = [];
  const run: Runner = async (cmd, o) => {
    calls.push(cmd);
    if (cmd[0] === "launchctl") return { code: opts.restartFails ? 1 : 0, stdout: "", stderr: "" };
    if (cmd[0] === "openclaw" && cmd[1] === "models") return { code: 0, stdout: JSON.stringify({ models: opts.ocModels ?? [] }), stderr: "" };
    if (cmd[0] === "openclaw") return { code: 0, stdout: "", stderr: "" };
    const model = opts.model ? opts.model(cmd) : null;
    if (cmd[0] === "python") {
      const usage = cmd[cmd.indexOf("--usage-file") + 1]!;
      writeFileSync(usage, JSON.stringify(model ? { model, completed: true, failed: false } : { failed: true }));
      return { code: model ? 0 : 1, stdout: "", stderr: model ? "" : "usage limit" };
    }
    if (cmd[0] === "codex") {
      const dir = join(o!.env!.CODEX_HOME!, "sessions/2026/10/01");
      mkdirSync(dir, { recursive: true });
      if (model) writeFileSync(join(dir, `rollout-${Date.now()}-${Math.random()}.jsonl`), `{"type":"turn_context","payload":{"model":"${model}"}}\n`.replace('"payload":{', '"payload":{').replace('{"model"', '{"model"'));
      return { code: model ? 0 : 1, stdout: "", stderr: model ? "" : "HTTP 401" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

/** 지금 설정 파일이 말하는 모델 — 적용 뒤 확인(override 없음)이 이걸 돌려준다. */
const configModel = (path: string, runtime: "hermes" | "codex") => () => {
  const t = readFileSync(path, "utf-8");
  return runtime === "hermes" ? yamlGet(t, "model", "default") : tomlTopGet(t, "model");
};

describe("check — 설정을 바꾸지 않는다", () => {
  test("hermes: 요청 모델로 실제 응답하면 works", async () => {
    const m = listMembers(join(home, "agents.json"), env)[0]!;
    const { run, calls } = fakeRunner({ model: (cmd) => cmd[cmd.lastIndexOf("-m") + 1] ?? null });
    const r = await checkMember(m, { model: "gpt-6.1-sol", effort: null }, env, run);
    expect(r).toMatchObject({ verdict: "works", actualModel: "gpt-6.1-sol" });
    expect(calls[0]).toContain("--provider");
    expect(readFileSync(m.configPath, "utf-8")).toBe(HERMES_YAML);
  });
  test("hermes: 다른 모델이 답하면 not_supported, 실패면 unknown(한도)", async () => {
    const m = listMembers(join(home, "agents.json"), env)[0]!;
    expect((await checkMember(m, { model: "gpt-x", effort: null }, env, fakeRunner({ model: () => "gpt-6-astra" }).run)).verdict).toBe("not_supported");
    const u = await checkMember(m, { model: "gpt-x", effort: null }, env, fakeRunner({ model: () => null }).run);
    expect(u).toMatchObject({ verdict: "unknown", detail: "한도(미확인)" });
  });
  test("codex: 세션 기록의 실제 모델로 판정", async () => {
    const m = listMembers(join(home, "agents.json"), env)[1]!;
    const r = await checkMember(m, { model: "gpt-6.1-sol", effort: "medium" }, env, fakeRunner({ model: (cmd) => cmd[cmd.lastIndexOf("-m") + 1] ?? null }).run);
    expect(r).toMatchObject({ verdict: "works", actualModel: "gpt-6.1-sol" });
  });
  test("openclaw: 게이트웨이 목록 available 만 믿는다", async () => {
    const m = listMembers(join(home, "agents.json"), env)[2]!;
    expect((await checkMember(m, { model: "gpt-6.1-sol", effort: null }, env, fakeRunner({ ocModels: [{ key: "openai/gpt-6.1-sol", available: null }] }).run)).verdict).toBe("not_supported");
    expect((await checkMember(m, { model: "gpt-6.1-sol", effort: null }, env, fakeRunner({ ocModels: [] }).run)).detail).toContain("목록에 없음");
    expect((await checkMember(m, { model: "gpt-6.1-sol", effort: null }, env, fakeRunner({ ocModels: [{ key: "openai/gpt-6.1-sol", available: true }] }).run)).verdict).toBe("works");
  });
});

describe("apply", () => {
  const target = { model: "gpt-6.1-sol", effort: "medium" };
  test("미리보기(yes=false)는 아무것도 바꾸지 않는다", async () => {
    const ms = listMembers(join(home, "agents.json"), env);
    const { run, calls } = fakeRunner({ ocModels: [{ key: "openai/gpt-6.1-sol", available: true }] });
    const steps = await applyAll(ms, target, env, run, false, "t1");
    expect(steps.filter((s) => s.action === "plan").length).toBe(3);
    expect(calls.filter((c) => c[0] === "launchctl" || (c[0] === "openclaw" && c[1] !== "models"))).toEqual([]);
    expect(readFileSync(ms[0]!.configPath, "utf-8")).toBe(HERMES_YAML);
  });
  test("성공: 백업 → 쓰기 → 그 팀원만 재시작 → 실제 모델 확인", async () => {
    const ms = listMembers(join(home, "agents.json"), env);
    const h = ms[0]!, c = ms[1]!;
    const { run, calls } = fakeRunner({ model: (cmd) => (cmd[0] === "python" ? configModel(h.configPath, "hermes")() : configModel(c.configPath, "codex")()), ocModels: [] });
    const steps = await applyAll([h, c], target, env, run, true, "t2");
    expect(steps.filter((s) => s.action === "verify").every((s) => s.ok)).toBe(true);
    expect(yamlGet(readFileSync(h.configPath, "utf-8"), "model", "default")).toBe("gpt-6.1-sol");
    expect(tomlTopGet(readFileSync(c.configPath, "utf-8"), "model")).toBe("gpt-6.1-sol");
    expect(existsSync(`${h.configPath}.bak-rollout-t2`)).toBe(true);
    expect(calls.filter((x) => x[0] === "launchctl").map((x) => x[3])).toEqual(["gui/501/ai.hermes.gateway-hp", "gui/501/com.test.codex-bridge-dx"]);
  });
  test("확인 실패면 백업 복원 + 재시작", async () => {
    const h = listMembers(join(home, "agents.json"), env)[0]!;
    const { run } = fakeRunner({ model: () => "gpt-6-astra" }); // 바꿨는데도 옛 모델이 답함
    const steps = await applyAll([h], target, env, run, true, "t3");
    expect(steps.find((s) => s.action === "verify")!.ok).toBe(false);
    expect(steps.find((s) => s.action === "rollback")!.ok).toBe(true);
    expect(readFileSync(h.configPath, "utf-8")).toBe(HERMES_YAML);
  });
  test("이미 그 모델이면 건너뛴다", async () => {
    const h = listMembers(join(home, "agents.json"), env)[0]!;
    writeFileSync(h.configPath, writeModel(h, HERMES_YAML, "gpt-6.1-sol", "medium")!);
    const steps = await applyAll([h], target, env, fakeRunner({}).run, true, "t4");
    expect(steps).toEqual([{ member: "herm", action: "skip", ok: true, detail: "이미 gpt-6.1-sol" }]);
  });
  test("openclaw: 게이트웨이가 모델을 모르면 아무도 안 바꾼다(재시작도 없음)", async () => {
    const o = listMembers(join(home, "agents.json"), env)[2]!;
    const { run, calls } = fakeRunner({ ocModels: [{ key: "openai/gpt-6.1-sol", available: null }] });
    const steps = await applyAll([o], target, env, run, true, "t5");
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ action: "skip", ok: false });
    expect(calls.some((c) => c[1] === "gateway" || c[1] === "config")).toBe(false);
    expect(readdirSync(join(home, ".openclaw")).some((f) => f.includes("bak-rollout"))).toBe(false);
  });
});
