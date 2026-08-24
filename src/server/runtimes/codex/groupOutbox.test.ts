import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, symlinkSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { consumeGroupReply, ensureOutboxDir, groupReplyPath, outboxDir, MAX_REPLY_BYTES } from "./groupOutbox";

const dir = () => mkdtempSync(join(tmpdir(), "outbox-"));
// 파일 자체의 판정을 재는 시험들은 ★부모 검사를 통과시킨 뒤★ 그 다음 칸을 본다.
// (부모 검사 자체는 아래 전용 describe 에서 ★진짜 outbox 배치★ 로 잰다 — 여기서 겸하면
//  자기 자신과 비교하는 모양이 되어 둘 다 못 재게 된다.)
const at = (f: string) => realpathSync(dirname(f));

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
    const r = consumeGroupReply(f, at(f));
    expect(r).toEqual({ kind: "reply", text: "방에 올릴 답" });
    expect(existsSync(f)).toBe(false);
  });

  test("★파일이 없으면 '답 안 함' 이다★ — 고장과 구분한다", () => {
    const f = join(dir(), "nope.txt");
    expect(consumeGroupReply(f, at(f))).toEqual({ kind: "none" });
  });

  test("★빈 파일은 거절하고 지운다★ — 방에 빈 줄을 올리지 않는다", () => {
    const f = join(dir(), "e.txt");
    writeFileSync(f, "   \n\n");
    expect(consumeGroupReply(f, at(f))).toEqual({ kind: "rejected", reason: "empty" });
    expect(existsSync(f)).toBe(false);
  });

  test("★심링크는 따라가지 않는다★ — 따라가면 읽기 권한이 곧 유출 경로가 된다", () => {
    const d = dir();
    const secret = join(d, "secret.txt");
    writeFileSync(secret, "비밀");
    const link = join(d, "r.txt");
    symlinkSync(secret, link);
    expect(consumeGroupReply(link, at(link))).toEqual({ kind: "rejected", reason: "not_regular_file" });
    // ★링크만 지우고 원본은 안 건드린다★
    expect(existsSync(secret)).toBe(true);
  });

  test("★심링크는 '답 안 함' 이 아니라 '거절' 로 남는다★ — 뭉치면 공격 시도가 조용히 묻힌다", () => {
    const d = dir();
    writeFileSync(join(d, "secret.txt"), "비밀");
    const link = join(d, "r.txt");
    symlinkSync(join(d, "secret.txt"), link);
    const r = consumeGroupReply(link, at(link));
    // ★"파일이 없다"(none) 와 섞이면 안 된다★ — 없는 것과 막은 것은 다른 사건이다
    expect(r.kind).toBe("rejected");
    expect(JSON.stringify(r)).not.toContain("비밀");
  });

  test("★검사한 것과 읽은 것이 같은 객체다★ — 열린 fd 로만 재고 읽는다", () => {
    // O_NOFOLLOW 로 한 번 열고 fstat 으로 ★그 fd★ 를 재므로, 검사와 읽기 사이에
    // 경로를 바꿔칠 창이 없다. 그 경로를 아는 것은 답을 쓰는 팀원 자신이다.
    const d = dir();
    const f = join(d, "r.txt");
    writeFileSync(f, "정상 답");
    expect(consumeGroupReply(f, at(f))).toEqual({ kind: "reply", text: "정상 답" });
    // 소각까지 한 동작이라, 같은 경로에 링크를 새로 걸어도 남은 것이 없다
    expect(existsSync(f)).toBe(false);
  });

  test("★디렉터리도 거절한다★", () => {
    const d = join(dir(), "sub");
    mkdirSync(d);
    expect(consumeGroupReply(d, at(d))).toEqual({ kind: "rejected", reason: "not_regular_file" });
  });

  test("★상한을 넘으면 거절한다★ — 실수로 로그를 통째로 쓴 것을 방에 붓지 않는다", () => {
    const f = join(dir(), "big.txt");
    writeFileSync(f, "가".repeat(MAX_REPLY_BYTES));  // UTF-8 3바이트 → 상한 초과
    expect(consumeGroupReply(f, at(f))).toEqual({ kind: "rejected", reason: "too_large" });
    expect(existsSync(f)).toBe(false);
  });

  test("★상한 바로 아래는 통과한다★ — 경계 너머만 재면 문턱이 어디든 통과한다", () => {
    const f = join(dir(), "ok.txt");
    writeFileSync(f, "a".repeat(MAX_REPLY_BYTES - 1));
    expect(consumeGroupReply(f, at(f)).kind).toBe("reply");
  });
});

