// opsRegistry 테스트 — predicate 평가 / 4상태 / desired DB / 카탈로그 scope.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../db/migrate";
import {
  evaluatePredicate, effectiveState, getDesired, setDesired, listOpsState, OPS_CATALOG,
  type OpsContext, type OpsEntry, type Predicate,
} from "./opsRegistry";

const ctx = (over: Partial<OpsContext> = {}): OpsContext => ({
  platform: "macos",
  agents: [{ id: "bill", capabilities: ["coordinator"], enabled: true }, { id: "steve", capabilities: null, enabled: true }],
  configPresent: (k) => k === "capture_bot_token",
  ...over,
});
const db = () => { const d = new Database(":memory:"); migrate(d); return d; };

describe("opsRegistry — predicate 평가", () => {
  test("platform in/out", () => {
    expect(evaluatePredicate({ platform: { in: ["macos"] } }, ctx()).ok).toBe(true);
    const r = evaluatePredicate({ platform: { in: ["linux"] } }, ctx());
    expect(r.ok).toBe(false); expect(r.reasons[0]).toContain("platform_unsupported");
  });
  test("team capability ≥ min", () => {
    expect(evaluatePredicate({ team: { capability: "coordinator", min: 1 } }, ctx()).ok).toBe(true);
    const r = evaluatePredicate({ team: { capability: "coordinator", min: 2 } }, ctx());
    expect(r.ok).toBe(false); expect(r.reasons[0]).toContain("need_capability:coordinator");
  });
  test("members ≥ min (disabled 제외)", () => {
    expect(evaluatePredicate({ members: { min: 2 } }, ctx()).ok).toBe(true);
    expect(evaluatePredicate({ members: { min: 3 } }, ctx()).ok).toBe(false);
    const c = ctx({ agents: [{ id: "a", enabled: true }, { id: "b", enabled: false }] });
    expect(evaluatePredicate({ members: { min: 2 } }, c).ok).toBe(false); // b는 disabled
  });
  test("config_present (missing 보고)", () => {
    expect(evaluatePredicate({ config_present: { keys: ["capture_bot_token"] } }, ctx()).ok).toBe(true);
    const r = evaluatePredicate({ config_present: { keys: ["capture_bot_token", "x"] } }, ctx());
    expect(r.ok).toBe(false); expect(r.reasons[0]).toContain("config_missing:x");
  });
  test("agent_exists", () => {
    expect(evaluatePredicate({ agent_exists: { id: "bill" } }, ctx()).ok).toBe(true);
    expect(evaluatePredicate({ agent_exists: { id: "ghost" } }, ctx()).ok).toBe(false);
  });
  test("all/any/not 조합", () => {
    const all: Predicate = { all: [{ platform: { in: ["macos"] } }, { members: { min: 2 } }] };
    expect(evaluatePredicate(all, ctx()).ok).toBe(true);
    const any: Predicate = { any: [{ platform: { in: ["linux"] } }, { members: { min: 2 } }] };
    expect(evaluatePredicate(any, ctx()).ok).toBe(true); // 두번째 충족
    expect(evaluatePredicate({ not: { platform: { in: ["linux"] } } }, ctx()).ok).toBe(true);
    expect(evaluatePredicate({ not: { platform: { in: ["macos"] } } }, ctx()).ok).toBe(false);
  });
});

describe("opsRegistry — desired / effective", () => {
  const entry: OpsEntry = { id: "t1", type: "job", title: "T", scope: "public", default_desired: true, conditions: { team: { capability: "coordinator", min: 1 } } };
  test("desired 기본값(default_desired) → set 후 반영", () => {
    const d = db();
    expect(getDesired(d, entry)).toBe(true); // default
    setDesired(d, "t1", false);
    expect(getDesired(d, entry)).toBe(false);
  });
  test("effective = eligible && desired + reasons", () => {
    const d = db();
    const s1 = effectiveState(d, entry, ctx());
    expect(s1.eligible).toBe(true); expect(s1.desired).toBe(true); expect(s1.effective).toBe(true);
    // 사용자 off → effective false(eligible은 true)
    setDesired(d, "t1", false);
    expect(effectiveState(d, entry, ctx()).effective).toBe(false);
    // 조건 미충족(coordinator 0) → eligible false + reasons
    const noCoord = ctx({ agents: [{ id: "x", capabilities: null, enabled: true }] });
    const s2 = effectiveState(d, entry, noCoord);
    expect(s2.eligible).toBe(false); expect(s2.effective).toBe(false); expect(s2.reasons.length).toBeGreaterThan(0);
  });
});

describe("opsRegistry — 카탈로그", () => {
  test("public/internal scope 분리", () => {
    const d = db();
    const pub = listOpsState(d, ctx(), { scope: "public" }).map((s) => s.id);
    const int = listOpsState(d, ctx(), { scope: "internal" }).map((s) => s.id);
    expect(pub).toContain("onoff"); expect(pub).toContain("kanban-daily");
    expect(int).toContain("deploy"); expect(int).toContain("b3os-native-nightly");
    expect(pub).not.toContain("deploy"); // 퍼블릭엔 deploy 없음
  });
  test("deploy=risky 플래그", () => {
    expect(OPS_CATALOG.find((e) => e.id === "deploy")?.risky).toBe(true);
  });
  test("learning-weekly: 팀 1명이면 ineligible(≥2 필요)", () => {
    const d = db();
    const solo = ctx({ agents: [{ id: "bill", capabilities: ["coordinator"], enabled: true }] });
    const lw = listOpsState(d, solo).find((s) => s.id === "learning-weekly")!;
    expect(lw.eligible).toBe(false); // members min 2 미충족
  });
});
