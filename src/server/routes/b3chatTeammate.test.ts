// 앱 [팀원 추가] b3os 쪽 — 인증·입력·작업 상태·되돌림·첫 인사. 실제 홈·라이브 명단·네트워크에 닿지 않는다.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { archiveWorkspaceAt, createB3chatTeammateRoutes, pidsWithCodexHome, residueOf, setModelLine, type B3chatTeammateDeps, type Residue } from "./b3chatTeammate";
import { decideWindowRequest, type BridgeWindowRequest } from "../runtimes/codex/bridgeWindow";
import { isDirectLocal, linkSecretMatches } from "../lib/b3chatLink";

const KEY = "k".repeat(43);
const TOKEN = `7:${"t".repeat(43)}`;
const BODY = { id: "testmate", display_name: "테스트메이트", role: "시험", runtime: "codex", api_base: "http://127.0.0.1:8741", room_id: "5", bot_token: TOKEN };

function setup(opts: { activate?: () => Response | Promise<Response>; greetedAfter?: number; bridgeOk?: boolean; tokenOk?: boolean; existing?: string[]; removeGate?: Promise<void>; removeStatus?: number; residue?: Residue[]; cleanWorks?: boolean } = {}) {
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
    if (opts.removeGate) await opts.removeGate;
    if (opts.removeStatus && opts.removeStatus !== 200) return c.json({ error: "x" }, opts.removeStatus as 500);
    const list = JSON.parse(readFileSync(registryPath, "utf-8")).filter((m: { id: string }) => m.id !== c.req.param("id"));
    writeFileSync(registryPath, JSON.stringify(list, null, 2));
    return c.json({ ok: true });
  });
  const bridgeReqs: BridgeWindowRequest[] = [];
  let greetPolls = 0;
  const settled: Record<string, () => void> = {};
  const residue: Residue[] = [...(opts.residue ?? [])];
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
    // ★실제 확인·정리는 절대 부르지 않는다★ — 실제 홈·launchd·프로세스에 닿는다.
    inspectResidue: (id) => {
      const inList = JSON.parse(readFileSync(registryPath, "utf-8")).some((m: { id: string }) => m.id === id);
      return [...(inList ? (["registry"] as Residue[]) : []), ...residue];
    },
    cleanResidue: (_id, left) => {
      calls.push(`clean:${left.join(",")}`);
      if (opts.cleanWorks !== false && !left.includes("registry")) residue.splice(0);
    },
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
  const del = (id: string, headers: Record<string, string> = { "x-b3chat-link": KEY }) =>
    app.request(`/members/b3chat/member/${id}`, { method: "DELETE", headers });
  const byMember = async (id: string) => (await (await app.request(`/members/b3chat/member/${id}`, { headers: { "x-b3chat-link": KEY } })).json()) as Record<string, unknown>;
  const settle = (jobId: string) => new Promise<void>((r) => { settled[jobId] = r; });
  return { dir, registryPath, calls, bridgeReqs, app, post, get, waitJob, deps, del, byMember, settle, residue };
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

describe("분산 실패 경계 — 응답이 사라져도 결과를 되찾는다", () => {
  test("같은 요청 재전송(진행 중·완료 뒤) → 같은 job_id, 새로 안 만든다", async () => {
    const s = setup();
    const first = await s.post(BODY);
    const { job_id } = (await first.clone().json()) as { job_id: string };
    const again = await s.post(BODY);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, job_id, duplicate: true });
    await s.waitJob(first);
    const after = await s.post(BODY);
    expect(((await after.json()) as { job_id: string }).job_id).toBe(job_id);
    expect(s.calls.filter((x) => x.startsWith("recruit")).length).toBe(1);
  });
  test("같은 id 인데 다른 토큰·방 → 409 name_taken(남의 재전송으로 보지 않는다)", async () => {
    const s = setup();
    await s.post(BODY);
    const r = await s.post({ ...BODY, room_id: "6" });
    expect(r.status).toBe(409);
  });
  test("팀원 id 로 상태 조회 — job_id 를 못 받았어도", async () => {
    const s = setup();
    const job = await s.waitJob(await s.post(BODY));
    const r = await s.app.request("/members/b3chat/member/testmate", { headers: { "x-b3chat-link": KEY } });
    expect(await r.json()).toMatchObject({ job_id: job.job_id, state: "ready" });
    const none = await s.app.request("/members/b3chat/member/nobody", { headers: { "x-b3chat-link": KEY } });
    expect(none.status).toBe(404);
  });
  test("failed 는 되돌림(퇴사 API)이 끝난 뒤에야 보인다", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const s = setup({ activate: () => Response.json({ ok: false }), removeGate: gate });
    const res = await s.post(BODY);
    const { job_id } = (await res.clone().json()) as { job_id: string };
    // 되돌림이 막혀 있는 동안
    for (let i = 0; i < 50 && !s.calls.some((x) => x.startsWith("remove")); i++) await new Promise((r) => setTimeout(r, 2));
    const mid = (await (await s.get(job_id)).json()) as { state: string; stage: string };
    expect(mid.state).not.toBe("failed");
    expect(mid.stage).toBe("activate_cleanup");
    release();
    const done = await s.waitJob(res);
    expect(done).toMatchObject({ state: "failed", code: "start_failed", cleanup: "removed" });
  });
  test("실패로 끝난 뒤 같은 요청 → 새 작업으로 다시(되돌림이 끝났으니)", async () => {
    let n = 0;
    const s = setup({ activate: () => (++n === 1 ? Response.json({ ok: false }) : Response.json({ ok: true })) });
    const first = await s.waitJob(await s.post(BODY));
    expect(first.state).toBe("failed");
    // 퇴사 API 는 가짜라 명단에서 안 지운다 — 실제 퇴사처럼 지워 준다
    const list = JSON.parse(readFileSync(s.registryPath, "utf-8")).filter((a: { id: string }) => a.id !== "testmate");
    writeFileSync(s.registryPath, JSON.stringify(list));
    const second = await s.waitJob(await s.post(BODY));
    expect(second.job_id).not.toBe(first.job_id);
    expect(second.state).toBe("ready");
  });
});

