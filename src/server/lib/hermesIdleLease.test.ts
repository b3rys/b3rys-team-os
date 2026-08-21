/**
 * ★턴 상한이 재는 것을 '일한 시간' 에서 '조용한 시간' 으로 바꾸고, 예약(lease)을 생존신호로 갱신한다.★
 *
 * ★고치는 결함 두 개 — 서로 반대 방향이다★
 *  ① 지금까지: 출력이 계속 나오는 ★멀쩡한 턴도★ 상한에서 죽었다(실측 12건이 90초에).
 *  ② 그렇다고 상한만 없애면: 매달린 자식은 출력이 없어 ★예약도 안 밀리고★ → 예약 만료 →
 *     `recoverStaleClaims` 가 행을 `pending` 으로 되돌림 → ★같은 메시지가 다시 디스패치★ → ★중복 실행.★
 *
 * 그래서 ★둘을 한 세트로★ 시험한다 — 하나만 있으면 다른 하나가 깨진다.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { EventEmitter } from "node:events";
import type { AgentRecord } from "../types";
import {
  markDispatching,
  extendLease,
  recoverStaleClaims,
  markWakeDispatched,
} from "../db/inboxQueries";
import { runHermesTeamTurn, __setHermesBridgeTestDeps } from "./hermesBridge";

// ── DB 최소 스키마 (이 시험이 쓰는 열만) ────────────────────────────────────
function setupDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE message_recipient (
    message_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    delivery_state TEXT NOT NULL DEFAULT 'pending',
    claimed_at TEXT, lease_until TEXT,
    PRIMARY KEY (message_id, agent_id))`);
  db.run(`INSERT INTO message_recipient (message_id, agent_id) VALUES ('m1','hermes')`);
  return db;
}
/** 예약을 ★과거 시각★ 으로 되돌린다 — "턴이 예약보다 오래 걸린" 상태를 실제로 만든다.
 *  (markDispatching 에 음수 초를 넘기면 `'+-5 seconds'` 가 되어 SQLite 가 NULL 을 준다 — 그러면
 *   회수 조건 `lease_until < now` 가 성립하지 않아 ★시험이 조용히 통과해버린다.★) */
function expireLease(db: Database, id = "m1"): void {
  db.run(`UPDATE message_recipient SET lease_until = datetime('now','-5 seconds') WHERE message_id = ?`, [id]);
}
const stateOf = (db: Database, id = "m1") =>
  (db.query(`SELECT delivery_state AS s FROM message_recipient WHERE message_id = ?`).get(id) as { s: string }).s;
const leaseOf = (db: Database, id = "m1") =>
  (db.query(`SELECT lease_until AS l FROM message_recipient WHERE message_id = ?`).get(id) as { l: string | null }).l;

describe("예약(lease)을 생존신호로 갱신한다", () => {
  test("★대조군 — 갱신하지 않으면 예약이 만료돼 같은 메시지가 다시 나간다★ (지금까지 kill 이 막던 그 길)", () => {
    const db = setupDb();
    markDispatching(db, "m1", "hermes", 60);
    expireLease(db); // 턴이 예약보다 오래 걸린 상태
    expect(stateOf(db), "맡긴 직후는 처리중이다").toBe("dispatching");

    expect(recoverStaleClaims(db), "만료됐으니 죽은 워커로 보고 회수한다").toBe(1);
    expect(stateOf(db), "★대기로 돌아갔다 = 폴러가 같은 메시지를 다시 집어간다(중복 실행)★").toBe("pending");
  });

  test("★생존신호로 예약을 밀면 회수되지 않는다★ — 일하는 중인 턴을 죽은 것으로 오인하지 않는다", () => {
    const db = setupDb();
    markDispatching(db, "m1", "hermes", 60);
    expireLease(db);
    expect(extendLease(db, "m1", "hermes", 600), "처리중인 행이므로 연장된다").toBe(true);

    expect(recoverStaleClaims(db), "★예약이 미래로 밀렸으니 회수 대상이 아니다★").toBe(0);
    expect(stateOf(db), "★처리중을 유지한다 = 중복 디스패치가 안 생긴다★").toBe("dispatching");
  });

  test("★끝난 턴의 예약은 되살리지 않는다★ (상태 가드 — 없으면 완료된 행이 다시 살아난다)", () => {
    const db = setupDb();
    markDispatching(db, "m1", "hermes", 60);
    markWakeDispatched(db, "m1", "hermes");
    const before = leaseOf(db);

    expect(extendLease(db, "m1", "hermes", 600), "처리중이 아니므로 연장하지 않는다").toBe(false);
    expect(leaseOf(db), "★예약 값이 그대로여야 한다★").toBe(before);
    expect(stateOf(db)).toBe("wake_dispatched");
  });
});

