// seedGroupIntoClaudeMembers — 팀방 나중 셋업 갭(#9) 수정 검증.
// ★실 FS 격리: 실제 ~/.claude/channels 가 아니라 mkdtemp 임시 dir(channelsDir 인자)만 만진다.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedGroupIntoClaudeMembers } from "./launcher";

const GID = "-1001234567890";
let tmpDirs: string[] = [];

function setupChannels(members: Record<string, unknown>): string {
  const base = mkdtempSync(join(tmpdir(), "b3os-seedgroup-"));
  tmpDirs.push(base);
  for (const [id, access] of Object.entries(members)) {
    const d = join(base, `telegram-${id}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "access.json"), JSON.stringify(access, null, 2));
  }
  return base;
}
function readAccess(base: string, id: string): any {
  return JSON.parse(readFileSync(join(base, `telegram-${id}`, "access.json"), "utf-8"));
}

afterEach(() => {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
  tmpDirs = [];
});

test("활성 멤버 access.json 에 그룹을 비파괴 시드한다(다른 필드 전부 보존)", () => {
  const base = setupChannels({
    lisa: { dmPolicy: "pairing", allowFrom: ["999"], groups: {}, pending: { code: "x" }, ackReaction: "👀" },
  });
  seedGroupIntoClaudeMembers(GID, ["lisa"], base);
  const a = readAccess(base, "lisa");
  expect(a.groups[GID]).toEqual({ requireMention: true, allowFrom: [] });
  expect(a.dmPolicy).toBe("pairing");
  expect(a.allowFrom).toEqual(["999"]);
  expect(a.pending).toEqual({ code: "x" });
  expect(a.ackReaction).toBe("👀");
});

test("memberIds 에 없는 봇(테스트/퇴사)에는 시드하지 않는다 — 과다부여 차단", () => {
  const base = setupChannels({
    lisa: { dmPolicy: "pairing", allowFrom: [], groups: {}, pending: {}, ackReaction: "👀" },
    claudetest: { dmPolicy: "pairing", allowFrom: [], groups: {}, pending: {}, ackReaction: "👀" },
  });
  seedGroupIntoClaudeMembers(GID, ["lisa"], base); // claudetest 는 목록에 없음
  expect(readAccess(base, "lisa").groups[GID]).toBeDefined();
  expect(readAccess(base, "claudetest").groups[GID]).toBeUndefined();
});

test("이미 그룹이 있으면 기존 정책 보존(skip-if-present, 덮어쓰지 않음)", () => {
  const base = setupChannels({
    jane: { dmPolicy: "allowlist", allowFrom: ["1"], groups: { [GID]: { requireMention: false, allowFrom: ["777"] } }, pending: {}, ackReaction: "👀" },
  });
  seedGroupIntoClaudeMembers(GID, ["jane"], base);
  expect(readAccess(base, "jane").groups[GID]).toEqual({ requireMention: false, allowFrom: ["777"] });
});

test("빈 gid 는 no-op", () => {
  const base = setupChannels({ lisa: { dmPolicy: "pairing", allowFrom: [], groups: {}, pending: {}, ackReaction: "👀" } });
  seedGroupIntoClaudeMembers("", ["lisa"], base);
  expect(readAccess(base, "lisa").groups).toEqual({});
});

test("groups 가 배열(비정상)이어도 객체로 교체하고 그룹 추가", () => {
  const base = setupChannels({ lisa: { dmPolicy: "pairing", allowFrom: [], groups: [], pending: {}, ackReaction: "👀" } });
  seedGroupIntoClaudeMembers(GID, ["lisa"], base);
  const a = readAccess(base, "lisa");
  expect(Array.isArray(a.groups)).toBe(false);
  expect(a.groups[GID]).toEqual({ requireMention: true, allowFrom: [] });
});

test("목록에 있으나 dir/파일 없으면 조용히 skip(throw 없음)", () => {
  const base = setupChannels({ lisa: { dmPolicy: "pairing", allowFrom: [], groups: {}, pending: {}, ackReaction: "👀" } });
  expect(() => seedGroupIntoClaudeMembers(GID, ["lisa", "ghost"], base)).not.toThrow();
  expect(readAccess(base, "lisa").groups[GID]).toBeDefined();
});

test("경로조작/비정상 id 는 무시(방어)", () => {
  const base = setupChannels({ lisa: { dmPolicy: "pairing", allowFrom: [], groups: {}, pending: {}, ackReaction: "👀" } });
  // 잘못된 id 들이 섞여도 lisa 만 정상 처리되고 throw 없음
  expect(() => seedGroupIntoClaudeMembers(GID, ["../evil", "", "A-Upper", "lisa"] as string[], base)).not.toThrow();
  expect(readAccess(base, "lisa").groups[GID]).toBeDefined();
});