describe("지우기 — 앱에서 만든 팀원만, 퇴사 API 한 경로로", () => {
  const ready = async (s: ReturnType<typeof setup>) => {
    const j = await s.waitJob(await s.post(BODY));
    expect(j.state).toBe("ready");
    return j.job_id as string;
  };
  test("ready → DELETE 202 removing → 퇴사 API → removed, 명단에서 빠짐", async () => {
    const s = setup();
    const jobId = await ready(s);
    const done = s.settle(jobId);
    const r = await s.del("testmate");
    expect(r.status).toBe(202);
    expect((await r.json()).state).toBe("removing");
    await done;
    expect((await s.byMember("testmate")).state).toBe("removed");
    expect(s.calls.filter((x) => x.startsWith("remove:"))).toEqual(["remove:testmate:테스트메이트"]);
    expect(JSON.parse(readFileSync(s.registryPath, "utf-8")).map((m: { id: string }) => m.id)).toEqual(["bill"]);
    const again = await s.del("testmate");
    expect(again.status).toBe(200);
    expect((await again.json()).state).toBe("removed");
    expect(s.calls.filter((x) => x.startsWith("remove:")).length).toBe(1);
  });
  test("removing 중 다시 보내도 퇴사는 한 번", async () => {
    let open!: () => void;
    const s = setup({ removeGate: new Promise<void>((r) => { open = r; }) });
    const jobId = await ready(s);
    const done = s.settle(jobId);
    expect((await s.del("testmate")).status).toBe(202);
    const second = await s.del("testmate");
    expect(second.status).toBe(202);
    expect((await second.json()).state).toBe("removing");
    open();
    await done;
    expect(s.calls.filter((x) => x.startsWith("remove:")).length).toBe(1);
  });
  test("퇴사 API 실패 → remove_failed cleanup_failed retryable, 다시 보내면 다시 시도", async () => {
    const s = setup({ removeStatus: 500 });
    const jobId = await ready(s);
    let done = s.settle(jobId);
    await s.del("testmate");
    await done;
    const v = await s.byMember("testmate");
    expect([v.state, v.code, v.retryable, v.ok]).toEqual(["remove_failed", "cleanup_failed", true, false]);
    done = s.settle(jobId);
    expect((await s.del("testmate")).status).toBe(202);
    await done;
    expect(s.calls.filter((x) => x.startsWith("remove:")).length).toBe(2);
  });
  test("이 경로로 만든 기록이 없는 팀원(기존 팀원) → 404, 퇴사 API 안 부름", async () => {
    const s = setup();
    const r = await s.del("bill");
    expect(r.status).toBe(404);
    expect(s.calls.some((x) => x.startsWith("remove:"))).toBe(false);
    expect(JSON.parse(readFileSync(s.registryPath, "utf-8")).map((m: { id: string }) => m.id)).toEqual(["bill"]);
  });
  test("만드는 중 → 409 teammate_busy", async () => {
    let release!: () => void;
    const s = setup({ activate: () => new Promise<Response>((r) => { release = () => r(Response.json({ ok: true, steps: [] })); }) });
    const res = await s.post(BODY);
    const { job_id } = (await res.json()) as { job_id: string };
    const settled = s.settle(job_id);
    while (!release) await new Promise((r) => setTimeout(r, 2));
    const r = await s.del("testmate");
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("teammate_busy");
    release();
    await settled;
  });
  test("만들기 실패로 이미 되돌린 팀원 → 퇴사 다시 안 부르고 removed", async () => {
    const s = setup({ activate: () => Response.json({ ok: false, error: "runtime_auth_required" }) });
    const j = await s.waitJob(await s.post(BODY));
    expect(j.state).toBe("failed");
    const before = s.calls.filter((x) => x.startsWith("remove:")).length;
    const done = s.settle(j.job_id as string);
    await s.del("testmate");
    await done;
    expect((await s.byMember("testmate")).state).toBe("removed");
    expect(s.calls.filter((x) => x.startsWith("remove:")).length).toBe(before);
  });
  test("지운 뒤 같은 id 로 다시 만들 수 있다", async () => {
    const s = setup();
    const jobId = await ready(s);
    const done = s.settle(jobId);
    await s.del("testmate");
    await done;
    const j = await s.waitJob(await s.post(BODY));
    expect(j.state).toBe("ready");
  });
  test("재시작으로 removing 에 남은 작업 → 다시 보내면 이어서 끝낸다", async () => {
    const s = setup();
    const jobId = await ready(s);
    s.deps.db.query("UPDATE b3chat_teammate_job SET state = 'removing' WHERE id = ?").run(jobId);
    const fresh = createB3chatTeammateRoutes(s.deps);
    const done = s.settle(jobId);
    const r = await fresh.request("/members/b3chat/member/testmate", { method: "DELETE", headers: { "x-b3chat-link": KEY } });
    expect(r.status).toBe(202);
    await done;
    expect((await s.byMember("testmate")).state).toBe("removed");
    expect(s.calls.filter((x) => x.startsWith("remove:")).length).toBe(1);
  });
  test("퇴사 API 가 200 이어도 프로세스가 남으면 removed 가 아니다 — 한 번 더 정리 후에도 남으면 remove_failed", async () => {
    const s = setup({ residue: ["process"], cleanWorks: false });
    const jobId = await ready(s);
    let done = s.settle(jobId);
    await s.del("testmate");
    await done;
    const v = await s.byMember("testmate");
    expect([v.state, v.code, v.cleanup]).toEqual(["remove_failed", "cleanup_failed", "left:process"]);
    expect(s.calls.filter((x) => x.startsWith("clean:"))).toEqual(["clean:process"]);
    // 명단은 이미 없다 — 다시 보내면 퇴사 API 없이 남은 것만 치우고, 다 사라지면 removed
    s.residue.splice(0, s.residue.length, "files");
    done = s.settle(jobId);
    s.deps.cleanResidue = undefined;
    const s2 = createB3chatTeammateRoutes({ ...s.deps, cleanResidue: (_id, left) => { s.calls.push(`clean2:${left.join(",")}`); s.residue.splice(0); } });
    expect((await s2.request("/members/b3chat/member/testmate", { method: "DELETE", headers: { "x-b3chat-link": KEY } })).status).toBe(202);
    await done;
    expect((await s.byMember("testmate")).state).toBe("removed");
    expect(s.calls.filter((x) => x.startsWith("remove:")).length).toBe(1);
    expect(s.calls).toContain("clean2:files");
  });
  test("남은 것이 처음 정리로 사라지면 removed", async () => {
    const s = setup({ residue: ["launchd", "files"] });
    const jobId = await ready(s);
    const done = s.settle(jobId);
    await s.del("testmate");
    await done;
    expect((await s.byMember("testmate")).state).toBe("removed");
    expect(s.calls).toContain("clean:launchd,files");
  });
  test("명단의 작업폴더 위치를 지우기 전에 기록하고, 재시도도 그 위치를 센다", async () => {
    const seen: string[] = [];
    const s = setup();
    const jobId = await ready(s);
    const now = JSON.parse(readFileSync(s.registryPath, "utf-8"));
    now.find((m: { id: string }) => m.id === "testmate").workspace_path = "/custom/testmate";
    writeFileSync(s.registryPath, JSON.stringify(now));
    const app2 = createB3chatTeammateRoutes({ ...s.deps, inspectResidue: (_id, ws) => { seen.push(ws); return []; } });
    const done = s.settle(jobId);
    await app2.request("/members/b3chat/member/testmate", { method: "DELETE", headers: { "x-b3chat-link": KEY } });
    await done;
    expect(seen).toEqual(["/custom/testmate"]);
  });
  test("퇴사 API 가 명단을 못 지우면(500) 명단은 여기서 건드리지 않고 remove_failed", async () => {
    const s = setup({ removeStatus: 500 });
    const jobId = await ready(s);
    const done = s.settle(jobId);
    await s.del("testmate");
    await done;
    const v = await s.byMember("testmate");
    expect([v.state, v.cleanup]).toEqual(["remove_failed", "offboard_500"]);
    expect(JSON.parse(readFileSync(s.registryPath, "utf-8")).map((m: { id: string }) => m.id)).toContain("testmate");
  });
  test("인증 없으면 403 — 퇴사 API 안 부름", async () => {
    const s = setup();
    await ready(s);
    expect((await s.del("testmate", {})).status).toBe(403);
    expect(s.calls.some((x) => x.startsWith("remove:"))).toBe(false);
  });
});

