/**
 * settings 라우트 — 팀명·Mission·팀원 추가/퇴사. 파일 쓰기는 temp 로 격리(원본 불변).
 * 사이드이펙트 방지 핵심 검증: §2 보존, 퇴사 이름확인 가드, 중복/유효성, 백업 생성.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../db/migrate";
import { appendAudit, listAgents } from "../db/queries";
import { syncRegistry } from "../lib/registry";
import { allowedRuntimes, createSettingsApp, MAX_OFFICIAL_TEAM_MEMBERS, publicRuntimeOptions, removePathWithRetries } from "./settings";
import { MEMBERS_ROOT } from "../lib/personaTemplates";

// 테스트 격리: codex 퇴사 테스트의 off-file 기록이 라이브 var/agent-off.txt를 오염하지 않게 temp로.
process.env.TEAMOS_AGENT_OFF_FILE = join(tmpdir(), "settings-test-off.txt");
process.env.TEAMOS_BUS_WAKE_EXTRA_FILE = join(tmpdir(), "settings-test-bus-wake.txt"); // 퇴사 테스트의 removeBusWake가 실 운영파일 미변경(격리)

const TEAM_OS = `# TEAM-OS

## 1. Mission & Identity

우리는 테스트 팀이다.

## 2. 다음 절

내용 보존 확인용.
`;
const AGENTS = [
  { id: "bill", display_name: "Bill", nicknames: ["bill"], role: "infra", runtime: "claude_channel", status_provider: "claude_tmux", avatar_emoji: "🛠️", moderator_eligible: true },
  { id: "steve", display_name: "Steve", nicknames: ["steve"], role: "fullstack", runtime: "claude_channel", status_provider: "claude_tmux", avatar_emoji: "🧑‍💻", moderator_eligible: false },
];

function setup(agents: any[] = AGENTS, overrides: Partial<Parameters<typeof createSettingsApp>[0]> = {}) {
  const db = new Database(":memory:");
  migrate(db);
  const dir = mkdtempSync(join(tmpdir(), "settings-test-"));
  const teamOsPath = join(dir, "TEAM-OS.md");
  const registryPath = join(dir, "agents.json");
  process.env.SLACK_TOKENS_DIR = join(dir, "slack-tokens");
  writeFileSync(teamOsPath, TEAM_OS, "utf-8");
  // FIX1(GD 2026-07-08): fixture 멤버(steve/bill = 실 멤버 폴더명)의 workspace를 per-test temp로 고정.
  //   미지정이면 swapRuntime/writeMemberPersona 가 memberPaths() 폴백으로 라이브 ~/Development/<id> 를
  //   건드려 실 CLAUDE.md 를 삭제하던 근본버그(activation.ts:897 rmSync). temp 주입으로 원천차단 +
  //   실제 파일연산은 temp 안에서 정상 동작(=삭제경로도 여전히 커버). 중앙가드(FIX2)와 이중방어.
  const isoAgents = agents.map((a: any) => ({
    ...a,
    workspace_path: a.workspace_path ?? join(dir, a.id),
    persona_file: a.persona_file ?? join(dir, a.id, "SOUL.md"),
  }));
  writeFileSync(registryPath, JSON.stringify(isoAgents, null, 2), "utf-8");
  syncRegistry(db, registryPath);
  // ⚠️ archiveWorkspace=noop 주입: 퇴사(DELETE) 테스트가 실제 ~/Development/<id>를 mv하지 않게 격리.
  // (이게 빠지면 full suite 실행 시 라이브 멤버 워크스페이스가 진짜 archive로 날아감 — high-sev 회귀)
  const app = createSettingsApp({ db, registryPath, teamOsPath, appendAudit, onRegistryChanged: () => syncRegistry(db, registryPath), archiveWorkspace: () => null, skipRuntimeCleanup: true, ...overrides });
  return { app, teamOsPath, registryPath, dir, db };
}
/** 팀 세팅이 '완료'된 상태 — 영입(recruit)은 setupComplete() 를 통과해야 열린다.
 *  ★필수 3필드 = team_name · lead_id · owner_name★ (2c0f363, GD 2026-07-10).
 *  owner_name 이 빠져 있어서 recruit 이 계속 막혔고, '영입 OT' 테스트 9건이 통째로 실패했다. */
