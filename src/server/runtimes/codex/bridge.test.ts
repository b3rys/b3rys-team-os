// codex 브리지(M2) 테스트 — 채널 I/O 흐름(👀 리액션 → 작업중 → 두뇌 → 답 교체). mock 주입, 토큰/네트워크 X.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  handleMessage,
  resetChatThreads,
  DEFAULT_WORKING_TEXT,
  SCHEDULE_UNSUPPORTED_TEXT,
  writeBridgeReadyMarker,
  bridgeRuntimeConfigForAgent,
  parseAllowFrom,
  isAllowedChat,
  isOneShotScheduleRequest,
  buildDirectScheduleRequest,
  extractScheduleMarker,
  SCHEDULE_MARKER,
  type BridgeDeps,
} from "./bridge";
import type { CodexTurnResult } from "./runner";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grantKey } from "../../lib/permissionGate";

const ok = (reply: string, sessionId?: string): CodexTurnResult => ({ ok: true, reply, sessionId, detail: "ok", elapsedMs: 1 });

// 첫 접촉 영입인사 마커를 매 테스트 격리(라이브 var/first-contact 안 건드림 + 테스트 상호격리).
// 기본 = 빈 임시dir → 마커 없음 → 첫 접촉 인사가 기존처럼 동작. 마커 검증 테스트는 파일을 직접 만든다.
let prevFirstContactDir: string | undefined;
beforeEach(() => {
  prevFirstContactDir = process.env.B3OS_FIRST_CONTACT_DIR;
  process.env.B3OS_FIRST_CONTACT_DIR = mkdtempSync(join(tmpdir(), "b3os-fc-"));
});
afterEach(() => {
  if (prevFirstContactDir === undefined) delete process.env.B3OS_FIRST_CONTACT_DIR;
  else process.env.B3OS_FIRST_CONTACT_DIR = prevFirstContactDir;
});

function spies(turn: (p: string) => CodexTurnResult, opts: { editOk?: boolean } = {}) {
  const calls = {
    reacts: [] as { mid: number; emoji: string }[],
    sends: [] as string[],
    edits: [] as { mid: number; text: string }[],
    prompts: [] as { prompt: string; resume?: string; sandbox?: string; networkAccess?: boolean; writableRoots?: string[] }[],
  };
  let nextMid = 1000;
  const deps: BridgeDeps = {
    reactMessage: async (_c, mid, emoji) => { calls.reacts.push({ mid, emoji }); return true; },
    sendMessage: async (_c, text) => { calls.sends.push(text); return ++nextMid; },
    editMessage: async (_c, mid, text) => { calls.edits.push({ mid, text }); return opts.editOk ?? true; },
    sandbox: "read-only",
    runTurn: async (o) => {
      calls.prompts.push({
        prompt: o.prompt,
        resume: o.resumeSessionId,
        sandbox: o.sandbox,
        networkAccess: o.networkAccess,
        writableRoots: o.writableRoots,
      });
      return turn(o.prompt);
    },
  };
  return { deps, calls };
}

