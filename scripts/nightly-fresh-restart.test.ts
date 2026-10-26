/**
 * nightly-fresh-restart — 건너뛰기 조건마다 하나씩, dry-run 은 restartAgent 를 부르지 않는다, 순서·간격·실패 계속·알림.
 * 실제 팀원은 재시작하지 않는다: restart 는 주입한 가짜다.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  countPending,
  decide,
  restartOrder,
  runNightly,
  summaryLine,
  GAP_MS,
  PENDING_WINDOW_H,
  type Deps,
  type Facts,
  type Member,
} from "./nightly-fresh-restart";

const NOW = Date.parse("2026-10-27T18:00:00Z"); // 03:00 KST
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
const M = (id: string, over: Partial<Member> = {}): Member => ({ id, runtime: "claude_channel", ...over });
const ok = (over: Partial<Facts> = {}): Facts => ({ state: "idle", lastActivityAt: ago(60), off: false, bridged: false, pending: 0, ...over });

describe("decide — 하나라도 해당하면 skip, 판단 못 하면 skip", () => {
  test("모두 조용하면 재시작", () => {
    expect(decide(M("a"), ok(), NOW).action).toBe("restart");
  });
  test("claude 런타임이 아니면 사유와 함께 skip", () => {
    const d = decide(M("a", { runtime: "codex" }), ok(), NOW);
    expect(d.action).toBe("skip");
    expect(d.reason).toContain("codex");
  });
  test("b3chat 채널은 skip", () => expect(decide(M("a"), ok({ bridged: true }), NOW).action).toBe("skip"));
  test("의도적 정지(off)는 skip", () => expect(decide(M("a"), ok({ off: true }), NOW).reason).toContain("off"));
  test("state 가 idle 이 아니면 skip", () => expect(decide(M("a"), ok({ state: "running" }), NOW).reason).toContain("running"));
  test("state 를 모르면 skip", () => {
    expect(decide(M("a"), ok({ state: undefined }), NOW).action).toBe("skip");
    expect(decide(M("a"), ok({ state: null }), NOW).action).toBe("skip");
  });
  test("마지막 활동이 15분 이내면 skip, 정확히 15분이면 통과", () => {
    expect(decide(M("a"), ok({ lastActivityAt: ago(14) }), NOW).action).toBe("skip");
    expect(decide(M("a"), ok({ lastActivityAt: ago(15) }), NOW).action).toBe("restart");
  });
  test("미래 시각·읽을 수 없는 시각·없음은 skip", () => {
    expect(decide(M("a"), ok({ lastActivityAt: ago(-5) }), NOW).action).toBe("skip");
    expect(decide(M("a"), ok({ lastActivityAt: "어제" }), NOW).action).toBe("skip");
    expect(decide(M("a"), ok({ lastActivityAt: null }), NOW).action).toBe("skip");
  });
  test("읽지 않았거나 처리 중인 메시지가 있으면 skip, 세지 못하면 skip", () => {
    expect(decide(M("a"), ok({ pending: 2 }), NOW).reason).toContain("2건");
    expect(decide(M("a"), ok({ pending: null }), NOW).action).toBe("skip");
  });
});

describe("countPending — 실제 스키마로 센다", () => {
  function mk() {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, to_agent_id TEXT, read_at TEXT, delivery_status TEXT, expires_at TEXT, created_at TEXT);
             CREATE TABLE message_recipient (message_id TEXT, agent_id TEXT, read_at TEXT, delivery_state TEXT NOT NULL DEFAULT 'completed');`);
    return db;
  }
  const ins = (db: Database, id: string, to: string, over: { read?: string | null; status?: string; exp?: string | null; at?: string } = {}) =>
    db.prepare("INSERT INTO message VALUES (?,?,?,?,?,?)").run(id, to, over.read ?? null, over.status ?? "delivered", over.exp ?? null, over.at ?? "2026-10-27 17:00:00");
  const rcpt = (db: Database, id: string, agent: string, read: string | null = null, state = "completed") =>
    db.prepare("INSERT INTO message_recipient VALUES (?,?,?,?)").run(id, agent, read, state);
  const NOWS = "2026-10-27 18:00:00";

  test("수신자 행이 없는 직접 메시지는 message.read_at 으로 센다(읽음·실패·만료는 제외)", () => {
    const db = mk();
    ins(db, "1", "a");
    ins(db, "2", "a", { read: "2026-10-27 17:00:00" });
    ins(db, "3", "a", { status: "failed" });
    ins(db, "4", "a", { status: "expired" });
    ins(db, "5", "a", { exp: "2026-10-27 17:00:00" });
    ins(db, "6", "a", { status: "pending" });
    ins(db, "7", "b");
    expect(countPending(db, "a", NOWS)).toBe(2);
  });
  test("읽음은 수신자 행에 찍힌다: 수신자 행이 읽혔으면 message.read_at 이 비어 있어도 센다", () => {
    const db = mk();
    ins(db, "1", "a"); // message.read_at 은 비었지만 수신자 행은 읽음
    rcpt(db, "1", "a", "2026-10-27 17:30:00");
    ins(db, "2", "a"); // 수신자 행도 읽지 않음
    rcpt(db, "2", "a", null);
    expect(countPending(db, "a", NOWS)).toBe(1);
  });
  test("읽음 표시가 있어도 아직 배달 중(pending/dispatching/wake_dispatched)이면 센다", () => {
    const db = mk();
    for (const [i, st] of ["pending", "dispatching", "wake_dispatched", "agent_ack", "completed"].entries()) {
      ins(db, String(i), "a");
      rcpt(db, String(i), "a", "2026-10-27 17:30:00", st);
    }
    expect(countPending(db, "a", NOWS)).toBe(3);
  });
  test("만료 시각은 ISO 형식이어도 SQL 형식과 같은 기준으로 비교한다", () => {
    const db = mk();
    ins(db, "1", "a", { exp: "2026-10-27T17:00:00Z" }); // 이미 만료
    ins(db, "2", "a", { exp: "2026-10-27T19:00:00Z" }); // 아직 유효
    ins(db, "3", "a", { exp: "알 수 없음" }); // 읽을 수 없으면 만료로 보지 않는다(센다)
    expect(countPending(db, "a", NOWS)).toBe(2);
  });
  test("시간 창을 주면 그보다 오래된 읽지 않은 메시지는 세지 않는다(기본은 전부 센다)", () => {
    const db = mk();
    ins(db, "old", "a", { at: "2026-10-24 10:00:00" });
    ins(db, "new", "a", { at: "2026-10-27 12:00:00" });
    expect(countPending(db, "a", NOWS)).toBe(2);
    expect(countPending(db, "a", NOWS, "2026-10-27 06:00:00")).toBe(1);
  });
  test("운영 기본 창은 2시간: 3시간 전 미읽음은 안 세고 1시간 전은 센다", () => {
    expect(PENDING_WINDOW_H).toBe(2);
    const db = mk();
    ins(db, "3h", "a", { at: ago(180) });
    ins(db, "1h", "a", { at: ago(60) });
    expect(countPending(db, "a", NOWS, ago(PENDING_WINDOW_H * 60))).toBe(1);
  });
  test("방송(수신자 행)으로 온 읽지 않은 메시지도 센다", () => {
    const db = mk();
    ins(db, "1", "broadcast");
    ins(db, "2", "broadcast");
    rcpt(db, "1", "a", null);
    rcpt(db, "2", "a", "2026-10-27 17:00:00");
    rcpt(db, "1", "b", null);
    expect(countPending(db, "a", NOWS)).toBe(1);
  });
  test("다른 사람에게 온 직접 메시지와 내 수신자 행이 없는 방송은 세지 않는다", () => {
    const db = mk();
    ins(db, "1", "b");
    ins(db, "2", "broadcast");
    expect(countPending(db, "a", NOWS)).toBe(0);
  });
});

describe("restartOrder", () => {
  test("코디네이터는 맨 마지막, 나머지는 원래 순서", () => {
    const ms = [M("x", { capabilities: ["coordinator"] }), M("y"), M("z")];
    expect(restartOrder(ms).map((m) => m.id)).toEqual(["y", "z", "x"]);
  });
});

function harness(facts: Record<string, Facts>, members: Member[], over: Partial<Deps> = {}) {
  const calls: string[] = [];
  const audits: Array<[string, string | null, unknown]> = [];
  const notes: string[] = [];
  const sleeps: number[] = [];
  const deps: Deps = {
    now: () => NOW,
    members: () => members,
    facts: (m) => facts[m.id]!,
    restart: async (id, runtime, fresh) => {
      calls.push(`${id}:${runtime}:${fresh}`);
      return { ok: true, detail: `${id} ok` };
    },
    sleep: async (ms) => void sleeps.push(ms),
    audit: (a, t, d) => void audits.push([a, t, d]),
    notify: async (b) => void notes.push(b),
    log: () => {},
    ...over,
  };
  return { deps, calls, audits, notes, sleeps };
}

describe("runNightly", () => {
  test("dry-run: 아무도 재시작하지 않고 감사·알림·대기도 없다", async () => {
    const h = harness({ a: ok(), b: ok({ state: "running" }) }, [M("a"), M("b")]);
    const out = await runNightly(false, h.deps);
    expect(h.calls).toEqual([]);
    expect(h.audits).toEqual([]);
    expect(h.notes).toEqual([]);
    expect(h.sleeps).toEqual([]);
    expect(out.map((o) => [o.id, o.result])).toEqual([["a", "restarted"], ["b", "skipped"]]);
    expect(summaryLine(out, false)).toContain("dry-run");
  });

  test("commit: fresh=true 로 한 명씩, 사이에 30초, 코디네이터 마지막", async () => {
    const facts = { c: ok(), a: ok(), b: ok() };
    const h = harness(facts, [M("c", { capabilities: ["coordinator"] }), M("a"), M("b")]);
    await runNightly(true, h.deps);
    expect(h.calls).toEqual(["a:claude_channel:true", "b:claude_channel:true", "c:claude_channel:true"]);
    expect(h.sleeps).toEqual([GAP_MS, GAP_MS]);
    expect(GAP_MS).toBe(30_000);
  });

  test("재시작 직전에 다시 판단한다: 앞선 재시작 뒤 running 이 된 팀원은 건너뛴다", async () => {
    let calls = 0;
    const h = harness({ a: ok(), b: ok() }, [M("a"), M("b")], {
      facts: (m) => {
        if (m.id === "b" && calls > 0) return ok({ state: "running" });
        return ok();
      },
      restart: async (id) => {
        calls++;
        return { ok: true, detail: `${id} ok` };
      },
    });
    const out = await runNightly(true, h.deps);
    expect(out.map((o) => [o.id, o.result])).toEqual([["a", "restarted"], ["b", "skipped"]]);
    expect(out[1]!.reason).toContain("재확인");
    expect(calls).toBe(1);
    expect(h.notes).toHaveLength(1);
  });

  test("skip 한 사람 앞에서는 기다리지 않는다(첫 재시작 전 sleep 없음)", async () => {
    const h = harness({ a: ok({ state: "running" }), b: ok() }, [M("a"), M("b")]);
    await runNightly(true, h.deps);
    expect(h.sleeps).toEqual([]);
    expect(h.calls).toEqual(["b:claude_channel:true"]);
  });

  test("한 명이 실패(반환·예외)해도 나머지는 계속하고, 팀원별 감사와 요약 1줄을 남기고, 알림 1건", async () => {
    const h = harness({ a: ok(), b: ok(), c: ok(), d: ok({ pending: 1 }) }, [M("a"), M("b"), M("c"), M("d")], {
      restart: async (id) => {
        if (id === "a") return { ok: false, detail: "tmux 없음" };
        if (id === "b") throw new Error("boom");
        return { ok: true, detail: "ok" };
      },
    });
    const out = await runNightly(true, h.deps);
    expect(out.map((o) => o.result)).toEqual(["failed", "failed", "restarted", "skipped"]);
    expect(h.audits.map(([a, t]) => `${a}:${t}`)).toEqual([
      "nightly_fresh_failed:a",
      "nightly_fresh_failed:b",
      "nightly_fresh_restarted:c",
      "nightly_fresh_skipped:d",
      "nightly_fresh_summary:null",
    ]);
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]).toContain("a: 실패 — tmux 없음");
    expect(h.notes[0]).toContain("d: 건너뜀");
    expect(h.notes[0]).not.toContain("c:");
  });

  test("전원 성공이면 알림을 보내지 않는다", async () => {
    const h = harness({ a: ok() }, [M("a")]);
    await runNightly(true, h.deps);
    expect(h.notes).toEqual([]);
  });

  test("알림 전송이 실패해도 실행은 끝난다", async () => {
    const h = harness({ a: ok({ state: "running" }) }, [M("a")], { notify: async () => { throw new Error("bus down"); } });
    await expect(runNightly(true, h.deps)).resolves.toHaveLength(1);
  });

  test("facts 를 못 읽으면 그 팀원은 skip(fail-closed), 다른 팀원은 계속", async () => {
    const h = harness({ b: ok() }, [M("a"), M("b")], {
      facts: (m) => {
        if (m.id === "a") throw new Error("db locked");
        return ok();
      },
    });
    const out = await runNightly(true, h.deps);
    expect(out[0]).toMatchObject({ id: "a", result: "skipped" });
    expect(out[0]!.reason).toContain("판단 실패");
    expect(h.calls).toEqual(["b:claude_channel:true"]);
  });
});
