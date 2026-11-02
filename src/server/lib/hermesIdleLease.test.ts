// 출력이 있으면 lease를 갱신하되 무응답 자식은 종료해야 한다. 한쪽만 보장하면 정상 턴 중단 또는 lease 회수 뒤 중복 실행이 생긴다.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setHermesSession } from "./hermesSessionStore";
import { leaseSecForRuntime, inFlightGraceForRuntime, noteTurnAlive, shouldReleaseInFlight, forgetTurnAlive } from "../bus/wakeDispatcher";
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
/** 예약을 과거 시각 으로 되돌린다 — "턴이 예약보다 오래 걸린" 상태를 실제로 만든다.
 *  (markDispatching 에 음수 초를 넘기면 `'+-5 seconds'` 가 되어 SQLite 가 NULL 을 준다 — 그러면
 *   회수 조건 `lease_until < now` 가 성립하지 않아 시험이 조용히 통과해버린다.) */
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

/** 진짜 hermes 를 띄우지 않고 출력만 흉내내는 가짜 자식. */
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
    __setHermesBridgeTestDeps({ spawn: (() => proc) as never, openStateDb: () => { throw new Error("unavailable"); } });
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
    __setHermesBridgeTestDeps({ spawn: (() => proc) as never, openStateDb: () => { throw new Error("unavailable"); } });

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
    __setHermesBridgeTestDeps({ spawn: (() => proc) as never, openStateDb: () => { throw new Error("unavailable"); } });

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

// 가짜 시계로 600초/2700초를 진행한다. 실제 프로세스·프로필 DB는 사용하지 않는다.
function fakeClock() {
  let now = 100_000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock = {
    now: () => now,
    setTimeout: ((fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    }) as unknown as typeof setTimeout,
    clearTimeout: ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout,
  };
  return { clock, advance(ms: number) {
    const end = now + ms;
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
    }
    now = end;
  }, pending: () => timers.size };
}

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function activityTurn(mode = 'cli', onAlive?: () => void) {
  const timer = fakeClock();
  const proc = fakeProc();
  const dir = mkdtempSync(join(tmpdir(), 'hermes-activity-'));
  const path = join(dir, 'state.db');
  const writer = new Database(path);
  writer.exec("CREATE TABLE sessions (id TEXT, source TEXT, started_at REAL); CREATE TABLE messages (session_id TEXT, timestamp REAL)");
  writer.query("INSERT INTO sessions VALUES (?, ?, ?)").run('session', mode === 'gateway' ? 'gateway' : 'cli', mode === 'old' || mode === 'resume' ? 1 : 100);
  cleanups.push(() => { writer.close(); rmSync(dir, { recursive: true, force: true }); });
  if (mode === 'locked') writer.exec("BEGIN EXCLUSIVE");
  const readers: Database[] = [];
  let alive = 0;
  const paths: string[] = [];
  if (mode === 'resume') setHermesSession('hermes', 'activity-test', 'session');
  __setHermesBridgeTestDeps({ spawn: (() => proc) as never, clock: timer.clock,
    openStateDb: (requested) => {
      paths.push(requested);
      const reader = new Database(mode === 'missing' ? join(dir, 'missing.db') : path, { readonly: true });
      readers.push(reader);
      return reader;
    },
  });
  const turn = runHermesTeamTurn({ agent: { ...hermes, hermes_profile: 'timeout-fixture' },
    threadId: mode === 'resume' ? 'activity-test' : `activity-${mode}`, messageId: 'activity-message', body: 'work', fromLabel: 'bill',
    replyRoute: { kind: 'teammate', to: 'bill' }, onAlive: () => { alive++; onAlive?.(); },
  }).catch((e: Error) => e.message);
  return { timer, proc, turn, paths, readers, missingExists: () => existsSync(join(dir, 'missing.db')), alive: () => alive,
    write: () => writer.query('INSERT INTO messages VALUES (?, ?)').run('session', timer.clock.now() / 1000 + 1) };
}