function setupReady(agents: any[] = AGENTS, overrides: Partial<Parameters<typeof createSettingsApp>[0]> = {}) {
  const out = setup(agents, overrides);
  out.db
    .query("INSERT INTO setting (key, value) VALUES ('team_name', '로빈팀'), ('lead_id', 'lead'), ('owner_name', 'GD')")
    .run();
  return out;
}
// provision getMe 검증 stub — 실 텔레그램 의존 차단. 기본은 '살아있는 봇'으로 통과.
const okBotToken = async (_token: string) => ({ ok: true as const, username: "verifiedbot" });
const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const put = (body: unknown) => ({ method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const del = (body: unknown) => ({ method: "DELETE", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const patch = (body: unknown) => ({ method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("Claude pairing backend contract", () => {
  test("allowFrom empty exposes pending state and valid code promotes atomically", async () => {
    const { app, dir, db } = setup();
    const channels = join(dir, "claude-channels");
    process.env.CLAUDE_CHANNELS_DIR = channels;
    const accessDir = join(channels, "telegram-bill");
    mkdirSync(accessDir, { recursive: true });
    writeFileSync(join(accessDir, "access.json"), JSON.stringify({
      dmPolicy: "pairing", allowFrom: [], groups: {},
      pending: { abc123: { senderId: "1000000001", chatId: "1000000001", expiresAt: Date.now() + 60_000 } },
    }));
    const steps = [
      { key: "register", state: "done" }, { key: "provision", state: "done" },
      { key: "preflight", state: "done" }, { key: "bundle", state: "done" }, { key: "join", state: "pending" },
    ];
    db.query("INSERT INTO ot(id,member_id,stage,steps_json) VALUES('ot_pair','bill','join',?)").run(JSON.stringify({ steps }));

    const before = await (await app.request("/members/bill/pairing-status")).json() as any;
    expect(before).toMatchObject({ runtime: "claude_channel", pairing_required: true, pending: true });
    expect(before.awaiting_input.kind).toBe("claude_pairing_code");

    const approved = await app.request("/ot/ot_pair/claude-pair-approve", json({ code: "abc123" }));
    expect(approved.status).toBe(200);
    const stored = JSON.parse(readFileSync(join(accessDir, "access.json"), "utf-8"));
    expect(stored.allowFrom).toEqual(["1000000001"]);
    expect(stored.pending.abc123).toBeUndefined();
    const after = await (await app.request("/members/bill/pairing-status")).json() as any;
    expect(after).toMatchObject({ pairing_required: false, pending: false, awaiting_input: null });
    delete process.env.CLAUDE_CHANNELS_DIR;
  });
});

test("공개 빌드 runtime_invalid allowed는 live-only 런타임을 노출하지 않는다", () => {
  expect(allowedRuntimes(true)).toEqual(["claude_channel", "openclaw", "hermes_agent"]);
  expect(allowedRuntimes(true)).not.toContain("codex");
  expect(allowedRuntimes(true)).not.toContain("b3os_native");
});

test("runtime-options는 빌드모드 인지 — 공개=정확히 3종(codex 부재)·내부=codex 포함, 미준비 BYO는 disabled+setup_ref", async () => {
  const readiness = {
    hermes_agent: { runtime: "hermes_agent", installed: true, authenticated: false, ready: false, detail: "미인증", fixHint: "hermes auth" },
    openclaw: { runtime: "openclaw", installed: true, authenticated: true, ready: true, detail: "인증 확인", fixHint: "" },
    codex: { runtime: "codex", installed: true, authenticated: true, ready: true, detail: "codex 인증 확인", fixHint: "" },
  };
  // 공개 빌드(publicBuild=true) → 정확히 3종, codex 없음.
  const publicOptions = publicRuntimeOptions(readiness, true);
  expect(publicOptions.map((o) => o.runtime)).toEqual(["claude_channel", "hermes_agent", "openclaw"]);
  expect(publicOptions.some((o) => o.runtime === ("codex" as any))).toBe(false);
  expect(publicOptions.find((o) => o.runtime === "claude_channel")).toMatchObject({ recommended: true, disabled: false });
  expect(publicOptions.find((o) => o.runtime === "hermes_agent")).toMatchObject({ disabled: true, setup_ref: "skills/b3os/references/runtime-setup.md#hermes-agent" });
  expect(publicOptions.find((o) => o.runtime === "openclaw")).toMatchObject({ disabled: false });
  // 내부 빌드(publicBuild=false) → 3종 + codex 복원.
  const internalOptions = publicRuntimeOptions(readiness, false);
  expect(internalOptions.map((o) => o.runtime)).toEqual(["claude_channel", "hermes_agent", "openclaw", "codex"]);
  expect(internalOptions.find((o) => o.runtime === "codex")).toMatchObject({ disabled: false, recommended: false });
  expect(internalOptions.some((o) => o.runtime === ("b3os_native" as any))).toBe(false);
  // 미준비 codex 는 내부에서도 disabled+사유로 남는다(숨김X).
  const codexNotReady = publicRuntimeOptions({ ...readiness, codex: { runtime: "codex", installed: true, authenticated: false, ready: false, detail: "codex 미인증", fixHint: "codex login 하세요" } }, false);
  expect(codexNotReady.find((o) => o.runtime === "codex")).toMatchObject({ disabled: true, reason: "codex login 하세요" });

  // 엔드포인트 실측 — 소스 PUBLIC_BUILD=false(내부·테스트) 이므로 codex 포함 4종.
  const { app } = setup(AGENTS, {
    checkRuntimeAuth: async (runtime: string) => runtime === "hermes_agent"
      ? { runtime, loggedIn: false, detail: "hermes 미인증", fixHint: "hermes auth" }
      : { runtime, loggedIn: true, detail: "ready", fixHint: "" },
  });
  const response = await app.request("/runtime-options");
  const body = await response.json() as { public_build: boolean; options: Array<{ runtime: string; disabled: boolean }> };
  expect(body.public_build).toBe(false);
  expect(body.options.map((o) => o.runtime)).toEqual(["claude_channel", "hermes_agent", "openclaw", "codex"]);
  expect(body.options.find((o) => o.runtime === "hermes_agent")?.disabled).toBe(true);
  expect(body.options.find((o) => o.runtime === "codex")?.disabled).toBe(false);
});

test("미준비 BYO는 members/recruit/swap에서 같은 runtime_not_ready+fixHint로 거부된다", async () => {
  const notReady = async (runtime: string) => ({ runtime, loggedIn: false, detail: `${runtime} 미인증`, fixHint: `${runtime} setup` });
  const members = setup(AGENTS, { checkRuntimeAuth: notReady });
  const memberRes = await members.app.request("/members", json({ id: "nova", display_name: "Nova", role: "dev", runtime: "hermes_agent" }));
  expect(memberRes.status).toBe(400);
  expect(await memberRes.json()).toMatchObject({ error: "runtime_not_ready", hint: "hermes_agent setup" });

  const recruit = setupReady(AGENTS, { checkRuntimeAuth: notReady });
  const recruitRes = await recruit.app.request("/members/recruit", json({ id: "nova", display_name: "Nova", role: "dev", runtime: "openclaw" }));
  expect(recruitRes.status).toBe(400);
  expect(await recruitRes.json()).toMatchObject({ error: "runtime_not_ready", hint: "openclaw setup" });

  const swap = setup(AGENTS, { checkRuntimeAuth: notReady });
  const swapRes = await swap.app.request("/members/steve/swap-runtime", json({ target_runtime: "hermes_agent", confirm_name: "Steve" }));
  expect(swapRes.status).toBe(400);
  expect(await swapRes.json()).toMatchObject({ ok: false, error: "runtime_not_ready", hint: "hermes_agent setup" });
});

describe("settings: 시스템 OP (P0 floor — capture/router)", () => {
  const SO_TOKEN = join(tmpdir(), "settings-systemop-token.txt");
  const SO_PIN = join(tmpdir(), "settings-systemop-pin.hash");
  const SO_GROUP = join(tmpdir(), "settings-systemop-group.txt");
  beforeEach(() => {
    process.env.APPROVAL_EXECUTION_ENABLED = "1"; // 퇴사=execOn 게이트 → 실행 ON에서 검증(.env 의존 제거, GD 2026-07-01 하네스)
    process.env.CAPTURE_TOKEN_FILE = SO_TOKEN;
    process.env.CAPTURE_GROUP_FILE = SO_GROUP;
    process.env.ADMIN_PIN_FILE = SO_PIN; // PIN 미설정 → graceful 허용
    try { require("node:fs").rmSync(SO_TOKEN); } catch { /* 무시 */ }
    try { require("node:fs").rmSync(SO_GROUP); } catch { /* 무시 */ }
    try { require("node:fs").rmSync(SO_PIN); } catch { /* 무시 */ }
    delete process.env.CAPTURE_BOT_TOKEN;
    delete process.env.ROUTER_ENABLED;
    delete process.env.CAPTURE_GROUP_ID;
  });

  test("GET 기본 상태 — 토큰 없음·router 기본 ON (setting·env 없으면 true, GD 0721)", async () => {
    const { app } = setup();
    const s = await (await app.request("/system-op")).json();
    expect(s).toEqual({ has_capture_token: false, capture_group_id: null, router_enabled: true });
  });

  test("PATCH router_enabled 토글 (PIN 없이 즉시 반영)", async () => {
    const { app } = setup();
    const r = await app.request("/system-op", patch({ router_enabled: true }));
    expect(r.status).toBe(200);
    expect((await (await app.request("/system-op")).json()).router_enabled).toBe(true);
  });

  test("PATCH 토큰 — 유효형식 저장 + has_capture_token + needs_restart, ★값 노출 안 함", async () => {
    const { app } = setup();
    const r = await app.request("/system-op", patch({ capture_bot_token: "123456:ABCdefGHIjklMNOpqrSTUvwxYZ012345" }));
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.has_capture_token).toBe(true);
    expect(body.needs_restart).toBe(true);
    expect(JSON.stringify(body)).not.toContain("ABCdefGHIjklMNOpqrSTUvwxYZ012345"); // 마스킹
    expect(JSON.stringify(await (await app.request("/system-op")).json())).not.toContain("ABCdefGHIjklMNOpqrSTUvwxYZ012345");
  });

  test("PATCH 잘못된 토큰 형식 → 400", async () => {
    const { app } = setup();
    expect((await app.request("/system-op", patch({ capture_bot_token: "not-a-valid-token" }))).status).toBe(400);
  });

  test("detect-lead-id — capture worker 캐시에서 최근 non-bot 발신자 저장, getUpdates 호출 없음", async () => {
    const token = "123456:ABCdefGHIjklMNOpqrSTUvwxYZ012345";
    writeFileSync(SO_TOKEN, token, "utf-8");
    const telegramFetch = async () => {
      throw new Error("detect-lead-id must not call getUpdates");
    };
    const { app, db } = setup(AGENTS, { telegramFetch: telegramFetch as unknown as typeof fetch });
    db.query("INSERT INTO setting (key, value) VALUES ('capture_last_non_bot_sender_id', '987654321'), ('capture_last_non_bot_sender_username', 'lead')").run();
    const r = await app.request("/system-op/detect-lead-id", json({}));
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(text).not.toContain("ABCdefGHIjklMNOpqrSTUvwxYZ012345");
    const body = JSON.parse(text);
    expect(body.lead_telegram_id).toBe("987654321");
    expect((db.query("SELECT value FROM setting WHERE key = 'lead_telegram_id'").get() as any).value).toBe("987654321");
  });

  test("detect-group — shadow 관찰 그룹 1개를 자동 설정하고 capture를 재시작", async () => {
    writeFileSync(SO_TOKEN, "123456:ABCdefGHIjklMNOpqrSTUvwxYZ012345", "utf-8");
    let restarted = 0;
    const { app, db } = setup(AGENTS, { restartCapture: () => { restarted += 1; } });
    db.query("INSERT INTO setting (key, value) VALUES ('capture_discovered_groups', ?)").run(JSON.stringify([
      { id: "-1001234567890", type: "supergroup", title: "Team", seen_at: "2026-07-20T00:00:00.000Z" },
    ]));
    const r = await app.request("/system-op/detect-group", json({}));
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.auto_set).toBe("-1001234567890");
    expect(body.needs_restart).toBe(false);
    expect(body.note).toContain("즉시 반영");
    expect(restarted).toBe(1);
    expect(readFileSync(SO_GROUP, "utf-8").trim()).toBe("-1001234567890");
  });

  test("detect-group — restartCapture 미주입이면 재시작 필요를 정확히 알림", async () => {
    writeFileSync(SO_TOKEN, "123456:ABCdefGHIjklMNOpqrSTUvwxYZ012345", "utf-8");
    const { app, db } = setup();
    db.query("INSERT INTO setting (key, value) VALUES ('capture_discovered_groups', ?)").run(JSON.stringify([
      { id: "-1001234567890", type: "supergroup", title: "Team", seen_at: "2026-07-20T00:00:00.000Z" },
    ]));
    const body = await (await app.request("/system-op/detect-group", json({}))).json();
    expect(body.needs_restart).toBe(true);
    expect(body.note).toContain("서버 재시작 시 반영");
  });
});

describe("settings: 팀명/태그라인", () => {
  test("기본 빈값 → PUT → 반영", async () => {
    const { app } = setup();
    expect(await (await app.request("/settings")).json()).toEqual({
      team_name: "",
      lead_id: "",
      setup_complete: false,
      lead_actor_id: "gd",
      lead_actor_source: "default",
      tagline: "",
      owner_name: "",
      owner_chat_id: "",
      locale: "ko",
      dm_capture: true, // 기본 on
    });
    // ★필수 3필드 = team_name · lead_id · owner_name (2c0f363, GD 2026-07-10).★
    //   2개만 채우면 아직 setup_complete=false 여야 한다 — 이 테스트는 옛 2필드 규칙을 기대해서 깨져 있었다.
    const r = await app.request("/settings", put({ team_name: "로빈팀", lead_id: "lead", tagline: "우리만의 팀" }));
    expect(r.status).toBe(200);
    expect(await (await app.request("/settings")).json()).toEqual({
      team_name: "로빈팀",
      lead_id: "lead",
      setup_complete: false, // owner_name 이 아직 비어서 미완
      lead_actor_id: "lead",
      lead_actor_source: "setting",
      tagline: "우리만의 팀",
      owner_name: "",
      owner_chat_id: "",
      locale: "ko",
      dm_capture: true, // 기본 on
    });
    // 3번째 필드(owner_name)까지 채워야 완료된다.
    expect((await app.request("/settings", put({ owner_name: "GD" }))).status).toBe(200);
    const done = await (await app.request("/settings")).json();
    expect(done.owner_name).toBe("GD");
    expect(done.setup_complete).toBe(true);
  });
  test("팀명 20자 초과 거부", async () => {
    const { app } = setup();
    expect((await app.request("/settings", put({ team_name: "x".repeat(21) }))).status).toBe(400);
    expect((await app.request("/settings", put({ team_name: "x".repeat(20) }))).status).toBe(200);
  });
  test("lead_id slug 검증", async () => {
    const { app } = setup();
    expect((await app.request("/settings", put({ lead_id: "lead_01" }))).status).toBe(200);
    expect((await app.request("/settings", put({ lead_id: "Bad!" }))).status).toBe(400);
    expect((await app.request("/settings", put({ lead_id: "x".repeat(41) }))).status).toBe(400);
  });
  test("leadActorId 우선순위: lead_id setting > env LEAD_ACTOR_ID > gd", async () => {
    const prev = process.env.LEAD_ACTOR_ID;
    try {
      process.env.LEAD_ACTOR_ID = "envlead";
      const { app } = setup();
      expect((await (await app.request("/settings")).json()).lead_actor_id).toBe("envlead");
      const r = await app.request("/settings", put({ lead_id: "db_lead" }));
      expect(r.status).toBe(200);
      const s = await (await app.request("/settings")).json();
      expect(s.lead_actor_id).toBe("db_lead");
      expect(s.lead_actor_source).toBe("setting");
    } finally {
      if (prev === undefined) delete process.env.LEAD_ACTOR_ID;
      else process.env.LEAD_ACTOR_ID = prev;
    }
  });
});

describe("settings: Mission(TEAM-OS §1)", () => {
  test("GET → §1 본문", async () => {
    const { app } = setup();
    expect((await (await app.request("/mission")).json()).mission).toBe("우리는 테스트 팀이다.");
  });
  test("PUT → 반영 + §2 보존 + 백업", async () => {
    const { app, teamOsPath } = setup();
    const r = await app.request("/mission", put({ mission: "새 미션\n여러 줄도 됨." }));
    expect(r.status).toBe(200);
    const file = readFileSync(teamOsPath, "utf-8");
    expect(file).toContain("새 미션\n여러 줄도 됨.");
    expect(file).toContain("## 2. 다음 절"); // 다음 절 보존 = 사이드이펙트 없음
    expect(file).toContain("내용 보존 확인용.");
    expect(existsSync(teamOsPath + ".bak")).toBe(true); // 백업 생성
    expect((await (await app.request("/mission")).json()).mission).toBe("새 미션\n여러 줄도 됨.");
  });
  test("빈 미션 거부", async () => {
    const { app } = setup();
    expect((await app.request("/mission", put({ mission: "  " }))).status).toBe(400);
  });
});

describe("settings: 팀원 추가/퇴사", () => {
  test("목록", async () => {
    const { app } = setup();
    const list = (await (await app.request("/members")).json()) as any[];
    expect(list.map((a) => a.id)).toEqual(["bill", "steve"]);
  });
  test("추가 성공 + 파일 반영", async () => {
    const { app, registryPath } = setup();
    const r = await app.request("/members", json({ id: "demis", display_name: "Demis", role: "research" }));
    expect(r.status).toBe(200);
    const list = JSON.parse(readFileSync(registryPath, "utf-8"));
    expect(list.map((a: any) => a.id)).toContain("demis");
    expect(list.find((a: any) => a.id === "demis").response_mode).toBe("mention-only");
  });
  test("첫 팀원 추가 → coordinator capability 자동 부여", async () => {
    const { app, registryPath } = setup([]);
    const r = await app.request("/members", json({ id: "founder", display_name: "Founder", role: "lead" }));
    expect(r.status).toBe(200);
    const founder = JSON.parse(readFileSync(registryPath, "utf-8")).find((a: any) => a.id === "founder");
    expect(founder.capabilities).toContain("coordinator");
  });
  test("openclaw 영입 → 유효 status_provider + workspace + syncRegistry(reload) 스키마 통과", async () => {
    const { app, registryPath, db } = setup();
    await app.request("/members", json({ id: "nova", display_name: "Nova", role: "design", runtime: "openclaw" }));
    const nova = JSON.parse(readFileSync(registryPath, "utf-8")).find((a: any) => a.id === "nova");
    expect(nova.status_provider).toBe("openclaw_gateway"); // 'none' 이면 CHECK 위반 크래시
    // ★ambient-safe(2026-07-12 Bill 갭): 하드코딩 대신 실제 해석된 MEMBERS_ROOT 기준★ — 라이브 .env(B3RYS_MEMBERS_ROOT)가 있어도 green.
    expect(nova.workspace_path).toBe(join(MEMBERS_ROOT, "nova"));
    expect(() => syncRegistry(db, registryPath)).not.toThrow(); // reload 경로가 스키마 위반 없이 통과
  });
  test("codex 영입 → status_provider=codex_cli + workspace + syncRegistry(reload) 스키마 통과", async () => {
    const { app, registryPath, db } = setup();
    const r = await app.request("/members", json({ id: "cody", display_name: "Cody", role: "dev", runtime: "codex" }));
    expect(r.status).toBe(200); // RUNTIMES에 codex 있어야 통과(없으면 runtime_invalid 400)
    const cody = JSON.parse(readFileSync(registryPath, "utf-8")).find((a: any) => a.id === "cody");
    expect(cody.runtime).toBe("codex");
    expect(cody.status_provider).toBe("codex_cli"); // CHECK enum + STATUS_BY_RUNTIME 매핑
    expect(cody.workspace_path).toBe(join(MEMBERS_ROOT, "cody"));
    expect(() => syncRegistry(db, registryPath)).not.toThrow(); // DB CHECK(codex/codex_cli) 위반 없이 reload
  });
  test("codex 퇴사 → 레지스트리 제거(브리지 정리는 best-effort, 실행 OFF여도 throw 없음)", async () => {
    const { app, registryPath } = setup([...AGENTS, { id: "cody", display_name: "Cody", nicknames: ["cody"], role: "dev", runtime: "codex", status_provider: "codex_cli", avatar_emoji: "✦", moderator_eligible: false }]);
    const r = await app.request("/members/cody", { method: "DELETE", body: JSON.stringify({ confirm_name: "Cody" }), headers: { "content-type": "application/json" } });
    expect(r.status).toBe(200);
    expect(JSON.parse(readFileSync(registryPath, "utf-8")).find((a: any) => a.id === "cody")).toBeUndefined();
  });
  test("영입 자동 아이콘 — 비우면 안 겹치는 ICONS 키 배정(결정적)", async () => {
    const { app, registryPath } = setup(); // fixture는 icon 미설정 → 첫 팔레트
    await app.request("/members", json({ id: "demis", display_name: "Demis", role: "research" }));
    const demis = JSON.parse(readFileSync(registryPath, "utf-8")).find((a: any) => a.id === "demis");
    expect(demis.icon).toBe("user-circle"); // founder 기본 아이콘 예약 뒤 첫 빈 키
  });
  test("영입 아이콘 직접 지정 우선", async () => {
    const { app, registryPath } = setup();
    await app.request("/members", json({ id: "nova", display_name: "Nova", role: "x", icon: "code" }));
    expect(JSON.parse(readFileSync(registryPath, "utf-8")).find((a: any) => a.id === "nova").icon).toBe("code");
  });
  test("PATCH 아이콘 교체", async () => {
    const { app, registryPath } = setup();
    const r = await app.request("/members/steve", patch({ icon: "flask-conical" }));
    expect(r.status).toBe(200);
    expect(JSON.parse(readFileSync(registryPath, "utf-8")).find((a: any) => a.id === "steve").icon).toBe("flask-conical");
  });
  test("PATCH 잘못된 아이콘 거부 / 없는 멤버 404", async () => {
    const { app } = setup();
    expect((await app.request("/members/steve", patch({ icon: "BAD KEY!" }))).status).toBe(400);
    expect((await app.request("/members/ghost", patch({ icon: "code" }))).status).toBe(404);
  });
  test("PATCH 아이콘 색 교체 — 유효 키 200·저장, 잘못된 키 400, 빈 바디 400", async () => {
    const { app, registryPath } = setup();
    const r = await app.request("/members/steve", patch({ icon_color: "orange" }));
    expect(r.status).toBe(200);
    expect(JSON.parse(readFileSync(registryPath, "utf-8")).find((a: any) => a.id === "steve").icon_color).toBe("orange");
    expect((await app.request("/members/steve", patch({ icon_color: "chartreuse" }))).status).toBe(400);
    expect((await app.request("/members/steve", patch({}))).status).toBe(400);
  });
  test("PATCH nicknames — 멘션 별칭 교체·@정규화·검증·빈배열=제거", async () => {
    const { app, registryPath } = setup();
    const read = (id: string) => JSON.parse(readFileSync(registryPath, "utf-8")).find((a: any) => a.id === id);
    // 정상: @접두 제거 후 저장
    expect((await app.request("/members/steve", patch({ nicknames: ["@스티브", "steevo"] }))).status).toBe(200);
    expect(read("steve").nicknames).toEqual(["스티브", "steevo"]);
    // 공백 포함 → 400
    expect((await app.request("/members/steve", patch({ nicknames: ["bad alias"] }))).status).toBe(400);
    // 배열 아님 → 400
    expect((await app.request("/members/steve", patch({ nicknames: "steve" }))).status).toBe(400);
    // 빈 배열 → 별칭 제거(undefined)
    expect((await app.request("/members/steve", patch({ nicknames: [] }))).status).toBe(200);
    expect(read("steve").nicknames).toBeUndefined();
  });
  test("중복 id 409", async () => {
    const { app } = setup();
    expect((await app.request("/members", json({ id: "bill", display_name: "X", role: "r" }))).status).toBe(409);
  });
  test("잘못된 id 400", async () => {
    const { app } = setup();
    expect((await app.request("/members", json({ id: "Bad Id!", display_name: "X", role: "r" }))).status).toBe(400);
  });
  test("잘못된 runtime 400", async () => {
    const { app } = setup();
    expect((await app.request("/members", json({ id: "zoe", display_name: "Z", role: "r", runtime: "bogus" }))).status).toBe(400);
  });
  test("퇴사: confirm_name 없으면 400", async () => {
    const { app } = setup();
    const r = await app.request("/members/steve", { method: "DELETE" });
    expect(r.status).toBe(400);
  });
  test("퇴사: 이름 불일치 400", async () => {
    const { app } = setup();
    expect((await app.request("/members/steve", del({ confirm_name: "steve" }))).status).toBe(400); // display_name=Steve
  });
  test("퇴사: 이름 정확 → 제거 + 백업", async () => {
    const { app, registryPath, db } = setup();
    const r = await app.request("/members/steve", del({ confirm_name: "Steve" }));
    expect(r.status).toBe(200);
    // ⚠️회귀 가드: archiveWorkspace가 noop으로 주입돼 실제 ~/Development/your-workspace를 mv하지 않음을 보장.
    // archived가 null이 아니면(실제 경로 반환) = 테스트가 라이브 워크스페이스를 건드린 것 → high-sev 재발.
    expect((await r.json()).removed.archived).toBe(null);
    const list = JSON.parse(readFileSync(registryPath, "utf-8"));
    expect(list.map((a: any) => a.id)).toEqual(["bill"]);
    expect(listAgents(db).map((a) => a.id)).toEqual(["bill"]);
    expect(existsSync(registryPath + ".bak")).toBe(true);
  });
  test("퇴사: 없는 멤버 404", async () => {
    const { app } = setup();
    expect((await app.request("/members/ghost", del({ confirm_name: "Ghost" }))).status).toBe(404);
  });
  test("hermes 퇴사 cleanup: 프로필 dir 삭제는 transient rm 실패 후 재시도한다", async () => {
    let exists = true;
    let rmCalls = 0;
    const slept: number[] = [];
    const ok = await removePathWithRetries("/tmp/.hermes/profiles/mes", { recursive: true, force: true }, {
      attempts: 3,
      delayMs: 5,
      exists: () => exists,
      rm: (() => {
        rmCalls++;
        if (rmCalls === 1) throw new Error("resource busy");
        exists = false;
      }) as any,
      sleep: async (ms) => { slept.push(ms); },
    });
    expect(ok).toBe(true);
    expect(rmCalls).toBe(2);
    expect(slept).toEqual([5]);
  });
});

describe("settings: 런타임 스왑(POST /members/:id/swap-runtime) — HTTP 배선", () => {
  // 코어 로직(STEP0~6·롤백·teardown 분기)은 activation.test.ts(swapRuntime 단위테스트)가 상세 검증한다.
  // 여기서는 라우트가 그 결과를 올바른 HTTP status로 매핑하고, exec 게이트·DI가 잘 물렸는지만 확인한다.
  const authOk = async (runtime: string) => ({ runtime, loggedIn: true, detail: "auth ok", fixHint: "" });
  const activateOk = async () => ({ ok: true, steps: [{ step: "runtime", ok: true, detail: "mock" }] });

  test("실행 OFF(APPROVAL_EXECUTION_ENABLED 미설정) → 403, 레지스트리 불변", async () => {
    delete process.env.APPROVAL_EXECUTION_ENABLED;
    const { app, registryPath } = setup();
    const before = readFileSync(registryPath, "utf-8");
    const r = await app.request("/members/steve/swap-runtime", json({ target_runtime: "codex", confirm_name: "Steve" }));
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("execution_off");
    expect(readFileSync(registryPath, "utf-8")).toBe(before);
  });

  test("없는 멤버 → 404", async () => {
    process.env.APPROVAL_EXECUTION_ENABLED = "1";
    const { app } = setup(AGENTS, { checkRuntimeAuth: authOk, activateMember: activateOk });
    const r = await app.request("/members/ghost/swap-runtime", json({ target_runtime: "codex" }));
    expect(r.status).toBe(404);
    expect((await r.json()).code).toBe("unknown_member");
  });

  test("target_runtime 누락 → 400", async () => {
    process.env.APPROVAL_EXECUTION_ENABLED = "1";
    const { app } = setup(AGENTS, { checkRuntimeAuth: authOk, activateMember: activateOk });
    const r = await app.request("/members/steve/swap-runtime", json({}));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("target_runtime_required");
  });

  test("confirm_name 누락/불일치 → 400 confirm_name_mismatch, 레지스트리 불변 (파괴적 작업 오발 방지, GD 2026-07-04)", async () => {
    process.env.APPROVAL_EXECUTION_ENABLED = "1";
    const { app, registryPath } = setup(AGENTS, { checkRuntimeAuth: authOk, activateMember: activateOk });
    const before = readFileSync(registryPath, "utf-8");
    // 이름 누락 → 400
    expect((await app.request("/members/steve/swap-runtime", json({ target_runtime: "codex" }))).status).toBe(400);
    // 이름 오타 → 400 confirm_name_mismatch
    const r = await app.request("/members/steve/swap-runtime", json({ target_runtime: "codex", confirm_name: "steev" }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("confirm_name_mismatch");
    expect(readFileSync(registryPath, "utf-8")).toBe(before); // 아무것도 안 바뀜
  });

  test("허용 안 되는 target_runtime → 400 invalid_runtime, checkRuntimeAuth 미호출", async () => {
    process.env.APPROVAL_EXECUTION_ENABLED = "1";
    let authCalls = 0;
    const { app } = setup(AGENTS, { checkRuntimeAuth: async (rt: string) => { authCalls++; return { runtime: rt, loggedIn: true, detail: "", fixHint: "" }; }, activateMember: activateOk });
    const r = await app.request("/members/steve/swap-runtime", json({ target_runtime: "bogus", confirm_name: "Steve" }));
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe("invalid_runtime");
    expect(authCalls).toBe(0);
  });

  test("preflight 미로그인 → 400 preflight_blocked, 레지스트리 불변", async () => {
    process.env.APPROVAL_EXECUTION_ENABLED = "1";
    const { app, registryPath } = setup(AGENTS, {
      checkRuntimeAuth: async (rt: string) => ({ runtime: rt, loggedIn: false, detail: "미로그인", fixHint: "codex login 하세요" }),
      activateMember: activateOk,
    });
    const before = readFileSync(registryPath, "utf-8");
    const r = await app.request("/members/steve/swap-runtime", json({ target_runtime: "codex", confirm_name: "Steve" }));
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.code).toBe("preflight_blocked");
    expect(readFileSync(registryPath, "utf-8")).toBe(before);
  });

  test("off 공식멤버 runtime swap 재활성은 15명 만석에서 409", async () => {
    process.env.APPROVAL_EXECUTION_ENABLED = "1";
    const offTarget = { ...AGENTS[1], id: "off-target", display_name: "Off Target", nicknames: ["off-target"] };
    const active = Array.from({ length: MAX_OFFICIAL_TEAM_MEMBERS }, (_, i) => ({
      ...AGENTS[0], id: `active${i}`, display_name: `Active ${i}`, nicknames: [`active${i}`],
    }));
    const offFile = join(mkdtempSync(join(tmpdir(), "settings-swap-limit-off-")), "agent-off.txt");
    process.env.TEAMOS_AGENT_OFF_FILE = offFile;
    writeFileSync(offFile, "off-target\n", "utf-8");
    const { app } = setup([offTarget, ...active], { checkRuntimeAuth: authOk, activateMember: activateOk });
    const r = await app.request("/members/off-target/swap-runtime", json({ target_runtime: "codex", confirm_name: "Off Target" }));
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.code).toBe("member_limit");
    expect(body.error).toBe("team_member_limit_reached");
  });

  test("성공 스왑 → 200 + 레지스트리 runtime 갱신 + audit member_swap_done", async () => {
    process.env.APPROVAL_EXECUTION_ENABLED = "1";
    const { app, registryPath, db } = setup(AGENTS, { checkRuntimeAuth: authOk, activateMember: activateOk });
    const r = await app.request("/members/steve/swap-runtime", json({ target_runtime: "codex", confirm_name: "Steve", bot_token: "123456:" + "A".repeat(35) }));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    const steve = JSON.parse(readFileSync(registryPath, "utf-8")).find((a: any) => a.id === "steve");
    expect(steve.runtime).toBe("codex");
    expect(steve.status_provider).toBe("codex_cli");
    const audit = db.query("SELECT action FROM audit_event WHERE target = 'steve' ORDER BY id DESC LIMIT 1").get() as any;
    expect(audit?.action).toBe("member_swap_done");
  });
});

describe("영입 OT / 능력 카탈로그", () => {
  const members = (count: number) => Array.from({ length: count }, (_, i) => ({
    id: `member${i}`,
    display_name: `Member ${i}`,
    nicknames: [`member${i}`],
    role: "member",
    runtime: "claude_channel",
    status_provider: "claude_tmux",
  }));

  test("recruit는 team_name+lead_id+owner_name 첫세팅 전 setup_incomplete 400", async () => {
    const { app } = setup();
    const r = await app.request("/members/recruit", json({ id: "lui", display_name: "Lui", role: "fullstack", runtime: "openclaw" }));
    const body = await r.json();
    expect(r.status).toBe(400);
    expect(body.error).toBe("setup_incomplete");
    expect(body.message).toContain("먼저 팀명·팀장ID·팀장이름 세팅");
    expect(body.missing.owner_name).toBe(true);
  });
  test("capabilities 카탈로그", async () => {
    const { app } = setup();
    const caps = (await (await app.request("/capabilities")).json()) as any[];
    expect(caps.length).toBeGreaterThan(5);
    expect(caps.some((c) => c.key === "owner_routing")).toBe(true);
    expect(caps[0]).toHaveProperty("category");
  });
  test("recruit → ot_id + member + ot 레코드(register done, provision next)", async () => {
    const { app, registryPath } = setupReady();
    const r = await app.request("/members/recruit", json({ id: "lui", display_name: "Lui", role: "fullstack", runtime: "openclaw", persona: "풀스택 개발자" }));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ot_id).toMatch(/^ot_/);
    expect(body.member.id).toBe("lui");
    expect(body.member.icon).toBeTruthy();
    expect(JSON.parse(readFileSync(registryPath, "utf-8")).some((a: any) => a.id === "lui")).toBe(true);
    const ot = await (await app.request(`/ot/${body.ot_id}`)).json();
    expect(ot.stage).toBe("provision");
    expect(ot.steps.find((s: any) => s.key === "register").state).toBe("done");
    expect(ot.joined).toBe(false);
  });
  test("첫 recruit 멤버 → coordinator capability 자동 부여", async () => {
    const { app, registryPath } = setupReady([]);
    const r = await app.request("/members/recruit", json({ id: "first", display_name: "First", role: "lead", runtime: "openclaw" }));
    expect(r.status).toBe(200);
    const first = JSON.parse(readFileSync(registryPath, "utf-8")).find((a: any) => a.id === "first");
    expect(first.capabilities).toContain("coordinator");
  });
  test("recruit 중복 409 / 잘못된 runtime 400", async () => {
    const { app } = setupReady();
    expect((await app.request("/members/recruit", json({ id: "bill", display_name: "X", role: "r" }))).status).toBe(409);
    expect((await app.request("/members/recruit", json({ id: "zee", display_name: "Z", role: "r", runtime: "bogus" }))).status).toBe(400);
  });
  test("공식 활성 팀원 15명이면 일반 추가와 recruit를 모두 409로 차단한다", async () => {
    const full = members(MAX_OFFICIAL_TEAM_MEMBERS);
    const { app } = setupReady(full);
    for (const path of ["/members", "/members/recruit"]) {
      const r = await app.request(path, json({ id: "extra", display_name: "Extra", role: "member", runtime: "claude_channel" }));
      const body = await r.json();
      expect(r.status).toBe(409);
      expect(body.error).toBe("team_member_limit_reached");
      expect(body.limit).toBe(15);
      expect(body.current).toBe(15);
      expect(body.hint).toContain("정지하거나 퇴사");
    }
  });
  test("비공식·정지 팀원은 15명 상한 계산에서 제외하고, 정지 팀원 재기동은 빈 자리가 없으면 차단한다", async () => {
    const offFile = join(mkdtempSync(join(tmpdir(), "settings-limit-off-")), "agent-off.txt");
    process.env.TEAMOS_AGENT_OFF_FILE = offFile;
    writeFileSync(offFile, "member14\n", "utf-8");
    const list = [
      ...members(15),
      { ...members(1)[0], id: "observer", display_name: "Observer", nicknames: ["observer"], team_official_member: false },
    ];
    const { app } = setupReady(list);

    const add = await app.request("/members/recruit", json({ id: "extra", display_name: "Extra", role: "member", runtime: "claude_channel" }));
    expect(add.status).toBe(200); // 활성 공식 14명 → 15번째 허용

    const reactivate = await app.request("/members/member14/enabled", json({ enabled: true }));
    const body = await reactivate.json();
    expect(reactivate.status).toBe(409); // extra가 들어와 다시 활성 공식 15명
    expect(body.error).toBe("team_member_limit_reached");

    const shown = await (await app.request("/members")).json() as any[];
    expect(shown.find((m) => m.id === "member14").off).toBe(true);
    expect(shown.find((m) => m.id === "observer").team_official_member).toBe(false);
  });
  test("ot advance → joined까지 진행", async () => {
    const { app } = setupReady();
    const { ot_id } = await (await app.request("/members/recruit", json({ id: "lui", display_name: "Lui", role: "dev", runtime: "openclaw" }))).json();
    for (const key of ["provision", "preflight", "bundle", "join"]) await app.request(`/ot/${ot_id}/advance`, json({ key, state: "done" }));
    const ot = await (await app.request(`/ot/${ot_id}`)).json();
    expect(ot.stage).toBe("joined");
    expect(ot.joined).toBe(true);
    expect(ot.done).toBe(true);
  });
  test("ot preflight-recheck — 엔드포인트 존재(웹 '다시 확인' 버튼 대상) + preflight 상태 반환, 토큰/계정값 미노출", async () => {
    const { app } = setupReady();
    const { ot_id } = await (await app.request("/members/recruit", json({ id: "lui", display_name: "Lui", role: "dev", runtime: "claude_channel" }))).json();
    const r = await app.request(`/ot/${ot_id}/preflight-recheck`, json({}));
    expect(r.status).toBe(200); // 404가 아님(엔드포인트 누락 회귀 방지)
    const body = await r.json();
    const pf = body.ot.steps.find((s: any) => s.key === "preflight");
    expect(pf).toBeTruthy();
    expect(["done", "blocked"]).toContain(pf.state); // 로그인/미로그인 둘 중 하나로 확정
    expect(typeof body.ok).toBe("boolean");
    // 없는 OT → 404
    expect((await app.request("/ot/ot_nope/preflight-recheck", json({}))).status).toBe(404);
  });
  test("ot bundle = OT 패키지(미션·persona·능력·연결)", async () => {
    const { app } = setupReady();
    const { ot_id } = await (await app.request("/members/recruit", json({ id: "lui", display_name: "Lui", role: "dev", runtime: "openclaw", persona: "풀스택" }))).json();
    const b = await (await app.request(`/ot/${ot_id}/bundle`)).json();
    expect(b.team_os.mission).toContain("테스트 팀");
    expect(b.persona).toBe("풀스택");
    expect(Array.isArray(b.capabilities)).toBe(true);
    expect(b.connection.runtime).toBe("openclaw");
    expect(b.first_action).toContain("feedback-mode");
  });
  test("ot 없는 id 404", async () => {
    const { app } = setup();
    expect((await app.request("/ot/ot_nope")).status).toBe(404);
    expect((await app.request("/ot/ot_nope/bundle")).status).toBe(404);
  });
  test("recruit → awaiting_input(bot_token) 마커 세팅", async () => {
    const { app } = setupReady();
    const { ot_id } = await (await app.request("/members/recruit", json({ id: "lui", display_name: "Lui", role: "dev", runtime: "openclaw" }))).json();
    const ot = await (await app.request(`/ot/${ot_id}`)).json();
    expect(ot.awaiting_input).not.toBeNull();
    expect(ot.awaiting_input.kind).toBe("bot_token");
    expect(ot.awaiting_input.fields[0].key).toBe("bot_token");
    expect(ot.awaiting_input.fields[0].secret).toBe(true);
  });
  test("provision: 유효 토큰 → 마커 clear + advance + 안전저장(값 echo X)", async () => {
    const { app, dir } = setupReady(AGENTS, { validateBotToken: okBotToken });
    const { ot_id, member } = await (await app.request("/members/recruit", json({ id: "forin", display_name: "Forin", role: "tutor", runtime: "hermes_agent" }))).json();
    const token = "1234567:" + "A".repeat(35);
    const r = await app.request(`/ot/${ot_id}/provision`, json({ bot_token: token }));
    expect(r.status).toBe(200);
    const bodyText = await r.text();
    expect(bodyText).not.toContain(token); // 토큰 echo 절대 X
    const ot = JSON.parse(bodyText).ot;
    expect(ot.awaiting_input).toBeNull(); // 마커 clear
    const pv = ot.steps.find((s: any) => s.key === "provision");
    expect(pv.state).toBe("done");
    expect(pv.detail).toContain("@verifiedbot"); // getMe로 검증된 실제 봇 username = 긍정 증거
    // 시크릿 파일 저장됨(값은 파일로만)
    expect(existsSync(join(dir, "var", "secrets", `${member.id}.bot-token`))).toBe(true);
  });
  test("provision: 잘못된 토큰 400(echo X) / 없는 ot 404", async () => {
    const { app } = setupReady();
    const { ot_id } = await (await app.request("/members/recruit", json({ id: "lui", display_name: "Lui", role: "dev", runtime: "openclaw" }))).json();
    const bad = await app.request(`/ot/${ot_id}/provision`, json({ bot_token: "not-a-token" }));
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain("not-a-token");
    expect((await app.request("/ot/ot_nope/provision", json({ bot_token: "1234567:" + "A".repeat(35) }))).status).toBe(404);
  });
  test("provision: getMe 실패(죽은/폐기 봇) → 400 bot_token_dead + provision 미완료 + 저장 안 함", async () => {
    const deadValidate = async (_t: string) => ({ ok: false as const, error: "bot_token_dead" as const });
    const { app, dir } = setupReady(AGENTS, { validateBotToken: deadValidate });
    const { ot_id, member } = await (await app.request("/members/recruit", json({ id: "zed", display_name: "Zed", role: "dev", runtime: "hermes_agent" }))).json();
    const token = "1234567:" + "A".repeat(35); // 형식은 유효하지만 getMe가 죽었다고 판정
    const r = await app.request(`/ot/${ot_id}/provision`, json({ bot_token: token }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("bot_token_dead");
    // 반쯤 통과 방지: provision 이 done 으로 안 넘어가고 토큰 파일도 저장 안 됨
    const ot = await (await app.request(`/ot/${ot_id}`)).json();
    expect(ot.steps.find((s: any) => s.key === "provision").state).not.toBe("done");
    expect(existsSync(join(dir, "var", "secrets", `${member.id}.bot-token`))).toBe(false);
  });
  test("provision: getMe 네트워크 실패 → 503 getme_failed(사용자 토큰 탓 아님)", async () => {
    const netFail = async (_t: string) => ({ ok: false as const, error: "getme_failed" as const });
    const { app } = setupReady(AGENTS, { validateBotToken: netFail });
    const { ot_id } = await (await app.request("/members/recruit", json({ id: "net", display_name: "Net", role: "dev", runtime: "hermes_agent" }))).json();
    const r = await app.request(`/ot/${ot_id}/provision`, json({ bot_token: "1234567:" + "A".repeat(35) }));
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe("getme_failed");
  });
  test("activate: 첫 모델콜 subscription/quota 실패 → joined가 아니라 subscription_needed 안내", async () => {
    const authOk = async (runtime: string) => ({ runtime, loggedIn: true, detail: "auth ok", fixHint: "" });
    const activateOk = async () => ({ ok: true, steps: [{ step: "runtime", ok: true, detail: "mock runtime" }, { step: "bus-wake", ok: true, detail: "mock wake" }] });
    const firstModelCall = async (input: { id: string; runtime: string }) => ({
      runtime: input.runtime,
      ok: false,
      subscriptionNeeded: true,
      detail: "429 insufficient_quota billing",
    });
    const { app } = setupReady(AGENTS, { checkRuntimeAuth: authOk, activateMember: activateOk, firstModelCall, validateBotToken: okBotToken });
    const { ot_id } = await (await app.request("/members/recruit", json({ id: "cody", display_name: "Cody", role: "dev", runtime: "codex" }))).json();
    const token = "1234567:" + "A".repeat(35);
    expect((await app.request(`/ot/${ot_id}/provision`, json({ bot_token: token }))).status).toBe(200);
    const r = await app.request(`/ot/${ot_id}/activate`, json({}));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.subscription_needed).toBe(true);
    expect(body.error).toBe("subscription_needed");
    expect(body.ot.joined).not.toBe(true);
    const joinStep = body.ot.steps.find((s: any) => s.key === "join");
    expect(joinStep.state).toBe("blocked");
    expect(joinStep.detail).toContain("subscription_needed");
    expect(body.ot.stage).toBe("join");
  });
  test("activate: 중앙 팀원 상한 가드 실패를 409로 전달", async () => {
    const authOk = async (runtime: string) => ({ runtime, loggedIn: true, detail: "auth ok", fixHint: "" });
    const activateLimited = async () => ({
      ok: false, code: "member_limit" as const, error: "team_member_limit_reached",
      steps: [{ step: "member-limit", ok: false, detail: "활성 공식 팀원은 최대 15명입니다." }],
    });
    const { app } = setupReady(AGENTS, { checkRuntimeAuth: authOk, activateMember: activateLimited, validateBotToken: okBotToken });
    const { ot_id } = await (await app.request("/members/recruit", json({ id: "cody-limit", display_name: "Cody Limit", role: "dev", runtime: "openclaw" }))).json();
    const token = "1234567:" + "A".repeat(35);
    expect((await app.request(`/ot/${ot_id}/provision`, json({ bot_token: token }))).status).toBe(200);
    const r = await app.request(`/ot/${ot_id}/activate`, json({}));
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.error).toBe("team_member_limit_reached");
    expect(body.steps[0]?.step).toBe("member-limit");
  });
});

describe("settings: Slack 지원 채널", () => {
  test("slack/status → ready/partial/not_connected 집계", async () => {
    const { app, dir } = setup([
      { ...AGENTS[0], slack_bot_user_id: "U0BILL0000", slack_app_name: "GD Bill" },
      { ...AGENTS[1], slack_bot_user_id: null, slack_app_name: null },
    ]);
    const tokenDir = join(dir, "slack-tokens");
    mkdirSync(tokenDir, { recursive: true });
    writeFileSync(join(tokenDir, "bill.env"), "SLACK_BOT_TOKEN=xoxb-fake-aa-abc\n", { mode: 0o600 });
    const status = await (await app.request("/slack/status")).json();
    expect(status.summary.ready).toBe(1);
    expect(status.summary.not_connected).toBe(1);
    expect(status.members.find((m: any) => m.id === "bill").supports_bot_mentions).toBe(true);
    expect(status.members.find((m: any) => m.id === "bill").mode).toBe("webhook");
    expect(status.members.find((m: any) => m.id === "steve").state).toBe("not_connected");
  });

  test("members/:id/slack 저장 → registry + token file, socket creds secret echo 없음", async () => {
    const { app, registryPath, dir } = setup();
    const token = "xoxb-fake-456-abcdef";
    const appToken = "xapp-1-fake-456-abcdef";
    const r = await app.request("/members/steve/slack", json({
      slack_bot_user_id: "U0STEVE000",
      slack_app_name: "GD Steve",
      slack_app_id: "A0STEVE000",
      slack_bot_token: token,
      slack_signing_secret: "a".repeat(32),
      slack_app_token: appToken,
      slack_connection_mode: "socket",
    }));
    expect(r.status).toBe(200);
    const bodyText = await r.text();
    expect(bodyText).not.toContain(token);
    expect(bodyText).not.toContain(appToken);
    const body = JSON.parse(bodyText);
    expect(body.member.has_app_token).toBe(true);
    expect(body.member.mode).toBe("socket");
    expect(body.member.slack_connection_mode).toBe("socket");
    expect(body.member.socket_ready).toBe(true);
    const steve = JSON.parse(readFileSync(registryPath, "utf-8")).find((a: any) => a.id === "steve");
    expect(steve.slack_bot_user_id).toBe("U0STEVE000");
    expect(steve.slack_app_name).toBe("GD Steve");
    expect(steve.slack_connection_mode).toBe("socket");
    expect(steve.channel_identities.slack).toBe("U0STEVE000");
    const tokenFile = join(dir, "slack-tokens", "steve.env");
    expect(existsSync(tokenFile)).toBe(true);
    const tokenText = readFileSync(tokenFile, "utf-8");
    expect(tokenText).toContain("SLACK_APP_ID=A0STEVE000");
    expect(tokenText).toContain("SLACK_APP_TOKEN=xapp-1-fake-456-abcdef");
    expect(tokenText).not.toContain("SLACK_MODE=");
  });

  test("members/:id/slack 유효성 검증", async () => {
    const { app } = setup();
    expect((await app.request("/members/steve/slack", json({ slack_bot_user_id: "bad" }))).status).toBe(400);
    expect((await app.request("/members/steve/slack", json({ slack_bot_user_id: "U0STEVE000", slack_bot_token: "bad" }))).status).toBe(400);
    expect((await app.request("/members/steve/slack", json({ slack_app_token: "bad" }))).status).toBe(400);
    expect((await app.request("/members/steve/slack", json({ slack_connection_mode: "poll" }))).status).toBe(400);
    expect((await app.request("/members/steve/slack", json({ slack_connection_mode: "socket" }))).status).toBe(400);
    expect((await app.request("/members/ghost/slack", json({ slack_bot_user_id: "U0GHOST000", slack_bot_token: "xoxb-fa-ke-a" }))).status).toBe(404);
  });
});

describe("settings: 전체 재적용 롤백 (6h .bak 복원)", () => {
  test("재적용 → .bak 기록 → 롤백 복원 → 창 소멸", async () => {
    const pdir = mkdtempSync(join(tmpdir(), "regen-rollback-"));
    const personaFile = join(pdir, "SOUL.md");
    const loadingFile = join(pdir, "CLAUDE.md");
    const ORIGINAL = "# Steve\n\n원본 내용 — 핵심룰 섹션 없음.\n";
    const ORIGINAL_LOADING = "# Steve\n\n원본 CLAUDE 로딩 내용 — 핵심룰 섹션 없음.\n";
    writeFileSync(personaFile, ORIGINAL, "utf-8");
    writeFileSync(loadingFile, ORIGINAL_LOADING, "utf-8");
    const agents = [
      { id: "steve", display_name: "Steve", nicknames: ["steve"], role: "fullstack", runtime: "claude_channel", status_provider: "claude_tmux", avatar_emoji: "🧑‍💻", moderator_eligible: false, persona_file: personaFile, workspace_path: pdir },
    ];
    const { app } = setup(agents);

    // 1) 재적용 — 파일 변경 + .bak 생성(=원본) + 롤백 가능 기록
    const j1 = await (await app.request("/members/regenerate-all-personas", json({}))).json();
    expect(j1.ok).toBe(true);
    expect(j1.rollback_available).toBe(true);
    expect(readFileSync(loadingFile, "utf-8")).not.toBe(ORIGINAL_LOADING); // 핵심룰/통신 주입됨
    expect(readFileSync(personaFile, "utf-8")).toBe(ORIGINAL); // SOUL.md는 persona 원문이라 주입하지 않음
    expect(existsSync(loadingFile + ".bak")).toBe(true);
    expect(readFileSync(loadingFile + ".bak", "utf-8")).toBe(ORIGINAL_LOADING);

    // 2) 롤백 상태 — available + 남은시간 > 0
    const s1 = await (await app.request("/members/regenerate-all-personas/rollback")).json();
    expect(s1.available).toBe(true);
    expect(s1.remaining_ms).toBeGreaterThan(0);

    // 3) 롤백 실행 — 원본 복원
    const jrb = await (await app.request("/members/regenerate-all-personas/rollback", json({}))).json();
    expect(jrb.ok).toBe(true);
    expect(jrb.restored.length).toBeGreaterThan(0);
    expect(readFileSync(loadingFile, "utf-8")).toBe(ORIGINAL_LOADING); // 원본 복원
    expect(readFileSync(personaFile, "utf-8")).toBe(ORIGINAL); // SOUL.md 유지

    // 4) 롤백 후 — 기록 삭제되어 창 소멸
    const s2 = await (await app.request("/members/regenerate-all-personas/rollback")).json();
    expect(s2.available).toBe(false);
  });

  test("재적용 없이 롤백 — 404 nothing_to_rollback", async () => {
    const pdir = mkdtempSync(join(tmpdir(), "regen-rollback2-"));
    const agents = [
      { id: "steve", display_name: "Steve", nicknames: ["steve"], role: "fullstack", runtime: "claude_channel", status_provider: "claude_tmux", avatar_emoji: "🧑", moderator_eligible: false, persona_file: join(pdir, "SOUL.md"), workspace_path: pdir },
    ];
    const { app } = setup(agents);
    expect((await app.request("/members/regenerate-all-personas/rollback", json({}))).status).toBe(404);
    expect((await (await app.request("/members/regenerate-all-personas/rollback")).json()).available).toBe(false);
  });
});
