// 팀원별 채널(b3chat) — 그룹 판정·그룹 차단 우회·순수 텍스트 발신·파일 주소·승인 요청 대체.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleMessage, resetChatThreads, tgEdit, tgSend, type BridgeDeps } from "./bridge";
import { downloadDmAttachments } from "./dmMedia";
import { sendApprovalToMemberRoom } from "./appServerPopup";
import { storeTelegramMedia } from "../../lib/mediaStore";
import { validateBotToken } from "../../lib/rotateToken";
import { DEFAULT_CHANNEL, isGroupChat, parseMemberChannel, type MemberChannel } from "../../lib/memberChannel";
import type { CodexTurnResult } from "./runner";
import type { ApprovalRequest } from "./appServerClient";

const B3CHAT: MemberChannel = parseMemberChannel({ kind: "b3chat", api_base: "http://127.0.0.1:8741", allow_from: ["2"], owner_chat: "2" });
const ok = (reply: string): CodexTurnResult => ({ ok: true, reply, detail: "ok", elapsedMs: 1 });

let prevFc: string | undefined;
const prevDeny = process.env.CODEX_GROUP_NATIVE_DENY;
beforeEach(() => {
  resetChatThreads();
  prevFc = process.env.B3OS_FIRST_CONTACT_DIR;
  process.env.B3OS_FIRST_CONTACT_DIR = mkdtempSync(join(tmpdir(), "b3os-fc-"));
  delete process.env.CODEX_GROUP_NATIVE_DENY; // 미설정 = 차단 켜짐(기본)
});
afterEach(() => {
  if (prevFc === undefined) delete process.env.B3OS_FIRST_CONTACT_DIR; else process.env.B3OS_FIRST_CONTACT_DIR = prevFc;
  if (prevDeny === undefined) delete process.env.CODEX_GROUP_NATIVE_DENY; else process.env.CODEX_GROUP_NATIVE_DENY = prevDeny;
});

function deps(channel: MemberChannel) {
  const seen = { turns: 0, reacts: 0 };
  const d: BridgeDeps = {
    channel,
    sandbox: "read-only",
    reactMessage: async () => { seen.reacts++; return true; },
    sendMessage: async () => 1001,
    editMessage: async () => true,
    ownerGate: async () => ({ suppress: false, reason: "explicit_mention", targets: ["x"] }),
    runTurn: async () => { seen.turns++; return ok("답"); },
  };
  return { d, seen };
}

describe("그룹 판정 → 폴링 입구 차단 (텔레그램 회귀)", () => {
  // 폴 루프가 넘기는 값 그대로: isGroupChat(msg.chat)
  for (const [label, chat, denied] of [
    ["supergroup(-100…)", { id: -1001234567890, type: "supergroup" }, true],
    ["group(음수)", { id: -4567, type: "group" }, true],
    ["private(양수)", { id: 7066867819, type: "private" }, false],
  ] as const) {
    test(`텔레그램 ${label} → ${denied ? "차단" : "처리"}`, async () => {
      const { d, seen } = deps(DEFAULT_CHANNEL);
      const r = await handleMessage(chat.id, "x", 55, d, undefined, "poll", isGroupChat(chat));
      expect(r.detail === "group_native_denied").toBe(denied);
      expect(seen.turns).toBe(denied ? 0 : 1);
    });
  }

  test("텔레그램인데 type 이 양수 group 이어도 차단(음수 판정에 기대지 않는다)", async () => {
    const { d, seen } = deps(DEFAULT_CHANNEL);
    const r = await handleMessage(42, "x", 55, d, undefined, "poll", true);
    expect(r.detail).toBe("group_native_denied");
    expect(seen.turns).toBe(0);
  });
});

describe("b3chat 채널", () => {
  test("그룹 글(양수 방 id, type=group) → 차단 없이 바로 처리 — 서버가 이미 멘션·답장만 골라 보낸다", async () => {
    const { d, seen } = deps(B3CHAT);
    const r = await handleMessage(1, "@codexmember 안녕", 55, d, undefined, "poll", isGroupChat({ id: 1, type: "group" }));
    expect(r.detail).toBe("delivered");
    expect(seen.turns).toBe(1);
  });

  test("1:1 → 처리", async () => {
    const { d, seen } = deps(B3CHAT);
    const r = await handleMessage(2, "안녕", 55, d, undefined, "poll", false);
    expect(r.detail).toBe("delivered");
    expect(seen.turns).toBe(1);
  });
});

