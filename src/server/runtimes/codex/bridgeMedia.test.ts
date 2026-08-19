import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { handleMessage, resetChatThreads, type BridgeDeps } from "./bridge";
import type { CodexTurnResult } from "./runner";
import type { DmAttachments } from "./dmMedia";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * ★배선 — 첨부가 턴까지 실려 가는가.★
 *
 * 단위 시험(dmMedia.test)은 "무엇을 받고 무엇을 적나" 를 본다. 여기서 보는 것은 다른 사실이다:
 * ★내려받은 그림이 codex 입력으로 실제로 넘어가는가.★ 둘은 같지 않다 —
 * 어제(#346) 함수는 맞는데 그 함수를 부르는 분기가 한 번도 안 돌았던 일이 있었다.
 */
let prev: string | undefined;
beforeEach(() => {
  prev = process.env.B3OS_FIRST_CONTACT_DIR;
  process.env.B3OS_FIRST_CONTACT_DIR = mkdtempSync(join(tmpdir(), "b3os-media-"));
  resetChatThreads();
});
afterEach(() => {
  if (prev === undefined) delete process.env.B3OS_FIRST_CONTACT_DIR;
  else process.env.B3OS_FIRST_CONTACT_DIR = prev;
});

const ok = (reply: string): CodexTurnResult => ({ ok: true, reply, detail: "ok", elapsedMs: 1 });

function spy() {
  const calls: { prompt: string; imagePaths?: readonly string[] }[] = [];
  let mid = 900;
  const deps: BridgeDeps = {
    reactMessage: async () => true,
    sendMessage: async () => ++mid,
    editMessage: async () => true,
    sandbox: "read-only",
    runTurn: async (o) => {
      calls.push({ prompt: o.prompt, imagePaths: o.imagePaths });
      return ok("답");
    },
  };
  return { deps, calls };
}

const attach = (a: Partial<DmAttachments>): DmAttachments => ({ imagePaths: [], files: [], failed: [], ...a });

describe("첨부 배선 — 그림이 codex 입력까지 간다", () => {
  test("★그림 경로가 턴 옵션으로 넘어간다★ — 본문에 적어주는 것과 다르다(적어주면 못 본다)", async () => {
    const { deps, calls } = spy();
    await handleMessage(1, "이거 뭐야", 5, deps, async () => attach({ imagePaths: ["/m/shot.jpg"] }));
    expect(calls[0]?.imagePaths, "그림은 입력 아이템으로 가야 한다").toEqual(["/m/shot.jpg"]);
  });

  test("★대조군 — 첨부가 없으면 그림도 없다★ (지어내지 않는다)", async () => {
    const { deps, calls } = spy();
    await handleMessage(1, "그냥 글", 5, deps);
    expect(calls[0]?.imagePaths).toBeUndefined();
  });

  test("그림이 왔다는 것을 ★본문에도 적는다★ — 설명 없이 그림만 오면 뭘 하란 건지 모른다", async () => {
    const { deps, calls } = spy();
    await handleMessage(1, "이거 뭐야", 5, deps, async () => attach({ imagePaths: ["/m/shot.jpg"] }));
    expect(calls[0]?.prompt).toContain("그림");
    expect(calls[0]?.prompt).toContain("이거 뭐야"); // 사람 말은 그대로 남는다
  });

  test("★문서는 경로가 본문에 들어간다★ — 그림과 달리 그게 유일한 통로다", async () => {
    const { deps, calls } = spy();
    await handleMessage(1, "읽어봐", 5, deps, async () => attach({
      files: [{ file_name: "spec.pdf", file_path: "/m/spec.pdf" } as never],
    }));
    expect(calls[0]?.prompt).toContain("/m/spec.pdf");
    expect(calls[0]?.imagePaths, "pdf 를 그림으로 넣으면 codex 가 거부한다").toEqual([]);
  });

  test("★내려받기가 통째로 실패해도 턴은 돈다★ — 사람 말까지 같이 잃으면 안 된다", async () => {
    const { deps, calls } = spy();
    const r = await handleMessage(1, "이거 봐줘", 5, deps, async () => {
      throw new Error("telegram getFile failed");
    });
    expect(r.ok, "첨부 실패가 대화를 끊으면 안 된다").toBe(true);
    expect(calls[0]?.prompt).toContain("이거 봐줘");
    expect(calls[0]?.prompt).toContain("실패"); // 무슨 일이 났는지 codex 가 안다
  });

  test("★부분 실패 — 받은 것은 가고 못 받은 것은 남는다★", async () => {
    const { deps, calls } = spy();
    await handleMessage(1, "둘 다 봐", 5, deps, async () => attach({
      imagePaths: ["/m/a.jpg"],
      failed: [{ kind: "document", reason: "20MB 초과" }],
    }));
    expect(calls[0]?.imagePaths).toEqual(["/m/a.jpg"]);
    expect(calls[0]?.prompt).toContain("20MB 초과");
  });
});
