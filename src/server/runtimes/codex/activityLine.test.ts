// ★지금 무엇을 하는 중인가★
//
// tmux 팀원은 statusProbe 가 화면을 긁어 activity_line 을 채운다. 창이 없는 codex 팀원은
// ★영영 비어 있었다★ — 실측: dex 의 activity_line 은 항상 null.
// codex 의 등가물은 app-server item 이벤트다. 같은 칸에 쓴다.
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../db/migrate";
import { setActivityLine } from "../../db/queries";
import { activityLineOf } from "./appServerClient";

describe("codex 활동 한 줄 — 무엇을 하는지 보여준다", () => {

const dbWithDex = () => {
  const db = new Database(":memory:"); migrate(db);
  db.prepare(`INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
              VALUES ('dex','Dex','eng','codex','codex_cli','/w','AGENTS.md')`).run();
  return db;
};

test("★무엇을 하는지가 나온다★ — 종류만 말하면 '진짜 뭘 하는지' 가 아니다", () => {
  expect(activityLineOf({ type: "commandExecution", command: "npm test" })).toBe("실행: npm test");
  expect(activityLineOf({ type: "commandExecution", command: ["git", "status"] })).toBe("실행: git status");
  expect(activityLineOf({ type: "fileChange", fileChanges: { "src/a.ts": {} } })).toBe("파일 수정: src/a.ts");
  expect(activityLineOf({ type: "fileChange", fileChanges: { a: {}, b: {}, c: {} } })).toBe("파일 3개 수정");
  expect(activityLineOf({ type: "webSearch", query: "codex config" })).toBe("웹 검색: codex config");
  expect(activityLineOf({ type: "mcpToolCall", name: "team_status" })).toBe("도구 호출: team_status");
});

test("긴 명령은 잘린다 — 한 줄 표시라 넘치면 화면을 밀어낸다", () => {
  const line = activityLineOf({ type: "commandExecution", command: "x".repeat(300) })!;
  expect(line.length).toBeLessThanOrEqual(85);
  expect(line.endsWith("…")).toBe(true);
});

test("알 수 없는 항목은 null — 빈 줄로 덮어써서 있던 정보를 지우지 않는다", () => {
  expect(activityLineOf({})).toBeNull();
  expect(activityLineOf(null)).toBeNull();
});

test("★다른 칸을 건드리지 않는다★ — state·tmux_pid 는 statusProbe 의 것이다", () => {
  const db = dbWithDex();
  db.prepare(`INSERT INTO agent_status (agent_id, state, last_activity_at, last_log_line, tmux_pid, probed_at)
              VALUES ('dex','idle',datetime('now'),'기존 로그',4242,datetime('now'))`).run();
  setActivityLine(db, "dex", "실행: npm test");
  const r = db.query("select state, tmux_pid, last_log_line, activity_line from agent_status where agent_id='dex'").get() as Record<string, unknown>;
  expect(r.activity_line).toBe("실행: npm test");
  expect(r.tmux_pid).toBe(4242);        // 두 주인이 서로 덮어쓰면 안 된다
  expect(r.last_log_line).toBe("기존 로그");
  db.close();
});

test("행이 없어도 만들어진다(첫 턴에 표시가 나와야 한다)", () => {
  const db = dbWithDex();
  setActivityLine(db, "dex", "웹 검색: x");
  expect((db.query("select activity_line from agent_status where agent_id='dex'").get() as { activity_line: string }).activity_line).toBe("웹 검색: x");
  db.close();
});
});