describe("codex bridge (M2) — 채널 I/O", () => {
  beforeEach(() => resetChatThreads());

  test("happy: 👀 리액션 → 작업중 발신 → 두뇌 → 작업중 메시지를 답으로 편집", async () => {
    const { deps, calls } = spies(() => ok("답입니다"));
    const r = await handleMessage(123, "안녕", 55, deps);
    expect(calls.reacts).toEqual([{ mid: 55, emoji: "👀" }]); // 접수 즉시 👀
    expect(calls.sends[0]).toBe(DEFAULT_WORKING_TEXT); // 작업중 메시지
    // 첫 접촉(영입인사 마커 없음)이라 인사+OT 지시가 prepend되고 원문 메시지 포함 (GD 2026-07-01)
    expect(calls.prompts[0]?.prompt).toContain("안녕"); // 원문 메시지 포함
    expect(calls.prompts[0]?.prompt).toContain("첫 응답"); // 첫 접촉 인사 지시 prepend
    expect(calls.edits[0]?.text).toBe("답입니다"); // 작업중 → 답 교체
    expect(r.ok).toBe(true);
    expect(r.detail).toBe("delivered");
  });

  // ─── 영입인사 = 영속 마커로 1회만 (GD 2026-07-10 버그픽스: 재시작마다 재소개하던 것) ───
  test("이미 합류한 팀원(마커 존재) → 세션 비어도 영입인사 prepend 안 함", async () => {
    const dir = process.env.B3OS_FIRST_CONTACT_DIR!;
    writeFileSync(join(dir, "devon.done"), "greeted\n"); // devon = 여태 한 번이라도 인사함
    const { deps, calls } = spies(() => ok("답입니다"));
    deps.agentId = "devon";
    const r = await handleMessage(777, "상태 보고", 55, deps);
    expect(calls.prompts[0]?.prompt).toContain("상태 보고"); // 원문 포함
    expect(calls.prompts[0]?.prompt).not.toContain("첫 응답"); // 영입인사 지시 없음
    expect(r.ok).toBe(true);
  });

  test("첫 인사 성공 → 마커 생성 → 재시작(세션 리셋) 후에도 재소개 안 함", async () => {
    const dir = process.env.B3OS_FIRST_CONTACT_DIR!;
    const { deps, calls } = spies(() => ok("답입니다"));
    deps.agentId = "devon";
    await handleMessage(777, "처음", 55, deps); // 첫 접촉 → 인사
    expect(calls.prompts[0]?.prompt).toContain("첫 응답");
    expect(existsSync(join(dir, "devon.done"))).toBe(true); // 마커 생성됨
    resetChatThreads(); // 서버 재시작 시뮬레이션(인메모리 세션 캐시 비움)
    await handleMessage(777, "두번째", 56, deps);
    expect(calls.prompts[1]?.prompt).not.toContain("첫 응답"); // 재시작해도 재소개 안 함
  });

  test("두뇌 실패 → 작업중 메시지를 에러문구로 교체", async () => {
    const { deps, calls } = spies(() => ({ ok: false, reply: "", detail: "exit_1", elapsedMs: 1 }));
    const r = await handleMessage(123, "x", 55, deps);
    expect(r.ok).toBe(false);
    expect(calls.edits[0]?.text).toContain("응답을 만들지 못했어요");
  });

  // ─── owner-gate shadow/enforcement (team-comm 3a, GD 2026-07-09, Codex 적대리뷰 대상) ───
  describe("owner-gate shadow/enforcement", () => {
    const PREV_S = process.env.CODEX_GROUP_NATIVE_DENY_SHADOW;
    const PREV_E = process.env.CODEX_GROUP_NATIVE_DENY;
    afterEach(() => {
      if (PREV_S === undefined) delete process.env.CODEX_GROUP_NATIVE_DENY_SHADOW; else process.env.CODEX_GROUP_NATIVE_DENY_SHADOW = PREV_S;
      if (PREV_E === undefined) delete process.env.CODEX_GROUP_NATIVE_DENY; else process.env.CODEX_GROUP_NATIVE_DENY = PREV_E;
    });
    const gate = (suppress: boolean) => { let n = 0; const fn = async () => { n++; return { suppress, reason: "explicit_mention", targets: ["bill"] }; }; return { fn, calls: () => n }; };

    test("flag off 기본 → ownerGate 미호출, 정상 delivered (라이브 영향 0)", async () => {
      delete process.env.CODEX_GROUP_NATIVE_DENY_SHADOW; delete process.env.CODEX_GROUP_NATIVE_DENY;
      const { deps, calls } = spies(() => ok("답")); const g = gate(true); deps.ownerGate = g.fn;
      const r = await handleMessage(-123, "x", 55, deps);
      expect(g.calls()).toBe(0); expect(calls.reacts.length).toBe(1); expect(r.detail).toBe("delivered");
    });
    test("shadow on + suppress + group → delivered 유지, react 계속(로그만)", async () => {
      process.env.CODEX_GROUP_NATIVE_DENY_SHADOW = "true"; delete process.env.CODEX_GROUP_NATIVE_DENY;
      const { deps, calls } = spies(() => ok("답")); deps.ownerGate = gate(true).fn;
      const r = await handleMessage(-123, "x", 55, deps);
      expect(calls.reacts.length).toBe(1); expect(r.detail).toBe("delivered");
    });
    test("enforcement on + group → drop(group_native_denied), ★gate 무관★, react 안 함", async () => {
      process.env.CODEX_GROUP_NATIVE_DENY = "true"; delete process.env.CODEX_GROUP_NATIVE_DENY_SHADOW;
      // Codex F1: 그룹은 owner여도(suppress=false) native drop(capture→bus가 처리) → 이중응답 방지.
      const { deps, calls } = spies(() => ok("답")); deps.ownerGate = gate(false).fn;
      const r = await handleMessage(-123, "x", 55, deps);
      expect(r.detail).toBe("group_native_denied"); expect(calls.reacts.length).toBe(0);
    });
    test("enforcement on + DM(chatId>0) → gate 미적용, DM 정상 통과", async () => {
      process.env.CODEX_GROUP_NATIVE_DENY = "true";
      const { deps, calls } = spies(() => ok("답")); deps.ownerGate = gate(true).fn;
      const r = await handleMessage(123, "x", 55, deps);
      expect(r.detail).toBe("delivered"); expect(calls.reacts.length).toBe(1);
    });
    test("shadow on + gate null(조회실패) → fail-open, 정상 delivered", async () => {
      process.env.CODEX_GROUP_NATIVE_DENY_SHADOW = "true";
      const { deps, calls } = spies(() => ok("답")); deps.ownerGate = async () => null;
      const r = await handleMessage(-123, "x", 55, deps);
      expect(r.detail).toBe("delivered"); expect(calls.reacts.length).toBe(1);
    });
  });

  test("편집 실패 → 신규 발신 fallback", async () => {
    const { deps, calls } = spies(() => ok("답"), { editOk: false });
    const r = await handleMessage(123, "x", 55, deps);
    expect(calls.edits.length).toBe(1); // 편집 시도
    expect(calls.sends).toContain("답"); // 실패 → 답을 신규 발신
    expect(r.ok).toBe(true);
  });

  test("resume: 같은 chat 두 번째 메시지는 이전 sessionId로 맥락 유지", async () => {
    const { deps, calls } = spies((p) => ok(`${p}-답`, "sess-1"));
    await handleMessage(123, "첫", 1, deps);
    await handleMessage(123, "둘", 2, deps);
    expect(calls.prompts[0]?.resume).toBeUndefined(); // 첫 턴 resume 없음
    expect(calls.prompts[1]?.resume).toBe("sess-1"); // 둘째 턴 이전 세션 resume
  });

  test("self-heal: 턴 실패 시 thread 초기화 → 다음 턴 resume 없음(죽은 세션 stuck 방지)", async () => {
    let n = 0;
    const { deps, calls } = spies(() => (++n === 1 ? ok("답", "sess-1") : { ok: false, reply: "", detail: "x", elapsedMs: 1 }));
    await handleMessage(1, "첫", 1, deps); // ok → sess-1 저장
    await handleMessage(1, "둘", 2, deps); // 실패 → thread 삭제
    await handleMessage(1, "셋", 3, deps); // 새 세션
    expect(calls.prompts[1]?.resume).toBe("sess-1"); // 둘째 턴은 첫 세션 resume 시도
    expect(calls.prompts[2]?.resume).toBeUndefined(); // 셋째 턴은 실패로 초기화돼 resume 없음
  });

  test("messageId 없으면 리액션 skip(그래도 작업중+답)", async () => {
    const { deps, calls } = spies(() => ok("답"));
    await handleMessage(123, "x", undefined, deps);
    expect(calls.reacts.length).toBe(0);
    expect(calls.edits[0]?.text).toBe("답");
  });

  test("sandbox/networkAccess deps를 Codex 턴까지 전달한다", async () => {
    const { deps, calls } = spies(() => ok("답"));
    await handleMessage(123, "파일 써줘", 55, {
      ...deps,
      agentId: "cody",
      workdir: "/tmp/cody",
      sandbox: "workspace-write",
      networkAccess: true,
      permissionContext: {
        grants: new Set([grantKey("cody", "workspace-write:/tmp/cody")]),
        networkAllowlist: ["*"],
      },
    });
    expect(calls.prompts[0]?.sandbox).toBe("workspace-write");
    expect(calls.prompts[0]?.networkAccess).toBe(true);
    expect(calls.prompts[0]?.writableRoots).toEqual(["/tmp/cody"]);
  });

  test("permission preflight blocks workspace-write before Codex turn", async () => {
    const { deps, calls } = spies(() => {
      throw new Error("runTurn must not be called when permission gate blocks");
    });
    const r = await handleMessage(123, "파일 써줘", 55, {
      ...deps,
      agentId: "cody",
      workdir: "/tmp/cody",
      sandbox: "workspace-write",
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("permission_ask:tier-a.workspace-write");
    expect(calls.prompts.length).toBe(0);
    expect(calls.edits[0]?.text).toContain("권한 게이트");
  });

  test("one-shot 예약 요청은 두뇌 턴으로 넘기지 않고 즉시 안내한다", async () => {
    const { deps, calls } = spies(() => {
      throw new Error("runTurn must not be called for one-shot schedule requests");
    });
    deps.scheduleToolEnabled = false; // env 격리(Codex F3): ambient CODEX_SCHEDULE_TOOL_ENABLED=true 여도 결정적.
    const r = await handleMessage(123, "5분 뒤에 나한테 메시지를 보내줘", 55, deps);
    expect(r.ok).toBe(true);
    expect(r.detail).toBe("schedule_unsupported");
    expect(calls.reacts).toEqual([{ mid: 55, emoji: "👀" }]);
    expect(calls.sends).toEqual([SCHEDULE_UNSUPPORTED_TEXT]);
    expect(calls.prompts.length).toBe(0);
    expect(calls.edits.length).toBe(0);
  });

  test("schedule tool enabled: LLM이 진짜 예약이라 판단해 SCHEDULE_MARKER를 내면 그때 등록한다", async () => {
    // 예약 등록은 ★LLM 판단★으로만 — 키워드 매치는 도구 안내(scheduleToolPrompt) 주입 힌트일 뿐, LLM이 marker를 내야 등록.
    let registered = false;
    const { deps, calls } = spies(() =>
      ok(`알겠습니다, 예약할게요.\n${SCHEDULE_MARKER} {"body":"5분 뒤 메시지","delay_seconds":300,"title":"reminder","direct_to_gd":true}`, "sess-1"),
    );
    const r = await handleMessage(123, "5분 뒤에 나한테 메시지를 보내줘", 55, {
      ...deps,
      scheduleToolEnabled: true,
      agentId: "dex",
      teamBaseUrl: "http://127.0.0.1:7878/team",
      registerScheduleReminder: async (req, ctx) => {
        registered = true;
        expect(ctx.agentId).toBe("dex");
        expect(req.delay_seconds).toBe(300);
        return "예약 등록 완료\n- job_id: sched_host";
      },
    });
    expect(r.ok).toBe(true);
    expect(calls.prompts.length).toBe(1); // ★LLM 턴이 실제로 실행됨(판단)★ — 옛 direct-register(턴 0)와 반대
    expect(calls.prompts[0]?.prompt).toContain("schedule_reminder"); // 도구 안내 주입 확인
    expect(registered).toBe(true); // LLM이 marker를 냈으므로 등록
    expect(r.reply).toContain("sched_host");
  });

  test("★GD 버그 회귀★: 예약처럼 보여도 LLM이 예약 아니라 판단(marker 없음)하면 등록하지 않는다", async () => {
    // 2026-07-05 실버그: "3분뒤 메시지가 안왔네"(불평/질문)가 키워드 매치로 자동 예약됨. 이제 LLM이 판단 → marker 없으면 등록 0.
    let registered = false;
    const { deps, calls } = spies(() => ok("아까 3분 전에 보낸 메시지가 도착 안 한 것 같네요 — 확인해볼게요.", "sess-1"));
    const r = await handleMessage(123, "3분뒤 메시지가 안왔네", 55, {
      ...deps,
      scheduleToolEnabled: true,
      agentId: "dex",
      teamBaseUrl: "http://127.0.0.1:7878/team",
      registerScheduleReminder: async () => {
        registered = true;
        return "등록됨";
      },
    });
    expect(r.ok).toBe(true);
    expect(calls.prompts.length).toBe(1); // LLM 턴 실행됨(판단함)
    expect(registered).toBe(false); // ★marker 없음 → 불평/질문 자동예약 방지★
    expect(r.reply).not.toContain("예약 등록");
  });

  test("extractScheduleMarker validates structured schedule requests", () => {
    expect(extractScheduleMarker(`${SCHEDULE_MARKER} {"body":"x","delay_seconds":60}`)).toEqual({
      body: "x",
      delay_seconds: 60,
      direct_to_gd: true,
    });
    expect(extractScheduleMarker(`${SCHEDULE_MARKER} {"body":"x","delay_seconds":60,"run_at":"2026-07-04T00:00:00Z"}`)).toBeNull();
    expect(extractScheduleMarker(`${SCHEDULE_MARKER} {"body":"x"}`)).toBeNull();
    expect(extractScheduleMarker("예약 등록 완료")).toBeNull();
  });

  test("direct schedule parser: 상대시간을 CLI 요청값으로 만든다", () => {
    expect(buildDirectScheduleRequest("60초 뒤 알려줘")).toMatchObject({
      body: "[예약 알림] 60초 뒤 알려줘",
      delay_seconds: 60,
      direct_to_gd: true,
    });
    expect(buildDirectScheduleRequest("remind me in 2 minutes")).toMatchObject({
      delay_seconds: 120,
    });
    expect(buildDirectScheduleRequest("내일 오전 9시에 알려줘")).toBeNull();
  });

  test("one-shot 예약 판정은 시간 표현과 알림 행동이 모두 필요하다", () => {
    expect(isOneShotScheduleRequest("5분 뒤에 메시지 보내줘")).toBe(true);
    expect(isOneShotScheduleRequest("remind me in 5 minutes")).toBe(true);
    expect(isOneShotScheduleRequest("내일 오전 9시에 알려줘")).toBe(true);
    expect(isOneShotScheduleRequest("5분 뒤쯤 어떻게 되는지 설명해줘")).toBe(false);
    expect(isOneShotScheduleRequest("메시지 보내는 방법 알려줘")).toBe(false);
  });

  test("ready marker writer: pid 파일을 원자적으로 생성", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-bridge-ready-"));
    const pidFile = join(dir, "cody.pid");
    expect(writeBridgeReadyMarker(pidFile, 4242, "cody")).toBe(true);
    expect(existsSync(pidFile)).toBe(true);
    const marker = JSON.parse(readFileSync(pidFile, "utf-8"));
    expect(marker.pid).toBe(4242);
    expect(marker.agentId).toBe("cody");
    expect(typeof marker.readyAt).toBe("string");
  });

  test("agent registry에서 bridge sandbox/networkAccess를 읽는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-bridge-registry-"));
    const registry = join(dir, "agents.json");
    writeFileSync(
      registry,
      JSON.stringify([
        {
          id: "dex",
          display_name: "Dex",
          role: "Step Engineer",
          runtime: "codex",
          status_provider: "codex_cli",
          telegram_bot_username: null,
          workspace_path: "/tmp/dex",
          persona_file: "/tmp/dex/SOUL.md",
          moderator_eligible: false,
          avatar_emoji: "🤖",
          codex_sandbox: "workspace-write",
          codex_network_access: true,
        },
      ]),
      "utf-8",
    );
    expect(bridgeRuntimeConfigForAgent({ agentId: "dex", registryPath: registry })).toEqual({
      sandbox: "workspace-write",
      networkAccess: true,
    });
  });
});

