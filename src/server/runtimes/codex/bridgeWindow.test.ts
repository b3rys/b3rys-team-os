import { describe, expect, test } from "bun:test";
import { mkdtempSync, chmodSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideWindowRequest,
  readWindowFile,
  tokensMatch,
  windowFilePathFor,
  writeWindowFile,
  WindowDedupe,
  WINDOW_BODY_LIMIT_BYTES,
} from "./bridgeWindow";

const TOKEN = "a".repeat(64);

function req(over: Record<string, unknown> = {}) {
  return {
    agentId: "dex",
    groupId: "-1003947108339",
    threadId: "tg--1003947108339",
    messageId: "tg-1",
    body: "@덱스 들려?",
    ...over,
  };
}
function opts(over: Record<string, unknown> = {}) {
  return {
    selfAgentId: "dex",
    presentedToken: TOKEN,
    expectedToken: TOKEN,
    contentType: "application/json",
    byteLength: 100,
    ...over,
  } as Parameters<typeof decideWindowRequest>[1];
}

describe("창구 파일 — 포트·토큰·주인", () => {
  test("★0600 으로 쓰고 그대로 읽는다★ (토큰이 다른 사용자에게 보이면 안 된다)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cbw-"));
    const path = join(dir, "dex.window.json");
    writeWindowFile(path, { port: 51234, token: TOKEN, pid: 42, agentId: "dex" });
    expect(readWindowFile(path)).toEqual({ port: 51234, token: TOKEN, pid: 42, agentId: "dex" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("★깨진 파일은 null★ — 반쯤 쓰인 값을 주소로 쓰지 않는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "cbw-"));
    const path = join(dir, "x.json");
    writeFileSync(path, "{not json");
    expect(readWindowFile(path)).toBeNull();
  });

  test("★값이 빠졌으면 null★ — 포트 0·짧은 토큰·주인 없음은 안 받는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "cbw-"));
    for (const [name, obj] of [
      ["port0", { port: 0, token: TOKEN, pid: 1, agentId: "dex" }],
      ["shorttoken", { port: 1, token: "abc", pid: 1, agentId: "dex" }],
      ["noagent", { port: 1, token: TOKEN, pid: 1 }],
    ] as const) {
      const p = join(dir, `${name}.json`);
      writeFileSync(p, JSON.stringify(obj));
      expect(readWindowFile(p)).toBeNull();
    }
  });

  test("pid 파일이 없으면 창구 자리도 없다", () => {
    expect(windowFilePathFor(undefined, "dex")).toBeNull();
    expect(windowFilePathFor("/tmp/x/dex.pid", "dex")).toBe("/tmp/x/dex.window.json");
  });
});

describe("토큰 비교", () => {
  test("같으면 참, 다르면 거짓", () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch(TOKEN, "b".repeat(64))).toBe(false);
  });
  test("★길이가 달라도 던지지 않는다★ — timingSafeEqual 은 길이가 다르면 예외를 낸다", () => {
    expect(() => tokensMatch("short", TOKEN)).not.toThrow();
    expect(tokensMatch("short", TOKEN)).toBe(false);
  });
});

describe("요청 판정", () => {
  test("정상 요청은 받는다", () => {
    expect(decideWindowRequest(req(), opts())).toEqual({ accept: true });
  });

  test("★토큰이 틀리면 401★ — 로컬이라도 아무나 턴을 못 돌린다", () => {
    const v = decideWindowRequest(req(), opts({ presentedToken: "b".repeat(64) }));
    expect(v).toEqual({ accept: false, status: 401, reason: "bad_token" });
  });

  test("토큰이 아예 없어도 401", () => {
    expect(decideWindowRequest(req(), opts({ presentedToken: null })).accept).toBe(false);
  });

  test("★남의 신원으로는 못 돈다 — 403★", () => {
    const v = decideWindowRequest(req({ agentId: "codex" }), opts());
    expect(v).toEqual({ accept: false, status: 403, reason: "agent_mismatch" });
  });

  test("content-type 이 json 이 아니면 415", () => {
    expect(decideWindowRequest(req(), opts({ contentType: "text/plain" })).accept).toBe(false);
  });

  test("★본문이 상한을 넘으면 413★", () => {
    const v = decideWindowRequest(req(), opts({ byteLength: WINDOW_BODY_LIMIT_BYTES + 1 }));
    expect(v).toEqual({ accept: false, status: 413, reason: "body_too_large" });
  });

  test("필수 값이 빠지면 400 — 어느 값인지 사유에 남는다", () => {
    for (const k of ["agentId", "groupId", "threadId", "messageId", "body"]) {
      const v = decideWindowRequest(req({ [k]: "" }), opts());
      expect(v.accept).toBe(false);
      if (!v.accept) expect(v.reason).toContain(k === "agentId" ? "agentId" : k);
    }
  });

  test("★판정은 순서가 있다 — 토큰이 먼저다★ (본문이 깨졌어도 인증이 먼저 걸린다)", () => {
    const v = decideWindowRequest(null, opts({ presentedToken: "b".repeat(64) }));
    expect(v).toEqual({ accept: false, status: 401, reason: "bad_token" });
  });

  test("★거절 사유에 토큰이 안 담긴다★", () => {
    const v = decideWindowRequest(req(), opts({ presentedToken: "b".repeat(64) }));
    expect(JSON.stringify(v)).not.toContain(TOKEN);
    expect(JSON.stringify(v)).not.toContain("b".repeat(64));
  });
});

