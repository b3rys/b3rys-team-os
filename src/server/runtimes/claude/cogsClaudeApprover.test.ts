/**
 * cogs 정책 클로드 승인: 권한 요청 → 카드 → 누름 → 인계 → 응답. 실제 DB·실제 대기·실제 판정, 카드 전송만 가짜.
 * 판정 기준은 "허용 응답 횟수"와 "허용 입력이 받은 입력과 같은가".
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/migrate";
import { getBinding, pressCogsApproval, type CardAction } from "../../lib/cogsPermissions/approvals";
import { createCogsDecisionWaiters } from "../../lib/cogsPermissions/waiters";
import type { ApprovalCardInput } from "../../lib/cogsPermissions/card";
import { claudeCardInput, createCogsClaudeApprover, fitsOnCard, type ClaudePermissionRequest } from "./cogsClaudeApprover";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const W = "/Users/t/b3os/members/flo";
const bash = (command: string, extra: Record<string, unknown> = {}): ClaudePermissionRequest => ({ tool_name: "Bash", input: { command, ...extra }, tool_use_id: "tu1" });

function setup(o: { stamp?: string | null; room?: string | null; cardOk?: boolean; ttlMs?: number; cardHangs?: boolean; cardTimeoutMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cogs-claude-appr-"));
  dirs.push(dir);
  const dbPath = join(dir, "team.db");
  const db = openDb(dbPath);
  migrate(db);
  let stamp: string | null = o.stamp === undefined ? "1:aaaa" : o.stamp;
  const cards: ApprovalCardInput[] = [];
  const onCard: Array<(i: ApprovalCardInput) => void> = [];
  const waiters = createCogsDecisionWaiters({ agentId: "flo", openDb: () => openDb(dbPath), expirySlackMs: 5, report: () => {} });
  const approver = createCogsClaudeApprover({
    agentId: "flo", roomId: o.room === undefined ? "42" : o.room, processGen: "g1", sessionId: "sess-1",
    workspace: W, controlPaths: ["/Users/t/b3rys-team-os"],
    openDb: () => openDb(dbPath), currentStamp: () => stamp, waiters, ttlMs: o.ttlMs ?? 30_000, log: () => {},
    ...(o.cardTimeoutMs ? { cardTimeoutMs: o.cardTimeoutMs } : {}),
    sendCard: async (input) => {
      cards.push(input);
      if (o.cardHangs) return new Promise(() => {});
      if (o.cardOk === false) return { ok: false };
      queueMicrotask(() => { for (const f of onCard.splice(0)) f(input); });
      return { ok: true, messageId: 900 + cards.length };
    },
  });
  /** 카드가 뜨면 주인이 누른다. thenBeforeWake: 누른 뒤, 대기가 깨기 전에 할 일(예: 정책 변경). */
  const pressOnCard = (action: CardAction, actor = 7, thenBeforeWake?: () => void) => onCard.push((input) => {
    pressCogsApproval(db, { requestId: input.requestId, action, actorUserId: actor, ownerUserId: 7, roomId: "42", bridgeAgentId: "flo", currentStamp: stamp, nowMs: Date.now() });
    thenBeforeWake?.();
    waiters.poke(input.requestId);
  });
  return { db, cards, approver, waiters, pressOnCard, setStamp: (s: string | null) => { stamp = s; } };
}

describe("거절 쪽으로 닫히는 경우(카드 없이)", () => {
  test("샌드박스 밖 실행 요청은 묻지 않고 거절", async () => {
    const s = setup();
    expect(await s.approver.approve(bash("touch /tmp/x", { dangerouslyDisableSandbox: true }))).toMatchObject({ behavior: "deny" });
    expect(s.approver.lastOutcome()).toBe("denied_unsandboxed");
    expect(s.cards).toEqual([]);
  });
  test("모양이 틀린 요청은 거절", async () => {
    const s = setup();
    for (const req of [{}, { tool_name: "Bash" }, { tool_name: "", input: {} }, { tool_name: "Bash", input: [] }, { tool_name: "Bash", input: "ls" }]) {
      expect(await s.approver.approve(req as ClaudePermissionRequest)).toMatchObject({ behavior: "deny" });
    }
    expect(s.cards).toEqual([]);
  });
  test("대상을 카드에 다 못 보이면 묻지 않고 거절(잘린 꼬리에 명령이 숨지 않게)", async () => {
    const s = setup();
    const hidden = `git log ${"a".repeat(520)} ; rm -rf ./important`;
    expect(await s.approver.approve(bash(hidden))).toMatchObject({ behavior: "deny", message: "too_long_to_review" });
    expect(s.approver.lastOutcome()).toBe("denied_unreviewable");
    expect(s.cards).toEqual([]);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM permission_request").get()).toEqual({ n: 0 });
  });
  test("카드에 실린 대상은 실행될 명령과 글자까지 같다", async () => {
    const s = setup();
    s.pressOnCard("pg1");
    // 앞서 200자에서 잘려 꼬리가 사라지던 길이(235자)도 이제 전부 실린다.
    const command = `git log --oneline ${"b".repeat(190)} ; rm -rf ./important`;
    const a = await s.approver.approve(bash(command));
    expect(command.length).toBeGreaterThan(200);
    expect(a).toMatchObject({ behavior: "allow", updatedInput: { command } });
    expect(s.cards[0]?.detail).toBe(command);
  });
  test("정책 도장을 못 읽거나 방이 없으면 거절", async () => {
    expect(await setup({ stamp: null }).approver.approve(bash("ls"))).toMatchObject({ behavior: "deny" });
    const s = setup({ room: null });
    expect(await s.approver.approve(bash("ls"))).toMatchObject({ behavior: "deny" });
    expect(s.cards).toEqual([]);
  });
  test("카드 전송 실패·멈춤은 거절", async () => {
    expect(await setup({ cardOk: false }).approver.approve(bash("ls"))).toMatchObject({ behavior: "deny" });
    const s = setup({ cardHangs: true, cardTimeoutMs: 20 });
    expect(await s.approver.approve(bash("ls"))).toMatchObject({ behavior: "deny" });
    expect(s.approver.lastOutcome()).toBe("card_failed");
  });
});