describe("남은 것 세기 — 순수 단계", () => {
  const none = { registryHas: () => false, launchdLoaded: () => false, envPids: () => [], exists: () => false };
  test("작업폴더는 명단에 적혀 있던 위치로 센다", () => {
    expect(residueOf("zzgone", { ...none, exists: (p) => p === "/custom/zzgone" }, "/custom/zzgone")).toEqual(["workdir"]);
    expect(residueOf("zzgone", { ...none, exists: (p) => p === "/custom/zzgone" }, "/other")).toEqual([]);
  });
  test("아무것도 없으면 빈 목록, 종류마다 하나씩", () => {
    expect(residueOf("zzgone", none)).toEqual([]);
    expect(residueOf("zzgone", { ...none, registryHas: () => true })).toEqual(["registry"]);
    expect(residueOf("zzgone", { ...none, launchdLoaded: (l) => l.endsWith("zzgone") })).toEqual(["launchd"]);
    expect(residueOf("zzgone", { ...none, envPids: (h) => (h.endsWith("/.codex-agents/zzgone") ? [42] : []) })).toEqual(["process"]);
    expect(residueOf("zzgone", { ...none, exists: (p) => p.endsWith("/zzgone.window.json") })).toEqual(["files"]);
    expect(residueOf("zzgone", { ...none, exists: (p) => p.endsWith("/.codex-agents/zzgone") })).toEqual(["files"]);
  });
  test("CODEX_HOME 은 정확히 그 값만 — 이름이 앞부분만 같은 남의 홈은 아니다", () => {
    const ps = [
      "  101 bun bridge.ts CODEX_HOME=/h/.codex-agents/mate PATH=/bin",
      "  102 codex app-server CODEX_HOME=/h/.codex-agents/mate",
      "  103 bun bridge.ts CODEX_HOME=/h/.codex-agents/mate2 PATH=/bin",
      "  104 bun other.ts HOME=/h",
    ].join("\n");
    expect(pidsWithCodexHome(ps, "/h/.codex-agents/mate")).toEqual([101, 102]);
  });
  test("CODEX_HOME 은 그 변수만 — 이름에 CODEX_HOME 이 들어간 다른 변수는 아니다(앞에 와도·혼자 있어도)", () => {
    const ps = [
      "  201 bun bridge.ts ORIGINAL_CODEX_HOME=/fake/mate2 CODEX_HOME=/fake/mate",
      "  202 bun other.ts OTHER_CODEX_HOME=/fake/mate",
    ].join("\n");
    expect(pidsWithCodexHome(ps, "/fake/mate")).toEqual([201]);
  });
  test("확인 명령이 실패하면 없음이 아니라 unverified", () => {
    const boom = () => { throw new Error("ps failed"); };
    expect(residueOf("zzgone", { ...none, envPids: boom })).toEqual(["unverified"]);
    expect(residueOf("zzgone", { ...none, launchdLoaded: boom, envPids: boom })).toEqual(["unverified"]);
  });
  test("슬랙 토큰 파일도 남은 것으로 센다", () => {
    const prev = process.env.SLACK_TOKENS_DIR;
    process.env.SLACK_TOKENS_DIR = "/zz-slack";
    try {
      expect(residueOf("zzgone", { ...none, exists: (p) => p.startsWith("/zz-slack/") && p.includes("zzgone") })).toEqual(["files"]);
    } finally {
      if (prev === undefined) delete process.env.SLACK_TOKENS_DIR; else process.env.SLACK_TOKENS_DIR = prev;
    }
  });
  test("작업폴더 보관 — 기본 위치가 아니어도 그 id 이름의 폴더면 옮기고, 이름이 다르면 손대지 않는다", () => {
    const root = mkdtempSync(join(tmpdir(), "b3arch-"));
    const ws = join(root, "custom", "zzmate");
    mkdirSync(ws, { recursive: true });
    const dest = archiveWorkspaceAt("zzmate", ws, join(root, ".archived"));
    expect(dest && existsSync(dest)).toBe(true);
    expect(existsSync(ws)).toBe(false);
    const other = join(root, "custom", "someone");
    mkdirSync(other, { recursive: true });
    expect(archiveWorkspaceAt("zzmate", other, join(root, ".archived"))).toBeNull();
    expect(existsSync(other)).toBe(true);
  });
});