describe("멱등 — 같은 messageId 는 한 번만", () => {
  test("★두 번째는 안 받는다★ — 받으면 dex 가 두 번 답한다", () => {
    const d = new WindowDedupe(1000);
    expect(d.admit("tg-1", 0)).toBe(true);
    expect(d.admit("tg-1", 10)).toBe(false);
  });

  test("다른 messageId 는 각각 받는다", () => {
    const d = new WindowDedupe(1000);
    expect(d.admit("tg-1", 0)).toBe(true);
    expect(d.admit("tg-2", 0)).toBe(true);
  });

  test("★기억 창을 넘기면 다시 받는다★ — 영원히 들고 있지 않는다", () => {
    const d = new WindowDedupe(1000);
    expect(d.admit("tg-1", 0)).toBe(true);
    expect(d.admit("tg-1", 1001)).toBe(true);
  });
});

// ── 실제로 bridge window 를 열어 본다 (127.0.0.1 · 토큰 · 멱등) ──
import { startBridgeWindow } from "./bridgeWindow";

describe("startBridgeWindow — 실제 왕복", () => {
  async function open(): Promise<{ h: NonNullable<Awaited<ReturnType<typeof startBridgeWindow>>>; file: string; got: unknown[] }> {
    const dir = mkdtempSync(join(tmpdir(), "cbw-live-"));
    const pidFile = join(dir, "dex.pid");
    const got: unknown[] = [];
    const h = await startBridgeWindow({ agentId: "dex", pidFile, enqueue: (r) => got.push(r) });
    if (!h) throw new Error("window did not open");
    return { h, file: join(dir, "dex.window.json"), got };
  }
  function post(port: number, token: string | null, body: unknown, ct = "application/json") {
    return fetch(`http://127.0.0.1:${port}/turn`, {
      method: "POST",
      headers: { "content-type": ct, ...(token ? { "x-b3os-token": token } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  test("★정상 요청 → 202 + 큐에 1건★", async () => {
    const { h, file, got } = await open();
    const wf = readWindowFile(file)!;
    const res = await post(h.port, wf.token, req());
    expect(res.status).toBe(202);
    expect(got.length).toBe(1);
    h.close();
  });

  test("★같은 messageId 두 번 → 두 번째는 큐에 안 들어간다★ (dex 가 두 번 답하면 안 된다)", async () => {
    const { h, file, got } = await open();
    const wf = readWindowFile(file)!;
    expect((await post(h.port, wf.token, req())).status).toBe(202);
    const second = await post(h.port, wf.token, req());
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, duplicate: true });
    expect(got.length).toBe(1);
    h.close();
  });

  test("★토큰 없이 부르면 401 · 큐는 그대로 0★", async () => {
    const { h, got } = await open();
    expect((await post(h.port, null, req())).status).toBe(401);
    expect(got.length).toBe(0);
    h.close();
  });

  test("★다른 팀원 id 로 부르면 403★", async () => {
    const { h, file, got } = await open();
    const wf = readWindowFile(file)!;
    expect((await post(h.port, wf.token, req({ agentId: "codex" }))).status).toBe(403);
    expect(got.length).toBe(0);
    h.close();
  });

  test("★POST /turn 이 아니면 404★ — 창구는 입구가 하나다", async () => {
    const { h, file } = await open();
    const wf = readWindowFile(file)!;
    const res = await fetch(`http://127.0.0.1:${h.port}/other`, {
      method: "POST", headers: { "content-type": "application/json", "x-b3os-token": wf.token }, body: "{}",
    });
    expect(res.status).toBe(404);
    h.close();
  });

  test("★닫으면 창구 파일이 사라진다★ — 남으면 서버가 죽은 포트를 부른다", async () => {
    const { h, file } = await open();
    expect(readWindowFile(file)).not.toBeNull();
    h.close();
    expect(readWindowFile(file)).toBeNull();
  });
  test("★파일을 못 쓰면 창구를 연 채로 두지 않는다★ — 아무도 못 부르는 리스너가 남으면 종료도 막는다", async () => {
    // 존재하지 않는 디렉터리 → writeWindowFile 이 ENOENT 로 던진다.
    const h = await startBridgeWindow({
      agentId: "dex",
      pidFile: join(tmpdir(), "no-such-dir-cbw", "dex.pid"),
      enqueue: () => {},
    });
    expect(h).toBeNull();
  });
});


// ── ★서버는 팀원 대신 말하지 않는다★ (hermes 와 같은 계약) ──
//
// bridge window 경로가 텔레그램으로 직접 쏘면 방에는 뜨지만 ★버스에는 아무 기록이 없다.★
// 같은 방에서 claude 팀원 답은 남고 dex 것만 0건이었다(대조군 실측). 그래서 턴 본문은
// 메모로 두고, 방에 말하려면 팀원이 직접 `send.sh --to broadcast` 를 불러야 한다.
//
// ★한 함수만 내보낸다★ — 발신 떼기와 명령 넣기는 한 쌍이라, 한쪽만 있는 상태를 못 만들게 한다.
import { groupTurnCall } from "./bridgeWindow";

describe("groupTurnCall — 발신을 떼고, ★답을 쓸 자리★ 를 함께 준다", () => {
  const base = () => ({
    sendMessage: async () => 1 as number | null,
    editMessage: async () => true,
    reactMessage: async () => true,
    agentId: "dex",
  });
  const call = (over: Partial<{ body: string; threadId: string; messageId: string; replyPath: string }> = {}) =>
    groupTurnCall(base(), {
      body: "@덱스 들려?", threadId: "tg--100", messageId: "tg-1",
      replyPath: "/repo/var/codex-bridge/outbox/dex/abc123.txt", ...over,
    });

  test("★텔레그램 발신을 뗀다★ — 서버가 팀원 대신 말하지 않는다", async () => {
    const c = call();
    expect(await c.deps.sendMessage()).toBeNull();
    expect(await c.deps.editMessage()).toBe(false);
  });

  test("★리액션은 안 뗀다★ — '받았다' 는 발신과 다른 값이다", async () => {
    expect(await call().deps.reactMessage()).toBe(true);
  });

  test("★셸 명령을 시키지 않는다★ — 답이 명령 문자열에 들어가면 인용이 해석된다", () => {
    const b = call().body;
    // 지금 근거는 인용이다 — 답이 명령 안에 있으면 따옴표·백틱·종료자가 해석돼 본문이 훼손된다.
    // (과거 on-request 시절 실측: send.sh 를 실행시켰더니 매 턴 승인 팝업이 오너 DM 으로 갔고
    // 300초 뒤 만료되며 턴이 통째로 죽었다. 이 시험은 그 형태가 다시 들어오는 것을 막는다.
    expect(b).not.toContain("send.sh");
    expect(b).not.toContain("mktemp");
    expect(b).not.toContain("<<");   // heredoc
    expect(b).not.toContain("rm -f");
  });

  test("★답을 쓸 경로를 그대로 준다★ — 브리지가 정한 자리여야 브리지가 읽는다", () => {
    const b = call({ replyPath: "/repo/var/codex-bridge/outbox/dex/deadbeef.txt" }).body;
    expect(b).toContain("/repo/var/codex-bridge/outbox/dex/deadbeef.txt");
  });

  test("★안 쓰면 안 나간다는 것을 말해준다★ — 답 안 함이 고장으로 읽히지 않게", () => {
    expect(call().body).toContain("안 쓰면 안 나간다");
  });

  test("★원문·스레드·in-reply-to 를 함께 싣는다★", () => {
    const b = call({ body: "질문 원문", threadId: "tg--777", messageId: "tg-9" }).body;
    expect(b).toContain("질문 원문");
    expect(b).toContain("tg--777");
    expect(b).toContain("tg-9");
  });

  test("★답이 명령 문자열에 안 들어간다★ — 적대 입력이 해석될 자리가 아예 없다", () => {
    // 이전 설계에서는 답이 heredoc 안에 들어가 따옴표·백틱·종료자 사고가 났고,
    // ★승인 operation hash 가 매 턴 달라져 '항상 허용' 이 원리적으로 안 걸렸다.★
    // 지금은 답이 프롬프트 밖(파일)이라 그 부류가 통째로 사라진다.
    const b = call({ body: "홑따옴표 ' 백틱 ` $(id) $HOME" }).body;
    expect(b).not.toContain("bash");
    expect(b).not.toContain("zsh");
    expect(b).not.toContain("-lc");
  });
});