describe("카드 → 누름", () => {
  test("이번만 허용 = 받은 입력 그대로 한 번 허용", async () => {
    const s = setup();
    s.pressOnCard("pg1");
    const req = bash("git status");
    const a = await s.approver.approve(req);
    expect(a).toEqual({ behavior: "allow", updatedInput: req.input as Record<string, unknown> });
    expect(s.approver.lastOutcome()).toBe("allowed");
  });
  test("거절 누름 = 거절", async () => {
    const s = setup();
    s.pressOnCard("pgd");
    expect(await s.approver.approve(bash("git status"))).toMatchObject({ behavior: "deny" });
    expect(s.approver.lastOutcome()).toBe("denied");
  });
  test("허용을 누른 뒤 넘기기 전에 정책이 바뀌면 인계에서 진다(실행 0)", async () => {
    const s = setup();
    s.pressOnCard("pg1", 7, () => s.setStamp("2:bbbb"));
    expect(await s.approver.approve(bash("git status"))).toMatchObject({ behavior: "deny" });
    expect(s.approver.lastOutcome()).toBe("handoff_lost");
  });
  test("주인이 아닌 사람이 누르면 허용되지 않는다", async () => {
    const s = setup({ ttlMs: 60 });
    s.pressOnCard("pg1", 99);
    expect(await s.approver.approve(bash("git status"))).toMatchObject({ behavior: "deny" });
  });
  test("대기 중 정책이 바뀌면 허용을 넘기지 않는다", async () => {
    const s = setup();
    s.pressOnCard("pg1");
    const pending = s.approver.approve(bash("git status"));
    s.setStamp("2:bbbb");
    expect(await pending).toMatchObject({ behavior: "deny" });
  });
  test("시간이 지나면 거절(20분 기본, 시험은 짧게)", async () => {
    const s = setup({ ttlMs: 30 });
    expect(await s.approver.approve(bash("git status"))).toMatchObject({ behavior: "deny" });
  });
});

describe("[항상] 버튼과 규칙", () => {
  test("허용 목록 명령은 [항상] 을 주고 정확한 규칙을 묶어 둔다", async () => {
    const s = setup();
    s.pressOnCard("pg1");
    await s.approver.approve(bash("git status"));
    expect(s.cards[0]).toMatchObject({ operationCode: "run_command", detail: "git status", allowAlways: true });
    expect(getBinding(s.db, s.cards[0]!.requestId)?.always_rule).toBe("Bash(git status)");
  });
  test("복합 명령·보호 파일은 [항상] 을 숨긴다", async () => {
    const s = setup({ ttlMs: 30 });
    await s.approver.approve(bash("git status && id"));
    await s.approver.approve({ tool_name: "Write", input: { file_path: `${W}/CLAUDE.md`, content: "x" } });
    expect(s.cards.map((c) => c.allowAlways)).toEqual([false, false]);
    expect(s.cards.map((c) => getBinding(s.db, c.requestId)?.always_rule ?? null)).toEqual([null, null]);
  });
  test("위험 표시가 있으면 허용 목록 명령이어도 [항상] 을 숨긴다", async () => {
    const s = setup({ ttlMs: 30 });
    await s.approver.approve(bash("git grep launchctl"));
    expect(s.cards[0]?.risks.length).toBeGreaterThan(0);
    expect(s.cards[0]?.allowAlways).toBe(false);
  });
});

describe("카드 입력", () => {
  test("도구별 operation_code 와 대상 전체(자르지 않음)", () => {
    expect(claudeCardInput("Bash", { command: "ls -la" }, "r", [], true)).toMatchObject({ operationCode: "run_command", detail: "ls -la" });
    expect(claudeCardInput("Edit", { file_path: "/a/b.txt" }, "r", [], false)).toMatchObject({ operationCode: "edit_files", detail: "/a/b.txt" });
    expect(claudeCardInput("WebFetch", { url: "https://x.example" }, "r", [], false)).toMatchObject({ operationCode: "request_permission", detail: "https://x.example" });
    expect(claudeCardInput("Bash", { command: "x".repeat(500) }, "r", [], false).detail).toHaveLength(500);
  });
  test("다 실리는지: 한도 안은 true, 넘거나 대상이 없으면 false(여러 바이트 글자 포함)", () => {
    const card = (detail: string | undefined) => ({ requestId: "prm_xxxxxxxxxxxxxxxxxx", operationCode: "run_command", detail, risks: [], allowAlways: false });
    expect(fitsOnCard(card("git status"))).toBe(true);
    expect(fitsOnCard(card("a".repeat(600)))).toBe(false);
    expect(fitsOnCard(card("한".repeat(200)))).toBe(false);
    expect(fitsOnCard(card(undefined))).toBe(false);
    expect(fitsOnCard(card(""))).toBe(false);
  });
});
