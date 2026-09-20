/**
 * hermes 브리지 — 버스 스레드별 세션 이어가기 (`--resume`).
 *
 * 브리지는 턴마다 별개 프로세스를 띄운다. 이 시험은 진짜 hermes 없이 가짜 spawn 으로
 *   · 첫 턴엔 --resume 이 없고, usage-file 의 session_id 가 (팀원, 스레드) 에 저장되는가
 *   · 같은 스레드의 다음 턴엔 --resume <그 id> 가 붙는가 · 다른 스레드·다른 팀원엔 안 붙는가
 *   · hermes 가 "session not found" 로 거절하면 그 id 를 지우고 한 번만 새 세션으로 다시 도는가
 *   · 그 밖의 실패는 재시도하지 않는가
 * 를 잰다. 가짜 spawn 은 hermes 처럼 args 의 --usage-file 경로에 JSON 을 쓴다.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRecord } from "../types";
import { runHermesTeamTurn, __setHermesBridgeTestDeps } from "./hermesBridge";
import { getHermesSession, setHermesSession } from "./hermesSessionStore";

const ames: AgentRecord = {
  id: "ames", display_name: "Ames", role: "analyst", runtime: "hermes_agent",
  status_provider: "hermes_gateway", tmux_session: null,
  telegram_bot_username: "example_ames_bot", workspace_path: "/tmp",
  persona_file: "", moderator_eligible: true, avatar_emoji: "", hermes_profile: undefined,
};
const forin: AgentRecord = { ...ames, id: "forin", display_name: "Forin" };

interface Call { args: string[] }
interface Script {
  /** stdout 본문. */
  out?: string;
  /** exit code (기본 0). */
  code?: number;
  /** stderr 본문. */
  err?: string;
  /** usage-file 에 쓸 JSON. undefined 면 파일을 안 쓴다(best-effort 실패 흉내). */
  usage?: Record<string, unknown>;
}

let calls: Call[];
let scripts: Script[];
let dir: string;

function installFakeSpawn(): void {
  __setHermesBridgeTestDeps({
    spawn: ((_cmd: string, args: string[]) => {
      const script = scripts.shift();
      if (!script) throw new Error("가짜 spawn 에 남은 대본이 없다 — 예상보다 많이 띄웠다");
      calls.push({ args: [...args] });
      const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => {};
      const usagePath = args[args.indexOf("--usage-file") + 1]!;
      setTimeout(() => {
        if (script.usage) writeFileSync(usagePath, JSON.stringify(script.usage));
        if (script.out) proc.stdout.emit("data", Buffer.from(script.out));
        if (script.err) proc.stderr.emit("data", Buffer.from(script.err));
        proc.emit("close", script.code ?? 0);
      }, 5);
      return proc;
    }) as never,
  });
}

