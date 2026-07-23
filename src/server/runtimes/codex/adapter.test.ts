/**
 * codex 어댑터 characterization 테스트 — in-memory sqlite, 진짜 codex CLI 호출 X(mock 주입).
 *
 * ═══ 예전 계약 [A] — 이 파일이 지키던 것 ═══
 * 어댑터가 codex CLI 의 stdout 을 받아 ★서버가 버스에 "codex 가 말했다" 로 insert★ 했다.
 * 수신자도 서버가 ★추측★ 했다(turnReplyTarget: 에이전트 요청 → directed / user 요청 → broadcast).
 * 그래서 핀이 ①at-most-once ③directed/broadcast ⑥dedupe(같은 답 두 번 → 1개) 였다.
 *
 * ═══ 왜 사라졌나 ═══ (GD 2026-07-13: "팀원한테 맡겨. 다 빼.")
 * ★서버가 대신 말하니 침묵이 불가능했다★ → `[NO_REPLY]` 우회 토큰 → 가드 누락 →
 * ★그 토큰이 팀장 단톡방에 그대로 찍혔다★ (라이브). 수집 종합도 ★나를 깨운 기여자★ 에게 오배송됐다(3/7).
 * ★dex 가 쓴 "[NO_REPLY]" 가 버스에 그대로 실린 것도 수트에서 실측됐다.★
 *
 * ═══ 지금 계약 [B] ═══
 * ★턴 본문은 dex 의 메모다. 어댑터는 그것을 게시하지 않는다★ (audit `turn_completed_no_autopost` 만 남긴다).
 * 말하려면 dex 가 직접 `send.sh` → POST /team/api/inbox 로 보낸다 (능력은 이미 있다 — 수트에서 팬아웃 실측).
 * ★플랫폼 공지(턴 실패)는 여전히 나간다 — 단, from="system" 이다. 팀원을 사칭하지 않는다.★
 *
 * 유지되는 핀: ★②in-flight 잠금 · ⑤lease-safe · 에러 무음 아님 · session 지속 · 권한 preflight ·
 *   RunArtifact(started/succeeded/timed_out) · 실패통지 dedupe · hop 승계★
 */