describe("발신자 게이트(allowlist) — parseAllowFrom + 통과 판정", () => {
  test("comma-sep chat_id 파싱(공백 무시, 비숫자 제거)", () => {
    const s = parseAllowFrom(" 1000000001, -2000000000001 , abc, ");
    expect(s.has(1000000001)).toBe(true);
    expect(s.has(-2000000000001)).toBe(true);
    expect(s.size).toBe(2); // abc·빈값 제거
  });

  test("미설정/빈값 → 빈 Set 이고 gate 는 fail-closed", () => {
    // 빈 Set = 시드 안 됨. 브리지 루프는 size===0 이면 전체 차단한다.
    expect(parseAllowFrom(undefined).size).toBe(0);
    expect(parseAllowFrom("").size).toBe(0);
    expect(parseAllowFrom("  ").size).toBe(0);
    expect(isAllowedChat(parseAllowFrom(undefined), 1000000001)).toBe(false);
  });

  test("게이트 판정: 설정 시 미포함 차단·포함 통과 (브리지 루프 로직 미러)", () => {
    const allow = parseAllowFrom("1000000001");
    expect(isAllowedChat(allow, 999999)).toBe(false); // 낯선 발신자 = 차단
    expect(isAllowedChat(allow, 1000000001)).toBe(true); // 오너 = 통과
  });
});
