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
  tgSend,
  tgEdit,
  isTurnRunningFor,
  buildDmSteerText,
  noAutopostDeps,
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
    // 첫 접촉(영입인사 마커 없음)이라 인사+OT 지시가 prepend되고 원문 메시지 포함
    expect(calls.prompts[0]?.prompt).toContain("안녕"); // 원문 메시지 포함
    expect(calls.prompts[0]?.prompt).toContain("첫 응답"); // 첫 접촉 인사 지시 prepend
    expect(calls.edits[0]?.text).toBe("답입니다"); // 작업중 → 답 교체
    expect(r.ok).toBe(true);
    expect(r.detail).toBe("delivered");
  });

  // ─── 영입인사 = 영속 마커로 1회만 ───
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

  // ─── owner-gate shadow/enforcement (team-comm 3a, Codex 적대리뷰 대상) ───
  describe("owner-gate shadow/enforcement", () => {
    const PREV_S = process.env.CODEX_GROUP_NATIVE_DENY_SHADOW;
    const PREV_E = process.env.CODEX_GROUP_NATIVE_DENY;
    afterEach(() => {
      if (PREV_S === undefined) delete process.env.CODEX_GROUP_NATIVE_DENY_SHADOW; else process.env.CODEX_GROUP_NATIVE_DENY_SHADOW = PREV_S;
      if (PREV_E === undefined) delete process.env.CODEX_GROUP_NATIVE_DENY; else process.env.CODEX_GROUP_NATIVE_DENY = PREV_E;
    });
    const gate = (suppress: boolean) => { let n = 0; const fn = async () => { n++; return { suppress, reason: "explicit_mention", targets: ["bill"] }; }; return { fn, calls: () => n }; };

    // ★차단은 '폴링 입구' 의 것이다★ — 그 입구엔 오너 판정이 없어 남을 부른 메시지에도 답했다.
    //   창구(window)로 들어온 것은 서버(capture)가 오너를 정한 뒤 넣은 것이라 그 차단을 지나지 않는다.
    test("★창구 입구는 차단을 지나지 않는다★ — 미설정(차단 켜짐)이어도 그룹 턴이 돈다", async () => {
      delete process.env.CODEX_GROUP_NATIVE_DENY_SHADOW; delete process.env.CODEX_GROUP_NATIVE_DENY;
      const { deps, calls } = spies(() => ok("답")); const g = gate(false); deps.ownerGate = g.fn;
      const r = await handleMessage(-123, "x", 55, deps, undefined, "window");
      expect(r.detail).toBe("delivered");
      expect(g.calls()).toBe(0); // 브리지는 오너 판정을 하지 않는다 — capture 가 이미 했다
      expect(calls.reacts.length).toBe(1);
    });

    test("★같은 메시지라도 폴링 입구면 여전히 막힌다★ (기본값이 우회 수단이 되면 안 된다)", async () => {
      delete process.env.CODEX_GROUP_NATIVE_DENY_SHADOW; delete process.env.CODEX_GROUP_NATIVE_DENY;
      const { deps, calls } = spies(() => ok("답")); deps.ownerGate = gate(false).fn;
      const r = await handleMessage(-123, "x", 55, deps, undefined, "poll");
      expect(r.detail).toBe("group_native_denied");
      expect(calls.reacts.length).toBe(0);
    });

    test("★미설정 = 켜짐★ → 그룹은 drop(group_native_denied), react 안 함", async () => {
      delete process.env.CODEX_GROUP_NATIVE_DENY_SHADOW; delete process.env.CODEX_GROUP_NATIVE_DENY;
      const { deps, calls } = spies(() => ok("답")); deps.ownerGate = gate(false).fn;
      const r = await handleMessage(-123, "x", 55, deps);
      expect(r.detail).toBe("group_native_denied"); expect(calls.reacts.length).toBe(0);
    });
    test("★명시적 \"false\" 만 끈다★ → 그룹 native 통과, ownerGate 미호출", async () => {
      process.env.CODEX_GROUP_NATIVE_DENY = "false"; delete process.env.CODEX_GROUP_NATIVE_DENY_SHADOW;
      const { deps, calls } = spies(() => ok("답")); const g = gate(true); deps.ownerGate = g.fn;
      const r = await handleMessage(-123, "x", 55, deps);
      expect(g.calls()).toBe(0); expect(calls.reacts.length).toBe(1); expect(r.detail).toBe("delivered");
    });
    test("미설정이어도 ★DM(chatId>0) 은 영향 없다★", async () => {
      delete process.env.CODEX_GROUP_NATIVE_DENY_SHADOW; delete process.env.CODEX_GROUP_NATIVE_DENY;
      const { deps, calls } = spies(() => ok("답")); deps.ownerGate = gate(true).fn;
      const r = await handleMessage(123, "x", 55, deps);
      expect(r.detail).toBe("delivered"); expect(calls.reacts.length).toBe(1);
    });
    test("shadow on + suppress + group → delivered 유지, react 계속(로그만)", async () => {
      process.env.CODEX_GROUP_NATIVE_DENY_SHADOW = "true"; process.env.CODEX_GROUP_NATIVE_DENY = "false";
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
      process.env.CODEX_GROUP_NATIVE_DENY_SHADOW = "true"; process.env.CODEX_GROUP_NATIVE_DENY = "false";
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

  // ★계약이 바뀌었다★ (다른 런타임과의 일관성).
  //   예전 이름: "permission preflight blocks workspace-write before Codex turn" —
  //   grant 없이 workspace-write 면 브리지가 턴을 안 돌리고 "⚠️ 권한 게이트가 …막았습니다" 로 답했다.
  //   우리 코드로 차단목록을 얹은 런타임이 codex 뿐이라 판정을 뺐다. 경계는 codex 설정이 정한다.
  test("★grant 없이도 workspace-write 턴은 그대로 돈다★ — 브리지 앞 우리 판정을 뺐다", async () => {
    const { deps, calls } = spies(() => ok("답입니다"));
    const r = await handleMessage(123, "파일 써줘", 55, {
      ...deps,
      agentId: "cody",
      workdir: "/tmp/cody",
      sandbox: "workspace-write",
      // ★permissionContext(설정-grant)를 일부러 안 준다★ — 예전엔 이것 때문에 매 턴 막혔다.
      //   바로 위 시험(grant 를 주는 경우)과 이제 ★결과가 같아야 한다★ = 통과 여부가 grant 에 안 달렸다.
    });
    expect(r.ok).toBe(true);        // 예전 false
    expect(r.detail).toBe("delivered"); // 예전 permission_ask:tier-a.workspace-write
    expect(calls.prompts.length, "★브리지 앞 차단이 되살아났다★ — 두뇌 턴이 안 돌았다").toBe(1);
    expect(calls.prompts[0]?.sandbox).toBe("workspace-write"); // 샌드박스 값은 그대로 codex 로 간다
    expect(calls.edits[0]?.text).toBe("답입니다");
    expect(calls.edits.some((e) => e.text.includes("권한 게이트"))).toBe(false);
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

// ── ★승인 버튼은 그 팀원 방에서 처리한다★ ──
//
// 서버가 이 봇으로 승인창을 띄우고, 누르는 것은 브리지가 받는다
// (getUpdates 는 봇당 한 프로세스만 가능하므로 폴링하는 쪽이 콜백을 맡는다).
// ★누른 뒤 answerCallbackQuery 를 반드시 보내야 한다★ — 안 보내면 텔레그램이 계속 '로딩중' 을 돌린다
// (실제로 그 증상이 났다: "눌러도 로딩중 뜨고 반응도 없어").

import { createSerialTurnQueue } from "./serialTurnQueue";
import { handleApprovalCallback } from "./bridge";
import { Database as CbDb } from "bun:sqlite";
import { migrate as cbMigrate } from "../../db/migrate";
import { requestPermission as cbRequest, getPermissionRequest as cbGet } from "../../lib/permissionGate";

import { tmpdir as cbTmpdir } from "node:os";
import { join as cbJoin } from "node:path";

const OWNER = 111111111; // 승인자 chat id (픽스처 — 실제 값과 무관)

function pendingRequest(): { dbPath: string; id: string } {
  const dbPath = cbJoin(mkdtempSync(cbJoin(cbTmpdir(), "cb-")), "team.db");
  const db = new CbDb(dbPath);
  cbMigrate(db);
  const res = cbRequest(db, {
    agent: { id: "dex", workspace_path: "/tmp/ws" },
    runtime: "codex", action: "shell", command: "echo hi", cwd: "/tmp/ws",
  } as never);
  const id = res.request!.id;
  db.close();
  return { dbPath, id };
}

const spyFetch = (calls: string[]) =>
  (async (url: string) => { calls.push(String(url).split("/bot")[1]!.split("?")[0]!); return { ok: true } as Response; }) as unknown as typeof fetch;

test("★누르면 결정이 기록되고 답을 보낸다★ — 답이 없으면 텔레그램은 계속 로딩중이다", async () => {
  const { dbPath, id } = pendingRequest();
  const calls: string[] = [];
  const out = await handleApprovalCallback("T", { id: "c1", data: `pg1:${id}`, from: { id: OWNER }, message: { message_id: 1, chat: { id: OWNER } } }, new Set([OWNER]), { dbPath, fetchFn: spyFetch(calls) });
  expect(out).toBe("decided");
  expect(calls).toContain("T/answerCallbackQuery"); // ★이게 없으면 로딩중이 안 멈춘다★
  const db = new CbDb(dbPath);
  expect(cbGet(db, id)?.status).toBe("allowed_once");
  db.close();
});

test("거절 버튼은 거절로 기록된다(세 버튼이 같은 결과면 버튼이 장식이다)", async () => {
  const { dbPath, id } = pendingRequest();
  await handleApprovalCallback("T", { id: "c2", data: `pgd:${id}`, from: { id: OWNER } }, new Set([OWNER]), { dbPath, fetchFn: spyFetch([]) });
  const db = new CbDb(dbPath);
  expect(cbGet(db, id)?.status).toBe("denied");
  db.close();
});

test("★이미 처리된 요청은 지난 대로 알린다★ — 무반응이면 사람은 다시 누른다", async () => {
  const { dbPath, id } = pendingRequest();
  const calls: string[] = [];
  await handleApprovalCallback("T", { id: "c3", data: `pg1:${id}`, from: { id: OWNER } }, new Set([OWNER]), { dbPath, fetchFn: spyFetch([]) });
  const out = await handleApprovalCallback("T", { id: "c4", data: `pg1:${id}`, from: { id: OWNER }, message: { message_id: 1, chat: { id: OWNER } } }, new Set([OWNER]), { dbPath, fetchFn: spyFetch(calls) });
  expect(out).toBe("stale");
  expect(calls).toContain("T/answerCallbackQuery");
  expect(calls).toContain("T/editMessageReplyMarkup"); // 버튼을 지워서 또 누르지 않게
});

test("허용 목록 밖 발신자는 결정하지 못한다(fail-closed)", async () => {
  const { dbPath, id } = pendingRequest();
  const out = await handleApprovalCallback("T", { id: "c5", data: `pg1:${id}`, from: { id: 999 } }, new Set([OWNER]), { dbPath, fetchFn: spyFetch([]) });
  expect(out).toBe("unauthorized");
  const db = new CbDb(dbPath);
  expect(cbGet(db, id)?.status).toBe("pending"); // 상태가 바뀌면 안 된다
  db.close();
});

test("승인과 무관한 콜백은 건드리지 않는다", async () => {
  const { dbPath } = pendingRequest();
  expect(await handleApprovalCallback("T", { id: "c6", data: "mcp:on", from: { id: OWNER } }, new Set([OWNER]), { dbPath, fetchFn: spyFetch([]) })).toBe("ignored");
});

// ── ★team.db 경로는 환경변수에 기대지 않는다★ (2026-08-12) ──
//
// 승인 버튼이 죽은 진짜 원인이었다: `B3OS_REPO_ROOT ?? "."` 로 잡았는데 ★브리지에는 그 변수가 없다★
// (실측: 브리지 프로세스 env 에 CODEX_WORKDIR 만 있고 B3OS_REPO_ROOT 없음).
// 그래서 cwd(팀원 작업폴더)의 team.db 를 찾아 "unable to open database file" 로 매번 던졌고,
// ★답을 못 보내서 사람 화면엔 로딩중만 돌았다.★

import { defaultTeamDbPath } from "./bridge";
import { existsSync as pathExists } from "node:fs";
import { isAbsolute, dirname, join as joinPath } from "node:path";

test("★cwd·환경변수와 무관하게 저장소의 team.db 를 가리킨다★", () => {
  const before = process.cwd();
  const saved = process.env.B3OS_REPO_ROOT;
  try {
    delete process.env.B3OS_REPO_ROOT; // ★없는 게 실제 브리지 환경이다★
    process.chdir("/tmp");             // 팀원 작업폴더에서 도는 상황을 흉내
    const p = defaultTeamDbPath();
    expect(isAbsolute(p)).toBe(true);
    expect(p.endsWith("/team.db")).toBe(true);
    expect(p.startsWith("/tmp/")).toBe(false); // cwd 를 따라가면 안 된다
    // ★가리키는 폴더가 실제 저장소 루트여야 한다.★
    //   전에는 team.db 자체의 존재를 봤는데, 그 파일은 ★git 이 추적하지 않는다★ —
    //   worktree·새 클론·CI 에는 없어서 시험이 브랜치와 무관하게 빨간불이 났다(2026-08-18 실측).
    //   추적되는 파일로 같은 것을 잰다: 경로가 엉뚱하면 여기서 걸린다.
    expect(pathExists(joinPath(dirname(p), "package.json"))).toBe(true);
  } finally {
    process.chdir(before);
    if (saved !== undefined) process.env.B3OS_REPO_ROOT = saved;
  }
});

// ★브리지도 app-server 로 간다★
//
// 전에는 브리지만 옛 exec 경로였다 — ★사람이 직접 말 거는 길★ 에만 그때까지의 개선이
// 하나도 안 붙어 있었다(중간 개입·상주·서브에이전트 생존·승인창은 전부 버스 경로에만).
import { defaultBridgeCaller } from "./bridge";

test("★app-server 하나뿐이다★ — 플래그로 갈라두면 한쪽만 좋아지고 다른 쪽은 조용히 뒤처진다", () => {
  // 폴백은 ★말은 통하지만 기능이 사라진 상태★ 이고, 조용해서 아무도 모른다.
  const saved = process.env.B3OS_CODEX_APPSERVER;
  try {
    delete process.env.B3OS_CODEX_APPSERVER; // 플래그가 없어도 app-server 로 간다
    expect(typeof defaultBridgeCaller()).toBe("function");
  } finally {
    if (saved !== undefined) process.env.B3OS_CODEX_APPSERVER = saved;
  }
});

// ── ★진행 표시 배선★ ──
//
// 순수 로직(줄 접기·길이·넘김)은 progressLines.test.ts 가 잰다.
// 여기서 재는 것은 ★배선★ 이다 — 브리지가 진행 이벤트를 실제로 받는가, 그 줄이 어느 메시지에
// 쓰이는가, 답이 어디로 가는가. 실제로 끊겨 있던 곳이 로직이 아니라 이 배선이었다.
describe("codex bridge — 진행 표시", () => {
  beforeEach(() => resetChatThreads());

  /** onActivity 를 실제로 부르는 두뇌 mock. */
  function spiesWithActivity(lines: string[], reply = "다 했습니다") {
    const calls = {
      sends: [] as string[],
      edits: [] as { mid: number; text: string }[],
      gotOnActivity: false,
    };
    let nextMid = 2000;
    const deps: BridgeDeps = {
      reactMessage: async () => true,
      sendMessage: async (_c, text) => { calls.sends.push(text); return ++nextMid; },
      editMessage: async (_c, mid, text) => { calls.edits.push({ mid, text }); return true; },
      sandbox: "read-only",
      runTurn: async (o) => {
        calls.gotOnActivity = typeof (o as { onActivity?: unknown }).onActivity === "function";
        for (const l of lines) (o as { onActivity?: (s: string) => void }).onActivity?.(l);
        // 편집은 배치(EDIT_MIN_INTERVAL_MS)라 턴이 끝나기 전에 한 번은 나가야 관측된다.
        await new Promise((r) => setTimeout(r, 1700));
        return { ok: true, reply, sessionId: "s1", detail: "ok", elapsedMs: 1 };
      },
    };
    return { deps, calls };
  }

  test("★브리지가 진행 통로를 넘긴다★ — 이 배선이 없어서 화면에 문구 하나만 남았다", async () => {
    const { deps, calls } = spiesWithActivity(["git status"]);
    await handleMessage(11, "확인해줘", 1, deps);
    expect(calls.gotOnActivity).toBe(true);
  });

  test("★받은 줄이 작업중 메시지에 실제로 쓰인다★", async () => {
    const { deps, calls } = spiesWithActivity(["git status --short", "bun test"]);
    await handleMessage(12, "확인해줘", 1, deps);
    const withLines = calls.edits.filter((e) => e.text.includes("🛠️"));
    expect(withLines.length).toBeGreaterThan(0);
    expect(withLines[withLines.length - 1]!.text).toContain("bun test");
  });

  test("★대조군 — 진행 줄이 없으면 진행 편집도 없다★ (기존 동작 그대로)", async () => {
    const { deps, calls } = spiesWithActivity([]);
    await handleMessage(13, "안녕", 1, deps);
    expect(calls.edits.filter((e) => e.text.includes("🛠️")).length).toBe(0);
  });

  /**
   * ★진행 버블도 MarkdownV2 로 나간다 — 그러면 이스케이프해서 보내야 한다.★
   *
   * 라이브: 버블 텍스트가 ★순수 텍스트 그대로★ parse_mode=MarkdownV2 로 나갔다. 그래서 `-`·`.` 이 있는 줄마다
   * 텔레그램이 400 을 냈고(`dex.log` ★156건★), 매번 평문으로 재전송해 ★같은 편집을 두 번씩★ 했다.
   * 화면은 멀쩡했지만 호출이 2배였고 로그가 그 실패로 덮였다. ★최종 답은 이미 변환을 타고 있었다 — 버블만 빠졌다.★
   */
  test("★진행 줄의 예약문자를 이스케이프해서 보낸다★ (안 하면 매번 400 → 재전송으로 호출 2배)", async () => {
    const { deps, calls } = spiesWithActivity(["a-b 파일 확인", "설정.값 갱신"]);
    await handleMessage(15, "해줘", 1, deps);

    const bubbles = calls.edits.filter((e) => e.text.includes("🛠️")).map((e) => e.text);
    expect(bubbles.length, "진행 편집이 한 번은 나가야 관측된다").toBeGreaterThan(0);
    const last = bubbles[bubbles.length - 1]!;
    expect(last, "★하이픈이 그대로 나가면 텔레그램이 400 을 낸다★").toContain("a\\-b");
    expect(last, "★마침표도 예약문자다★").toContain("설정\\.값");
  });

  test("★마지막 편집은 답이다★ — 진행 줄이 답을 덮어쓰지 않는다", async () => {
    const { deps, calls } = spiesWithActivity(["read a.ts", "read b.ts"], "정리했습니다");
    await handleMessage(14, "해줘", 1, deps);
    const last = calls.edits[calls.edits.length - 1]!;
    expect(last.text).toBe("정리했습니다");
  });
  /**
   * 경합을 실제로 만드는 mock.
   *   · lines: [지연ms, 문구] — 그 시각에 진행 줄을 흘린다
   *   · editDelays: 편집 호출별 지연(부족하면 0). ★첫 편집만 느리게★ 해야 답과 순서가 뒤집힌다
   *   · turnMs: 턴이 끝나는 시각
   */
  function spiesRace(opts: {
    lines: [number, string][];
    editDelays: number[];
    reply: string;
    turnMs: number;
  }) {
    const calls = { sends: [] as string[], edits: [] as { text: string; doneAt: number }[] };
    let nextMid = 3000;
    let editN = 0;
    const t0 = Date.now();
    const deps: BridgeDeps = {
      reactMessage: async () => true,
      sendMessage: async (_c, text) => { calls.sends.push(text); return ++nextMid; },
      editMessage: async (_c, _mid, text) => {
        const d = opts.editDelays[editN++] ?? 0;
        if (d > 0) await new Promise((r) => setTimeout(r, d));
        calls.edits.push({ text, doneAt: Date.now() - t0 });
        return true;
      },
      sandbox: "read-only",
      runTurn: async (o) => {
        const onAct = (o as { onActivity?: (s: string) => void }).onActivity;
        for (const [at, text] of opts.lines) setTimeout(() => onAct?.(text), at);
        await new Promise((r) => setTimeout(r, opts.turnMs));
        return { ok: true, reply: opts.reply, sessionId: "s1", detail: "ok", elapsedMs: 1 };
      },
    };
    return { deps, calls };
  }

  // ★첫 편집은 즉시 나간다★(lastEditAt 초기값 0) — 이후만 EDIT_MIN_INTERVAL_MS 간격으로 묶인다.
  //   그래서 경합을 만들려면 ★첫 편집을 길게★ 잡아야 한다. 아래 두 시험의 시간 값은 그 실측에서 나왔다.

  test("★편집 중에 들어온 마지막 줄도 화면에 나간다★ — 재예약이 없으면 그 줄은 영영 안 보인다", async () => {
    // 첫 줄 t=0 → 편집 즉시 시작, 3000ms 걸린다.
    // 둘째 줄 t=100 → 예약된 flush 가 t≈1500 에 뜨는데 ★그때 편집이 아직 돈다★ → 조용히 되돌아간다.
    // 타이머는 이미 소진됐고 뒤에 줄이 더 없으므로, 재예약이 없으면 둘째 줄은 화면에 못 간다.
    const { deps, calls } = spiesRace({
      lines: [[0, "첫 명령"], [100, "둘째 명령"]],
      editDelays: [3000],
      reply: "끝",
      turnMs: 4200,
    });
    await handleMessage(21, "해줘", 1, deps);
    const progress = calls.edits.filter((e) => e.text.includes("🛠️"));
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]!.text).toContain("둘째 명령");
  });

  test("★날아간 편집이 답을 덮지 않는다★ — 마지막 편집은 언제나 답이다", async () => {
    // 진행 편집이 t≈0 에 시작해 2000ms 걸리는데 턴은 t=500 에 끝난다
    // = 답을 쓰려는 순간 ★진행 편집이 아직 날아가 있다.★ 기다리지 않으면 답이 먼저 찍히고
    //   늦게 끝난 진행 줄이 그 위를 덮는다.
    const { deps, calls } = spiesRace({
      lines: [[0, "느린 명령"]],
      editDelays: [2000],
      reply: "최종 답변",
      turnMs: 500,
    });
    await handleMessage(22, "해줘", 1, deps);
    expect(calls.edits.length).toBeGreaterThan(1);
    expect(calls.edits[calls.edits.length - 1]!.text).toBe("최종 답변");
  });
});

// ── ★턴이 도는 도중에 눌러도 처리되는가★ ──
//
// 이것이 #334 가 고친 것의 핵심이다. 예전에는 폴링 루프가 턴을 인라인으로 기다려서
// 버튼 입력을 제때 가져오지 못했고, 승인 요청은 codex 로 전달되지 못한 채 만료됐다
// (실측: 2026-08-13 11:35 ~ 08-18 11:18 구간 8건 전부 expired · 그중 6건이 300~302초.
//  사람이 누른 기록은 6건 있었으나 codex 로 전달된 건은 0건 — state != 'delivered' 기준).
//
// ★라이브 증거★: 고친 뒤 prm_93e07c50a14b4eb989 이 생성 7초 만에 delivered 됐다
// (2026-08-18 12:29 · approver=GD). 그 구간 이후 첫 전달이다.
//
// ★여기서 재는 것★: 턴이 아직 도는 중에 콜백이 들어오면 그 자리에서 처리되고 DB 가 실제로 바뀐다.
// ★여기서 재지 않는 것★: 폴링 루프가 그 콜백을 실제로 가져오는지. 루프는 무한 루프라 단위 시험으로
//   돌릴 수 없다 — 그 부분은 라이브 로그로 확인했다(턴의 답이 나가기 전에 다음 메시지가 수신됨).
test("★턴이 도는 도중에 눌러도 그 자리에서 처리된다★ — 이게 안 되면 승인은 300초 뒤 만료된다", async () => {
  const { dbPath, id } = pendingRequest();
  const turns = createSerialTurnQueue();

  let turnFinished = false;
  turns.enqueue(async () => {
    await new Promise((r) => setTimeout(r, 800)); // 도는 중인 턴
    turnFinished = true;
  });

  // ★턴이 끝나기 전에★ 버튼이 눌린 상황.
  const out = await handleApprovalCallback(
    "T",
    { id: "cb-mid", data: `pg1:${id}`, from: { id: OWNER }, message: { message_id: 7, chat: { id: OWNER } } },
    new Set([OWNER]),
    { dbPath, fetchFn: spyFetch([]) },
  );

  expect(turnFinished).toBe(false); // 아직 턴은 돌고 있다
  expect(out).not.toBe("unauthorized");
  expect(out).not.toBe("stale");

  const db = new CbDb(dbPath);
  const row = db.prepare("SELECT status FROM permission_request WHERE id = ?").get(id) as { status: string };
  db.close();
  expect(row.status).not.toBe("pending"); // ★턴이 도는 동안 실제로 결정됐다★

  await turns.drain();
  expect(turnFinished).toBe(true);
});

test("★대조군 — 대기열이 콜백 처리를 늦추지 않는다★ (턴을 기다렸다면 이 시간이 턴 길이만큼 늘어난다)", async () => {
  const { dbPath, id } = pendingRequest();
  const turns = createSerialTurnQueue();
  turns.enqueue(async () => { await new Promise((r) => setTimeout(r, 1500)); });

  const t0 = Date.now();
  await handleApprovalCallback(
    "T",
    { id: "cb-fast", data: `pg1:${id}`, from: { id: OWNER } },
    new Set([OWNER]),
    { dbPath, fetchFn: spyFetch([]) },
  );
  const elapsed = Date.now() - t0;
  expect(elapsed).toBeLessThan(1000); // 턴(1500ms)을 기다리지 않았다
  await turns.drain();
});

// ── ★재시작 넘어 맥락이 이어지는가 (배선)★ ──
//
// 순수 저장 로직은 dmSessionStore.test.ts 가 잰다. 여기서는 ★브리지가 그것을 실제로 쓰는지★ 를 잰다 —
// 실제로 끊겨 있던 곳이 저장소가 아니라 배선이었다(브리지가 codex_session_map 을 참조하지 않았다).
describe("codex bridge — 1:1 세션 재시작 연속성", () => {
  beforeEach(() => resetChatThreads());

  /** 인메모리 지도가 빈 상태 = 방금 재시작한 상황. */
  function spiesWithSessions(store: { get: (c: number) => string | undefined; save: (c: number, s: string) => void; clear: (c: number) => void }) {
    const seen: { resume?: string }[] = [];
    const deps: BridgeDeps = {
      reactMessage: async () => true,
      sendMessage: async () => 900,
      editMessage: async () => true,
      sandbox: "read-only",
      dmSessions: store,
      runTurn: async (o) => {
        seen.push({ resume: o.resumeSessionId });
        return { ok: true, reply: "답", sessionId: "sess-new", detail: "ok", elapsedMs: 1 };
      },
    };
    return { deps, seen };
  }

  test("★재시작 후에도 지난 세션으로 이어간다★ — 이 배선이 없으면 매 재시작마다 첫 대화가 된다", async () => {
    const saved = new Map<number, string>([[42, "sess-before-restart"]]);
    const { deps, seen } = spiesWithSessions({
      get: (c) => saved.get(c),
      save: (c, s) => { saved.set(c, s); },
      clear: (c) => { saved.delete(c); },
    });
    await handleMessage(42, "이어서 하자", 1, deps);
    expect(seen[0]!.resume).toBe("sess-before-restart");
  });

  test("★대조군 — 기억하는 곳이 없으면 새 대화로 시작한다★ (고치기 전 동작)", async () => {
    const { deps, seen } = spiesWithSessions({ get: () => undefined, save: () => {}, clear: () => {} });
    await handleMessage(43, "안녕", 1, deps);
    expect(seen[0]!.resume).toBeUndefined();
  });

  test("턴이 끝나면 그 세션을 적는다 — 다음 재시작이 이어받을 수 있게", async () => {
    const saved = new Map<number, string>();
    const { deps } = spiesWithSessions({
      get: (c) => saved.get(c),
      save: (c, s) => { saved.set(c, s); },
      clear: (c) => { saved.delete(c); },
    });
    await handleMessage(44, "해줘", 1, deps);
    expect(saved.get(44)).toBe("sess-new");
  });

  test("★턴이 실패하면 저장된 세션을 지운다★ — 죽은 세션을 계속 resume 하면 매번 실패한다", async () => {
    const saved = new Map<number, string>([[45, "sess-dead"]]);
    const deps: BridgeDeps = {
      reactMessage: async () => true,
      sendMessage: async () => 900,
      editMessage: async () => true,
      sandbox: "read-only",
      dmSessions: {
        get: (c) => saved.get(c),
        save: (c, s) => { saved.set(c, s); },
        clear: (c) => { saved.delete(c); },
      },
      runTurn: async () => ({ ok: false, reply: "", detail: "boom", elapsedMs: 1 }),
    };
    await handleMessage(45, "해줘", 1, deps);
    expect(saved.has(45)).toBe(false);
  });
});

// ── ★'이 세션' 버튼★ ──
//
// 배선은 원래 끝까지 있었다 — permissionGate 의 allow_session · decision_scope='session' ·
// serverRequestCodec 의 acceptForSession 까지. ★없던 것은 사람이 누를 자리뿐이었다.★
describe("codex bridge — 이 세션 승인", () => {
  test("★'이 세션' 을 누르면 세션 범위로 기록된다★ — 한번 허용과 구분돼야 codex 가 세션 동안 기억한다", async () => {
    const { dbPath, id } = pendingRequest();
    const out = await handleApprovalCallback(
      "T",
      { id: "cs1", data: `pgs:${id}`, from: { id: OWNER }, message: { message_id: 3, chat: { id: OWNER } } },
      new Set([OWNER]),
      { dbPath, fetchFn: spyFetch([]) },
    );
    expect(out).not.toBe("ignored");
    const db = new CbDb(dbPath);
    const row = db.prepare("SELECT status, decision_scope FROM permission_request WHERE id = ?").get(id) as { status: string; decision_scope: string };
    db.close();
    expect(row.decision_scope).toBe("session");
    expect(row.status).toBe("allowed_once"); // status 로는 한번 허용과 같다 — 범위는 decision_scope 가 말한다
  });

  test("★대조군 — 한번 허용은 세션 범위가 아니다★ (둘이 같으면 세션 버튼이 하는 일이 없다)", async () => {
    const { dbPath, id } = pendingRequest();
    await handleApprovalCallback(
      "T",
      { id: "cs2", data: `pg1:${id}`, from: { id: OWNER } },
      new Set([OWNER]),
      { dbPath, fetchFn: spyFetch([]) },
    );
    const db = new CbDb(dbPath);
    const row = db.prepare("SELECT decision_scope FROM permission_request WHERE id = ?").get(id) as { decision_scope: string };
    db.close();
    expect(row.decision_scope).toBe("once");
  });

  test("★'이 세션' 은 설정 파일에 쓰지 않는다★ — 지속되는 허가를 남기면 세션 범위가 아니다", async () => {
    const { dbPath, id } = pendingRequest();
    const calls: string[] = [];
    await handleApprovalCallback(
      "T",
      { id: "cs3", data: `pgs:${id}`, from: { id: OWNER } },
      new Set([OWNER]),
      { dbPath, fetchFn: spyFetch(calls) },
    );
    // 설정 기록 경로는 allow_always 에만 걸려 있다. 세션 결정에서 그 경로를 타면 안 된다.
    const db = new CbDb(dbPath);
    const row = db.prepare("SELECT decision_scope FROM permission_request WHERE id = ?").get(id) as { decision_scope: string };
    db.close();
    expect(row.decision_scope).toBe("session");
  });
});

// ── ★답 포맷 배선★ ──
//
// 변환 규칙 자체는 telegramMarkdown.test.ts 가 잰다. 여기서는 ★브리지가 그것을 실제로 쓰는지★ 를 잰다.
describe("codex bridge — 답 포맷", () => {
  beforeEach(() => resetChatThreads());

  function spiesForReply(reply: string) {
    const sends: string[] = [];
    const edits: string[] = [];
    const deps: BridgeDeps = {
      reactMessage: async () => true,
      sendMessage: async (_c, text) => { sends.push(text); return 700 + sends.length; },
      editMessage: async (_c, _m, text) => { edits.push(text); return true; },
      sandbox: "read-only",
      runTurn: async () => ({ ok: true, reply, sessionId: "s1", detail: "ok", elapsedMs: 1 }),
    };
    return { deps, sends, edits };
  }

  test("★굵게 표시가 텔레그램 표기로 바뀌어 나간다★ — 예전엔 별표가 글자로 보였다", async () => {
    const { deps, edits } = spiesForReply("**중요** 합니다");
    await handleMessage(31, "해줘", 1, deps);
    const last = edits[edits.length - 1]!;
    expect(last).toContain("*중요*");
    expect(last).not.toContain("**중요**");
  });

  test("★예약문자는 이스케이프돼서 나간다★ — 안 하면 메시지 전체가 거부된다", async () => {
    const { deps, edits } = spiesForReply("판교 28-31도(맑음).");
    await handleMessage(32, "해줘", 1, deps);
    const last = edits[edits.length - 1]!;
    expect(last).toContain("\\-");
    expect(last).toContain("\\(");
    expect(last).toContain("\\.");
  });

  test("★긴 답은 자르지 않고 나눠 보낸다★", async () => {
    const long = Array.from({ length: 500 }, (_, i) => "줄 " + i + " 내용이 제법 길게 이어진다").join("\n");
    const { deps, sends, edits } = spiesForReply(long);
    await handleMessage(33, "해줘", 1, deps);
    // 첫 조각은 작업중 버블 편집으로, 나머지는 새 메시지로 나간다
    expect(edits.length).toBeGreaterThan(0);
    expect(sends.length).toBeGreaterThan(1); // 작업중 버블 1 + 이어지는 조각들
    for (const t of [...edits, ...sends]) expect(t.length).toBeLessThanOrEqual(4096);
  });

  test("★대조군 — 짧은 답은 한 번에 나간다★ (쓸데없이 나누지 않는다)", async () => {
    const { deps, sends } = spiesForReply("네 알겠습니다");
    await handleMessage(34, "해줘", 1, deps);
    expect(sends.length).toBe(1); // 작업중 버블 하나뿐
  });
});

// ── ★폴백 분기 — 실패했을 때만 도는 길★ ──
//
// 이 분기가 이 변경의 안전장치인데, 주입 없이는 단위에서도 라이브에서도 실행되지 않는다.
// ★함수가 검증된 것과 그 함수를 부르는 분기가 검증된 것은 다르다★ — toPlain 은 시험돼 있었지만
// 그것을 부르는 이 길은 한 번도 안 돌았다. 여기서 그 길을 직접 밟는다.
describe("텔레그램 전송 — MarkdownV2 거부 시 폴백", () => {
  /** 첫 호출은 실패, 그 뒤는 성공하는 가짜 텔레그램. */
  function flakyFetch(okFrom: number, result: Record<string, unknown> = { message_id: 5 }) {
    const bodies: Record<string, unknown>[] = [];
    const fn = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      const ok = bodies.length >= okFrom;
      return { json: async () => (ok ? { ok: true, result } : { ok: false, description: "can't parse entities" }) } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fn, bodies };
  }

  test("★거부되면 표시를 걷고 한 번 더 보낸다★ — 없으면 답이 통째로 사라진다", async () => {
    const { fn, bodies } = flakyFetch(2);
    const send = tgSend("TKN", fn);
    const id = await send(7066867819, "판교 28\\-31도\\(맑음\\)");

    expect(bodies).toHaveLength(2);                       // ① 두 번째 호출이 일어났다
    expect(bodies[0]!.parse_mode).toBe("MarkdownV2");
    expect(bodies[1]!.parse_mode).toBeUndefined();        // ② 재시도에는 parse_mode 가 없다
    expect(bodies[1]!.text).toBe("판교 28-31도(맑음)");    //    표시가 걷혔다
    expect(id).toBe(5);                                   // ③ 최종적으로 성공했다
  });

  test("★대조군 — 첫 전송이 성공하면 두 번째 호출은 없다★ (폴백이 늘 돌면 표시가 사라진다)", async () => {
    const { fn, bodies } = flakyFetch(1);
    const id = await tgSend("TKN", fn)(1, "*굵게*");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.parse_mode).toBe("MarkdownV2");
    expect(id).toBe(5);
  });

  test("★둘 다 실패하면 실패로 돌려준다★ — 성공한 척하지 않는다", async () => {
    const { fn, bodies } = flakyFetch(99);
    const id = await tgSend("TKN", fn)(1, "x");
    expect(bodies).toHaveLength(2);
    expect(id).toBeNull();
  });

  test("편집도 같은 폴백을 탄다 — 답은 대개 편집으로 나간다", async () => {
    const { fn, bodies } = flakyFetch(2, {});
    const ok = await tgEdit("TKN", fn)(1, 42, "28\\-31도");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.parse_mode).toBe("MarkdownV2");
    expect(bodies[1]!.parse_mode).toBeUndefined();
    expect(bodies[1]!.text).toBe("28-31도");
    expect(ok).toBe(true);
  });

  test("★대조군 — 편집이 한 번에 되면 재시도하지 않는다★", async () => {
    const { fn, bodies } = flakyFetch(1, {});
    expect(await tgEdit("TKN", fn)(1, 42, "*굵게*")).toBe(true);
    expect(bodies).toHaveLength(1);
  });
});

// ── ★상태는 한 자리, 작업은 그 아래★ ──
describe("codex bridge — 상태 머리글", () => {
  beforeEach(() => resetChatThreads());

  function spiesWithStatus(steps: Array<{ status?: string; work?: string; id?: string }>) {
    const edits: string[] = [];
    const deps: BridgeDeps = {
      reactMessage: async () => true,
      sendMessage: async () => 800,
      editMessage: async (_c, _m, text) => { edits.push(text); return true; },
      sandbox: "read-only",
      runTurn: async (o) => {
        const oa = (o as { onActivity?: (l: string, id?: string) => void }).onActivity;
        const os = (o as { onStatus?: (l: string) => void }).onStatus;
        for (const s of steps) {
          if (s.status) os?.(s.status);
          if (s.work) oa?.(s.work, s.id);
          await new Promise((r) => setTimeout(r, 2100)); // 배치 간격을 넘긴다
        }
        return { ok: true, reply: "끝", sessionId: "s1", detail: "ok", elapsedMs: 1 };
      },
    };
    return { deps, edits };
  }

  test("★상태는 쌓이지 않고 맨 윗줄에서 바뀐다★ — 작업은 아래에 남는다", async () => {
    const { deps, edits } = spiesWithStatus([
      { status: "🧠 생각하는 중…", work: "실행: ls", id: "e1" },
      { status: "✍️ 대답하는 중…" },
    ]);
    await handleMessage(41, "해줘", 1, deps);
    const withWork = edits.filter((e) => e.includes("실행: ls"));
    expect(withWork.length).toBeGreaterThan(0);
    const last = withWork[withWork.length - 1]!;
    expect(last.split("\n")[0]).toBe("✍️ 대답하는 중…"); // 머리글은 최신 상태 하나
    expect(last).toContain("실행: ls");                   // 작업은 남아 있다
    expect((last.match(/생각하는 중/g) ?? []).length).toBe(0); // 옛 상태는 안 쌓인다
  });

  test("★대조군 — 상태가 안 오면 머리글은 처음 그대로★", async () => {
    const { deps, edits } = spiesWithStatus([{ work: "실행: pwd", id: "e1" }]);
    await handleMessage(42, "해줘", 1, deps);
    const withWork = edits.filter((e) => e.includes("실행: pwd"));
    expect(withWork[0]!.split("\n")[0]).toBe(DEFAULT_WORKING_TEXT);
  });
});

// ── ★도는 중인 작업에 말을 밀어 넣는다★ ──
//
// 실측(2026-08-19): 팀 리드가 작업 중에 보낸 메시지 4건이 ★전부 로그에 들어와 있는데 답이 없었다.★
// 받기는 하지만 새 턴으로 줄을 세우니, 하던 일이 끝날 때까지 아무 반응이 없어 ★못 듣는 것처럼 보인다.★
// 버스로 온 일에는 이 배선이 있었고(7군데) 1:1 에는 ★0군데★ 였다.
describe("codex bridge — 진행 중 작업에 끼어들기", () => {
  beforeEach(() => resetChatThreads());

  test("★턴이 도는 동안에는 그 대화가 '도는 중' 으로 보인다★ — 끼어들지 말지를 이걸로 가른다", async () => {
    let sawRunning = false;
    const deps: BridgeDeps = {
      reactMessage: async () => true,
      sendMessage: async () => 900,
      editMessage: async () => true,
      sandbox: "read-only",
      runTurn: async () => {
        sawRunning = isTurnRunningFor(51);
        return { ok: true, reply: "끝", sessionId: "s1", detail: "ok", elapsedMs: 1 };
      },
    };
    await handleMessage(51, "해줘", 1, deps);
    expect(sawRunning, "턴 안에서는 도는 중이어야 한다").toBe(true);
    expect(isTurnRunningFor(51), "끝나면 도는 중이 아니다").toBe(false);
  });

  test("★대조군 — 다른 대화는 '도는 중' 이 아니다★ (남의 턴에 끼워 넣으면 안 된다)", async () => {
    let other = true;
    const deps: BridgeDeps = {
      reactMessage: async () => true,
      sendMessage: async () => 900,
      editMessage: async () => true,
      sandbox: "read-only",
      runTurn: async () => {
        other = isTurnRunningFor(52); // 다른 대화 번호
        return { ok: true, reply: "끝", sessionId: "s1", detail: "ok", elapsedMs: 1 };
      },
    };
    await handleMessage(51, "해줘", 1, deps);
    expect(other).toBe(false);
  });

  test("★턴이 던져도 '도는 중' 표시가 남지 않는다★ — 남으면 이후 모든 말이 갈 곳을 잃는다", async () => {
    const deps: BridgeDeps = {
      reactMessage: async () => true,
      sendMessage: async () => 900,
      editMessage: async () => true,
      sandbox: "read-only",
      runTurn: async () => { throw new Error("터짐"); },
    };
    await handleMessage(53, "해줘", 1, deps).catch(() => undefined);
    expect(isTurnRunningFor(53)).toBe(false);
  });

  test("밀어 넣는 문구에 ★반영하라·답하라★ 가 들어간다 — 없으면 조용히 무시될 수 있다", () => {
    const t = buildDmSteerText("로그인이 안되면 알려줘");
    expect(t).toContain("[중간 메시지");
    expect(t).toContain("로그인이 안되면 알려줘");
    expect(t).toContain("반영해서 계속하라");
    expect(t).toContain("이 메시지에도 답해라");
  });
});

// ── ★창구 경로는 서버가 대신 말하지 않는다★ (2026-08-24 실측) ──
describe("noAutopostDeps — 발신만 떼고 리액션은 남긴다", () => {
  test("★sendMessage·editMessage 가 아무것도 안 보낸다★", async () => {
    let sent = 0, edited = 0;
    const base = {
      sendMessage: async () => { sent += 1; return 1; },
      editMessage: async () => { edited += 1; return true; },
    } as unknown as Parameters<typeof noAutopostDeps>[0];
    const d = noAutopostDeps(base);
    expect(await d.sendMessage!(1, "x")).toBeNull();
    expect(await d.editMessage!(1, 2, "x")).toBe(false);
    expect(sent).toBe(0);
    expect(edited).toBe(0);
  });

  test("★리액션은 그대로 남는다★ — '그 팀원이 받았다' 는 발신과 다른 값이다", async () => {
    let reacted = 0;
    const base = { reactMessage: async () => { reacted += 1; return true; } } as unknown as Parameters<typeof noAutopostDeps>[0];
    await noAutopostDeps(base).reactMessage!(1, 2, "👀");
    expect(reacted).toBe(1);
  });

  test("나머지 deps 는 그대로 넘어간다", () => {
    const base = { agentId: "dex", teamBaseUrl: "http://x" } as unknown as Parameters<typeof noAutopostDeps>[0];
    const d = noAutopostDeps(base);
    expect(d.agentId).toBe("dex");
    expect(d.teamBaseUrl).toBe("http://x");
  });
});
