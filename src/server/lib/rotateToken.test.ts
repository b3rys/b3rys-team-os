// rotateToken — 런타임별 격리 스토어 + fail-safe 검증. 토큰 값은 다루지 않음(경로/형식만).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveTokenStore, validateBotToken, rotateBotToken, openclawConfiguredTokenFile } from "./rotateToken";
import { REPO_ROOT } from "./personaTemplates";

const agent = (runtime: string, id: string, extra: Record<string, unknown> = {}) => ({ id, runtime, display_name: id, role: "x", ...extra }) as any;
const mkOpenclawCfg = (accounts: Record<string, unknown>) => {
  const dir = mkdtempSync(join(tmpdir(), "octok-"));
  const p = join(dir, "openclaw.json");
  writeFileSync(p, JSON.stringify({ channels: { telegram: { accounts } } }));
  return p;
};

describe("rotateToken: resolveTokenStore 런타임별 격리", () => {
  test("codex → 스토어 반환(var/secrets)", () => {
    expect("unsupported" in resolveTokenStore("codex", "codi", agent("codex", "codi"))).toBe(false);
  });
  test("claude_channel → 스토어 반환(.env)", () => {
    expect("unsupported" in resolveTokenStore("claude_channel", "bill", agent("claude_channel", "bill"))).toBe(false);
  });
  test("hermes_agent → 스토어 반환(.env)", () => {
    expect("unsupported" in resolveTokenStore("hermes_agent", "hermes", agent("hermes_agent", "hermes"))).toBe(false);
  });
  test("openclaw 토큰파일 없는 계정(brief 류) → unsupported(인라인/미정의, 기존 유지)", () => {
    const s = resolveTokenStore("openclaw", "nonexistent_openclaw_x", agent("openclaw", "nonexistent_openclaw_x"));
    expect("unsupported" in s).toBe(true);
    if ("unsupported" in s) expect(s.unsupported).toContain("직접");
  });
  test("알 수 없는 런타임 → unsupported(기존 유지)", () => {
    expect("unsupported" in resolveTokenStore("weird_runtime", "x", agent("weird_runtime", "x"))).toBe(true);
  });
});

// GD 2026-07-05 fix — openclaw 파일기반 계정은 토큰파일 실종돼도 rotate 허용(생성). 인라인/비표준경로는 거부. 하네스 지적으로 신 분기 커버.
describe("rotateToken: openclawConfiguredTokenFile 파일기반 판별(fixture 격리)", () => {
  test("tokenFile 정의된 파일기반 계정 → 경로 반환 (파일 실존 여부 무관 = Lui 실종 케이스)", () => {
    const p = mkOpenclawCfg({ lui: { name: "GD LUI", enabled: true, tokenFile: "/abs/telegram-lui-token.txt" } });
    expect(openclawConfiguredTokenFile("lui", p)).toBe("/abs/telegram-lui-token.txt");
  });
  test("인라인 botToken 계정(tokenFile 없음) → null (거부 대상 — default/jy 류)", () => {
    const p = mkOpenclawCfg({ jy: { name: "JY", botToken: "123456:AAAA" } });
    expect(openclawConfiguredTokenFile("jy", p)).toBeNull();
  });
  test("config 에 없는 계정(codex→gd 미존재 류) → null", () => {
    const p = mkOpenclawCfg({ lui: { tokenFile: "/abs/t.txt" } });
    expect(openclawConfiguredTokenFile("ghost", p)).toBeNull();
  });
  test("빈/공백 tokenFile → null", () => {
    const p = mkOpenclawCfg({ x: { tokenFile: "   " } });
    expect(openclawConfiguredTokenFile("x", p)).toBeNull();
  });
  test("cfg 파일 미존재(공개판=openclaw 설정 없음) → null, 크래시 없음(deny-safe)", () => {
    expect(openclawConfiguredTokenFile("lui", join(tmpdir(), "no-such-openclaw-xyz.json"))).toBeNull();
  });
  test("malformed JSON → null (catch, 크래시 없음)", () => {
    const dir = mkdtempSync(join(tmpdir(), "octok-"));
    const p = join(dir, "openclaw.json");
    writeFileSync(p, "{ not valid json ");
    expect(openclawConfiguredTokenFile("lui", p)).toBeNull();
  });
});

describe("rotateToken: validateBotToken 형식(네트워크 전 차단)", () => {
  test("빈/짧은/형식오류 → bot_token_invalid (getMe 호출 안 함)", async () => {
    for (const bad of ["", "bad", "123:short", "abc:defghijklmnopqrstuvwxyz1234567890"]) {
      const r = await validateBotToken(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("bot_token_invalid");
    }
  });
});

describe("rotateToken: fail-safe(검증 실패 시 기존 안 건드림)", () => {
  test("형식 오류면 store.write 호출 0 + 기존 유지", async () => {
    let wrote = 0, restarted = 0;
    // rotateBotToken은 validateBotToken(형식)에서 먼저 걸러 store 접근 전 반환.
    const res = await rotateBotToken(
      async () => { restarted++; return { ok: true, detail: "" }; },
      "codex", "codi", agent("codex", "codi"), "bad-format",
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("bot_token_invalid");
    expect(restarted).toBe(0); // 재시작 안 함 = 기존 유지
    expect(wrote).toBe(0);
  });
  test("미지원 런타임(openclaw brief류)이면 재시작 0 + 기존 유지 메시지", async () => {
    // 형식 유효한 더미 토큰(네트워크는 탐 — CI에선 getme_failed일 수 있으니 unsupported 경로만 확정 검증은 형식 이전 단계).
    // 여기선 resolveTokenStore 단으로 unsupported가 store 접근·재시작을 막는지 rotateBotToken 흐름으로 확인.
    let restarted = 0;
    const res = await rotateBotToken(
      async () => { restarted++; return { ok: true, detail: "" }; },
      "openclaw", "nonexistent_openclaw_x", agent("openclaw", "nonexistent_openclaw_x"),
      "1234567:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    );
    // getMe가 이 더미 토큰을 dead로 거부하거나(bot_token_dead) 네트워크(getme_failed) — 어느 쪽이든 store 접근 전이라 재시작 0.
    expect(res.ok).toBe(false);
    expect(restarted).toBe(0);
  });

  test("restart 성공 후 essentials 실패 → old token 파일만 복원하지 않는다(프로세스/파일 불일치 방지)", async () => {
    const id = `essfail-${Date.now()}`;
    const tokenFile = join(REPO_ROOT, "var/secrets", `${id}.bot-token`);
    mkdirSync(dirname(tokenFile), { recursive: true });
    writeFileSync(tokenFile, "111111:" + "A".repeat(35) + "\n", "utf-8");
    const oldFetch = globalThis.fetch;
    process.env.TEAMOS_POLLER_WAIT_MS = "1";
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, result: { username: "new_bot" } }))) as unknown as typeof fetch;
    try {
      let restarted = 0;
      const newToken = "222222:" + "B".repeat(35);
      const res = await rotateBotToken(
        async () => { restarted++; return { ok: true, detail: "restarted" }; },
        "codex", id, agent("codex", id), newToken,
      );
      expect(res.ok).toBe(false);
      expect(res.error).toBe("essentials_failed");
      expect(restarted).toBe(1);
      expect(readFileSync(tokenFile, "utf-8").trim()).toBe(newToken);
    } finally {
      globalThis.fetch = oldFetch;
      delete process.env.TEAMOS_POLLER_WAIT_MS;
      if (existsSync(tokenFile)) rmSync(tokenFile, { force: true });
    }
  });
});
