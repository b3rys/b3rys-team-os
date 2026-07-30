// opNotice — team op 상황 알림의 계약 테스트.
//
// 지키는 것 (2026-07-30 사고에서 나온 요구):
//   ① 부팅 오탐을 내지 않는다 — 짧게 미충족했다 회복하면 아무 알림도 안 나간다(jane: 34초).
//   ② 지속되면 반드시 1회 알린다 — 그리고 반복 스팸하지 않는다(lisa: 28분).
//   ③ 알림은 고장난 본인에게 가지 않는다 — 그 멤버가 못 듣는 상태가 사고 본체다(블랙홀 금지).
//   ④ coordinator 가 고장이면 다른 멤버로 폴백한다.
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  EssentialsOpNotifier,
  emitOpNotice,
  pickOpNoticeRecipient,
  buildEssentialsDownBody,
  buildEssentialsRecoveredBody,
} from "./opNotice";
import { migrate } from "../db/migrate";
import type { AgentRecord } from "../types";

const agent = (id: string, capabilities: string[] = [], runtime = "claude_channel"): AgentRecord =>
  ({ id, runtime, capabilities } as unknown as AgentRecord);

// 실제 팀 구성을 반영한다 — lisa·jane 은 claude_channel(같은 경합 공유), clo·herm 은 다른 런타임.
const TEAM = [
  agent("lisa", ["coordinator", "full_context"]),
  agent("jane"),
  agent("clo", [], "openclaw"),
  agent("herm", [], "hermes_agent"),
];

describe("pickOpNoticeRecipient — 알림은 살아있는 사람에게", () => {
  // ★이 단정을 지우지 마라★ (리사 리뷰 B1, 2026-07-30): 한 번 삭제했다가 사고가 났다.
  //   R4 가중치를 넣을 때 런타임 다양성(+2)이 coordinator(+1)를 이기게 되어 기본 라우팅이
  //   coordinator → clo 로 ★뒤집혔는데★, 마침 이 단정을 같이 지워서 무보고로 통과했다.
  //   'claude 봇 poller 사망' 이 이 알림의 가장 흔한 시나리오이므로 기본 라우팅이 곧 본선이다.
  test("★기본은 coordinator 로 간다★ — 전원 건강 + 같은 런타임 상황의 불변식", () => {
    expect(pickOpNoticeRecipient(TEAM, "jane")).toBe("lisa");
  });

  test("★고장난 본인에게는 절대 안 보낸다★ (블랙홀 방지)", () => {
    const to = pickOpNoticeRecipient(TEAM, "lisa");
    expect(to).not.toBe("lisa");
  });

  // 가중치를 건드리면 여기가 먼저 빨개진다 — 표 전체를 못으로 박아둔다.
  test("실팀 구성 라우팅 표 전체", () => {
    const pick = (affected: string, down: string[] = []) =>
      pickOpNoticeRecipient(TEAM, affected, (id) => down.includes(id));
    expect(pick("jane")).toBe("lisa");                      // coordinator 기본
    expect(pick("lisa")).toBe("clo");                       // 같은 런타임 jane 탈락
    expect(pick("clo")).toBe("lisa");                       // coordinator
    expect(pick("jane", ["clo", "herm"])).toBe("lisa");     // 건강한 coordinator
    expect(pick("lisa", ["clo", "herm"])).toBe("jane");     // 유일한 건강 멤버
  });

  test("coordinator 가 없으면 남은 아무 멤버", () => {
    expect(pickOpNoticeRecipient([agent("clo"), agent("herm")], "clo")).toBe("herm");
  });

  test("예약 id(system 등)는 수신자가 될 수 없다", () => {
    expect(pickOpNoticeRecipient([agent("system"), agent("broadcast")], "jane")).toBeNull();
  });

  test("혼자인 팀에서 그 1인이 고장이면 null (호출부가 audit 만 남긴다)", () => {
    expect(pickOpNoticeRecipient([agent("jane")], "jane")).toBeNull();
  });

  // ── R4: 대칭 경합에서 죽은 쪽으로 알림이 들어가는 걸 막는다 ──
  test("★같이 죽은 멤버는 수신자에서 제외한다★ — lisa·jane 동시 탈락(08:03:37 실측)", () => {
    // lisa 가 고장이고 jane 도 down 이면, jane 에게 보내면 아무도 못 읽는다.
    const to = pickOpNoticeRecipient(TEAM, "lisa", (id) => id === "jane");
    expect(to).not.toBe("jane");
    expect(to).not.toBe("lisa");
    expect(to).not.toBeNull();
    expect(["clo", "herm"]).toContain(to as string);
  });

  test("★폴백은 같은 경합을 공유하지 않는 다른 런타임을 우선한다★", () => {
    // lisa(claude_channel) 고장 → 같은 claude_channel 인 jane 보다 다른 런타임이 안전하다.
    const to = pickOpNoticeRecipient(TEAM, "lisa");
    expect(to).not.toBe("jane");
    expect(to).not.toBeNull();
    expect(["clo", "herm"]).toContain(to as string);
  });

  test("다른 런타임 후보들 중에서는 coordinator 를 고른다", () => {
    const team = [agent("jane"), agent("clo", [], "openclaw"), agent("herm", ["coordinator"], "hermes_agent")];
    expect(pickOpNoticeRecipient(team, "jane")).toBe("herm");
  });

  test("전원 down 이어도 null 대신 최선을 골라 시도한다 (아무것도 안 보내는 것보다 낫다)", () => {
    const to = pickOpNoticeRecipient(TEAM, "lisa", () => true);
    expect(to).not.toBeNull();
    expect(to).not.toBe("lisa");
  });
});

