// 앱 [팀원 추가] b3os 쪽 — 인증·입력·작업 상태·되돌림·첫 인사. 실제 홈·라이브 명단·네트워크에 닿지 않는다.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createB3chatTeammateRoutes, setModelLine, type B3chatTeammateDeps } from "./b3chatTeammate";
import { decideWindowRequest, type BridgeWindowRequest } from "../runtimes/codex/bridgeWindow";
import { isDirectLocal, linkSecretMatches } from "../lib/b3chatLink";

const KEY = "k".repeat(43);
const TOKEN = `7:${"t".repeat(43)}`;
const BODY = { id: "testmate", display_name: "테스트메이트", role: "시험", runtime: "codex", api_base: "http://127.0.0.1:8741", room_id: "5", bot_token: TOKEN };

function setup(opts: { activate?: () => Response | Promise<Response>; greetedAfter?: number; bridgeOk?: boolean; tokenOk?: boolean; existing?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "b3t-"));
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify((opts.existing ?? ["bill"]).map((id) => ({ id, display_name: id, role: "x", runtime: "codex" })), null, 2));
  const keyPath = join(dir, "link.key");
  writeFileSync(keyPath, KEY);
  const calls: string[] = [];
  const settings = new Hono();
  settings.post("/members/recruit", async (c) => {
    const b = await c.req.json();
    calls.push(`recruit:${b.id}:${b.runtime}`);
    const list = JSON.parse(readFileSync(registryPath, "utf-8"));
    list.push({ id: b.id, display_name: b.display_name, role: b.role, runtime: b.runtime });
    writeFileSync(registryPath, JSON.stringify(list, null, 2));
    return c.json({ ok: true, ot_id: "ot_x" });
  });
  settings.post("/ot/:ot/activate", async () => { calls.push("activate"); return opts.activate ? opts.activate() : Response.json({ ok: true, steps: [] }); });
  settings.delete("/members/:id", async (c) => {
    const b = await c.req.json();
    calls.push(`remove:${c.req.param("id")}:${b.confirm_name}`);
    return c.json({ ok: true });
  });
  const bridgeReqs: BridgeWindowRequest[] = [];
  let greetPolls = 0;
  const settled: Record<string, () => void> = {};
  const db = new Database(":memory:");
  const deps: B3chatTeammateDeps = {
    db, settings, registryPath, linkKeyPath: keyPath,
    remoteAddress: () => "127.0.0.1",
    validateToken: async () => (opts.tokenOk === false ? { ok: false, error: "bot_token_dead" } : { ok: true, username: "testmate" }),
    prepareModel: (id) => calls.push(`model:${id}`),
    callBridge: async (r) => { bridgeReqs.push(r); return opts.bridgeOk === false ? { ok: false, reason: "no_window" } : { ok: true, duplicate: false }; },
    greeted: () => ++greetPolls > (opts.greetedAfter ?? 1),
    greetingWaitMs: 200, pollMs: 2, activateTimeoutMs: 100,
    onJobSettled: (id) => settled[id]?.(),
  };
  const app = createB3chatTeammateRoutes(deps);
  const post = (body: unknown, headers: Record<string, string> = { "x-b3chat-link": KEY }) =>
    app.request("/members/b3chat", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const get = (jobId: string) => app.request(`/members/b3chat/${jobId}`, { headers: { "x-b3chat-link": KEY } });
  const waitJob = async (res: Response) => {
    const j = (await res.json()) as { job_id: string };
    await new Promise<void>((r) => { settled[j.job_id] = r; });
    return (await (await get(j.job_id)).json()) as Record<string, unknown>;
  };
  return { dir, registryPath, calls, bridgeReqs, app, post, get, waitJob, deps };
}

describe("인증 — 같은 기계 직접 + 공유 비밀", () => {
  test("비밀 없음·틀림 → 403, 무엇이 틀렸는지 안 알린다", async () => {
    const s = setup();
    for (const h of [{}, { "x-b3chat-link": "wrong" }]) {
      const r = await s.post(BODY, h as Record<string, string>);
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ ok: false, code: "forbidden", retryable: false, stage: "auth" });
    }
    expect(s.calls).toEqual([]);
  });
  test("터널·프록시 헤더가 붙으면 loopback 이어도 거부", () => {
    for (const h of ["cf-ray", "cf-connecting-ip", "x-forwarded-for", "forwarded", "x-real-ip"]) {
      expect(isDirectLocal("127.0.0.1", new Headers({ [h]: "1" }))).toBe(false);
    }
    expect(isDirectLocal("127.0.0.1", new Headers())).toBe(true);
    expect(isDirectLocal("::1", new Headers())).toBe(true);
    expect(isDirectLocal("192.168.0.5", new Headers())).toBe(false);
    expect(isDirectLocal(null, new Headers())).toBe(false);
  });
  test("접속 주소가 밖이면 비밀이 맞아도 403", async () => {
    const s = setup();
    s.deps.remoteAddress = () => "10.0.0.2";
    const app = createB3chatTeammateRoutes(s.deps);
    const r = await app.request("/members/b3chat", { method: "POST", headers: { "content-type": "application/json", "x-b3chat-link": KEY }, body: JSON.stringify(BODY) });
    expect(r.status).toBe(403);
  });
  test("비밀 비교 — 같으면 참, 길이만 같아도 거짓", () => {
    expect(linkSecretMatches(KEY, KEY)).toBe(true);
    expect(linkSecretMatches("j".repeat(43), KEY)).toBe(false);
    expect(linkSecretMatches(KEY, null)).toBe(false);
  });
});

