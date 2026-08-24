import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeGroupReply, ensureOutboxDir, groupReplyPath, MAX_REPLY_BYTES } from "./groupOutbox";

const dir = () => mkdtempSync(join(tmpdir(), "outbox-"));

describe("groupReplyPath — 자리를 겹치지 않게 준다", () => {
  test("★부를 때마다 다르다★ — 고정 경로면 이번 턴이 안 썼을 때 직전 답이 다시 나간다", () => {
    const a = groupReplyPath("/repo", "dex");
    const b = groupReplyPath("/repo", "dex");
    expect(a).not.toBe(b);
  });

  test("★팀원마다 갈린다★ — 한 팀원 안은 큐가 막지만 팀원 사이는 안 막는다", () => {
    expect(groupReplyPath("/repo", "dex")).toContain("/outbox/dex/");
    expect(groupReplyPath("/repo", "cody")).toContain("/outbox/cody/");
  });

  test("★이상한 agentId 로 경로를 벗어나지 못한다★", () => {
    const p = groupReplyPath("/repo", "../../etc");
    expect(p).not.toContain("..");
    expect(p).toContain("/repo/var/codex-bridge/outbox/");
  });
});

describe("consumeGroupReply — 한 번 읽고 반드시 지운다", () => {
  test("★답을 읽고 파일을 지운다★ — 남기면 다음 턴이 이번 답을 자기 답으로 읽는다", () => {
    const f = join(dir(), "r.txt");
    writeFileSync(f, "  방에 올릴 답  \n");
    const r = consumeGroupReply(f);
    expect(r).toEqual({ kind: "reply", text: "방에 올릴 답" });
    expect(existsSync(f)).toBe(false);
  });

  test("★파일이 없으면 '답 안 함' 이다★ — 고장과 구분한다", () => {
    expect(consumeGroupReply(join(dir(), "nope.txt"))).toEqual({ kind: "none" });
  });

  test("★빈 파일은 거절하고 지운다★ — 방에 빈 줄을 올리지 않는다", () => {
    const f = join(dir(), "e.txt");
    writeFileSync(f, "   \n\n");
    expect(consumeGroupReply(f)).toEqual({ kind: "rejected", reason: "empty" });
    expect(existsSync(f)).toBe(false);
  });

  test("★심링크는 따라가지 않는다★ — 따라가면 읽기 권한이 곧 유출 경로가 된다", () => {
    const d = dir();
    const secret = join(d, "secret.txt");
    writeFileSync(secret, "비밀");
    const link = join(d, "r.txt");
    symlinkSync(secret, link);
    expect(consumeGroupReply(link)).toEqual({ kind: "rejected", reason: "not_regular_file" });
    // ★링크만 지우고 원본은 안 건드린다★
    expect(existsSync(secret)).toBe(true);
  });

  test("★디렉터리도 거절한다★", () => {
    const d = join(dir(), "sub");
    mkdirSync(d);
    expect(consumeGroupReply(d)).toEqual({ kind: "rejected", reason: "not_regular_file" });
  });

  test("★상한을 넘으면 거절한다★ — 실수로 로그를 통째로 쓴 것을 방에 붓지 않는다", () => {
    const f = join(dir(), "big.txt");
    writeFileSync(f, "가".repeat(MAX_REPLY_BYTES));  // UTF-8 3바이트 → 상한 초과
    expect(consumeGroupReply(f)).toEqual({ kind: "rejected", reason: "too_large" });
    expect(existsSync(f)).toBe(false);
  });

  test("★상한 바로 아래는 통과한다★ — 경계 너머만 재면 문턱이 어디든 통과한다", () => {
    const f = join(dir(), "ok.txt");
    writeFileSync(f, "a".repeat(MAX_REPLY_BYTES - 1));
    expect(consumeGroupReply(f).kind).toBe("reply");
  });
});

test("ensureOutboxDir — 팀원이 쓸 자리를 미리 만든다", () => {
  const p = join(dir(), "a", "b", "r.txt");
  ensureOutboxDir(p);
  writeFileSync(p, "됨");  // 디렉터리가 없으면 여기서 던진다
  expect(consumeGroupReply(p)).toEqual({ kind: "reply", text: "됨" });
});