// ── 무응답 시계 ────────────────────────────────────────────────────────────
const hermes: AgentRecord = {
  id: "hermes", display_name: "Hermes", role: "CSO", runtime: "hermes_agent",
  status_provider: "hermes_gateway", tmux_session: null,
  telegram_bot_username: "example_hermes_bot", workspace_path: "/tmp",
  persona_file: "", moderator_eligible: true, avatar_emoji: "", hermes_profile: undefined,
};

/** 진짜 hermes 를 띄우지 않고 ★출력만 흉내내는★ 가짜 자식. */
function fakeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter;
    kill: (sig?: string) => void; signals: string[];
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.signals = [];
  proc.kill = (sig?: string) => { proc.signals.push(sig ?? "SIGTERM"); };
  return proc;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => __setHermesBridgeTestDeps());

describe("무응답 시계 — 재는 것은 '조용한 시간' 이다", () => {
  test("★출력이 계속 오면 상한을 훨씬 넘겨도 안 죽는다★ (라이브에서 12건이 죽은 그 상황)", async () => {
    const proc = fakeProc();
    __setHermesBridgeTestDeps({ spawn: (() => proc) as never });
    const alive: number[] = [];

    const turn = runHermesTeamTurn({
      agent: hermes, threadId: "t1", messageId: "m1", body: "일 시킴",
      fromLabel: "bill", replyRoute: { kind: "teammate", to: "bill" },
      timeoutMs: 150,
      onAlive: () => alive.push(Date.now()),
    }).catch((e: Error) => `REJECTED:${e.message}`);

    // 상한(150ms)보다 짧은 간격으로 계속 떠든다 — 총 600ms = 상한의 4배
    for (let i = 0; i < 8; i++) { await sleep(75); proc.stdout.emit("data", Buffer.from(`진행 ${i}\n`)); }
    expect(proc.signals, "★일하는 중인데 죽였다 — 이게 라이브에서 난 일이다★").toEqual([]);

    proc.emit("close", 0);
    await turn;
    expect(alive.length, "생존신호가 최소 한 번은 나가야 예약이 밀린다").toBeGreaterThan(0);
  });

  test("★대조군 — 아무 소식이 없으면 상한에서 끝낸다★ (상한을 없앤 게 아니다)", async () => {
    const proc = fakeProc();
    __setHermesBridgeTestDeps({ spawn: (() => proc) as never });

    const started = Date.now();
    const r = await runHermesTeamTurn({
      agent: hermes, threadId: "t1", messageId: "m1", body: "일 시킴",
      fromLabel: "bill", replyRoute: { kind: "teammate", to: "bill" },
      timeoutMs: 150,
    }).catch((e: Error) => `REJECTED:${e.message}`);

    expect(String(r), "무응답이면 끝낸다").toContain("REJECTED:hermes_timeout");
    expect(String(r), "★'오래 걸려서' 가 아니라 '조용해서' 라는 것을 사유에 남긴다★").toContain("idle");
    expect(Date.now() - started, "상한 근처에서 끊긴다").toBeLessThan(1000);
    expect(proc.signals[0], "먼저 정중히 종료를 요청한다").toBe("SIGTERM");
  });

  test("★SIGTERM 을 무시하면 SIGKILL 로 승격한다★ — 안 그러면 '중복 실행 방지' 가 보장이 아니라 희망이다", async () => {
    const proc = fakeProc();
    __setHermesBridgeTestDeps({ spawn: (() => proc) as never });

    void runHermesTeamTurn({
      agent: hermes, threadId: "t1", messageId: "m1", body: "일 시킴",
      fromLabel: "bill", replyRoute: { kind: "teammate", to: "bill" },
      timeoutMs: 100,
    }).catch(() => {});

    await sleep(160);
    expect(proc.signals, "아직은 SIGTERM 만").toEqual(["SIGTERM"]);
    await sleep(5200); // KILL_ESCALATION_MS = 5s
    expect(proc.signals, "★죽지 않으면 확실히 죽인다★").toEqual(["SIGTERM", "SIGKILL"]);
  }, 10_000);
});