describe("발신 — b3chat 은 순수 텍스트 한 번, 텔레그램은 MarkdownV2 그대로", () => {
  function recorder(okResult = true) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify(okResult ? { ok: true, result: { message_id: 9 } } : { ok: false, error_code: 404, description: "Not Found" }));
    }) as unknown as typeof fetch;
    return { calls, fetchFn };
  }

  test("b3chat sendMessage: 그 서버 주소로, parse_mode 없이, 이스케이프 걷고 한 번", async () => {
    const { calls, fetchFn } = recorder();
    const id = await tgSend("T", fetchFn, { apiBase: B3CHAT.apiBase, plainOnly: true })(2, "a\\.b \\(c\\)");
    expect(id).toBe(9);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8741/botT/sendMessage");
    expect(calls[0]!.body).toEqual({ chat_id: 2, text: "a.b (c)" });
  });

  test("b3chat editMessageText: parse_mode 없이 한 번", async () => {
    const { calls, fetchFn } = recorder();
    expect(await tgEdit("T", fetchFn, { apiBase: B3CHAT.apiBase, plainOnly: true })(2, 9, "x\\!")).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8741/botT/editMessageText");
    expect(calls[0]!.body).toEqual({ chat_id: 2, message_id: 9, text: "x!" });
  });

  test("텔레그램(기본): api.telegram.org · 1차 MarkdownV2 — 지금과 같다", async () => {
    const { calls, fetchFn } = recorder();
    await tgSend("T", fetchFn)(5, "a\\.b");
    expect(calls[0]!.url).toBe("https://api.telegram.org/botT/sendMessage");
    expect(calls[0]!.body).toEqual({ chat_id: 5, text: "a\\.b", parse_mode: "MarkdownV2" });
  });
});

describe("파일 — 채널 주소에서 받는다", () => {
  let server: ReturnType<typeof Bun.serve>;
  const hits: string[] = [];
  let getFileSupported = true;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        hits.push(u.pathname);
        if (u.pathname === "/botT/getFile") {
          return getFileSupported
            ? Response.json({ ok: true, result: { file_id: "f1", file_path: "docs/a.txt", file_size: 3 } })
            : Response.json({ ok: false, error_code: 404, description: "Not Found: method not supported" }, { status: 404 });
        }
        if (u.pathname === "/file/botT/docs/a.txt") return new Response("abc");
        return new Response("nope", { status: 404 });
      },
    });
  });
  afterAll(() => server.stop(true));

  test("storeTelegramMedia(apiBase) → getFile·파일 모두 그 서버로", async () => {
    hits.length = 0; getFileSupported = true;
    const dir = mkdtempSync(join(tmpdir(), "b3os-media-"));
    const saved = await storeTelegramMedia("T", { kind: "document", file_id: "f1", file_unique_id: "u1", file_name: "a.txt" }, { mediaDir: dir, apiBase: `http://127.0.0.1:${server.port}` });
    expect(hits).toEqual(["/botT/getFile", "/file/botT/docs/a.txt"]);
    expect(await Bun.file(saved.file_path).text()).toBe("abc");
  });

  test("getFile 미지원(지금 b3chat) → 첨부 실패로 기록, 예외 없음", async () => {
    hits.length = 0; getFileSupported = false;
    const out = await downloadDmAttachments("T", { document: { file_id: "f1", file_name: "a.txt" } }, { apiBase: `http://127.0.0.1:${server.port}`, mediaDir: mkdtempSync(join(tmpdir(), "b3os-media-")) });
    expect(out.files.length).toBe(0);
    expect(out.failed.length).toBe(1);
    expect(hits).toEqual(["/botT/getFile"]);
  });

  test("dmMedia: 텔레그램 기본이면 store 옵션이 지금과 같다({} · mediaDir 만)", async () => {
    const seen: unknown[] = [];
    const store = (async (_t: string, _r: unknown, o: unknown) => { seen.push(o); throw new Error("stop"); }) as unknown as typeof storeTelegramMedia;
    await downloadDmAttachments("T", { document: { file_id: "f1" } }, { store });
    await downloadDmAttachments("T", { document: { file_id: "f1" } }, { store, mediaDir: "/x" });
    expect(seen).toEqual([{}, { mediaDir: "/x" }]);
  });
});

