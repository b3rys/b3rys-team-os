// ★b3os_native 두뇌 선택(model_provider·model_id)의 ★로드 경로★ 회귀가드★
//
// 왜 이 파일이 따로 있나 — 이 버그는 ★유닛테스트를 통과하면서★ 실환경에서만 터지는 계열이다.
// `loadRegistry` 는 agents.json 을 필드 ★화이트리스트로 재구성★ 한다. 목록에 없는 필드는 로드에서
// 조용히 사라진다. 그런데 agent 객체를 ★손으로 만들어★ 넣는 테스트는 이 정규화 단계를 지나지
// 않으므로 사각지대가 된다 — 실제로 `no_bot` 때 유닛테스트 100+ 개가 전부 통과했는데 실환경에서
// 안 먹었다(2026-08-02). 그래서 여기서는 ★임시 agents.json 파일을 실제로 써서★ 로드 결과를 본다.
//
// 그리고 로드만 보는 것으로도 부족하다 — 이 필드의 의미는 "그래서 어떤 두뇌로 호출되나" 다.
// 그래서 마지막에 `pickModel` 까지 ★체인으로★ 확인한다(버그가 눈에 보이던 유일한 지점).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { loadRegistry } from "./registry";
import { pickModel, DEFAULT_PROVIDER, DEFAULT_MODEL } from "../runtimes/b3osNative/runner";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

/** 임시 agents.json 을 써서 첫 레코드를 로드한다 — ★정규화 경로를 반드시 통과시킨다.★ */
function loadOne(extra: Record<string, unknown>): any {
  const dir = mkdtempSync(join(tmpdir(), "registry-model-"));
  dirs.push(dir);
  const path = join(dir, "agents.json");
  writeFileSync(
    path,
    JSON.stringify([
      {
        id: "qwenling",
        display_name: "Qwenling",
        role: "local-model teammate",
        runtime: "b3os_native",
        status_provider: "b3os_native_runner",
        tmux_session: null,
        telegram_bot_username: null,
        workspace_path: "/tmp/qwenling",
        persona_file: "/tmp/qwenling/SOUL.md",
        moderator_eligible: false,
        avatar_emoji: "Q",
        ...extra,
      },
    ]),
  );
  return loadRegistry(path)[0];
}

describe("loadRegistry — b3os_native 두뇌 필드", () => {
  test("★핵심★ model_provider·model_id 가 로드에서 살아남는다", () => {
    const a = loadOne({ model_provider: "openai_compatible", model_id: "Qwen/Qwen3-32B" });
    expect(a.model_provider).toBe("openai_compatible");
    expect(a.model_id).toBe("Qwen/Qwen3-32B");
  });

  test("★버그 재현 가드★ 로드된 레코드가 pickModel 까지 가면 그 모델로 호출된다", () => {
    // 고치기 전엔 여기서 {anthropic, claude-sonnet-4-6} 이 나왔다 — 즉 agents.json 에 뭘 써도
    // 무조건 Claude 로 돌았다. 이 단정이 그 회귀를 잡는다.
    const a = loadOne({ model_provider: "openai_compatible", model_id: "Qwen/Qwen3-32B" });
    expect(pickModel(a.model_provider, a.model_id)).toEqual({
      provider: "openai_compatible",
      model: "Qwen/Qwen3-32B",
    });
  });

  test("ollama provider 도 그대로 전달된다(runner 화이트리스트의 다른 한 값)", () => {
    const a = loadOne({ model_provider: "ollama", model_id: "qwen3-coder-next:latest" });
    expect(pickModel(a.model_provider, a.model_id).provider).toBe("ollama");
  });

  test("★하위호환★ 필드가 없으면 null — 기존 팀원은 기본 두뇌(Claude)로 그대로 돈다", () => {
    const a = loadOne({});
    expect(a.model_provider).toBeNull();
    expect(a.model_id).toBeNull();
    expect(pickModel(a.model_provider, a.model_id)).toEqual({
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
    });
  });

  test("빈 문자열·공백은 null 로 접는다 — provider=\"  \" 로 호출이 나가지 않게", () => {
    // pickModel 은 `provider || DEFAULT` 라서 ""는 스스로 폴백하지만 "  "(공백)은 ★참★ 이다.
    // 여기서 접지 않으면 공백 provider 로 resolveCaller 가 불려 조용히 엉뚱한 곳으로 간다.
    expect(loadOne({ model_provider: "", model_id: "" }).model_provider).toBeNull();
    const ws = loadOne({ model_provider: "   ", model_id: "  " });
    expect(ws.model_provider).toBeNull();
    expect(ws.model_id).toBeNull();
    expect(pickModel(ws.model_provider, ws.model_id).provider).toBe(DEFAULT_PROVIDER);
  });

  test("문자열이 아닌 값(숫자·객체·배열·true)은 null 로 떨어뜨린다", () => {
    // 손으로 편집하는 파일이라 오타가 들어온다. 숫자 3을 provider 로 들고 가면 fetch 단계에서
    // 죽으므로, 경계에서 막고 기본 두뇌로 돈다.
    for (const bad of [3, { a: 1 }, ["x"], true]) {
      const a = loadOne({ model_provider: bad as unknown, model_id: bad as unknown });
      expect(a.model_provider).toBeNull();
      expect(a.model_id).toBeNull();
    }
  });

  test("한쪽만 있어도 각각 독립으로 살아남는다", () => {
    // provider 만 지정하고 모델은 runner 기본값을 쓰는 조합이 실제로 쓰인다.
    const onlyProvider = loadOne({ model_provider: "openai_compatible" });
    expect(onlyProvider.model_provider).toBe("openai_compatible");
    expect(onlyProvider.model_id).toBeNull();
    expect(pickModel(onlyProvider.model_provider, onlyProvider.model_id)).toEqual({
      provider: "openai_compatible",
      model: DEFAULT_MODEL,
    });

    const onlyModel = loadOne({ model_id: "Qwen/Qwen3-32B" });
    expect(onlyModel.model_provider).toBeNull();
    expect(onlyModel.model_id).toBe("Qwen/Qwen3-32B");
  });

  test("★하위호환★ 두 키를 뺀 나머지 레코드는 필드가 하나도 안 바뀐다", () => {
    // 이 매핑은 모든 팀원의 부팅 경로라, 조용한 변화가 곧 전원 장애다.
    const before = loadOne({});
    const after = loadOne({ model_provider: "openai_compatible", model_id: "Qwen/Qwen3-32B" });
    const strip = (r: any) => {
      const { model_provider: _p, model_id: _m, ...rest } = r;
      return rest;
    };
    expect(strip(after)).toEqual(strip(before));
  });
});