// ★R3 — 고쳐진 그 결함 자체에 붙는 테스트★
// 원 사고의 본체는 '감지는 했는데 message 테이블에 안 넣었다' 다. emitOpNotice 를 실제로 호출해
// 행이 들어갔는지 보지 않으면, 이 함수를 통째로 no-op 으로 만들어도 테스트가 전부 초록이다
// — 사고가 그대로 재현되는데. (리사 리뷰 R3, 2026-07-30)
describe("emitOpNotice — message 테이블에 실제로 적재되는가", () => {
  const setup = (): Database => {
    const db = new Database(":memory:");
    migrate(db);
    for (const a of ["lisa", "jane", "clo"]) {
      db.prepare(
        `INSERT OR IGNORE INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
         VALUES (?, ?, 'r', 'claude_channel', 'claude_tmux', '/tmp', 'P.md')`,
      ).run(a, a);
    }
    return db;
  };

  test("★행이 실제로 들어간다★ — to_agent_id·source='system'·body 확인", () => {
    const db = setup();
    const id = emitOpNotice(db, { to: "lisa", body: "[team op] jane down", threadKey: "op-health-jane" });
    expect(id).not.toBeNull();

    const row = db
      .prepare(`SELECT to_agent_id, from_agent_id, source, body, priority FROM message WHERE id = ?`)
      .get(id as string) as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.to_agent_id).toBe("lisa");
    expect(row.from_agent_id).toBe("system");
    expect(row.source).toBe("system"); // ★op 메시지는 정직하게 system 발신★ (agent 사칭 금지)
    expect(String(row.body)).toContain("jane down");
    expect(row.priority).toBe("high"); // 기본 high
  });

  test("registry 에 없는 id 면 넣지 않는다 (깨울 대상이 없다)", () => {
    const db = setup();
    expect(emitOpNotice(db, { to: "nobody", body: "x", threadKey: "op-health-nobody" })).toBeNull();
    expect((db.prepare(`SELECT COUNT(*) c FROM message`).get() as { c: number }).c).toBe(0);
  });

  test("같은 threadKey 로 두 번 보내도 둘 다 적재된다 (down → autofix 결과 2연발)", () => {
    const db = setup();
    const a = emitOpNotice(db, { to: "lisa", body: "down", threadKey: "op-health-jane" });
    const b = emitOpNotice(db, { to: "lisa", body: "autofix 성공", threadKey: "op-health-jane" });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
    expect((db.prepare(`SELECT COUNT(*) c FROM message`).get() as { c: number }).c).toBe(2);
  });

  test("priority 를 넘기면 반영된다", () => {
    const db = setup();
    const id = emitOpNotice(db, { to: "lisa", body: "회복", threadKey: "op-health-jane", priority: "normal" });
    const row = db.prepare(`SELECT priority FROM message WHERE id = ?`).get(id as string) as { priority: string };
    expect(row.priority).toBe("normal");
  });
});

