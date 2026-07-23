// b3os_native runner — M2b OpenAI 호환 caller + resolveCaller 게이팅 테스트.
// global.fetch 모킹(진짜 API 호출 X). 환경변수 플래그 분기 검증.
import { afterEach, describe, expect, test } from "bun:test";
import {
  callClaude,
  callOpenAICompatible,
  resolveCaller,
  OPENAI_COMPAT_FLAG,
} from "./runner";

const origFetch = global.fetch;
const origFlag = process.env[OPENAI_COMPAT_FLAG];

afterEach(() => {
  global.fetch = origFetch;
  if (origFlag === undefined) delete process.env[OPENAI_COMPAT_FLAG];
  else process.env[OPENAI_COMPAT_FLAG] = origFlag;
});

function mockFetch(status: number, body: unknown): void {
  global.fetch = (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("callOpenAICompatible (M2b)", () => {
  const turn = { provider: "ollama", model: "gemma3:27b-it-qat", system: "sys", prompt: "hi" };

  test("정상: choices[].message.content 파싱·trim", async () => {
    mockFetch(200, { choices: [{ message: { content: "  안녕하세요  " } }] });
    expect(await callOpenAICompatible(turn)).toBe("안녕하세요");
  });

  test("비정상 status → openai_compat_api_<status> 에러", async () => {
    mockFetch(500, "boom");
    await expect(callOpenAICompatible(turn)).rejects.toThrow(/openai_compat_api_500/);
  });

  test("빈 응답(choices 없음/내용 빈값) → openai_compat_empty_response", async () => {
    mockFetch(200, { choices: [] });
    await expect(callOpenAICompatible(turn)).rejects.toThrow("openai_compat_empty_response");
  });
});

describe("resolveCaller 게이팅(플래그가드)", () => {
  test("플래그 off → ollama provider라도 callClaude(회귀 0)", () => {
    delete process.env[OPENAI_COMPAT_FLAG];
    expect(resolveCaller("ollama")).toBe(callClaude);
    expect(resolveCaller("anthropic")).toBe(callClaude);
  });

  test("플래그 on + provider ollama/openai_compatible → callOpenAICompatible", () => {
    process.env[OPENAI_COMPAT_FLAG] = "1";
    expect(resolveCaller("ollama")).toBe(callOpenAICompatible);
    expect(resolveCaller("openai_compatible")).toBe(callOpenAICompatible);
  });

  test("플래그 on + provider anthropic → callClaude(기존 경로 유지)", () => {
    process.env[OPENAI_COMPAT_FLAG] = "1";
    expect(resolveCaller("anthropic")).toBe(callClaude);
  });
});
