/**
 * continuation-guard — 가드가 자기가 시킨 표시를 읽는가
 *
 * 배경: guardBody() 는 "막혔으면 blocked 표시를 description 에 남기라" 고 시키는데,
 * 판정부(stalledDoingCards)는 column/owner/updated_at 만 보고 description 을 아예 읽지
 * 않았다. 시킨 대로 해도 반영되는 경로가 없으니 지킬 수 없는 약속이었고, 재핑이 에피소드
 * 기준이라 ★성실히 갱신하는 blocked 카드일수록 더 자주 핑을 받는★ 역유인까지 있었다.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dueCards, recordNotification, reconcileState, isBlockedCard, stalledDoingCards, guardBody, parseUtc, toUtcIso } from "./task-continuation-guard";

const NOW = Date.parse("2026-07-26T00:00:00Z");
const STALL = 60 * 60 * 1000; // 60분
const OWNERS = new Set(["someone"]);

// updated_at 형식은 실제 DB 와 같은 "YYYY-MM-DD HH:MM:SS"(UTC, TZ 표기 없음).
const agoIso = (ms: number) => new Date(NOW - ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");

function card(over: Partial<Parameters<typeof stalledDoingCards>[0][number]> = {}) {
  return {
    id: "c1",
    title: "카드",
    owner: "someone",
    column: "doing" as const,
    description: null as string | null,
    updated_at: agoIso(2 * STALL),
    ...over,
  };
}

describe("blocked 표시 인식", () => {
  test("영어·한국어 표기를 모두 인정한다", () => {
    for (const d of ["blocked on review", "waiting_on GD", "waiting on GD", "승인 대기 중", "차단 중", "보류 중"]) {
      expect(isBlockedCard(card({ description: d }))).toBe(true);
    }
  });

  test("표시가 없으면 blocked 가 아니다", () => {
    expect(isBlockedCard(card({ description: null }))).toBe(false);
    expect(isBlockedCard(card({ description: "다음 액션: 테스트 작성" }))).toBe(false);
  });

  test("★unblocked 를 blocked 로 읽지 않는다★ (부분일치 함정)", () => {
    expect(isBlockedCard(card({ description: "unblocked, 재개함" }))).toBe(false);
  });
});

describe("stall 판정 — 가드가 시킨 표시를 실제로 반영한다", () => {
  test("표시 없는 카드는 기존대로 stallMs 로 걸린다", () => {
    const t = card({ updated_at: agoIso(STALL + 1000) });
    expect(stalledDoingCards([t], OWNERS, NOW, STALL)).toHaveLength(1);
  });

  test("★blocked 표시가 있으면 같은 경과시간에 걸리지 않는다★ (이게 없어서 영구 나그가 났다)", () => {
    const t = card({ updated_at: agoIso(STALL + 1000), description: "blocked — GD 판단 대기" });
    expect(stalledDoingCards([t], OWNERS, NOW, STALL)).toHaveLength(0);
  });

  test("★그래도 면제는 아니다★ — 6배를 넘기면 blocked 카드도 걸린다", () => {
    const t = card({ updated_at: agoIso(6 * STALL + 1000), description: "blocked — GD 판단 대기" });
    expect(stalledDoingCards([t], OWNERS, NOW, STALL)).toHaveLength(1);
  });

  test("doing 이 아니거나 owner 가 대상 밖이면 표시와 무관하게 제외", () => {
    expect(stalledDoingCards([card({ column: "plan" })], OWNERS, NOW, STALL)).toHaveLength(0);
    expect(stalledDoingCards([card({ owner: "other" })], OWNERS, NOW, STALL)).toHaveLength(0);
    expect(stalledDoingCards([card({ owner: null })], OWNERS, NOW, STALL)).toHaveLength(0);
  });
});

test("보류된 doing 카드는 continuation 대상으로 깨우지 않는다", () => {
  const now = Date.parse("2026-08-03T06:00:00Z");
  const card = { id: "held", title: "보류", owner: "codex", column: "doing" as const, description: null, updated_at: "2026-08-01 00:00:00", held_at: "2026-08-02 00:00:00" };
  expect(stalledDoingCards([card], new Set(["codex"]), now, 60_000)).toEqual([]);
});

describe("안내 문구", () => {
  test("표시하면 무엇이 달라지는지 알려준다 — 안 그러면 유인이 서지 않는다", () => {
    const body = guardBody("someone", [card()], 60);
    expect(body).toContain("blocked");
    expect(body).toContain("뜸하게");
  });
});

describe("parseUtc — 시간대 표시자", () => {
  // 문자열로 단정한다. Date.parse 결과는 프로세스 시간대를 타고, 테스트 러너는 UTC 로 돌아서
  // 표시자를 빠뜨려도 결과가 같아진다 — 그러면 이 판정을 검사할 수 없다.

  test("표시자가 없으면 Z 를 붙인다 — 구분자가 공백이든 T 든 같다", () => {
    expect(toUtcIso("2026-07-24 13:31:36")).toBe("2026-07-24T13:31:36Z");
    expect(toUtcIso("2026-07-30T18:10:00")).toBe("2026-07-30T18:10:00Z");
  });

  test("표시자가 있으면 그대로 둔다", () => {
    for (const v of [
      "2026-07-30T18:10:00Z",
      "2026-07-30T18:10:00+09:00",
      "2026-07-30T18:10:00-05:00",
      "2026-07-30T18:10:00+0900",
      "2026-07-30T18:10:00z",
      "2026-07-30T18:10:00.123Z",
      "2026-07-30T18:10Z",
    ]) {
      expect(toUtcIso(v)).toBe(v);
    }
  });

  test("표시자가 없는 변형에도 Z 를 하나만 붙인다", () => {
    expect(toUtcIso("2026-07-30T18:10")).toBe("2026-07-30T18:10Z");
    expect(toUtcIso("2026-07-30T18:10:00.123")).toBe("2026-07-30T18:10:00.123Z");
    expect(toUtcIso("  2026-07-30 18:10:00  ")).toBe("2026-07-30T18:10:00Z");
  });

  test("결과에는 항상 표시자가 있다", () => {
    for (const v of ["2026-07-24 13:31:36", "2026-07-30T18:10:00", "2026-07-30T18:10:00Z"]) {
      expect(toUtcIso(v)).toMatch(/(?:Z|[+-]\d{2}:?\d{2})$/);
    }
  });

  test("빈 값과 파싱 실패는 now 를 돌려준다", () => {
    expect(parseUtc("", 12345)).toBe(12345);
    expect(parseUtc(null, 12345)).toBe(12345);
    expect(parseUtc("not-a-date", 12345)).toBe(12345);
  });
});

describe("진행 갱신 뒤 한 주기 유예", () => {
  test("처음 멈춘 카드는 보내고, 같은 미변경 카드는 다시 보내지 않는다", () => {
    const t = card();
    expect(dueCards([t], {})).toEqual([t]);
    expect(dueCards([t], { c1: new Date(NOW).toISOString() })).toEqual([]);
  });
  test("마지막 알림 뒤 갱신됐으면 이번에는 억제하고 다음 주기에 재판단한다", () => {
    const state: Parameters<typeof dueCards>[1] = { c1: new Date(NOW - 4 * STALL).toISOString() };
    const t = card();
    expect(dueCards([t], state)).toEqual([]);
    const restored = JSON.parse(JSON.stringify(state));
    expect(dueCards([t], restored)).toEqual([t]);
    expect(dueCards([card({ updated_at: agoIso(STALL) })], restored)).toEqual([]);
  });
});


describe("재개 시각", () => {
  test("미래 시각은 일반·blocked 카드 모두 억제하고 경계 시각부터 다시 판단한다", () => {
    for (const prefix of ["", "blocked\n"]) {
      const t = card({ updated_at: agoIso(8 * STALL), description: prefix + "재개 시각: 2026-07-26T10:00:00+09:00" });
      expect(stalledDoingCards([t], OWNERS, NOW, STALL)).toEqual([]);
      expect(stalledDoingCards([t], OWNERS, NOW + STALL, STALL)).toEqual([t]);
    }
  });
  test("지난 시각·잘못된 값·빈 값은 기존대로 알림 대상이다", () => {
    for (const value of ["2026-07-26T08:00:00+09:00", "모레 오전", "not-a-date", "2099-02-31T09:00:00+09:00", ""]) {
      const t = card({ description: "다음 액션: 검증\n재개 시각: " + value + "\nfallback: 확인" });
      expect(stalledDoingCards([t], OWNERS, NOW, STALL)).toEqual([t]);
    }
  });
  test("안내문에 시간대가 명시된 한 줄 형식이 있다", () => {
    expect(guardBody("someone", [card()], 60)).toContain("재개 시각: 2026-10-20T09:00:00+09:00");
  });
});

describe("재알림 간격", () => {
  test("갱신만 반복해도 120→240→480→960→1440분으로 늘고 24시간에서 멈춘다", () => {
    let now = NOW;
    let state: Parameters<typeof dueCards>[1] = {};
    let t = card();
    expect(dueCards(stalledDoingCards([t], OWNERS, now, STALL), state, now, STALL)).toEqual([t]);
    recordNotification(t, state, now);
    for (const minutes of [120, 240, 480, 960, 1440, 1440]) {
      const interval = minutes * 60_000;
      // 담당자가 응답한 뒤 상태 파일을 다시 읽은 다음 회차를 재현한다.
      t = card({ updated_at: new Date(now + 1).toISOString() });
      expect(dueCards([t], state, now + interval - 1, STALL)).toEqual([]);
      state = JSON.parse(JSON.stringify(state));
      expect(dueCards([t], state, now + interval - 1, STALL)).toEqual([]);
      now += interval;
      expect(dueCards(stalledDoingCards([t], OWNERS, now, STALL), state, now, STALL)).toEqual([t]);
      recordNotification(t, state, now);
    }
  });
  test("blocked 카드는 최초 6시간, 재알림 12시간·24시간을 적용한다", () => {
    const t = card({ description: "blocked", updated_at: agoIso(6 * STALL) });
    const state: Parameters<typeof dueCards>[1] = {};
    expect(stalledDoingCards([t], OWNERS, NOW - 1, STALL)).toEqual([]);
    expect(dueCards(stalledDoingCards([t], OWNERS, NOW, STALL), state, NOW, STALL)).toEqual([t]);
    recordNotification(t, state, NOW);
    for (const [last, interval] of [[NOW, 12 * STALL], [NOW + 12 * STALL, 24 * STALL]] as const) {
      const changed = { ...t, updated_at: new Date(last + 1).toISOString() };
      expect(dueCards([changed], state, last + interval - 1, STALL)).toEqual([]);
      expect(dueCards([changed], state, last + interval - 1, STALL)).toEqual([]);
      expect(dueCards([changed], state, last + interval, STALL)).toEqual([changed]);
      recordNotification(changed, state, last + interval);
    }
  });
  test("lane을 plan으로 옮겼다가 doing으로 돌아오면 최초 간격부터 시작한다", () => {
    const state: Parameters<typeof dueCards>[1] = {};
    recordNotification(card(), state, NOW);
    reconcileState([card({ column: "plan" })], state);
    expect(state).toEqual({});
    const changed = card({ updated_at: new Date(NOW + 1).toISOString() });
    const now = NOW + STALL + 1;
    expect(dueCards(stalledDoingCards([changed], OWNERS, now, STALL), state, now, STALL)).toEqual([changed]);
    recordNotification(changed, state, now);
    expect((state.c1 as { notificationCount: number }).notificationCount).toBe(1);
  });
  test("담당자 변경은 아직 stall이 아니어도 초기화한다", () => {
    const state: Parameters<typeof dueCards>[1] = {};
    recordNotification(card(), state, NOW);
    reconcileState([card({ owner: "other", updated_at: new Date(NOW).toISOString() })], state);
    expect(state).toEqual({});
    const t = card({ owner: "other", updated_at: new Date(NOW).toISOString() });
    expect(dueCards(stalledDoingCards([t], new Set(["other"]), NOW + STALL, STALL), state, NOW + STALL, STALL)).toEqual([t]);
  });
  test("옛 문자열·객체 상태를 읽고 다음 알림부터 횟수와 담당자를 보존한다", () => {
    for (const entry of [new Date(NOW - 4 * STALL).toISOString(), {
      notifiedAt: new Date(NOW - 4 * STALL).toISOString(), observedUpdatedAt: agoIso(3 * STALL),
    }]) {
      const state: Parameters<typeof dueCards>[1] = { c1: entry };
      const t = card();
      expect(dueCards([t], state, NOW, STALL)).toEqual([]);
      const restored = JSON.parse(JSON.stringify(state));
      expect(dueCards([t], restored, NOW, STALL)).toEqual([t]);
      recordNotification(t, restored, NOW);
      expect(restored.c1).toMatchObject({ notificationCount: 2, owner: "someone", column: "doing" });
      expect(dueCards([t], restored, NOW + 24 * STALL, STALL)).toEqual([]);
    }
  });
});


test("CLI는 격리 API에서 미래 시각·재알림 상태 저장·lane 초기화를 연결한다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "continuation-guard-"));
  const statePath = join(dir, "state.json");
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, "[]");
  const old = new Date(Date.now() - 8 * STALL).toISOString();
  let tasks = [card({ updated_at: old, description: "재개 시각: 2099-01-01T00:00:00+09:00" })];
  let sends = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    if (new URL(req.url).pathname === "/tasks") return Response.json({ tasks });
    sends++;
    return Response.json({ ok: true });
  }});
  const run = async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "task-continuation-guard.ts")], {
      env: { ...process.env, DRY_RUN: "", TEAM_AGENT_REGISTRY: registryPath,
        CONTINUATION_OWNER_IDS: "someone", CONTINUATION_STALL_MIN: "60", CONTINUATION_STATE_PATH: statePath,
        TEAM_TASKS_API: `http://127.0.0.1:${server.port}/tasks`,
        TEAM_INBOX_API: `http://127.0.0.1:${server.port}/inbox` }, stdout: "pipe", stderr: "pipe",
    });
    const [, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    return JSON.parse(readFileSync(statePath, "utf8"));
  };
  try {
    expect(await run()).toEqual({});
    expect(sends).toBe(0);
    tasks[0]!.description = "재개 시각: 읽을 수 없음";
    const first = await run();
    expect(sends).toBe(1);
    expect(first.c1).toMatchObject({ notificationCount: 1, owner: "someone", column: "doing" });
    expect(await run()).toEqual(first);
    expect(sends).toBe(1);
    // 알림 뒤 갱신됐고 충분히 시간이 지났지만, 현재 재알림 간격은 24시간이다.
    const previous = new Date(Date.now() - 4 * STALL).toISOString();
    tasks[0]!.updated_at = new Date(Date.now() - 2 * STALL).toISOString();
    writeFileSync(statePath, JSON.stringify({ c1: { ...first.c1, notifiedAt: previous, notificationCount: 8 } }));
    await run();
    const waiting = await run();
    expect(sends).toBe(1);
    expect(waiting.c1.notificationCount).toBe(8);
    // 이미 관측된 갱신: 1회 알림 이력이면 2시간 간격을 지나 발송하고 2회로 저장한다.
    writeFileSync(statePath, JSON.stringify({ c1: { ...waiting.c1, notificationCount: 1 } }));
    expect((await run()).c1.notificationCount).toBe(2);
    expect(sends).toBe(2);
    tasks = [card({ column: "plan" })];
    expect(await run()).toEqual({});
    tasks = [card({ updated_at: old })];
    expect((await run()).c1.notificationCount).toBe(1);
    expect(sends).toBe(3);
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