describe("EssentialsOpNotifier — 부팅 오탐 억제 + 1회 발행", () => {
  test("★임계 미달이면 알리지 않는다★ — 부팅 직후 잠깐 미충족은 정상(jane 34초 케이스)", () => {
    const n = new EssentialsOpNotifier(3);
    expect(n.observe("jane", ["poller:claude bot.pid"])).toBeNull(); // 1
    expect(n.observe("jane", ["poller:claude bot.pid"])).toBeNull(); // 2
    expect(n.observe("jane", null)).toBeNull(); // 회복 — down 을 안 보냈으니 recovered 도 없다
    expect(n.streakOf("jane")).toBe(0);
  });

  test("연속 임계 도달 시 down 1회 (lisa 28분 케이스)", () => {
    const n = new EssentialsOpNotifier(3);
    n.observe("lisa", ["poller:claude bot.pid"]);
    n.observe("lisa", ["poller:claude bot.pid"]);
    expect(n.observe("lisa", ["poller:claude bot.pid"])).toBe("down");
  });

  test("★down 이후 매 tick 반복 알림 금지★ (스팸 방지)", () => {
    const n = new EssentialsOpNotifier(2);
    n.observe("lisa", ["x"]);
    expect(n.observe("lisa", ["x"])).toBe("down");
    for (let i = 0; i < 10; i++) expect(n.observe("lisa", ["x"])).toBeNull();
  });

  test("down 을 보낸 뒤 회복하면 recovered 1회", () => {
    const n = new EssentialsOpNotifier(2);
    n.observe("lisa", ["x"]);
    expect(n.observe("lisa", ["x"])).toBe("down");
    expect(n.observe("lisa", null)).toBe("recovered");
    expect(n.observe("lisa", null)).toBeNull(); // 반복 없음
  });

  test("회복 후 다시 고장나면 또 알린다 (한 번 알렸다고 영구 침묵하지 않는다)", () => {
    const n = new EssentialsOpNotifier(2);
    n.observe("lisa", ["x"]);
    n.observe("lisa", ["x"]);
    n.observe("lisa", null);
    n.observe("lisa", ["x"]);
    expect(n.observe("lisa", ["x"])).toBe("down");
  });

  test("멤버별로 독립 추적된다 (한 명의 streak 이 다른 명을 오염시키지 않는다)", () => {
    const n = new EssentialsOpNotifier(2);
    n.observe("lisa", ["x"]);
    n.observe("jane", ["x"]);
    expect(n.observe("lisa", ["x"])).toBe("down");
    expect(n.streakOf("jane")).toBe(1);
  });

  test("빈 missing 배열은 정상으로 취급한다", () => {
    const n = new EssentialsOpNotifier(1);
    expect(n.observe("jane", [])).toBeNull();
  });

  test("isDown 은 알림을 보낸 멤버만 true (수신자 선정 입력)", () => {
    const n = new EssentialsOpNotifier(2);
    n.observe("lisa", ["x"]);
    expect(n.isDown("lisa")).toBe(false); // 아직 임계 미달
    n.observe("lisa", ["x"]);
    expect(n.isDown("lisa")).toBe(true);
    n.observe("lisa", null);
    expect(n.isDown("lisa")).toBe(false);
  });

  // ── N3: 본문의 경과 초가 실측이어야 한다 ──
  test("★실경과를 쓴다★ — afterTicks×interval 로 계산하면 항상 90 이 나온다", () => {
    let clock = 1_000_000;
    const n = new EssentialsOpNotifier(3, () => clock);
    n.observe("lisa", ["x"]);          // t=0 첫 관측
    clock += 30_000;
    n.observe("lisa", ["x"]);
    clock += 200_000;                  // tick 스킵/autofix await 로 크게 벌어진 구간
    expect(n.observe("lisa", ["x"])).toBe("down");
    // 고정계산이면 90, 실측이면 230.
    expect(n.elapsedSecOf("lisa")).toBe(230);
    expect(n.elapsedSecOf("lisa")).not.toBe(90);
  });

  test("회복하면 경과가 리셋된다 (다음 고장은 그때부터 센다)", () => {
    let clock = 0;
    const n = new EssentialsOpNotifier(1, () => clock);
    n.observe("lisa", ["x"]);
    clock += 50_000;
    expect(n.elapsedSecOf("lisa")).toBe(50);
    n.observe("lisa", null);
    expect(n.elapsedSecOf("lisa")).toBe(0);
    n.observe("lisa", ["x"]);
    expect(n.elapsedSecOf("lisa")).toBe(0);
  });
});

describe("본문 — 사람이 바로 조치할 수 있어야 한다", () => {
  const body = buildEssentialsDownBody({
    agentId: "lisa",
    runtime: "claude_channel",
    missing: ["poller:claude bot.pid"],
    elapsedSec: 90,
  });

  test("누가·무엇이·얼마나 를 담는다", () => {
    expect(body).toContain("lisa");
    expect(body).toContain("poller:claude bot.pid");
    expect(body).toContain("90초");
  });

  test("★복구 명령에 --force 가 있다★ (없으면 'Session already running' no-op 함정)", () => {
    expect(body).toContain("--force");
    expect(body).toContain("Session already running");
  });

  test("system 발신이라 회신 대상이 없음을 명시한다 (--to system 블랙홀 방지)", () => {
    expect(body).toContain("팀장님께 직접 보고");
  });

  test("회복 본문은 앞선 down 을 해소로 연결한다", () => {
    expect(buildEssentialsRecoveredBody("lisa")).toContain("lisa");
    expect(buildEssentialsRecoveredBody("lisa")).toContain("해소");
  });
});