describe("승인 요청 — b3chat 은 글자로 남긴다", () => {
  const req = { method: "item/commandExecution/requestApproval", params: { command: "ls -la" } } as unknown as ApprovalRequest;
  function recorder(statuses: number[]) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      const st = statuses.shift() ?? 200;
      return new Response(JSON.stringify(st === 200 ? { ok: true, result: { message_id: 1 } } : { ok: false, error_code: st, description: "Not Found" }), { status: st });
    }) as unknown as typeof fetch;
    return { calls, fetchFn };
  }

  test("owner_chat 으로, HTML 없이, '승인 필요:' + 요청 id + 버튼 함께", async () => {
    const { calls, fetchFn } = recorder([200]);
    expect(await sendApprovalToMemberRoom("bee", "prm_abc", req, { token: "T", fetchFn, channel: B3CHAT })).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8741/botT/sendMessage");
    const b = calls[0]!.body as { chat_id: string; text: string; parse_mode?: string; reply_markup?: unknown };
    expect(b.chat_id).toBe("2");
    expect(b.parse_mode).toBeUndefined();
    expect(b.text.startsWith("승인 필요:")).toBe(true);
    expect(b.text).toContain("prm_abc");
    expect(b.text).not.toContain("<code>");
    expect(b.reply_markup).toBeDefined();
  });

  test("버튼째 거절(404) → 버튼 없이 글자만 재전송", async () => {
    const { calls, fetchFn } = recorder([404, 200]);
    expect(await sendApprovalToMemberRoom("bee", "prm_abc", req, { token: "T", fetchFn, channel: B3CHAT })).toBe(true);
    expect(calls.length).toBe(2);
    expect(calls[1]!.body.reply_markup).toBeUndefined();
    expect(String(calls[1]!.body.text)).toStartWith("승인 필요:");
  });

  test("둘 다 실패 → false (호출부가 감사 기록을 남긴다)", async () => {
    const { calls, fetchFn } = recorder([404, 404]);
    expect(await sendApprovalToMemberRoom("bee", "prm_abc", req, { token: "T", fetchFn, channel: B3CHAT })).toBe(false);
    expect(calls.length).toBe(2);
  });

  test("owner_chat 없으면 보내지 않는다(allow_from 을 목적지로 쓰지 않는다)", async () => {
    const { calls, fetchFn } = recorder([200]);
    const noOwner = parseMemberChannel({ kind: "b3chat", api_base: "http://127.0.0.1:8741", allow_from: ["2"] });
    expect(await sendApprovalToMemberRoom("bee", "prm_abc", req, { token: "T", fetchFn, channel: noOwner })).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("텔레그램(기본) → api.telegram.org · HTML · 팀장 DM — 지금과 같다", async () => {
    const { calls, fetchFn } = recorder([200]);
    expect(await sendApprovalToMemberRoom("cody", "prm_abc", req, { token: "T", fetchFn, channel: DEFAULT_CHANNEL, resolveDestination: () => "777" })).toBe(true);
    expect(calls[0]!.url).toBe("https://api.telegram.org/botT/sendMessage");
    expect(calls[0]!.body.parse_mode).toBe("HTML");
    expect(calls[0]!.body.chat_id).toBe("777");
  });
});

describe("토큰 확인(getMe) 형식", () => {
  test("b3chat 토큰은 봇 id 가 짧아도 형식 통과(텔레그램 형식은 그대로)", async () => {
    const b3 = `5:${"a".repeat(43)}`;
    expect(await validateBotToken(b3)).toEqual({ ok: false, error: "bot_token_invalid" });
    // b3chat 주소면 형식 통과 → getMe 로 간다(여기선 닫힌 포트라 getme_failed)
    expect(await validateBotToken(b3, "http://127.0.0.1:1")).toEqual({ ok: false, error: "getme_failed" });
  });
});