const resumeOf = (c: Call): string | null => {
  const i = c.args.indexOf("--resume");
  return i < 0 ? null : c.args[i + 1]!;
};
const turn = (agent: AgentRecord, threadId: string, messageId: string) =>
  runHermesTeamTurn({ agent, threadId, messageId, body: "질문", fromLabel: "bill", replyRoute: { kind: "teammate", to: "bill" } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hermes-sessions-"));
  process.env.HERMES_SESSIONS_DIR = dir;
  calls = [];
  scripts = [];
  installFakeSpawn();
});
afterEach(() => {
  __setHermesBridgeTestDeps();
  delete process.env.HERMES_SESSIONS_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("hermes 브리지 — 스레드별 세션 이어가기", () => {
  test("첫 턴: --resume 없이 띄우고, usage-file 의 session_id 를 (팀원, 스레드) 에 저장한다", async () => {
    scripts.push({ out: "첫 답", usage: { completed: true, session_id: "20260920_130000_aaaaaa" } });
    expect(await turn(ames, "t1", "m1")).toBe("첫 답");
    expect(calls).toHaveLength(1);
    expect(resumeOf(calls[0]!)).toBeNull();
    expect(calls[0]!.args.slice(0, 1)).toEqual(["-z"]);
    expect(getHermesSession("ames", "t1")).toBe("20260920_130000_aaaaaa");
    const file = JSON.parse(readFileSync(join(dir, "ames.json"), "utf8")) as Record<string, { session_id: string }>;
    expect(file.t1!.session_id).toBe("20260920_130000_aaaaaa");
  });

  test("같은 스레드의 다음 턴: --resume <저장된 id> 가 붙고, 새 id 로 갱신된다", async () => {
    scripts.push({ out: "첫 답", usage: { completed: true, session_id: "S1" } });
    scripts.push({ out: "둘째 답", usage: { completed: true, session_id: "S1" } });
    await turn(ames, "t1", "m1");
    expect(await turn(ames, "t1", "m2")).toBe("둘째 답");
    expect(resumeOf(calls[1]!)).toBe("S1");
    // --resume 는 -z <prompt> --usage-file <path> 뒤에 붙는다 (실측한 호출 모양)
    expect(calls[1]!.args.indexOf("--resume")).toBeGreaterThan(calls[1]!.args.indexOf("--usage-file"));
  });

  test("다른 스레드·다른 팀원에는 그 id 가 새지 않는다", async () => {
    scripts.push({ out: "a", usage: { completed: true, session_id: "S1" } });
    scripts.push({ out: "b", usage: { completed: true, session_id: "S2" } });
    scripts.push({ out: "c", usage: { completed: true, session_id: "S3" } });
    await turn(ames, "t1", "m1");
    await turn(ames, "t2", "m2"); // 같은 팀원, 다른 스레드
    await turn(forin, "t1", "m3"); // 다른 팀원, 같은 스레드 id
    expect(resumeOf(calls[1]!)).toBeNull();
    expect(resumeOf(calls[2]!)).toBeNull();
    expect(getHermesSession("ames", "t1")).toBe("S1");
    expect(getHermesSession("ames", "t2")).toBe("S2");
    expect(getHermesSession("forin", "t1")).toBe("S3");
  });

  test("hermes 가 세션을 모르면(session not found) 그 id 를 지우고 한 번만 새 세션으로 다시 돈다", async () => {
    setHermesSession("ames", "t1", "GONE");
    // 실측 모양(hermes 0.21.3): exit 1 · stderr "hermes -z: agent failed: session not found: GONE" · usage failed:true
    scripts.push({ code: 1, err: "hermes -z: agent failed: session not found: GONE\n",
      usage: { failed: true, failure: "session not found: GONE", session_id: null, completed: null } });
    scripts.push({ out: "새 세션 답", usage: { completed: true, session_id: "FRESH" } });
    expect(await turn(ames, "t1", "m1")).toBe("새 세션 답");
    expect(calls).toHaveLength(2);
    expect(resumeOf(calls[0]!)).toBe("GONE");
    expect(resumeOf(calls[1]!)).toBeNull();
    expect(getHermesSession("ames", "t1")).toBe("FRESH");
  });

  test("세션 없음 → 새 세션 재시도도 실패하면, 지운 id 는 지워진 채로 남는다 (다음 턴이 또 GONE 으로 안 돈다)", async () => {
    setHermesSession("ames", "t1", "GONE");
    scripts.push({ code: 1, err: "hermes -z: agent failed: session not found: GONE\n",
      usage: { failed: true, failure: "session not found: GONE", session_id: null } });
    scripts.push({ code: 1, err: "boom" });
    await expect(turn(ames, "t1", "m1")).rejects.toThrow(/hermes_exit_1:boom/);
    expect(calls).toHaveLength(2);
    expect(getHermesSession("ames", "t1")).toBeNull();
  });

  test("usage-file 이 안 쓰였어도 stderr 의 session not found 로 폴백한다", async () => {
    setHermesSession("ames", "t1", "GONE");
    scripts.push({ code: 1, err: "hermes -z: agent failed: session not found: GONE\n" });
    scripts.push({ out: "새 세션 답", usage: { completed: true, session_id: "FRESH" } });
    expect(await turn(ames, "t1", "m1")).toBe("새 세션 답");
    expect(calls).toHaveLength(2);
  });

  test("stderr 문구가 바뀌어도 usage-file 의 구조화 failure(session not found) 만으로 폴백한다 (1차 = 구조화 신호)", async () => {
    setHermesSession("ames", "t1", "GONE");
    scripts.push({ code: 1, err: "hermes -z: agent failed\n",
      usage: { failed: true, failure: "session not found: GONE", session_id: null } });
    scripts.push({ out: "새 세션 답", usage: { completed: true, session_id: "FRESH" } });
    expect(await turn(ames, "t1", "m1")).toBe("새 세션 답");
    expect(calls).toHaveLength(2);
  });

  test("resume 가 다른 이유로 실패하면 재시도하지 않고 그대로 실패한다 (턴 도중 이미 팬아웃했을 수 있다)", async () => {
    setHermesSession("ames", "t1", "S1");
    scripts.push({ out: "API call failed after 3 retries: HTTP 429: limit",
      usage: { completed: false, failed: true, failure: "HTTP 429", session_id: null } });
    await expect(turn(ames, "t1", "m1")).rejects.toThrow(/hermes_incomplete_turn/);
    expect(calls).toHaveLength(1);
    expect(getHermesSession("ames", "t1"), "다른 실패는 세션 기억을 지우지 않는다").toBe("S1");
  });

  test("저장된 id 가 없는데 실패하면 새 세션 재시도도 없다 (같은 조건으로 두 번 돌 이유가 없다)", async () => {
    scripts.push({ code: 1, err: "boom" });
    await expect(turn(ames, "t1", "m1")).rejects.toThrow(/hermes_exit_1/);
    expect(calls).toHaveLength(1);
  });

  test("usage-file 에 session_id 가 없으면 아무것도 저장하지 않는다 (판정 불가 = 기억 없음)", async () => {
    scripts.push({ out: "답" });
    expect(await turn(ames, "t1", "m1")).toBe("답");
    expect(getHermesSession("ames", "t1")).toBeNull();
  });
});
