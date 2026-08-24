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

// ── 실제로 창구를 열어 본다 (127.0.0.1 · 토큰 · 멱등) ──
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
// 창구 경로가 텔레그램으로 직접 쏘면 방에는 뜨지만 ★버스에는 아무 기록이 없다.★
// 같은 방에서 claude 팀원 답은 남고 dex 것만 0건이었다(대조군 실측). 그래서 턴 본문은
// 메모로 두고, 방에 말하려면 팀원이 직접 `send.sh --to broadcast` 를 불러야 한다.
//
// ★한 함수만 내보낸다★ — 발신 떼기와 명령 넣기는 한 쌍이라, 한쪽만 있는 상태를 못 만들게 한다.
import { groupTurnCall } from "./bridgeWindow";

describe("groupTurnCall — 발신을 떼고, 답 보내는 법을 함께 준다", () => {
  const base = () => ({
    sendMessage: async () => 1 as number | null,
    editMessage: async () => true,
    reactMessage: async () => true,
    agentId: "dex",
  });
  const made = (over: Record<string, string> = {}) =>
    groupTurnCall(base(), {
      repoRoot: "/repo",
      body: "@덱스 들려?",
      threadId: "tg--1003947108339",
      messageId: "tg-8874",
      ...over,
    });

  test("★발신이 떨어진다★ — sendMessage·editMessage 가 아무것도 안 한다", async () => {
    const { deps } = made();
    expect(await deps.sendMessage()).toBeNull();
    expect(await deps.editMessage()).toBe(false);
  });

  test("★리액션은 남는다★ — '받았다' 는 발신과 다른 값이다", async () => {
    const { deps } = made();
    expect(await deps.reactMessage()).toBe(true);
  });

  test("나머지 deps 는 그대로 넘어간다", () => {
    expect(made().deps.agentId).toBe("dex");
  });

  test("★send.sh --to broadcast 가 본문에 있다★ — 없으면 답이 아무 데도 안 간다", () => {
    const { body } = made();
    expect(body).toContain("/repo/skills/b3os-team-inbox/scripts/send.sh");
    expect(body).toContain("--to broadcast");
  });

  test("★--body 가 아니라 --body-file 을 시킨다★ — 답의 홑따옴표가 명령을 깬다", () => {
    const { body } = made();
    expect(body).toContain("--body-file");
    expect(body).not.toContain("--body '");
  });

  test("★heredoc 구분자가 따옴표로 감싸여 있다★ — $ ·백틱이 해석되면 본문이 훼손된다", () => {
    expect(made().body).toMatch(/<<'[A-Z0-9_]+'/);
  });

  test("★종료자가 EOF 가 아니다★ — 답에 EOF 한 줄이 들어가면 거기서 끊기고 뒤가 셸 명령이 된다", () => {
    expect(made().body).not.toContain("<<'EOF'");
  });

  test("★고정 경로를 안 쓴다 — mktemp 로 매번 새 파일★ (쓰기 실패 시 옛 답이 다시 나간다)", () => {
    const { body } = made();
    expect(body).toContain("mktemp");
    expect(body).not.toContain("/tmp/dex-reply.txt");
  });

  test("★보낸 뒤 지운다★ — 팀 대화가 /tmp 에 평문으로 남지 않게", () => {
    expect(made().body).toContain('rm -f "$f"');
  });

  test("스레드와 in-reply-to 가 박혀 있다 — 조립하다 틀리지 않게", () => {
    const { body } = made();
    expect(body).toContain("--thread tg--1003947108339");
    expect(body).toContain("--in-reply-to tg-8874");
  });

  test("'서버가 대신 게시하지 않는다' 를 말해준다 — 안 보내면 말한 게 아니다", () => {
    expect(made().body).toContain("서버가 대신 게시하지 않는다");
  });

  test("원문이 맨 앞에 그대로 있다 — 지시문이 질문을 덮지 않는다", () => {
    expect(made().body.startsWith("@덱스 들려?")).toBe(true);
  });

  test("★--to user 가 아니다★ — 그룹 행의 발신자는 팀원이 아니다", () => {
    expect(made().body).not.toContain("--to user");
  });
});

// ── ★적대 입력 왕복 시험★ — 모양 단언이 아니라 실제 동작을 잰다 ──
//
// "mktemp 를 쓴다"·"종료자가 EOF 가 아니다" 는 ★생성된 문자열의 모양★ 이라, 템플릿을 바꾸면
// 같이 바뀐다. ★인용을 잘못해도 통과한다.★ 유일한 증명은 실제로 셸에 태워서
// ★나온 파일이 원문과 바이트로 같은가★ 를 보는 것이다.
//
// ★이 시험이 증명하지 않는 것★: dex 가 이 조각을 ★그대로 실행한다★ 는 것.
//   본문은 프롬프트고 dex 는 다르게 쓸 수 있다 — 그건 배포 후 ② 로만 재진다.
//   (부품이 맞다 ≠ 조립된 게 돈다 ≠ 실제로 그 경로로 간다)
import { readFileSync, existsSync, mkdirSync } from "node:fs";

