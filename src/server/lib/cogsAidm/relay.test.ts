/**
 * 팀원끼리 대화 → cogs AI DM 중계. 실제 버스 표(message)와 실제 outbox, cogs API 만 가짜.
 * 판정 기준: cogs 에 실제로 무엇이 어떤 순서로 몇 번 갔나.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../db/migrate";
import { ensureThread, insertMessage } from "../../db/inbox/messages";
import { CogsDeliveryUnknown } from "../cogsRelay";
import { drain, reconcileAll, reconcileThread, startCogsAidmRelay, type CogsAidmApi, type CogsIdentity } from "./relay";
import { migrateCogsAidm } from "./store";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const COGS = "https://cogs.example";
const ids: Record<string, CogsIdentity> = {
  lisa: { apiBase: COGS, token: "t-lisa" }, jane: { apiBase: COGS, token: "t-jane" }, clo: { apiBase: COGS, token: "t-clo" },
  dex: { apiBase: "https://other.example", token: "t-dex" },
};

function setup(opts: { failSend?: (n: number) => Error | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cogs-aidm-"));
  dirs.push(dir);
  const db = openDb(join(dir, "team.db"));
  migrate(db);
  migrateCogsAidm(db);
  const calls: string[] = [];
  let sends = 0;
  let work = 0;
  const seen = new Map<string, number>();
  const api: CogsAidmApi = {
    botId: async (i) => ({ "t-lisa": 1, "t-jane": 2, "t-clo": 3 } as Record<string, number>)[i.token]!,
    openPair: async (i, peer) => { calls.push(`open ${i.token} ${peer}`); return `dm-${[i.token, peer].join("-")}`; },
    startWork: async (i, a) => { calls.push(`start ${a.chat_id} ${a.request_key} origin=${a.origin_chat_id}/${a.origin_message_id}`); return ++work; },
    send: async (i, a) => {
      const err = opts.failSend?.(++sends);
      if (err) throw err;
      // 서버 중복 키: 같은 client_msg_id 는 같은 메시지.
      if (!seen.has(a.client_msg_id)) { seen.set(a.client_msg_id, 100 + seen.size); calls.push(`send ${i.token} w${a.work_id} seq${a.bus_seq}${a.no_wake ? " nowake" : ""} ${a.text}`); }
      return seen.get(a.client_msg_id)!;
    },
    complete: async (i, a) => { calls.push(`complete ${i.token} w${a.work_id} last${a.last_bus_seq}${a.report_message_id ? ` report${a.report_message_id}` : ""}`); },
  };
  const deps = { db, api, identityOf: (a: string) => ids[a] ?? null, roster: () => new Set(["lisa", "jane", "clo", "dex", "herm"]), log: () => {} };
  const thread = (tid = "T1") => {
    ensureThread(db, { thread_id: tid, from_agent_id: "user", to_agent_id: "lisa", type: "dm", body: "x" });
    insertMessage(db, { thread_id: tid, from_agent_id: "user", to_agent_id: "lisa", type: "dm", body: "단체방 정리해줘", source: "user",
      meta: { cogs: { agent_id: "lisa", chat_id: "16", message_id: 77, from: { id: "9" } } } } as never);
    return tid;
  };
  const say = (from: string, to: string, body: string, extra: Record<string, unknown> = {}, tid = "T1") =>
    insertMessage(db, { thread_id: tid, from_agent_id: from, to_agent_id: to, type: to === "broadcast" ? "broadcast" : "dm", body, source: "agent", ...extra } as never);
  const answer = (body = "정리했어요", tid = "T1") => say("lisa", "broadcast", body, { meta: { cogs_delivery: { state: "sent", message_id: 555 } } }, tid);
  const rows = () => db.prepare("SELECT seq, kind, state, reason FROM cogs_aidm_outbox ORDER BY seq").all();
  return { db, deps, calls, thread, say, answer, rows };
}

describe("무엇을 잇나", () => {
  test("cogs 에서 시작된 thread 의 팀원끼리 메시지 → 짝 방·work 하나·원래 메시지 고정", async () => {
    const s = setup();
    s.thread(); s.say("lisa", "jane", "제인, 앱 화면 맡아줘"); s.say("jane", "lisa", "접수");
    reconcileThread(s.deps, "T1");
    await drain(s.deps);
    expect(s.calls).toEqual([
      "open t-lisa 2", "start dm-t-lisa-2 T1:jane|lisa:g1 origin=16/77",
      "send t-lisa w1 seq1 제인, 앱 화면 맡아줘", "send t-jane w1 seq2 접수",
    ]);
  });
  test("cogs 와 무관한 thread 는 행도 만들지 않는다", () => {
    const s = setup();
    ensureThread(s.db, { thread_id: "X", from_agent_id: "lisa", to_agent_id: "jane", type: "dm", body: "x" });
    s.say("lisa", "jane", "그냥 버스", {}, "X");
    expect(reconcileAll(s.deps)).toBe(0);
    expect(s.rows()).toEqual([]);
  });
  test("cogs 계정 없는 팀원·다른 cogs 서버 = 건너뜀 + 이유, 버스는 그대로", async () => {
    const s = setup();
    s.thread(); s.say("lisa", "herm", "헤름 리뷰"); s.say("lisa", "dex", "덱스");
    reconcileThread(s.deps, "T1");
    expect(s.rows()).toEqual([{ seq: 1, kind: "message", state: "skipped", reason: "not_cogs_member" }, { seq: 2, kind: "message", state: "skipped", reason: "different_cogs_server" }]);
    await drain(s.deps);
    expect(s.calls).toEqual([]);
  });
  test("hop 상한으로 막힌 메시지는 잇지 않는다(정상 전달처럼 보이면 안 된다)", () => {
    const s = setup();
    s.thread(); s.say("lisa", "jane", "막힘", { hop_count: 16, max_hop: 16 });
    reconcileThread(s.deps, "T1");
    expect(s.rows()).toEqual([{ seq: 1, kind: "message", state: "skipped", reason: "bus_blocked:hop_limit_exceeded" }]);
  });
  test("깨우지 않는 메시지는 표시용으로 간다", async () => {
    const s = setup();
    s.thread(); s.say("lisa", "jane", "참고만", { meta: { no_wake: true } });
    reconcileThread(s.deps, "T1"); await drain(s.deps);
    expect(s.calls.at(-1)).toBe("send t-lisa w1 seq1 nowake 참고만");
  });
  test("같은 thread 에서 A↔B, B↔C = 짝마다 work", async () => {
    const s = setup();
    s.thread(); s.say("lisa", "jane", "1"); s.say("jane", "clo", "2");
    reconcileThread(s.deps, "T1"); await drain(s.deps);
    expect(s.calls.filter((c) => c.startsWith("start"))).toEqual([
      "start dm-t-lisa-2 T1:jane|lisa:g1 origin=16/77", "start dm-t-jane-3 T1:clo|jane:g1 origin=16/77",
    ]);
  });
});

describe("종료", () => {
  test("원래 담당이 방에 답을 올리면 열린 work 를 마지막 순번으로 닫고, 그 뒤 메시지는 새 work", async () => {
    const s = setup();
    s.thread(); s.say("lisa", "jane", "1"); s.answer();
    reconcileThread(s.deps, "T1"); await drain(s.deps);
    expect(s.calls.slice(-2)).toEqual(["send t-lisa w1 seq1 1", "complete t-lisa w1 last1 report555"]);
    s.say("jane", "lisa", "늦은 메시지");
    reconcileThread(s.deps, "T1"); await drain(s.deps);
    expect(s.calls.slice(-2)).toEqual(["start dm-t-jane-1 T1:jane|lisa:g2 origin=16/77", "send t-jane w2 seq3 늦은 메시지"]);
  });
  test("원래 담당이 아닌 팀원의 방 게시는 종료 사건이 아니다", () => {
    const s = setup();
    s.thread(); s.say("lisa", "jane", "1"); s.say("jane", "broadcast", "제인 중간 공유", { meta: { cogs_delivery: { state: "sent", message_id: 9 } } });
    reconcileThread(s.deps, "T1");
    expect(s.rows().map((r: any) => r.kind)).toEqual(["message"]);
  });
  test("답 게시가 실패/미확정이면 종료 사건이 아니다", () => {
    const s = setup();
    s.thread(); s.say("lisa", "jane", "1"); s.say("lisa", "broadcast", "실패한 답", { meta: { cogs_delivery: { state: "unknown" } } });
    reconcileThread(s.deps, "T1");
    expect(s.rows().map((r: any) => r.kind)).toEqual(["message"]);
  });
  test("훅이 빠진 메시지가 있어도 종료보다 먼저 간다(같은 대조 안에서 누락 → 종료 순)", async () => {
    const s = setup();
    s.thread(); s.say("lisa", "jane", "훅 빠짐"); s.answer();
    // 훅 없이 곧바로 대조(재시작 상황)
    reconcileAll(s.deps); await drain(s.deps);
    expect(s.calls.slice(-2)).toEqual(["send t-lisa w1 seq1 훅 빠짐", "complete t-lisa w1 last1 report555"]);
  });
  test("앞 메시지가 아직 안 갔으면 종료는 기다린다", async () => {
    const s = setup({ failSend: (n) => (n === 1 ? new Error("cogs_api_failed") : null) });
    s.thread(); s.say("lisa", "jane", "1"); s.answer();
    reconcileThread(s.deps, "T1");
    await drain(s.deps);
    expect(s.calls.filter((c) => c.startsWith("complete"))).toEqual([]);
    await drain(s.deps);
    expect(s.calls.slice(-2)).toEqual(["send t-lisa w1 seq1 1", "complete t-lisa w1 last1 report555"]);
  });
});

describe("종료 호출자", () => {
  test("짝에 담당이 없으면(B↔C) 짝 참여자로, 담당이 있으면 담당 토큰으로", async () => {
    const s = setup();
    s.thread(); s.say("jane", "clo", "B→C"); s.say("lisa", "jane", "A→B"); s.answer();
    reconcileThread(s.deps, "T1"); await drain(s.deps);
    const completes = s.calls.filter((c) => c.startsWith("complete")).sort();
    expect(completes).toEqual(["complete t-clo w1 last1 report555", "complete t-lisa w2 last2 report555"]);
  });
});

describe("중복·순서·복구", () => {
  test("대조는 몇 번 돌아도 같은 행을 다시 만들지 않는다", () => {
    const s = setup();
    s.thread(); s.say("lisa", "jane", "1");
    expect(reconcileThread(s.deps, "T1")).toBe(1);
    expect(reconcileThread(s.deps, "T1")).toBe(0);
    expect(reconcileAll(s.deps)).toBe(0);
  });
  test("응답 유실 → 같은 client_msg_id 로 재전송, cogs 에는 한 번, work 도 하나", async () => {
    const s = setup({ failSend: (n) => (n === 1 ? new CogsDeliveryUnknown() : null) });
    s.thread(); s.say("lisa", "jane", "1");
    reconcileThread(s.deps, "T1");
    await drain(s.deps);
    expect(s.rows()).toEqual([{ seq: 1, kind: "message", state: "pending", reason: "delivery_unknown" }]);
    await drain(s.deps);
    expect(s.calls.filter((c) => c.startsWith("send"))).toEqual(["send t-lisa w1 seq1 1"]);
    expect(s.calls.filter((c) => c.startsWith("start")).length).toBe(1);
  });
  test("앞 행이 실패하면 같은 thread 뒤 행은 이번에 안 보낸다(순서 보존)", async () => {
    const s = setup({ failSend: (n) => (n === 1 ? new Error("boom") : null) });
    s.thread(); s.say("lisa", "jane", "첫째"); s.say("jane", "lisa", "둘째");
    reconcileThread(s.deps, "T1");
    await drain(s.deps);
    expect(s.calls.filter((c) => c.startsWith("send"))).toEqual([]);
    await drain(s.deps);
    expect(s.calls.filter((c) => c.startsWith("send"))).toEqual(["send t-lisa w1 seq1 첫째", "send t-jane w1 seq2 둘째"]);
  });
  test("5번 실패하면 failed 로 멈추고 다음 행으로 간다", async () => {
    const s = setup({ failSend: (n) => (n <= 5 ? new Error("boom") : null) });
    s.thread(); s.say("lisa", "jane", "첫째"); s.say("jane", "lisa", "둘째");
    reconcileThread(s.deps, "T1");
    for (let i = 0; i < 6; i++) await drain(s.deps);
    expect(s.rows()).toEqual([
      { seq: 1, kind: "message", state: "failed", reason: "error:boom" },
      { seq: 2, kind: "message", state: "sent", reason: null },
    ]);
  });
  test("오래전에 시작한 thread 의 오늘 대화도 훅이 빠지면 주기 대조가 채운다", async () => {
    const s = setup();
    s.thread();
    s.db.prepare("UPDATE message SET created_at = datetime('now', '-3 days') WHERE thread_id = 'T1'").run();
    s.say("lisa", "jane", "오늘 대화"); // 훅 누락
    expect(reconcileAll(s.deps)).toBe(1);
    await drain(s.deps);
    expect(s.calls.filter((c) => c.startsWith("send"))).toEqual(["send t-lisa w1 seq1 오늘 대화"]);
  });
  test("서버가 저장한 뒤 응답만 잃어도 재전송은 같은 메시지로 끝난다(cogs 에 한 번)", async () => {
    const s = setup();
    let lost = true;
    const orig = s.deps.api.send;
    s.deps.api.send = async (i, a) => { const id = await orig(i, a); if (lost) { lost = false; throw new CogsDeliveryUnknown(); } return id; };
    s.thread(); s.say("lisa", "jane", "1");
    reconcileThread(s.deps, "T1");
    await drain(s.deps); await drain(s.deps);
    expect(s.calls.filter((c) => c.startsWith("send"))).toEqual(["send t-lisa w1 seq1 1"]);
    expect(s.rows()).toEqual([{ seq: 1, kind: "message", state: "sent", reason: "delivery_unknown" }]);
  });
  test("48시간 창 밖 누락은 미전송으로 기록(유실이 아니라 명시)", () => {
    const s = setup();
    s.thread(); const m = s.say("lisa", "jane", "옛날");
    s.db.prepare("UPDATE message SET created_at = datetime('now', '-3 days') WHERE id = ?").run(m.id);
    reconcileThread(s.deps, "T1");
    expect(s.rows()).toEqual([{ seq: 1, kind: "message", state: "skipped", reason: "out_of_window" }]);
  });
  test("계정이 그사이 사라지면 보내지 않는다", async () => {
    const s = setup();
    s.thread(); s.say("lisa", "jane", "1");
    reconcileThread(s.deps, "T1");
    const gone = { ...s.deps, identityOf: (a: string) => (a === "jane" ? null : ids[a] ?? null) };
    await drain(gone);
    expect(s.rows()).toEqual([{ seq: 1, kind: "message", state: "skipped", reason: "identity_or_origin_gone" }]);
    expect(s.calls).toEqual([]);
  });
  test("작업자: 훅(kick)이 대조·전송을 깨우고, 주기 대조가 훅 누락을 채운다", async () => {
    const s = setup();
    s.thread();
    const r = startCogsAidmRelay(s.deps, 60_000);
    s.say("lisa", "jane", "훅으로");
    r.kick("T1"); await r.idle();
    s.say("jane", "lisa", "훅 없이"); // 훅이 빠짐
    r.kick(); await r.idle();     // 주기 대조
    r.stop();
    expect(s.calls.filter((c) => c.startsWith("send"))).toEqual(["send t-lisa w1 seq1 훅으로", "send t-jane w1 seq2 훅 없이"]);
  });
});