test("ensureOutboxDir — 팀원이 쓸 자리를 미리 만든다", () => {
  const p = join(dir(), "a", "b", "r.txt");
  expect(ensureOutboxDir(p).ok).toBe(true);
  writeFileSync(p, "됨");  // 디렉터리가 없으면 여기서 던진다
  expect(consumeGroupReply(p, at(p))).toEqual({ kind: "reply", text: "됨" });
});

describe("★부모 디렉터리가 바꿔치기되면 거절한다★ — O_NOFOLLOW 는 마지막 조각만 막는다", () => {
  test("outbox/<agent> 가 심링크로 바뀌면 그 너머 파일을 안 읽는다", () => {
    const root = dir();
    const real = outboxDir(root, "dex");
    mkdirSync(real, { recursive: true });
    // 공격자가 그 자리를 남의 디렉터리로 향하는 링크로 바꾼다
    const elsewhere = join(root, "secrets");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "x.txt"), "비밀");
    rmSync(real, { recursive: true });
    symlinkSync(elsewhere, real);
    const p = join(real, "x.txt");
    const r = consumeGroupReply(p, outboxDir(root, "dex"));
    expect(r).toEqual({ kind: "rejected", reason: "dir_moved" });
    expect(JSON.stringify(r)).not.toContain("비밀");
    // ★거절만으로는 부족하다★ — 지우면서 거절하면 반환값은 같은데 남의 파일이 사라진다.
    //   반환값만 보는 시험은 그 차이를 못 본다. ★막았다는 것은 원본이 그대로라는 뜻이다.★
    expect(existsSync(join(elsewhere, "x.txt"))).toBe(true);
  });

  test("★정상 자리는 통과한다★ — 경계 밖만 재면 문턱이 어디든 통과한다", () => {
    const root = dir();
    const p = groupReplyPath(root, "dex");
    ensureOutboxDir(p);
    writeFileSync(p, "정상");
    expect(consumeGroupReply(p, outboxDir(root, "dex"))).toEqual({ kind: "reply", text: "정상" });
  });
});

test("★열기 실패 사유를 가른다★ — 전부 '답 안 함' 이면 고장이 조용히 통과한다", () => {
  // outbox 디렉터리가 한 번 틀어지면 ★모든 턴이 "답 안 함" 으로 보인다★ —
  // 사람은 "덱스가 답을 안 하네" 로 읽는다. 이 PR 이 없애려는 그 모양이다.
  const root = dir();
  const d = outboxDir(root, "dex");
  mkdirSync(d, { recursive: true });
  const p = join(d, "r.txt");
  // 경로 중간을 파일로 만들어 ENOTDIR 을 낸다 (ENOENT 가 아니다)
  const p2 = join(p, "더", "안쪽.txt");
  const r = consumeGroupReply(p2, outboxDir(root, "dex"));
  writeFileSync(p, "x");
  expect(consumeGroupReply(p2, outboxDir(root, "dex")).kind).not.toBe("none");
  expect(r.kind).not.toBe("reply");
});

test("★자리를 못 만들면 실패로 알린다★ — 삼키면 '답 안 함'(정상)으로 기록되고 경고도 안 붙는다", () => {
  // /dev/null 아래에는 디렉터리를 못 만든다(ENOTDIR).
  const r = ensureOutboxDir("/dev/null/outbox/r.txt");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.detail).toBeTruthy();
});