describe('Hermes session activity watchdog', () => {
  for (const mode of ['cli', 'resume']) {
    test(`current session activity survives 600 seconds without output (${mode})`, async () => {
      const t = activityTurn(mode);
      for (let i = 0; i < 25; i++) { t.write(); t.timer.advance(30_000); }
      expect(t.proc.signals).toEqual([]);
      expect(t.alive()).toBe(25);
      for (const reader of t.readers) expect(() => reader.query('SELECT 1').get()).toThrow();
      expect(t.paths.every(p => p.endsWith('/profiles/timeout-fixture/state.db'))).toBe(true);
      t.proc.stdout.emit('data', 'done'); t.proc.emit('close', 0);
      expect(await t.turn).toBe('done');
      expect(t.timer.pending()).toBe(0);
    });
  }
  for (const mode of ['gateway', 'old', 'missing', 'locked']) {
    test(`unrelated or unavailable session kills at 600 seconds (${mode})`, async () => {
      const t = activityTurn(mode);
      for (let i = 0; i < 20; i++) { t.write(); t.timer.advance(30_000); }
      expect(t.proc.signals).toEqual(['SIGTERM']);
      expect(await t.turn).toBe('hermes_timeout (idle 600s)');
      expect(t.alive()).toBe(0);
      for (const reader of t.readers) expect(() => reader.query('SELECT 1').get()).toThrow();
      if (mode === 'missing') expect(t.missingExists()).toBe(false);
      t.proc.emit('close', 0);
    });
  }
  test('unchanged DB kills at exactly 600 seconds, then escalates; late output cannot restart clocks', async () => {
    const t = activityTurn();
    t.timer.advance(599_999);
    expect(t.proc.signals).toEqual([]);
    t.timer.advance(1);
    expect(await t.turn).toBe('hermes_timeout (idle 600s)');
    expect(t.proc.signals).toEqual(['SIGTERM']);
    t.proc.stdout.emit('data', 'too late');
    t.write();
    t.timer.advance(5_000);
    expect(t.proc.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(t.alive()).toBe(0);
    expect(t.timer.pending()).toBe(0);
  });
  test('unchanged timestamp after one write does not extend idle', async () => {
    const t = activityTurn();
    t.write(); t.timer.advance(30_000);
    expect(t.alive()).toBe(1);
    t.timer.advance(599_999);
    expect(t.proc.signals).toEqual([]);
    t.timer.advance(1);
    expect(t.proc.signals).toEqual(['SIGTERM']);
    expect(await t.turn).toBe('hermes_timeout (idle 600s)');
    expect(t.alive()).toBe(1);
    t.proc.emit('close', 0);
  });
  test('continuous DB activity still kills at the absolute 45 minute cap', async () => {
    const t = activityTurn();
    for (let i = 0; i < 89; i++) { t.write(); t.timer.advance(30_000); }
    expect(t.proc.signals).toEqual([]);
    t.write(); t.timer.advance(30_000);
    expect(await t.turn).toBe('hermes_timeout (max 2700s)');
    expect(t.proc.signals).toEqual(['SIGTERM']);
    t.proc.emit('close', 0);
    expect(t.timer.pending()).toBe(0);
  });
});

test('activity renews 660-second lease and idle grace; silence permits recovery', async () => {
  const db = setupDb();
  try {
    const lease = leaseSecForRuntime('hermes_agent');
    expect(lease).toBe(660);
    expect(inFlightGraceForRuntime('hermes_agent')).toBe(720_000);
    markDispatching(db, 'm1', 'hermes', lease);
    let heartbeatAt = 0;
    const t = activityTurn('cli', () => {
      expireLease(db);
      extendLease(db, 'm1', 'hermes', lease);
      noteTurnAlive('m1', 'hermes');
      heartbeatAt = Date.now();
    });
    for (let i = 0; i < 25; i++) {
      t.write(); t.timer.advance(30_000);
      expect(recoverStaleClaims(db)).toBe(0);
      expect(stateOf(db)).toBe('dispatching');
    }
    expect(t.alive()).toBe(25);
    expect(shouldReleaseInFlight('m1:hermes', heartbeatAt - 2_000_000, 720_000, heartbeatAt + 719_000)).toBe(false);
    expect(shouldReleaseInFlight('m1:hermes', heartbeatAt - 2_000_000, 720_000, heartbeatAt + 721_000)).toBe(true);
    // SQLite의 실제 예약값을 이동해 마지막 연장 후 659초/661초를 재현한다.
    db.run("UPDATE message_recipient SET lease_until = datetime(lease_until, '-659 seconds')");
    expect(recoverStaleClaims(db)).toBe(0);
    db.run("UPDATE message_recipient SET lease_until = datetime(lease_until, '-2 seconds')");
    expect(recoverStaleClaims(db)).toBe(1);
    t.proc.stdout.emit('data', 'done'); t.proc.emit('close', 0); await t.turn;
  } finally { forgetTurnAlive('m1:hermes'); db.close(); }
});

describe("the member's scripts find the team", () => {
  test("a relative TEAM_DB_PATH reaches the hermes process as the server's absolute path", async () => {
    const proc = fakeProc();
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    __setHermesBridgeTestDeps({
      spawn: ((_cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => { spawnedEnv = opts.env; return proc; }) as never,
      openStateDb: () => { throw new Error("unavailable"); },
    });
    const before = process.env.TEAM_DB_PATH;
    process.env.TEAM_DB_PATH = "./team.db";
    try {
      const turn = runHermesTeamTurn({
        agent: hermes, threadId: "t-db", messageId: "m-db", body: "보내기",
        fromLabel: "bill", replyRoute: { kind: "teammate", to: "bill" }, timeoutMs: 1_000,
      }).catch(() => undefined);
      proc.emit("close", 0);
      await turn;
    } finally {
      if (before === undefined) delete process.env.TEAM_DB_PATH; else process.env.TEAM_DB_PATH = before;
    }
    expect(spawnedEnv?.TEAM_DB_PATH).toBe(`${process.cwd()}/team.db`);
  });
});