import { describe, expect, test, beforeEach, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, rmSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { migrate } from "../../db/migrate";
import { makeCodexAdapter, runTurn } from "./adapter";
import type { CodexCaller, CodexTurnResult } from "./runner";
import type { AgentRecord } from "../../types";
import type { PendingDispatchRow } from "../../bus/types";
import { clearRuntimeBlock, getRuntimeBlock } from "../../lib/runtimeBlocks";
import { grantKey } from "../../lib/permissionGate";
import { CodexInflightStore, CodexRunArtifactStore, CodexSessionStore } from "./state";
import { CodexTurnEnvelopeBuilder } from "./envelope";

/** 전역 격리(preload)가 세팅한 값 — afterAll 에서 ★지우지 말고 되돌린다.★ */
const PREV_AUDIT_DIR = process.env.B3OS_AUDIT_LOG_DIR;

// 테스트 격리: isAgentOff가 라이브 var/agent-off.txt 대신 temp를 읽게(라이브 오염·의존 차단).
const OFF_FILE = join(tmpdir(), "codex-adapter-test-off.txt");
process.env.TEAMOS_AGENT_OFF_FILE = OFF_FILE;
beforeEach(() => { try { rmSync(OFF_FILE); } catch { /* 없으면 무시 → isAgentOff=false */ } });
beforeEach(() => clearRuntimeBlock("cody"));

// ★audit 격리★ — appendAuditFile 이 라이브 logs/ 를 건드리면 안 된다(팀 하드레슨: 테스트는 실 FS 격리).
//   [B] 의 "게시하지 않았다" 는 ★audit 으로만 관측된다★ → 이 파일이 audit 을 읽어야 한다.
let TMP_LOG_DIR: string;
beforeAll(() => {
  TMP_LOG_DIR = mkdtempSync(join(tmpdir(), "codex-adapter-audit-"));
  process.env.B3OS_AUDIT_LOG_DIR = TMP_LOG_DIR;
});
afterAll(() => {
  // ★지우면 안 된다 — 되돌려야 한다.★ (2026-07-14)
  //   전역 preload(src/test/audit-isolation.ts)가 B3OS_AUDIT_LOG_DIR 을 temp 로 세팅해 ★모든★ 테스트를
  //   라이브 logs/ 에서 격리한다. 여기서 delete 하면 ★그 격리가 통째로 풀리고★, 같은 프로세스에서
  //   ★뒤에 도는 모든 테스트가 라이브 감사로그에 쓴다.★
  //   실측: 라이브 로그에 테스트 이벤트 ★1619건★ (actor='nova', thread='t1' — 존재하지 않는 팀원/스레드).
  //   ★계기판이 첫날부터 가짜 데이터로 못 쓰게 됐다.★ (팀 하드레슨: bun test 는 라이브를 안 건드린다)
  if (PREV_AUDIT_DIR === undefined) delete process.env.B3OS_AUDIT_LOG_DIR;
  else process.env.B3OS_AUDIT_LOG_DIR = PREV_AUDIT_DIR;
  try { rmSync(TMP_LOG_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
});

interface AuditLine { actor: string; action: string; target: string | null; detail: Record<string, unknown> | null }
/** temp audit 로그에서 (선택) action 으로 거른 줄들. */
const auditLines = (action?: string): AuditLine[] =>
  readdirSync(TMP_LOG_DIR)
    .filter((f) => f.startsWith("audit-"))
    .flatMap((f) => readFileSync(join(TMP_LOG_DIR, f), "utf8").split("\n").filter(Boolean))
    .map((l) => JSON.parse(l) as AuditLine)
    .filter((l) => !action || l.action === action);

const okResult = (reply: string): CodexTurnResult => ({ ok: true, reply, detail: "ok", elapsedMs: 1 });

function setup(): Database {
  const db = new Database(":memory:");
  migrate(db);
  const ins = (id: string, runtime: string, sp: string) =>
    db
      .prepare(
        `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
         VALUES (?, ?, 'role', ?, ?, '/tmp', 'AGENTS.md')`,
      )
      .run(id, id, runtime, sp);
  ins("cody", "codex", "codex_cli"); // codex 런타임 멤버
  ins("bill", "claude_channel", "claude_tmux");
  db.prepare(
    `INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('t1','test','dm','["cody","bill"]','bill')`,
  ).run();
  return db;
}

const agentsOf = (db: Database) => (): AgentRecord[] =>
  (db.prepare(`SELECT * FROM agent`).all() as Record<string, unknown>[]).map(
    (r) => ({ ...r, moderator_eligible: !!r.moderator_eligible }) as never,
  );
const codyOf = (db: Database): AgentRecord => agentsOf(db)().find((a) => a.id === "cody")!;

const row = (over: Partial<PendingDispatchRow> = {}): PendingDispatchRow => ({
  message_id: "m1", agent_id: "cody", delivery_state: "dispatching", retry_count: 0, last_error: null,
  from_agent_id: "bill", to_agent_id: "cody", body: "안녕 도와줘", source: "agent", created_by: null,
  max_hop: 6, hop_count: 0, in_reply_to: null, parent_message_id: null, sync: "none", thread_id: "t1",
  type: "dm", created_at: new Date().toISOString(), priority: "normal", ...over,
});

const repliesFrom = (db: Database, from: string) =>
  db.prepare(`SELECT * FROM message WHERE from_agent_id=? ORDER BY created_at DESC`).all(from) as Record<string, unknown>[];
/** 버스에 들어간 ★모든★ 메시지 — "서버가 아무것도 게시하지 않았다" 를 증명할 때 쓴다. */
const allMessages = (db: Database) =>
  db.prepare(`SELECT * FROM message ORDER BY created_at DESC`).all() as Record<string, unknown>[];
const artifacts = (db: Database, status?: string) =>
  db
    .prepare(`SELECT * FROM codex_run_artifact ${status ? "WHERE status = ?" : ""} ORDER BY created_at, id`)
    .all(...(status ? [status] : [])) as Record<string, unknown>[];
const sessions = (db: Database) =>
  db.prepare(`SELECT * FROM codex_session_map ORDER BY updated_at DESC`).all() as Record<string, unknown>[];
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

describe("codex adapter — 핵심 정확성", () => {
  /**
   * ★[A] → [B] 전환의 심장.★ 예전 ①at-most-once 는 "서버가 답을 ★정확히 1회★ 게시한다" 였다.
   * ★이제 0회다.★ 턴 본문은 dex 의 메모다 — 말하려면 dex 가 자기 손으로 보낸다.
   * (GD 2026-07-13 "팀원한테 맡겨. 다 빼." · `[NO_REPLY]` 가 팀장 단톡방에 찍힌 사고의 근본 처방)
   */
  test("★성공 턴 → 서버가 게시하지 않는다 (메시지 0개) + audit turn_completed_no_autopost★", async () => {
    const db = setup();
    const fake: CodexCaller = async () => okResult("네, 도와드릴게요!");
    await runTurn(db, agentsOf(db), codyOf(db), row({ message_id: "no-autopost-1" }), "팀컨텍스트", fake);

    // ★서버는 dex 를 대신해 한 마디도 하지 않았다★ — 버스 전체에 메시지가 없다(그 팀원 명의든 아니든)
    expect(
      allMessages(db),
      "★서버가 codex 의 턴 본문을 대신 버스에 게시했다★ — [A] 회귀.\n" +
        "  그 순간 침묵이 불가능해지고 → `[NO_REPLY]` 우회로가 필요해지고 → 그 토큰이 팀장 단톡방에 찍힌다.",
    ).toEqual([]);
    expect(repliesFrom(db, "cody")).toEqual([]);

    // ★대신 audit 에 "턴은 끝났고, 게시하지 않았다" 를 남긴다★ — 이게 [B] 의 유일한 관측점이다
    const audit = auditLines("turn_completed_no_autopost").filter((l) => l.target === "no-autopost-1");
    expect(audit.length).toBe(1);
    expect(audit[0]?.actor).toBe("cody");
    expect(audit[0]?.detail?.thread_id).toBe("t1");
    expect(audit[0]?.detail?.chars).toBe("네, 도와드릴게요!".length); // 본문은 남기지 않는다 — 길이만
    expect(JSON.stringify(audit[0])).not.toContain("네, 도와드릴게요!"); // audit 에도 본문 저장 안 함(메모니까)
  });

  test("★user 요청이어도 자동 broadcast 하지 않는다★ — 수신자 '추측' 이 오배송의 근원이었다", () => {
    // ★[A]★: 서버가 수신자를 추측했다(에이전트 요청 → directed / user 요청 → broadcast).
    //   수집에선 ★나를 깨운 사람★ 이 기여자라 ★종합이 그 기여자에게 갔다★ (실측 7회 중 3회 오배송).
    // ★[B]★: 서버는 추측하지 않는다. ★보낼 사람이 수신자를 안다.★
    const db = setup();
    const fake: CodexCaller = async () => okResult("공개 답변");
    return runTurn(db, agentsOf(db), codyOf(db), row({ from_agent_id: "user" }), "", fake).then(() => {
      expect(allMessages(db)).toEqual([]);
      // 성공 턴이었음은 artifact 로 확인된다(게시가 없다고 턴이 없었던 게 아니다)
      expect(artifacts(db, "succeeded").length).toBe(1);
    });
  });

  test("④codex 실패(ok:false) → 게시 안 함(에이전트 요청)", async () => {
    const db = setup();
    const fake: CodexCaller = async () => ({ ok: false, reply: "", detail: "exit_1", elapsedMs: 1 });
    await runTurn(db, agentsOf(db), codyOf(db), row(), "", fake);
    expect(repliesFrom(db, "cody").length).toBe(0);
    expect(getRuntimeBlock("cody")?.line).toContain("exit_1");
  });

  test("codex 성공 턴 → 이전 runtime block 자동 clear", async () => {
    const db = setup();
    const fail: CodexCaller = async () => ({ ok: false, reply: "", detail: "429 rate limit", elapsedMs: 1 });
    await runTurn(db, agentsOf(db), codyOf(db), row(), "", fail);
    expect(getRuntimeBlock("cody")?.line).toContain("429 rate limit");
    const ok: CodexCaller = async () => okResult("복구됨");
    await runTurn(db, agentsOf(db), codyOf(db), row({ message_id: "m2" }), "", ok);
    expect(getRuntimeBlock("cody")).toBe(null);
  });

  // ★유지★ — lease-safe 는 [B] 와 무관하게 그대로 필요하다(claim-tick 블록 방지).
  //   달라진 것: "턴이 끝났다" 의 증거가 ★게시된 메시지★ 에서 ★succeeded artifact★ 로 바뀌었다.
  test("⑤lease-safe: wake 즉시 codex_dispatched + 턴 비동기 완료(artifact 로 관측)", async () => {
    const db = setup();
    const fake: CodexCaller = async () => okResult("비동기 답");
    const adapter = makeCodexAdapter(db, agentsOf(db), { callCodex: fake });
    const r = await adapter.wake("cody", row(), "");
    expect(r.ok).toBe(true);
    expect(r.detail).toBe("codex_dispatched"); // 즉시 반환(턴은 detach)
    await sleep(20);
    expect(artifacts(db, "succeeded").length).toBe(1); // 턴은 뒤에서 완주했다
    expect(allMessages(db)).toEqual([]);               // ★그래도 게시는 0★ ([B])
  });

  // ★유지·강화★ — in-flight 잠금은 [B] 에서 ★더 중요해졌다.★
  //   [A] 시절엔 "두 턴이 돌아도 dedupe 가 게시를 1개로 막아준다" 는 뒤늦은 안전망이 있었다.
  //   ★[B] 엔 그 안전망이 없다★ (게시 자체를 안 하니 dedupe 할 것도 없다) → ★두 번째 턴이 시작되면
  //   dex 가 자기 손으로 ★두 번 보낸다★.★ 그래서 잠금은 "게시 1회" 가 아니라 ★"턴 1회"★ 를 지켜야 한다.
  test("②in-flight 잠금: 처리 중 재-wake → deferred + ★두 번째 턴이 시작되지 않는다★", async () => {
    const db = setup();
    let release!: (r: CodexTurnResult) => void;
    let calls = 0;
    const blocking: CodexCaller = () => {
      calls += 1;
      return new Promise<CodexTurnResult>((res) => (release = res));
    };
    const adapter = makeCodexAdapter(db, agentsOf(db), { callCodex: blocking });
    const r1 = await adapter.wake("cody", row(), "");
    expect(r1.detail).toBe("codex_dispatched");
    const r2 = await adapter.wake("cody", row(), "");   // 처리 중 재-wake
    expect(r2.deferred).toBe(true);
    expect(r2.detail).toBe("codex_in_flight");
    expect(calls, "★재-wake 가 두 번째 codex 턴을 띄웠다★ — dex 가 같은 요청에 두 번 발신하게 된다").toBe(1);

    release(okResult("끝"));
    await sleep(20);
    expect(calls).toBe(1);                              // 완료 후에도 두 번째 턴 없음
    expect(artifacts(db, "started").length).toBe(1);    // 턴은 정확히 하나만 시작됐다
    expect(artifacts(db, "succeeded").length).toBe(1);
    expect(allMessages(db)).toEqual([]);                // 게시는 [B] 대로 0
  });

  test("off 명단 멤버 → wake가 codex_agent_off(응답 차단, ok:true no-retry)", async () => {
    const db = setup();
    writeFileSync(OFF_FILE, "cody\n"); // cody를 off 명단에
    const fake: CodexCaller = async () => okResult("응답하면 안 됨");
    const adapter = makeCodexAdapter(db, agentsOf(db), { callCodex: fake });
    const r = await adapter.wake("cody", row(), "");
    expect(r.ok).toBe(true);
    expect(r.detail).toBe("codex_agent_off");
    await sleep(20);
    expect(repliesFrom(db, "cody").length).toBe(0); // off라 응답 게시 안 함
  });

  test("모르는 에이전트 → ok:false", async () => {
    const db = setup();
    const adapter = makeCodexAdapter(db, agentsOf(db), { callCodex: async () => okResult("x") });
    const r = await adapter.wake("ghost", row({ agent_id: "ghost" }), "");
    expect(r.ok).toBe(false);
  });

  /**
   * ★예전 ⑥dedupe 는 ★대상을 잃었다★.★
   * [A]: 서버가 답을 게시하니 ★같은 답이 두 번 실릴 위험★ 이 있었다 → dedupe_key 로 1개로 접었다.
   * [B]: ★서버가 게시를 안 하니 접을 것이 없다.★ ★그러나 테스트를 지우지 않는다★ — 지우면
   *   "두 번 돌려도 게시 0" 이라는 ★[B] 의 핵심 불변식이 무방비★ 가 된다. 그래서 [B] 등가물로 바꾼다.
   *   (dedupe 기계 자체는 ★죽지 않았다★ — 아래 '실패통지 dedupe' 로 여전히 살아있다.)
   */
  test("★같은 턴 두 번 → 여전히 게시 0★ (dedupe 할 게 없다 — 애초에 아무것도 안 실린다)", async () => {
    const db = setup();
    const fake: CodexCaller = async () => okResult("동일한 답");
    await runTurn(db, agentsOf(db), codyOf(db), row(), "", fake);
    await runTurn(db, agentsOf(db), codyOf(db), row(), "", fake);
    expect(allMessages(db)).toEqual([]);
    // 턴은 ★두 번 다 정상 완주★ 했다 — 예전엔 두 번째가 'deduped' 로 접혔다(게시가 있었으니까).
    expect(artifacts(db, "succeeded").length).toBe(2);
    expect(artifacts(db, "deduped").length).toBe(0);
  });

  /**
   * ★플랫폼 공지는 살아있다 — 단, 팀원을 사칭하지 않는다.★ (2026-07-13, [B] 전환 중 발견)
   * ★[A]★: from=<팀원>, source="agent" → ★"그 팀원이 그렇게 말했다" 로 보였다.★
   *   ★그 팀원은 아무 말도 안 했다 — 턴이 죽은 것이다.★ 서버가 그의 입을 빌리면 안 된다.
   * ★[B]★: from="system", source="system" (만료 통지·마감 알림이 이미 그런 것과 같은 원칙).
   */
  test("★실패통지: user 요청 + codex 실패 → 가시 통지 1회, 단 from=system (팀원 사칭 금지)★", async () => {
    const db = setup();
    const fail: CodexCaller = async () => ({ ok: false, reply: "", detail: "boom", elapsedMs: 1 });
    await runTurn(db, agentsOf(db), codyOf(db), row({ from_agent_id: "user" }), "", fail);

    // ★그 팀원 명의로는 한 마디도 안 나간다★ — 턴이 죽었는데 그가 말한 것처럼 보이면 거짓이다
    expect(repliesFrom(db, "cody")).toEqual([]);

    const notices = repliesFrom(db, "system");
    expect(notices.length).toBe(1);
    expect(notices[0]?.source).toBe("system");        // 사칭 방지의 두 번째 축
    expect(notices[0]?.to_agent_id).toBe("broadcast");
    expect(String(notices[0]?.body)).toContain("응답이 실패했습니다");
    expect(String(notices[0]?.body)).toContain("cody"); // 누구의 턴이 죽었는지는 본문으로 밝힌다
  });

  test("★실패통지 dedupe 는 살아있다★ — 연속 실패로 팀방을 도배하지 않는다 (60s 창)", async () => {
    const db = setup();
    const fail: CodexCaller = async () => ({ ok: false, reply: "", detail: "boom", elapsedMs: 1 });
    await runTurn(db, agentsOf(db), codyOf(db), row({ from_agent_id: "user", message_id: "f1" }), "", fail);
    await runTurn(db, agentsOf(db), codyOf(db), row({ from_agent_id: "user", message_id: "f2" }), "", fail);
    expect(repliesFrom(db, "system").length).toBe(1); // 같은 본문 → 60s 내 재통지 억제
  });

  test("에이전트 요청(user 아님) + 실패 → 통지 안 함 (봇↔봇 루프 방지)", async () => {
    const db = setup();
    const fail: CodexCaller = async () => ({ ok: false, reply: "", detail: "boom", elapsedMs: 1 });
    await runTurn(db, agentsOf(db), codyOf(db), row({ from_agent_id: "bill" }), "", fail);
    expect(allMessages(db)).toEqual([]);
  });

  test("session persistence: 같은 thread 두 번째 턴은 저장된 Codex session으로 resume", async () => {
    const db = setup();
    const seen: Array<string | undefined> = [];
    const fake: CodexCaller = async (opts) => {
      seen.push(opts.resumeSessionId);
      return { ok: true, reply: `답-${seen.length}`, detail: "ok", elapsedMs: 1, sessionId: `sess-${seen.length}` };
    };

    await runTurn(db, agentsOf(db), codyOf(db), row({ message_id: "m1" }), "", fake);
    await runTurn(db, agentsOf(db), codyOf(db), row({ message_id: "m2" }), "", fake);

    expect(seen).toEqual([undefined, "sess-1"]);
    expect(sessions(db)[0]?.codex_session_id).toBe("sess-2");
  });

  test("agent-level codex sandbox/network config is passed after explicit permission grants", async () => {
    const db = setup();
    const agent = {
      ...codyOf(db),
      codex_sandbox: "workspace-write" as const,
      codex_network_access: true,
    };
    const seen: Array<{ sandbox?: string; networkAccess?: boolean; writableRoots?: string[]; prompt: string }> = [];
    const fake: CodexCaller = async (opts) => {
      seen.push({
        sandbox: opts.sandbox,
        networkAccess: opts.networkAccess,
        writableRoots: opts.writableRoots,
        prompt: opts.prompt,
      });
      return okResult("권한 확인");
    };

    await runTurn(db, agentsOf(db), agent, row(), "", fake, {
      sessionStore: new CodexSessionStore(db),
      artifactStore: new CodexRunArtifactStore(db),
      inflightStore: new CodexInflightStore(db),
      envelopeBuilder: new CodexTurnEnvelopeBuilder(db),
      permissionContext: {
        grants: new Set([grantKey("cody", "workspace-write:/tmp")]),
        networkAllowlist: ["*"],
      },
    });

    expect(seen[0]?.sandbox).toBe("workspace-write");
    expect(seen[0]?.networkAccess).toBe(true);
    expect(seen[0]?.writableRoots).toEqual(["/tmp"]);
    expect(seen[0]?.prompt).toContain('"sandbox": "workspace-write"');
    expect(seen[0]?.prompt).toContain('"networkAccess": true');
  });

  test("permission preflight blocks workspace-write before spawning codex when no grant exists", async () => {
    const db = setup();
    const agent = { ...codyOf(db), codex_sandbox: "workspace-write" as const };
    let called = false;
    const fake: CodexCaller = async () => {
      called = true;
      return okResult("실행되면 안 됨");
    };

    await runTurn(db, agentsOf(db), agent, row(), "", fake);

    expect(called).toBe(false);
    expect(getRuntimeBlock("cody")?.line).toContain("tier-a.workspace-write");
    expect(artifacts(db, "failed")[0]?.detail).toContain("permission_ask:tier-a.workspace-write");
    const pending = db.query("SELECT action, status, requested_by FROM permission_request").all() as any[];
    expect(pending).toEqual([{ action: "sandbox", status: "pending", requested_by: "codex-adapter" }]);
    const approval = db.query("SELECT action_key, status FROM approval_request").all() as any[];
    expect(approval).toEqual([{ action_key: "permission_gate", status: "pending" }]);
  });

  test("team-bus codex turn uses per-agent CODEX_HOME instead of host ~/.codex", async () => {
    const db = setup();
    const seen: Array<{ codexHome?: string }> = [];
    const fake: CodexCaller = async (opts) => {
      seen.push({ codexHome: opts.codexHome });
      return okResult("home 확인");
    };

    await runTurn(db, agentsOf(db), codyOf(db), row(), "", fake);

    expect(seen[0]?.codexHome).toBe(`${process.env.HOME}/.codex-agents/cody`);
  });

  test("session persistence: 다른 thread는 session을 섞지 않는다", async () => {
    const db = setup();
    db.prepare(
      `INSERT INTO thread (id, title, kind, participants_json, opened_by) VALUES ('t2','test2','dm','["cody","bill"]','bill')`,
    ).run();
    const seen: Array<string | undefined> = [];
    const fake: CodexCaller = async (opts) => {
      seen.push(opts.resumeSessionId);
      return { ok: true, reply: `답-${seen.length}`, detail: "ok", elapsedMs: 1, sessionId: `sess-${seen.length}` };
    };

    await runTurn(db, agentsOf(db), codyOf(db), row({ message_id: "m1", thread_id: "t1" }), "", fake);
    await runTurn(db, agentsOf(db), codyOf(db), row({ message_id: "m2", thread_id: "t2" }), "", fake);

    expect(seen).toEqual([undefined, undefined]);
    expect(sessions(db).length).toBe(2);
  });

  test("session persistence: 실패한 턴은 기존 session을 덮어쓰지 않는다", async () => {
    const db = setup();
    const ok: CodexCaller = async () => ({ ok: true, reply: "정상", detail: "ok", elapsedMs: 1, sessionId: "good-session" });
    await runTurn(db, agentsOf(db), codyOf(db), row({ message_id: "m1" }), "", ok);
    const fail: CodexCaller = async () => ({ ok: false, reply: "", detail: "exit_1", elapsedMs: 1, sessionId: "bad-session" });
    await runTurn(db, agentsOf(db), codyOf(db), row({ message_id: "m2" }), "", fail);
    expect(sessions(db)[0]?.codex_session_id).toBe("good-session");
  });

  // ★유지★ — RunArtifact 는 [B] 에서 ★유일한 턴 관측 수단★ 이라 더 중요해졌다.
  //   달라진 것 둘: ①두 번째 성공이 'deduped' 가 아니라 'succeeded' 다(게시가 없으니 접힐 일이 없다)
  //                ②succeeded 의 reply_message_id 가 ★null★ 이다 — ★게시한 메시지가 없기 때문★.
  test("RunArtifact: started/succeeded/timed_out 을 구조화해서 남긴다 (게시 없어도 턴은 보인다)", async () => {
    const db = setup();
    const ok: CodexCaller = async () => ({ ok: true, reply: "동일", detail: "ok", elapsedMs: 7, sessionId: "sess" });
    await runTurn(db, agentsOf(db), codyOf(db), row({ message_id: "m1" }), "", ok);
    await runTurn(db, agentsOf(db), codyOf(db), row({ message_id: "m2" }), "", ok);
    const fail: CodexCaller = async () => ({ ok: false, reply: "", detail: "timeout after 1ms", elapsedMs: 1 });
    await runTurn(db, agentsOf(db), codyOf(db), row({ message_id: "m3" }), "", fail);

    expect(artifacts(db, "started").length).toBe(3);
    expect(artifacts(db, "succeeded").length).toBe(2);   // [A] 에선 1 + deduped 1 이었다
    expect(artifacts(db, "deduped").length).toBe(0);     // ★게시를 안 하므로 dedupe 상태가 생길 수 없다★
    expect(artifacts(db, "timed_out").length).toBe(1);   // 실패 분류(timeout)는 그대로 유지
    expect(artifacts(db, "timed_out")[0]?.detail).toContain("timeout");
    // ★[A] 회귀 가드★: 여기에 message id 가 박히면 = 서버가 그 팀원 이름으로 뭔가 게시했다는 뜻이다
    for (const a of artifacts(db, "succeeded")) {
      expect(
        a.reply_message_id,
        "★succeeded artifact 에 reply_message_id 가 있다 = 서버가 턴 본문을 게시했다★ ([A] 회귀)",
      ).toBeNull();
    }
    expect(allMessages(db)).toEqual([]);
  });

  test("inflight marker: runTurn 정상 종료 후 marker를 삭제한다", async () => {
    const db = setup();
    const fake: CodexCaller = async () => okResult("끝");
    await runTurn(db, agentsOf(db), codyOf(db), row(), "", fake);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM codex_inflight`).get() as { n: number };
    expect(count.n).toBe(0);
  });

  /**
   * ★hop 승계 — 무한 봇↔봇 루프의 마지막 방어선. [B] 에서도 유지된다.★
   * ★[A]★: 어댑터가 게시하던 ★답★ 이 hop 메타(max_hop)를 이어받아, acceptance smoke 가 답 뒤에 멈출 수 있었다.
   * ★[B]★: ★그 답이 없다★ (dex 가 직접 보내면 그 발신에 hop 이 실린다 — routes/inbox.ts 소관).
   *   서버가 여전히 ★자기 이름으로★ 내보내는 건 ★실패 공지★ 뿐이다 → ★hop 승계는 거기서 지켜져야 한다.★
   *   (공지가 hop 을 리셋하면 공지 → 재-wake → 또 공지 로 도는 문이 열린다)
   */
  test("★실패 공지가 hop 을 승계한다★ (hop_count+1 · in_reply_to) — 루프 차단선 유지", async () => {
    const db = setup();
    const fail: CodexCaller = async () => ({ ok: false, reply: "", detail: "boom", elapsedMs: 1 });
    await runTurn(
      db, agentsOf(db), codyOf(db),
      row({ from_agent_id: "user", message_id: "hop-1", hop_count: 2, max_hop: 6 }), "", fail,
    );
    const notice = repliesFrom(db, "system")[0];
    expect(notice?.hop_count).toBe(3);          // 2 + 1 — 홉을 리셋하지 않는다
    expect(notice?.in_reply_to).toBe("hop-1");  // 원 요청에 매달린다(체인 추적 가능)
  });

  test("★성공 턴은 hop 을 쓸 일이 없다★ — 게시하는 메시지가 아예 없기 때문 ([B])", async () => {
    const db = setup();
    const fake: CodexCaller = async () => okResult("ACK");
    await runTurn(db, agentsOf(db), codyOf(db), row({ max_hop: 1 }), "", fake);
    expect(allMessages(db)).toEqual([]);
  });
});