describe("입력", () => {
  test("모양이 틀리면 400 bad_request (id·runtime·room·api_base·토큰)", async () => {
    const s = setup();
    for (const patch of [{ id: "Bad Id" }, { id: "1abc" }, { runtime: "claude_channel" }, { room_id: "0" }, { api_base: "http://evil.example.com" }, { bot_token: "nope" }, { display_name: "" }]) {
      const r = await s.post({ ...BODY, ...patch });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { code: string }).code).toBe("bad_request");
    }
    expect(s.calls).toEqual([]);
  });
  test("이미 있는 id → 409 name_taken", async () => {
    const s = setup({ existing: ["bill", "testmate"] });
    const r = await s.post(BODY);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe("name_taken");
  });
  test("봇이 그 서버에서 안 살아 있으면 400 bot_check_failed — 등록 전", async () => {
    const s = setup({ tokenOk: false });
    const r = await s.post(BODY);
    expect(((await r.json()) as { code: string }).code).toBe("bot_check_failed");
    expect(s.calls).toEqual([]);
  });
});

describe("작업 — 성공", () => {
  test("202 → recruit·channel·시험 팀원 표시·토큰·모델·activate → ready → 첫 인사는 새 팀원 브리지 창구로", async () => {
    const s = setup();
    const r = await s.post(BODY);
    expect(r.status).toBe(202);
    const job = await s.waitJob(r);
    expect(job).toMatchObject({ ok: true, state: "ready", member_id: "testmate", room_id: "5", greeting: "sent", code: null });
    expect(s.calls).toEqual(["recruit:testmate:codex", "model:testmate", "activate"]);
    const t = JSON.parse(readFileSync(s.registryPath, "utf-8")).find((a: { id: string }) => a.id === "testmate");
    expect(t.channel).toEqual({ kind: "b3chat", api_base: "http://127.0.0.1:8741", allow_from: ["5"], owner_chat: "5" });
    expect(t.team_official_member).toBe(false);
    const tp = join(s.dir, "var", "secrets", "testmate.bot-token");
    expect(readFileSync(tp, "utf-8")).toBe(TOKEN);
    expect(statSync(tp).mode & 0o777).toBe(0o600);
    expect(s.bridgeReqs.length).toBe(1);
    expect(s.bridgeReqs[0]).toMatchObject({ agentId: "testmate", groupId: "5", kind: "greeting" });
    // 토큰은 응답·상태 어디에도 없다
    expect(JSON.stringify(job)).not.toContain(TOKEN);
  });
});

describe("작업 — 실패와 되돌림(퇴사 API)", () => {
  test("AI 로그인 안 됨 → failed ai_not_ready + 퇴사 API 로 되돌림", async () => {
    const s = setup({ activate: () => Response.json({ error: "runtime_auth_required", hint: "내부 문장" }, { status: 400 }) });
    const job = await s.waitJob(await s.post(BODY));
    expect(job).toMatchObject({ ok: false, state: "failed", stage: "activate", code: "ai_not_ready", retryable: true, cleanup: "removed" });
    expect(s.calls).toContain("remove:testmate:테스트메이트");
    expect(JSON.stringify(job)).not.toContain("내부 문장");
  });
  test("기동 실패 → start_failed + 되돌림", async () => {
    const s = setup({ activate: () => Response.json({ ok: false, steps: [] }) });
    const job = await s.waitJob(await s.post(BODY));
    expect(job).toMatchObject({ state: "failed", code: "start_failed", cleanup: "removed" });
  });
  test("기동이 상한을 넘으면 timeout + 되돌림", async () => {
    const s = setup({ activate: () => new Promise<Response>(() => {}) });
    const job = await s.waitJob(await s.post(BODY));
    expect(job).toMatchObject({ state: "failed", code: "timeout", retryable: true, cleanup: "removed" });
  });
  test("첫 인사가 안 와도 ready 는 그대로 — greeting 만 failed(인사 실패 ≠ 기동 실패)", async () => {
    const s = setup({ greetedAfter: 1_000_000 });
    const job = await s.waitJob(await s.post(BODY));
    expect(job).toMatchObject({ ok: true, state: "ready", greeting: "failed" });
    expect(s.calls).not.toContain("remove:testmate:테스트메이트");
  });
  test("브리지 창구가 안 열리면 greeting failed", async () => {
    const s = setup({ bridgeOk: false });
    const job = await s.waitJob(await s.post(BODY));
    expect(job).toMatchObject({ state: "ready", greeting: "failed" });
  });
});

describe("부품", () => {
  test("모델 줄 — 있으면 바꾸고 없으면 맨 위에", () => {
    expect(setModelLine('model = "gpt-6-astra"\nx = 1\n', "gpt-6.1-sol")).toBe('model = "gpt-6.1-sol"\nx = 1\n');
    expect(setModelLine("x = 1\n", "gpt-6.1-sol")).toBe('model = "gpt-6.1-sol"\nx = 1\n');
  });
  test("브리지 창구 — kind 는 greeting 만", () => {
    const base = { agentId: "a", groupId: "5", threadId: "t", messageId: "m", body: "b" };
    const opts = { selfAgentId: "a", presentedToken: "x", expectedToken: "x", contentType: "application/json", byteLength: 10 };
    expect(decideWindowRequest({ ...base, kind: "greeting" }, opts)).toEqual({ accept: true });
    expect(decideWindowRequest({ ...base, kind: "evil" as "greeting" }, opts)).toMatchObject({ accept: false, reason: "bad_kind" });
    expect(decideWindowRequest(base, opts)).toEqual({ accept: true });
  });
});