// ── ★라이브에서 본 것을 고정한다★ (2026-08-18) ──
//
// 화면에 뜬 줄: `userMessage` · `생각하는 중`(반복) · `웹 검색`(검색어 없음).
// 원인 둘 — ①검색어 필드가 queries(복수)인데 단수 query 만 읽었다
//          ②알 수 없는 항목에서 type 을 그대로 찍어 내부 이름이 새어나갔다
// 필드명 근거: codex 0.147.0 바이너리의 WebSearchAction = queries · open_page(url) · find_in_page(pattern)
describe("진행 줄 — 라이브에서 드러난 구멍", () => {
  test("★검색어는 queries(복수)에서 읽는다★ — 단수만 보면 '웹 검색' 만 뜬다", () => {
    expect(activityLineOf({ type: "webSearch", queries: ["판교 날씨"] })).toBe("웹 검색: 판교 날씨");
    expect(activityLineOf({ type: "webSearch", queries: ["a", "b"] })).toBe("웹 검색: a · b");
  });

  test("중첩된 action 안에 있어도 읽는다", () => {
    expect(activityLineOf({ type: "webSearch", action: { queries: ["codex config"] } })).toBe("웹 검색: codex config");
  });

  test("검색 말고 페이지 열기·찾기도 무엇인지 보여준다", () => {
    expect(activityLineOf({ type: "webSearch", action: { url: "https://example.com/x" } })).toBe("웹 열기: https://example.com/x");
    expect(activityLineOf({ type: "webSearch", action: { pattern: "강수확률" } })).toBe("페이지에서 찾기: 강수확률");
  });

  test("★대조군 — 아무 정보가 없으면 예전처럼 '웹 검색'★ (없는 것을 지어내지 않는다)", () => {
    expect(activityLineOf({ type: "webSearch" })).toBe("웹 검색");
  });

  test("★내부 항목 이름이 화면에 새지 않는다★ — 라이브에 `userMessage` 가 그대로 떴다", () => {
    expect(activityLineOf({ type: "userMessage" })).toBeNull();
    expect(activityLineOf({ type: "user_message" })).toBeNull();
  });

  test("★대조군 — 모르는 항목은 여전히 보여준다★ (조용해지면 진행이 멈춘 것처럼 보인다)", () => {
    expect(activityLineOf({ type: "somethingNew" })).toBe("somethingNew");
  });

  test("생각 요약이 오면 무엇을 생각하는지 보여준다 — 없으면 예전 문구", () => {
    expect(activityLineOf({ type: "reasoning", summary: "판교 날씨를 찾는다\n두 번째 줄" })).toBe("생각: 판교 날씨를 찾는다");
    expect(activityLineOf({ type: "reasoning" })).toBe("생각하는 중");
  });
});

// ── ★기록해 둔 실제 원문으로 잰다★ ──
//
// 아래 payload 는 2026-08-18 에 실제 codex 0.147.0 턴에서 받아 적은 것이다(합성 아님).
// 합성 입력만으로는 openPage 인데 최상위 query 에 URL 이 실려 오는 것 같은 모양을 못 만든다.
describe("진행 줄 — 실제 payload", () => {
  test("★시작 시점은 비어 있다★ — 그래서 시작 줄만 쓰면 영영 '웹 검색' 이다", () => {
    const started = { type: "webSearch", id: "exec-1", query: "", action: null, results: null };
    expect(activityLineOf(started)).toBe("웹 검색");
  });

  test("완료 시점 — action.queries(복수)", () => {
    const done = {
      type: "webSearch", id: "exec-1", query: "판교 주간 날씨 예보 ...",
      action: { type: "search", query: null, queries: ["판교 주간 날씨 예보", "성남시 분당구 주간 날씨 예보"] },
    };
    expect(activityLineOf(done)).toBe("웹 검색: 판교 주간 날씨 예보 · 성남시 분당구 주간 날씨 예보");
  });

  test("완료 시점 — action.query(단수)", () => {
    const done = {
      type: "webSearch", id: "exec-2", query: "판교 이번주 날씨",
      action: { type: "search", query: "판교 이번주 날씨", queries: null },
    };
    expect(activityLineOf(done)).toBe("웹 검색: 판교 이번주 날씨");
  });

  test("★openPage 는 '웹 검색' 이 아니다★ — 최상위 query 에 URL 이 실려 와 라벨이 뒤집혔었다", () => {
    const done = {
      type: "webSearch", id: "exec-3",
      query: "https://api.open-meteo.com/v1/forecast?latitude=37.39",
      action: { type: "openPage", url: "https://api.open-meteo.com/v1/forecast?latitude=37.39" },
    };
    const line = activityLineOf(done)!;
    expect(line.startsWith("웹 열기: ")).toBe(true);
    expect(line).not.toContain("웹 검색");
  });

  test("★대조군 — 검색이 빈손이면 예전 문구 그대로★ (action.type='other')", () => {
    const done = { type: "webSearch", id: "exec-4", query: "", action: { type: "other" }, results: [] };
    expect(activityLineOf(done)).toBe("웹 검색");
  });
});