describe("템플릿이 적대 입력을 손상 없이 통과시킨다 (dex 가 그대로 실행하는지는 배포 후 ②)", () => {
  // 한 덩어리로 넣는다 — 하나씩 넣으면 조합에서 새는 것을 못 잡는다.
  const HOSTILE = [
    "홑따옴표 ' 하나",
    ' 겹따옴표 " 하나',
    "백틱 `id` 와 달러괄호 $(id) 와 달러변수 $HOME",
    "EOF",
    "B3OS_REPLY_DEADBEEF",
    // ★JS String.replace 의 치환 패턴 문자★ — 시험이 자기 이스케이프로 무너지는지도 같이 잰다.
    //   bash ANSI-C 인용($'\\n')도 여기 걸린다. 아래 () => 형태가 아니면 이 줄에서 깨진다.
    "치환패턴 $$ $& $` $' $1 끝",
    "탭\t끝",
    "역슬래시 \\ 와 이모지 ✦ 와 한글",
    "",
    "마지막 줄",
  ].join("\n");

  test("★적대 입력이 파일까지 바이트 그대로 간다★", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-"));
    // send.sh 스텁 — --body-file 의 내용을 그대로 밖으로 복사한다.
    const stubRoot = join(dir, "root");
    const stubDir = join(stubRoot, "skills", "b3os-team-inbox", "scripts");
    mkdirSync(stubDir, { recursive: true });
    const out = join(dir, "captured.txt");
    writeFileSync(
      join(stubDir, "send.sh"),
      ['#!/bin/bash', 'while [ $# -gt 0 ]; do', '  if [ "$1" = "--body-file" ]; then cp "$2" "' + out + '"; shift; fi',
       '  shift', 'done', ''].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(join(stubDir, "send.sh"), 0o755);

    const { body } = groupTurnCall(
      { sendMessage: async () => null, editMessage: async () => false },
      { repoRoot: stubRoot, body: "질문", threadId: "tg--100", messageId: "tg-1" },
    );

    // 본문에서 셸 조각만 떼어낸다: f=... 줄부터 rm -f 줄까지.
    const lines = body.split("\n");
    const from = lines.findIndex((l) => l.startsWith('f="$(mktemp'));
    const to = lines.findIndex((l) => l.startsWith('rm -f'));
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    // <답> 자리를 적대 입력으로 갈아끼운다.
    // ★치환은 반드시 함수로 준다★ — 문자열로 주면 JS 가 $$·$&·$`·$'·$1 을 치환 패턴으로
    //   먼저 해석해서, 적대 입력이 ★bash 에 닿기도 전에★ 뭉개진다. 그러면 빨간불이 뜨는데
    //   범인은 시험인데 템플릿을 뒤지게 된다 — 이 PR 이 고치는 것과 ★같은 병★ 이다.
    const snippet = lines.slice(from, to + 1).join("\n").replace("<답>", () => HOSTILE);
    // 셸에 태우기 전에, 적대 입력이 ★온전한 채로★ 들어갔는지부터 확인한다.
    // 여기서 깨지면 원인은 템플릿이 아니라 위 치환이다.
    expect(snippet).toContain(HOSTILE);

    const r = Bun.spawnSync(["bash", "-c", snippet]);
    expect(r.exitCode).toBe(0);
    expect(existsSync(out)).toBe(true);
    // ★바이트로 비교한다★ — heredoc 은 끝에 개행을 하나 붙인다.
    expect(readFileSync(out, "utf8")).toBe(HOSTILE + "\n");
  });

  test("★종료자가 매번 다르다★ — 고정이면 답이 그 줄을 맞힐 수 있다", () => {
    const term = (b: string) => b.split("\n").find((l) => l.startsWith("cat > "))!;
    const a = groupTurnCall({}, { repoRoot: "/r", body: "x", threadId: "t", messageId: "m" }).body;
    const b = groupTurnCall({}, { repoRoot: "/r", body: "x", threadId: "t", messageId: "m" }).body;
    expect(term(a)).not.toBe(term(b));
  });

  test("★보낸 뒤 임시파일이 남지 않는다★ — 팀 대화가 /tmp 에 평문으로 남으면 안 된다", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt2-"));
    const stubDir = join(dir, "skills", "b3os-team-inbox", "scripts");
    mkdirSync(stubDir, { recursive: true });
    const seen = join(dir, "path.txt");
    writeFileSync(
      join(stubDir, "send.sh"),
      ['#!/bin/bash', 'while [ $# -gt 0 ]; do', '  if [ "$1" = "--body-file" ]; then echo -n "$2" > "' + seen + '"; shift; fi',
       '  shift', 'done', ''].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(join(stubDir, "send.sh"), 0o755);
    const { body } = groupTurnCall({}, { repoRoot: dir, body: "질문", threadId: "t", messageId: "m" });
    const lines = body.split("\n");
    const from = lines.findIndex((l) => l.startsWith('f="$(mktemp'));
    const to = lines.findIndex((l) => l.startsWith("rm -f"));
    Bun.spawnSync(["bash", "-c", lines.slice(from, to + 1).join("\n").replace("<답>", () => "내용")]);
    const used = readFileSync(seen, "utf8");
    expect(used).toContain("b3os-reply");
    expect(existsSync(used)).toBe(false);
  });
});
