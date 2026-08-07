/**
 * settings 라우트 — 팀명·Mission·팀원 추가/퇴사. 파일 쓰기는 temp 로 격리(원본 불변).
 * 사이드이펙트 방지 핵심 검증: §2 보존, 퇴사 이름확인 가드, 중복/유효성, 백업 생성.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { MERGE_APPROVERS_SETTING_KEY } from "../lib/approvals";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../db/migrate";
import { appendAudit, listAgents } from "../db/queries";
import { syncRegistry } from "../lib/registry";
import { allowedRuntimes, createSettingsApp, MAX_OFFICIAL_TEAM_MEMBERS, publicRuntimeOptions, removePathWithRetries } from "./settings";
import { MEMBERS_ROOT } from "../lib/personaTemplates";
// 사용자가 붙여넣는 최종 JSON 은 서버 매니페스트 + 이 변환의 합성이다. 접합부를 검사하려고 가져온다.
import { socketManifest } from "../../web/components/AgentSlack";

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

// ★런타임 인증 검사 기본 스텁 — 테스트가 실제 머신을 탐침하지 않게 한다.★
//   publicRuntimeGate(settings.ts) 가 openclaw/hermes 영입 때 checkRuntimeAuth 를 부르는데,
//   주입이 없으면 ★실 머신의 openclaw 바이너리·~/.hermes 프로필을 찾는다.★
//   그래서 그 런타임이 깔린 기기에서만 통과하는 ★환경결합 테스트★ 가 됐다 —
//   fresh clone(=CI·외부 기여자 조건)에서 10건이 400 으로 떨어졌다(2026-07-27 실측).
//   archiveWorkspace=noop · skipRuntimeCleanup=true 와 같은 이유의 격리다: 테스트는 이 기기 상태를 읽지 않는다.
//   ★미준비 상태를 검증하는 테스트는 각자 notReady 를 주입한다★ — 그쪽이 의도적으로 덮어쓴다.
const readyAuth = async (runtime: string) => ({ runtime, loggedIn: true, detail: "테스트 스텁(준비됨)", fixHint: "" });

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
  const app = createSettingsApp({ db, registryPath, teamOsPath, appendAudit, onRegistryChanged: () => syncRegistry(db, registryPath), archiveWorkspace: () => null, skipRuntimeCleanup: true, checkRuntimeAuth: readyAuth, ...overrides });
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

  /* 2026-07-26 리사 고착 재현. 승인이 이 라우트 밖에서 먼저 끝나면(스킬 [6] 이 안내하는 access.json
   * 수동 편집·플러그인 promote-pending) pending 이 비어 409 만 반복되고 위저드를 닫을 길이 사라졌다.
   * 승인이 이미 성립했으면 어느 경로였든 합류로 정합돼야 한다. */
  test("이미 승인된 상태면 pending 이 없어도 합류로 정합된다 (access.json 은 불변)", async () => {
    const { app, dir, db } = setup();
    const channels = join(dir, "claude-channels");
    process.env.CLAUDE_CHANNELS_DIR = channels;
    const accessDir = join(channels, "telegram-bill");
    mkdirSync(accessDir, { recursive: true });
    // 수동 승인이 끝난 뒤의 실제 모양: allowlist + allowFrom 1건 + pending 비어 있음
    const approvedAccess = { dmPolicy: "allowlist", allowFrom: ["1000000001"], groups: {}, pending: {} };
    writeFileSync(join(accessDir, "access.json"), JSON.stringify(approvedAccess));
    db.query("INSERT INTO setting (key, value) VALUES ('owner_chat_id', '1000000001')").run();
    const steps = [
      { key: "register", state: "done" }, { key: "provision", state: "done" },
      { key: "preflight", state: "done" }, { key: "bundle", state: "done" }, { key: "join", state: "pending" },
    ];
    db.query("INSERT INTO ot(id,member_id,stage,steps_json) VALUES('ot_done','bill','join',?)").run(JSON.stringify({ steps }));

    const res = await app.request("/ot/ot_done/claude-pair-approve", json({ code: "abc123" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, already_approved: true });

    // 위저드가 닫혔다
    const row = db.query("SELECT stage FROM ot WHERE id='ot_done'").get() as any;
    expect(row.stage).toBe("joined");
    // 승인 파일은 건드리지 않는다 — 이 경로는 표시 정합일 뿐이다
    expect(JSON.parse(readFileSync(join(accessDir, "access.json"), "utf-8"))).toEqual(approvedAccess);
    delete process.env.CLAUDE_CHANNELS_DIR;
  });

  /* 정합 조건을 '누군가 승인됨' 이 아니라 '★팀장이 실제로 닿을 수 있음★' 까지 좁힌다.
   * 팀장 chat_id 는 setting(owner_chat_id)/env 같은 ★비순환★ 출처에서만 읽는다 — resolveOwnerDmId() 는
   * 못 찾으면 access.json 의 allowFrom[0] 을 읽는 폴백이 있어서, 그걸로 allowFrom 을 검증하면
   * 자기 자신을 확인하는 순환이 되어 무조건 통과한다. */
  test("★팀장 id 를 아는데 allowlist 에 없으면 합류로 만들지 않는다★ (남이 승인된 경우)", async () => {
    const oldEnv = process.env.GD_CHAT_ID; delete process.env.GD_CHAT_ID;
    const { app, dir, db } = setup();
    const channels = join(dir, "claude-channels");
    process.env.CLAUDE_CHANNELS_DIR = channels;
    const accessDir = join(channels, "telegram-bill");
    mkdirSync(accessDir, { recursive: true });
    // 승인은 돼 있지만 허용된 사람이 팀장이 아니다
    writeFileSync(join(accessDir, "access.json"), JSON.stringify({
      dmPolicy: "allowlist", allowFrom: ["999999999"], groups: {}, pending: {},
    }));
    db.query("INSERT INTO setting (key, value) VALUES ('owner_chat_id', '1000000001')").run();
    const steps = [
      { key: "register", state: "done" }, { key: "provision", state: "done" },
      { key: "preflight", state: "done" }, { key: "bundle", state: "done" }, { key: "join", state: "pending" },
    ];
    db.query("INSERT INTO ot(id,member_id,stage,steps_json) VALUES('ot_other','bill','join',?)").run(JSON.stringify({ steps }));

    const res = await app.request("/ot/ot_other/claude-pair-approve", json({ code: "abc123" }));
    expect(res.status).toBe(409);
    expect((db.query("SELECT stage FROM ot WHERE id='ot_other'").get() as any).stage).toBe("join");

    // 같은 상태에서 팀장이 allowlist 에 들어가면 정합된다
    writeFileSync(join(accessDir, "access.json"), JSON.stringify({
      dmPolicy: "allowlist", allowFrom: ["999999999", "1000000001"], groups: {}, pending: {},
    }));
    const res2 = await app.request("/ot/ot_other/claude-pair-approve", json({ code: "abc123" }));
    expect(res2.status).toBe(200);
    expect((db.query("SELECT stage FROM ot WHERE id='ot_other'").get() as any).stage).toBe("joined");
    delete process.env.CLAUDE_CHANNELS_DIR;
    if (oldEnv === undefined) delete process.env.GD_CHAT_ID; else process.env.GD_CHAT_ID = oldEnv;
  });

  /* 코덱스 리뷰: "모르면 조건을 뺀다" 는 ★강화한 척★ 이었다. owner_chat_id 는 부팅 시 1회만 자동
   * persist 되고 Settings 입력도 선택이라, 정작 필요한 순간(첫 페어링·수동 promote 직후)에는 비어 있다.
   * 그래서 팀장 id 를 모르면 정합하지 않고, 대신 ★무엇을 하면 열리는지★ 를 알려준다. */
  /* ★persist 가 실패해도 조용히 넘기지 않는다★(코덱스 리뷰). 승인은 이미 access.json 에 기록됐으니
   * 되돌릴 수 없다 — 대신 응답에 사실을 밝힌다. 안 그러면 나중에 정합이 owner_identity_unknown 으로
   * 막혔을 때 ★왜 막혔는지 알 방법이 없다.★ 침묵을 고치는 PR 에서 침묵을 남길 뻔했다. */
  test("★신원 저장이 실패해도 승인은 유지하되 사실을 알린다★", async () => {
    const { app, dir, db } = setup();
    const channels = join(dir, "claude-channels");
    process.env.CLAUDE_CHANNELS_DIR = channels;
    const accessDir = join(channels, "telegram-bill");
    mkdirSync(accessDir, { recursive: true });
    writeFileSync(join(accessDir, "access.json"), JSON.stringify({
      dmPolicy: "pairing", allowFrom: [], groups: {},
      pending: { fff999: { senderId: "1000000001", chatId: "1000000001", expiresAt: Date.now() + 60_000 } },
    }));
    const steps = [
      { key: "register", state: "done" }, { key: "provision", state: "done" },
      { key: "preflight", state: "done" }, { key: "bundle", state: "done" }, { key: "join", state: "pending" },
    ];
    db.query("INSERT INTO ot(id,member_id,stage,steps_json) VALUES('ot_pfail','bill','join',?)").run(JSON.stringify({ steps }));
    // setting 테이블을 지워 persist 를 실패시킨다(승인 자체는 파일에 기록되므로 영향 없어야 한다)
    db.query("DROP TABLE setting").run();

    const res = await app.request("/ot/ot_pfail/claude-pair-approve", json({ code: "fff999" }));
    expect(res.status).toBe(200);                       // ★승인은 유지된다★ — 되돌리면 안 된다
    const b = await res.json() as any;
    expect(b.ok).toBe(true);
    expect(b.owner_identity_persisted).toBe(false);     // ★사실을 숨기지 않는다★
    expect(typeof b.warning).toBe("string");
    // 승인 자체는 파일에 기록됐다
    const stored = JSON.parse(readFileSync(join(accessDir, "access.json"), "utf-8"));
    expect(stored.allowFrom).toContain("1000000001");
    delete process.env.CLAUDE_CHANNELS_DIR;
  });

  test("★팀장 id 를 모르면 정합하지 않는다★ — owner_identity_unknown (막다른 길이 아니라 복구행동 명시)", async () => {
    const oldEnv = process.env.GD_CHAT_ID; delete process.env.GD_CHAT_ID;
    const { app, dir, db } = setup();
    const channels = join(dir, "claude-channels");
    process.env.CLAUDE_CHANNELS_DIR = channels;
    const accessDir = join(channels, "telegram-bill");
    mkdirSync(accessDir, { recursive: true });
    writeFileSync(join(accessDir, "access.json"), JSON.stringify({
      dmPolicy: "allowlist", allowFrom: ["999999999"], groups: {}, pending: {},
    }));
    const steps = [
      { key: "register", state: "done" }, { key: "provision", state: "done" },
      { key: "preflight", state: "done" }, { key: "bundle", state: "done" }, { key: "join", state: "pending" },
    ];
    db.query("INSERT INTO ot(id,member_id,stage,steps_json) VALUES('ot_noowner','bill','join',?)").run(JSON.stringify({ steps }));

    const res = await app.request("/ot/ot_noowner/claude-pair-approve", json({ code: "abc123" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "owner_identity_unknown" });
    expect((db.query("SELECT stage FROM ot WHERE id='ot_noowner'").get() as any).stage).toBe("join");
    delete process.env.CLAUDE_CHANNELS_DIR;
    if (oldEnv === undefined) delete process.env.GD_CHAT_ID; else process.env.GD_CHAT_ID = oldEnv;
  });

  /* 위 fail-closed 가 막다른 길이 되지 않으려면 ★정상 승인이 owner_chat_id 를 채워야★ 한다.
   * 정상 승인은 팀장 신원을 확인할 수 있는 유일한 지점이다(검증된 senderId). */
  test("★정상 승인은 owner_chat_id 를 채운다★ — 단 팀장이 직접 넣은 값은 덮지 않는다", async () => {
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
    db.query("INSERT INTO ot(id,member_id,stage,steps_json) VALUES('ot_persist','bill','join',?)").run(JSON.stringify({ steps }));

    expect((await app.request("/ot/ot_persist/claude-pair-approve", json({ code: "abc123" }))).status).toBe(200);
    expect((db.query("SELECT value FROM setting WHERE key='owner_chat_id'").get() as any)?.value).toBe("1000000001");

    // ★빈 행이 있어도 채워야 한다★ — INSERT…WHERE NOT EXISTS 로 쓰면 여기서 PK 충돌이 나고
    //   catch 가 삼켜 값이 영영 안 채워진다(코덱스 리뷰). UPSERT 라야 통과한다.
    db.query("DELETE FROM setting WHERE key='owner_chat_id'").run();
    db.query("INSERT INTO setting (key, value) VALUES ('owner_chat_id','')").run();
    writeFileSync(join(accessDir, "access.json"), JSON.stringify({
      dmPolicy: "pairing", allowFrom: [], groups: {},
      pending: { aaa111: { senderId: "1000000001", chatId: "1000000001", expiresAt: Date.now() + 60_000 } },
    }));
    db.query("INSERT INTO ot(id,member_id,stage,steps_json) VALUES('ot_empty','bill','join',?)").run(JSON.stringify({ steps }));
    expect((await app.request("/ot/ot_empty/claude-pair-approve", json({ code: "aaa111" }))).status).toBe(200);
    expect((db.query("SELECT value FROM setting WHERE key='owner_chat_id'").get() as any)?.value).toBe("1000000001");

    // 이미 값이 있으면 나중 페어링이 조용히 바꾸지 않는다
    writeFileSync(join(accessDir, "access.json"), JSON.stringify({
      dmPolicy: "pairing", allowFrom: [], groups: {},
      pending: { def456: { senderId: "2222222222", chatId: "2222222222", expiresAt: Date.now() + 60_000 } },
    }));
    db.query("INSERT INTO ot(id,member_id,stage,steps_json) VALUES('ot_persist2','bill','join',?)").run(JSON.stringify({ steps }));
    expect((await app.request("/ot/ot_persist2/claude-pair-approve", json({ code: "def456" }))).status).toBe(200);
    expect((db.query("SELECT value FROM setting WHERE key='owner_chat_id'").get() as any)?.value).toBe("1000000001");
    delete process.env.CLAUDE_CHANNELS_DIR;
  });

  test("승인도 pending 도 없으면 여전히 409 — 정합이 미승인을 합류로 만들지 않는다", async () => {
    const { app, dir, db } = setup();
    const channels = join(dir, "claude-channels");
    process.env.CLAUDE_CHANNELS_DIR = channels;
    const accessDir = join(channels, "telegram-bill");
    mkdirSync(accessDir, { recursive: true });
    writeFileSync(join(accessDir, "access.json"), JSON.stringify({ dmPolicy: "pairing", allowFrom: [], groups: {}, pending: {} }));
    const steps = [
      { key: "register", state: "done" }, { key: "provision", state: "done" },
      { key: "preflight", state: "done" }, { key: "bundle", state: "done" }, { key: "join", state: "pending" },
    ];
    db.query("INSERT INTO ot(id,member_id,stage,steps_json) VALUES('ot_none','bill','join',?)").run(JSON.stringify({ steps }));

    const res = await app.request("/ot/ot_none/claude-pair-approve", json({ code: "abc123" }));
    expect(res.status).toBe(409);
    expect((db.query("SELECT stage FROM ot WHERE id='ot_none'").get() as any).stage).toBe("join");
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
    expect(s).toEqual({ has_capture_token: false, capture_group_id: null, router_enabled: true, mcp_enabled: false }); // ★MCP 기본 꺼짐★
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

// ★GitHub 계정·승인자 ★쓰기★ 경로 (2026-07-29, 하네스가 잡은 차단 사유)★
//   읽기만 열었더니 ★값을 넣을 방법이 아예 없었다★ — DB 에 행조차 없고 PUT 이 그 키를 안 받았다.
//   그러면 머지 게이트가 ★항상 '설정 누락' 으로 실패★ 하고 탈출구는 --skip-approver-check 하나뿐이다.
//   ★도달 가능한 상태가 '건너뛰기' 뿐인 게이트는 사람에게 건너뛰기를 훈련시킨다.★
describe("settings: 머지 승인자 설정 쓰기", () => {
  test("★쓰고 다시 읽을 수 있다★ — 없으면 머지 게이트를 켤 방법이 없다", async () => {
    const { app } = setup();
    const r = await app.request("/settings", put({
      github_team_account: "gdb3rys",
      github_approver_account: "gd452",
      merge_approvers_normal: "bill, codex,  steve",
    }));
    expect(r.status).toBe(200);
    const j = await (await app.request("/settings")).json() as any;
    expect(j.github_team_account).toBe("gdb3rys");
    expect(j.github_approver_account).toBe("gd452");
    expect(j.merge_approvers_normal).toBe("bill,codex,steve");   // 공백 정리 + 소문자
  });

  test("★쓰는 시점에 막는다★ — 안 그러면 '머지 때 알 수 없는 이유로 막힘' 이 된다", async () => {
    const { app } = setup();
    // 판정기는 [a-z0-9._-] 로 매칭한다 → 한글·@ 는 ★영원히 불일치★ 한다
    expect((await app.request("/settings", put({ merge_approvers_normal: "빌,steve" }))).status).toBe(400);
    expect((await app.request("/settings", put({ merge_approvers_normal: "@bill" }))).status).toBe(400);
    expect((await app.request("/settings", put({ github_approver_account: "not a name" }))).status).toBe(400);
    expect((await app.request("/settings", put({ github_team_account: "-leadinghyphen" }))).status).toBe(400);
  });

  test("★거부되면 아무것도 안 바뀐다★ — 반쯤 바뀐 보안 설정이 제일 위험하다", async () => {
    const { app } = setup();
    await app.request("/settings", put({ github_team_account: "old-team", github_approver_account: "old-appr" }));
    // 세 번째 키가 잘못됐다 — ★앞의 두 개도 저장되면 안 된다★ (ames 실측: 저장됐었다)
    const r = await app.request("/settings", put({
      github_team_account: "new-team", github_approver_account: "new-appr", merge_approvers_normal: "@invalid",
    }));
    expect(r.status).toBe(400);
    const j = await (await app.request("/settings")).json() as any;
    expect(j.github_team_account).toBe("old-team");
    expect(j.github_approver_account).toBe("old-appr");
  });

  test("★문자열이 아니면 거부★ — String() 강제변환이 숫자·배열을 삼켰다", async () => {
    const { app } = setup();
    expect((await app.request("/settings", put({ github_team_account: 123 }))).status).toBe(400);
    expect((await app.request("/settings", put({ merge_approvers_normal: ["bill", "steve"] }))).status).toBe(400);
    expect((await app.request("/settings", put({ github_approver_account: null }))).status).toBe(400);
  });

  // ★읽기만 구현돼 있던 키 (2026-07-30)★ — GET 은 값을 주는데 PUT 이 안 받아서, 보내면
  //   ok:true 를 받고 저장이 안 됐다. 증상이 조용해서 호출자는 저장된 줄 알고 넘어간다.
  test("★github_team_commit_email 을 쓰고 다시 읽을 수 있다★ (읽기만 열려 있던 키)", async () => {
    const { app } = setup();
    const r = await app.request("/settings", put({ github_team_commit_email: "1234+bot@users.noreply.github.com" }));
    expect(r.status).toBe(200);
    const j = await (await app.request("/settings")).json() as any;
    expect(j.github_team_commit_email).toBe("1234+bot@users.noreply.github.com");
  });

  test("커밋 이메일 형식 검증 — 잘못된 값은 커밋 시점에야 드러나므로 여기서 막는다", async () => {
    const { app } = setup();
    expect((await app.request("/settings", put({ github_team_commit_email: "not-an-email" }))).status).toBe(400);
    expect((await app.request("/settings", put({ github_team_commit_email: "a@b" }))).status).toBe(400);
    expect((await app.request("/settings", put({ github_team_commit_email: 123 }))).status).toBe(400);
    // 빈 문자열은 '해제' 로 허용
    expect((await app.request("/settings", put({ github_team_commit_email: "" }))).status).toBe(200);
  });
});

// ★모르는 키를 조용히 버리지 않는다 (2026-07-30)★
//   핸들러가 아는 키만 골라 처리하고 나머지를 무시한 뒤 ok:true 를 돌려줬다. 그래서 오타·미구현 키·
//   이름이 바뀐 키가 전부 ★성공으로 보였다.★ 실패는 고칠 수 있지만 조용한 성공은 고칠 기회가 없다.
describe("settings: 모르는 키는 400 으로 거절한다", () => {
  test("★오타 키가 성공으로 보이지 않는다★", async () => {
    const { app } = setup();
    const r = await app.request("/settings", put({ github_team_email: "x@y.com" }));  // 실제 키는 _commit_email
    expect(r.status).toBe(400);
    const j = await r.json() as any;
    expect(j.error).toBe("unknown_settings_key");
    expect(j.unknown).toContain("github_team_email");
    expect(String(j.hint)).toContain("github_team_commit_email");   // 올바른 키를 알려준다
  });

  test("아는 키와 모르는 키를 같이 보내면 ★아무것도 저장되지 않는다★", async () => {
    const { app } = setup();
    await app.request("/settings", put({ team_name: "before" }));
    const r = await app.request("/settings", put({ team_name: "after", bogus_key: "x" }));
    expect(r.status).toBe(400);
    const j = await (await app.request("/settings")).json() as any;
    expect(j.team_name).toBe("before");   // 모르는 키 때문에 거절 → 아는 키도 안 바뀐다
  });

  // ★200 만 보면 이 PR 이 죽이려던 결함이 목록의 반대쪽에서 살아남는다★ (steve 교차검증)
  //   WRITABLE_KEYS 와 핸들러 분기가 ★따로 관리★ 되므로 방향별 결과가 비대칭이다:
  //     핸들러는 있는데 목록에 없다 → 400 (시끄럽게 실패, 이 PR 이 노린 것)
  //     ★목록에는 있는데 핸들러가 없다 → 200 + 저장 안 됨★ (조용한 무시 — 고치려던 그 결함)
  //   실측: WRITABLE_KEYS 에 키 한 줄만 추가(핸들러 없음)해도 ★기존 106개가 전부 통과★ 했다.
  //   그래서 상태코드가 아니라 ★되읽어서 값이 실제로 반영됐는지★ 를 본다.
  //   옛 검사는 11개 중 10개만 손으로 나열했고 ★lead_id 가 빠져 있었다★(이름은 '전부' 인데 아니었다).
  // ★손으로 유지하는 목록을 하나로 줄인다★ (steve 리뷰)
  //   전에는 SAMPLES 와 아래 대조용 배열이 ★같은 키를 두 벌★ 갖고 있었다. 새 키를 대조용에만 넣으면
  //   커버리지 검사는 통과하고 저장 검사는 그 키를 아예 안 본다 — ★막으려던 구멍이 그대로 재개통★ 된다.
  //   이제 대조는 Object.keys(SAMPLES) 에서 유도하므로 손으로 맞출 목록은 WRITABLE_KEYS ↔ SAMPLES 둘뿐이고,
  //   커버리지 검사가 실제로 ★그 둘을★ 비교한다(자기 복사본이 아니라).
  const SAMPLES: Record<string, { send: unknown; expect: string }> = {
      team_name: { send: "팀이름", expect: "팀이름" },
      lead_id: { send: "leadslug", expect: "leadslug" },
      tagline: { send: "한 줄 소개", expect: "한 줄 소개" },
      owner_name: { send: "오너", expect: "오너" },
      owner_chat_id: { send: "123456", expect: "123456" },
      locale: { send: "en", expect: "en" },
      dm_capture: { send: true, expect: "on" },   // 불리언은 "on"/"off" 로 저장된다
      github_team_account: { send: "acct", expect: "acct" },
      github_team_commit_email: { send: "a@b.co", expect: "a@b.co" },
      github_approver_account: { send: "appr", expect: "appr" },
      [MERGE_APPROVERS_SETTING_KEY]: { send: "bill", expect: "bill" },
  };

  test("★쓰기 가능한 키는 실제로 저장된다★ — 200 이 아니라 되읽어서 확인한다", async () => {
    for (const [key, sample] of Object.entries(SAMPLES)) {
      const { app, db } = setup();
      const r = await app.request("/settings", put({ [key]: sample.send }));
      expect(r.status, `${key}: PUT 이 거절됐다`).toBe(200);
      const row = db.prepare("SELECT value FROM setting WHERE key = ?").get(key) as { value: string } | undefined;
      expect(row?.value, `★${key}: 200 을 받았는데 저장이 안 됐다 (조용한 무시)★`).toBe(sample.expect);
    }
  });

  test("★샘플 목록이 쓰기 가능한 키 전부를 덮는다★ — 키가 늘면 이 검사가 먼저 깨진다", async () => {
    // 위 검사는 SAMPLES 를 순회한다. 새 키를 WRITABLE_KEYS 에만 넣고 SAMPLES 에 안 넣으면
    // 위 검사는 ★그 키를 아예 안 보고 통과★ 한다 — 커버리지 구멍이 조용히 생긴다.
    // 거절 응답의 hint 가 쓰기 가능 키 전체를 실어 보내므로 그걸로 목록을 얻어 대조한다.
    const { app } = setup();
    const r = await app.request("/settings", put({ __definitely_unknown__: "x" }));
    expect(r.status).toBe(400);
    const body = (await r.json()) as { hint?: string };
    const listed = (body.hint ?? "").split("쓰기 가능:")[1] ?? "";
    const writable = listed.split(",").map((s) => s.trim()).filter(Boolean);
    expect(writable.length, "hint 에서 쓰기 가능 키 목록을 못 읽었다").toBeGreaterThan(0);
    // ★세 번째 목록을 만들지 않는다★ — 위 SAMPLES 에서 유도한다(steve 리뷰).
    const sampled = Object.keys(SAMPLES);
    const missing = writable.filter((k) => !sampled.includes(k));
    expect(missing, `★위 저장 검사에 빠진 키가 있다: ${missing.join(", ")}★`).toEqual([]);
  });

  test("빈 본문은 거절하지 않는다 (바꿀 게 없는 요청은 유효하다)", async () => {
    const { app } = setup();
    expect((await app.request("/settings", put({}))).status).toBe(200);
  });

  test("빈 문자열은 '해제' 로 허용 — 설정을 되돌릴 수 있어야 한다", async () => {
    const { app } = setup();
    await app.request("/settings", put({ github_approver_account: "gd452" }));
    expect((await app.request("/settings", put({ github_approver_account: "" }))).status).toBe(200);
    expect(((await (await app.request("/settings")).json()) as any).github_approver_account).toBe("");
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
      // ★GitHub 계정·승인자 — 셸 절차(release-preflight --mode merge)가 읽는 값 (2026-07-29)★
      //   ★기본이 빈 문자열인 게 핵심이다★ — 절차는 비면 진행하지 않는다.
      //   기본값으로 때우면 팀장 개인 계정으로 나가고, 그게 이 절차가 막으려는 일이다.
      github_team_account: "",
      github_team_commit_email: "",
      github_approver_account: "",
      merge_approvers_normal: "",
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
      // ★GitHub 계정·승인자 — 셸 절차(release-preflight --mode merge)가 읽는 값 (2026-07-29)★
      //   ★기본이 빈 문자열인 게 핵심이다★ — 절차는 비면 진행하지 않는다.
      //   기본값으로 때우면 팀장 개인 계정으로 나가고, 그게 이 절차가 막으려는 일이다.
      github_team_account: "",
      github_team_commit_email: "",
      github_approver_account: "",
      merge_approvers_normal: "",
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
  test("PATCH runtime_cwd — Hermes 시작 CWD를 멤버별로 저장·초기화한다", async () => {
    const { app, registryPath, db } = setup([
      ...AGENTS,
      { id: "mes", display_name: "Mes", nicknames: ["mes"], role: "strategy", runtime: "hermes_agent", status_provider: "hermes_gateway", avatar_emoji: "✦", moderator_eligible: false, workspace_path: "/tmp/mes", persona_file: "/tmp/mes/SOUL.md" },
    ]);
    const read = () => JSON.parse(readFileSync(registryPath, "utf-8")).find((a: any) => a.id === "mes");

    const saved = await app.request("/members/mes", patch({ runtime_cwd: "~/b3os/members/mes" }));
    expect(saved.status).toBe(200);
    expect(read().runtime_cwd).toBe("~/b3os/members/mes");
    syncRegistry(db, registryPath);
    expect(listAgents(db).find((a) => a.id === "mes")?.runtime_cwd).toBe("~/b3os/members/mes");

    expect((await app.request("/members/mes", patch({ runtime_cwd: "bad\0path" }))).status).toBe(400);
    expect((await app.request("/members/mes", patch({ runtime_cwd: null }))).status).toBe(200);
    expect(read().runtime_cwd).toBeNull();
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

  // ★'팀장ID' 가 뭔지 응답만 보고 알 수 있어야 한다★ (2026-07-25 맥스튜디오 실기).
  //   전엔 placeholder 가 웹 UI 에만 있어서, API 응답만 본 사용자는 소스를 읽어야 알 수 있었다.
  //   사용자가 코드를 읽어야 아는 건 결함이다 — 필드별 hint 를 응답에 싣는다.
  test("setup_incomplete 응답에 필드별 hint — lead_id 는 형식 규칙 + 예시까지", async () => {
    const { app } = setup();
    const r = await app.request("/members/recruit", json({ id: "lui", display_name: "Lui", role: "fullstack", runtime: "openclaw" }));
    const body = await r.json();
    expect(Object.keys(body.hints).sort()).toEqual(["lead_id", "owner_name", "team_name"]);
    expect(body.hints.lead_id).toContain("소문자/숫자/-/_, 1~40자");
    expect(body.hints.lead_id).toContain("예: gd");
    expect(body.hints.team_name).toContain("예:");
    expect(body.hints.owner_name).toContain("예:");
    // missing 인 필드에 대응하는 hint 가 반드시 있어야 한다(빠진 필드만 보고 hint 가 없으면 무용).
    for (const [field, isMissing] of Object.entries(body.missing)) {
      if (isMissing) expect(typeof body.hints[field]).toBe("string");
    }
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
    expect(body.persona_written).toBe(true);
    expect(body.persona_file).toBeTruthy();
    expect(existsSync(body.persona_file)).toBe(true);
    expect(JSON.parse(readFileSync(registryPath, "utf-8")).some((a: any) => a.id === "lui")).toBe(true);
    const ot = await (await app.request(`/ot/${body.ot_id}`)).json();
    expect(ot.stage).toBe("provision");
    expect(ot.steps.find((s: any) => s.key === "register").state).toBe("done");
    expect(ot.joined).toBe(false);
  });
  test("openclaw 영입 직후 AGENTS.md가 이름·역할·팀을 직접 제공하고, 없는 persona_file은 null", async () => {
    const { app, registryPath } = setupReady();
    const r = await app.request("/members/recruit", json({
      id: "clo", display_name: "Clo", role: "프론트, 앱, 풀스택 개발자", runtime: "openclaw",
    }));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.persona_written).toBe(false);
    expect(body.persona_file).toBeNull();

    const clo = JSON.parse(readFileSync(registryPath, "utf-8")).find((a: any) => a.id === "clo");
    const agents = readFileSync(join(clo.workspace_path, "AGENTS.md"), "utf-8");
    expect(agents).toContain("You are **Clo** (clo) — 프론트, 앱, 풀스택 개발자.");
    expect(agents).toContain("**로빈팀** team");
    expect(existsSync(clo.persona_file)).toBe(false);
  });
  test("claude 영입도 CLAUDE.md에 이름·역할·팀을 유지하고 없는 persona_file을 반환하지 않는다", async () => {
    const { app, registryPath } = setupReady();
    const r = await app.request("/members/recruit", json({
      id: "jane", display_name: "Jane", role: "기획/PM", runtime: "claude_channel",
    }));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.persona_written).toBe(false);
    expect(body.persona_file).toBeNull();

    const jane = JSON.parse(readFileSync(registryPath, "utf-8")).find((a: any) => a.id === "jane");
    const claude = readFileSync(join(jane.workspace_path, "CLAUDE.md"), "utf-8");
    expect(claude).toContain("You are **Jane** (jane) — 기획/PM.");
    expect(claude).toContain("**로빈팀** team");
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
  // ── ★페어링 안내가 '더 먼저 풀어야 하는 차단'을 덮으면 안 된다★ (Bill 교차검증 2026-07-25) ──
  //   DM 을 보낸다고 결제 문제가 풀리지 않는다. 페어링 안내를 앞에 두면 '따라 해도 절대 안 풀리는 안내' 라는
  //   ★이 PR 이 없애려던 바로 그 패턴★ 이 다른 조합에서 재현된다. 순서: 구독차단 → 첫콜실패 → 페어링대기.
  const pairingActivate = async () => ({
    ok: true,
    needsPairing: true,
    steps: [{ step: "runtime", ok: true, detail: "mock runtime" }, { step: "bus-wake", ok: true, detail: "mock wake" }],
  });
  const authOkFn = async (runtime: string) => ({ runtime, loggedIn: true, detail: "auth ok", fixHint: "" });
  const activateThenProvision = async (app: any, id: string, runtime: string) => {
    const { ot_id } = await (await app.request("/members/recruit", json({ id, display_name: id, role: "dev", runtime }))).json();
    expect((await app.request(`/ot/${ot_id}/provision`, json({ bot_token: "1234567:" + "A".repeat(35) }))).status).toBe(200);
    return await (await app.request(`/ot/${ot_id}/activate`, json({}))).json();
  };

  test("★페어링 대기 + 구독/한도 실패 → 구독 차단이 이긴다★ (페어링은 병기하되 감추지 않는다)", async () => {
    const quotaFail = async (input: { id: string; runtime: string }) => ({
      runtime: input.runtime, ok: false, subscriptionNeeded: true, detail: "429 insufficient_quota billing",
    });
    const { app } = setupReady(AGENTS, { checkRuntimeAuth: authOkFn, activateMember: pairingActivate, firstModelCall: quotaFail, validateBotToken: okBotToken });
    const body = await activateThenProvision(app, "lisa", "claude_channel");

    expect(body.ok).toBe(false);                    // 구독 문제는 '거의 완료' 가 아니다
    expect(body.subscription_needed).toBe(true);
    expect(body.error).toBe("subscription_needed");
    const joinStep = body.ot.steps.find((s: any) => s.key === "join");
    expect(joinStep.state).toBe("blocked");
    expect(joinStep.detail).toContain("subscription_needed");
    expect(joinStep.detail).toContain("결제/구독");
    expect(joinStep.detail).toContain("페어링도 남아 있습니다"); // 사실이니 병기는 한다
    expect(joinStep.detail).not.toContain("거의 완료");          // 다만 '거의 완료' 로 읽히면 안 된다
  });

  test("페어링 대기 + 구독 무관 첫 모델호출 실패 → 페어링 안내가 실패를 가리지 않는다", async () => {
    const plainFail = async (input: { id: string; runtime: string }) => ({
      runtime: input.runtime, ok: false, subscriptionNeeded: false, detail: "첫 호출 응답 없음",
    });
    const { app } = setupReady(AGENTS, { checkRuntimeAuth: authOkFn, activateMember: pairingActivate, firstModelCall: plainFail, validateBotToken: okBotToken });
    const body = await activateThenProvision(app, "jane", "claude_channel");

    const joinStep = body.ot.steps.find((s: any) => s.key === "join");
    expect(joinStep.state).not.toBe("done");
    expect(joinStep.detail).not.toContain("거의 완료");
    expect(joinStep.detail).toContain("페어링도 남아 있습니다");
  });

  test("페어링 대기 + 첫 모델호출 성공 → '거의 완료 — 마지막 한 단계' 안내(봇 username 포함, 조사 앞 공백 없음)", async () => {
    const callOk = async (input: { id: string; runtime: string }) => ({ runtime: input.runtime, ok: true, subscriptionNeeded: false, detail: "첫 호출 확인" });
    const { app } = setupReady(AGENTS, { checkRuntimeAuth: authOkFn, activateMember: pairingActivate, firstModelCall: callOk, validateBotToken: okBotToken });
    const body = await activateThenProvision(app, "mina", "claude_channel");

    expect(body.ok).toBe(true);
    expect(body.needs_pairing).toBe(true);
    expect(body.pairing_hint).toContain("DM");
    const joinStep = body.ot.steps.find((s: any) => s.key === "join");
    expect(joinStep.state).toBe("pending");        // 실패(blocked)도, 완료(done)도 아니다
    expect(joinStep.detail).toContain("거의 완료 — 마지막 한 단계");
    expect(joinStep.detail).toMatch(/@[a-z0-9_]+에게/i); // 봇 username 이 찍히고 조사 앞에 공백이 없다
    expect(joinStep.detail).not.toContain("<bot_username>");
    // ★조사 앞 공백 검사는 사용자에게 나가는 문자열 ★전부★ 에 건다★ — joinStep.detail 만 보면
    //   pairing_hint 가 ' 에게' 인 채로 남는다(Bill 지적: 절반만 고쳐졌다).
    for (const text of [joinStep.detail, body.pairing_hint]) {
      expect(text).not.toContain(" 에게");
      expect(text).not.toContain(" 에서");
      expect(text).not.toContain("DM 을");
    }
    expect(body.pairing_hint).toMatch(/@[a-z0-9_]+에게/i);
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

/* 2026-07-26 맥스튜디오 실측: Slack 연동 마법사가 ★빈 매니페스트★({"settings":{"socket_mode_enabled":true}})와
 * ★빈 scope★("—")를 그럴싸하게 그렸다. 원인은 이 엔드포인트가 TEAM_PUBLIC_BASE_URL 없으면 400 을 내고,
 * 클라이언트가 r.ok 를 안 보고 그 본문을 정상 데이터로 썼기 때문. 사용자가 그 매니페스트를 붙여넣으면
 * ★권한 0개짜리 Slack 앱★ 이 만들어진다 — 실패보다 나쁘다.
 * UI 는 "Socket Mode = 공개 URL 불필요" 라고 안내하는데 서버가 공개 URL 을 필수로 요구한 자기모순도 있었다. */
// ★생산자에 대한 검증★ — 앞서 이 불변식은 손으로 쓴 픽스처(AgentSlack.test.ts)에만 있었고,
// ★서버가 실제로 무엇을 내보내는지는 아무도 안 봤다.★ 그래서 #74 가 불법 매니페스트를 내보내는데도
// 전 수트가 초록이었다(2026-07-27 Steve 리뷰). 규칙은 만드는 쪽에 걸어야 한다.
describe("★서버가 내보내는 매니페스트는 어떤 경우에도 Slack 규격을 만족한다★", () => {
  // Slack: event_subscriptions 가 있으면 request_url 또는 socket_mode_enabled 중 하나가 필수.
  //   ("Event Subscription requires either Request URL or Socket Mode Enabled")
  const slackAccepts = (m: any): boolean => {
    const ev = m?.settings?.event_subscriptions;
    if (!ev) return true;
    return Boolean(ev.request_url) || m?.settings?.socket_mode_enabled === true;
  };

  for (const [label, base] of [["공개 URL 없음", undefined], ["공개 URL 있음", "https://example.test/"]] as const) {
    test(`${label} — 서버 매니페스트가 Slack 규격을 만족한다`, async () => {
      const old = process.env.TEAM_PUBLIC_BASE_URL;
      if (base === undefined) delete process.env.TEAM_PUBLIC_BASE_URL; else process.env.TEAM_PUBLIC_BASE_URL = base;
      try {
        const { app } = setup();
        const b = await (await app.request("/members/bill/slack/reinstall-info")).json() as any;
        expect(b.ok).toBe(true);
        expect(slackAccepts(b.manifest)).toBe(true);
      } finally {
        if (old === undefined) delete process.env.TEAM_PUBLIC_BASE_URL; else process.env.TEAM_PUBLIC_BASE_URL = old;
      }
    });
  }
});

describe("slack reinstall-info", () => {
  const withBase = (v: string | undefined, fn: () => Promise<void>) => async () => {
    const old = process.env.TEAM_PUBLIC_BASE_URL;
    if (v === undefined) delete process.env.TEAM_PUBLIC_BASE_URL; else process.env.TEAM_PUBLIC_BASE_URL = v;
    try { await fn(); } finally {
      if (old === undefined) delete process.env.TEAM_PUBLIC_BASE_URL; else process.env.TEAM_PUBLIC_BASE_URL = old;
    }
  };

  /* ★서버는 언제나 Socket 매니페스트를 낸다★ (GD 2026-07-27 — 슬랙 정본 = Socket Mode).
   * 예전엔 공개 URL 이 있으면 request_url + socket_mode_enabled:false 를 내보냈다. 화면에서는
   * 클라이언트 socketManifest() 가 Socket 으로 바꿔줘 멀쩡해 보였지만, ★그건 화면을 거칠 때만★ 이다.
   * 이 엔드포인트를 직접 받아가면 ★지원하지 않는 Event URL 앱을 만드는 매니페스트★ 가 그대로 나갔다.
   * 그래서 ★공개 URL 유무와 무관하게 같은 Socket 매니페스트★ 가 나오는 것을 고정한다. */
  const expectSocketManifest = (b: any) => {
    expect(b.manifest?.settings?.socket_mode_enabled).toBe(true);
    expect(b.manifest?.settings?.event_subscriptions?.bot_events).toEqual(["app_mention"]);
    // ★request_url 이 있으면 Event URL 앱이 만들어진다★ — 공개 URL 이 설정돼 있어도 넣지 않는다
    expect(b.manifest?.settings?.event_subscriptions?.request_url).toBeUndefined();
  };

  test("★공개 URL 이 없어도 Socket 매니페스트를 완전하게 준다★", withBase(undefined, async () => {
    const { app } = setup();
    const res = await app.request("/members/bill/slack/reinstall-info");
    expect(res.status).toBe(200);
    const b = await res.json() as any;
    expect(b.ok).toBe(true);
    // ★scope 가 비면 권한 없는 앱이 만들어진다★ — 이게 이전 사고의 핵심이라 개수까지 고정한다
    expect(b.needed_scopes).toEqual(["app_mentions:read", "chat:write", "groups:history", "channels:history"]);
    expect(b.manifest?.oauth_config?.scopes?.bot).toEqual(b.needed_scopes);
    expect(b.manifest?.display_information?.name).toBeTruthy();
    expectSocketManifest(b);
  }));

  test("★공개 URL 이 있어도 request_url 을 넣지 않는다★ (Event URL 방식은 지원하지 않는다)", withBase("https://example.test/", async () => {
    const { app } = setup();
    const b = await (await app.request("/members/bill/slack/reinstall-info")).json() as any;
    expectSocketManifest(b);
  }));

  /* ★서버 산출물 → 클라이언트 변환★ 접합부. 양쪽을 따로만 검사하면, 서버가 모양을 바꿔도 클라이언트
   * 테스트는 손으로 베낀 fixture 를 계속 통과시킨다(하네스 지적). 사용자가 붙여넣는 것은 이 합성 결과다. */
  test("★사용자가 붙여넣는 최종 Socket JSON★ — 서버 응답을 그대로 변환해 확인한다", withBase(undefined, async () => {
    const { app } = setup();
    const b = await (await app.request("/members/bill/slack/reinstall-info")).json() as any;
    const final = socketManifest(b.manifest) as any;
    expect(final.settings.socket_mode_enabled).toBe(true);
    expect(final.settings.event_subscriptions?.bot_events).toEqual(["app_mention"]);
    expect(final.settings.event_subscriptions?.request_url).toBeUndefined();
    expect(final.oauth_config?.scopes?.bot).toContain("app_mentions:read");
  }));

  test("★채널이 설정 안 됐으면 빈 문자열★ — 남의 채널명을 기본값으로 주지 않는다", withBase("https://example.test", async () => {
    const old = process.env.TEAM_SLACK_POLL_CHANNELS;
    delete process.env.TEAM_SLACK_POLL_CHANNELS;
    try {
      const { app } = setup();
      const b = await (await app.request("/members/bill/slack/reinstall-info")).json() as any;
      expect(b.channel).toBe("");
      expect(JSON.stringify(b)).not.toContain("300-gd-ai-team");
    } finally {
      if (old === undefined) delete process.env.TEAM_SLACK_POLL_CHANNELS; else process.env.TEAM_SLACK_POLL_CHANNELS = old;
    }
  }));
});

// ────────────────────────────────────────────────────────────────────────────
// ★영입 위저드가 페어링 코드 입력창을 못 띄우던 회귀 (2026-07-28 외부 사용자 신고)★
//
// 증상: 대시보드로 claude 팀원을 영입하면 마지막 '합류 확인' 에서 영원히 멈춘다.
//   위저드는 "봇에게 DM 을 한 번 보내주세요" 라고 안내하고, 사용자가 DM 을 보내면
//   봇이 6자리 코드를 답한다. ★그런데 그 코드를 넣을 입력창이 뜨지 않는다.★
//
// 원인: 입력창은 `awaiting_input.kind === "claude_pairing_code"` 일 때만 렌더된다
//   (web/components/Settings.ts shouldShowClaudePairingPanel). 그 값을 만드는 곳은
//   `GET /members/:id/pairing-status` 뿐인데 ★웹은 그 엔드포인트를 한 번도 부르지 않는다★.
//   위저드가 폴링하는 `GET /ot/:ot_id` 는 steps_json 에 저장된 awaiting_input 만 돌려주고,
//   그 값은 봇 토큰 단계에서만 채워지고 그 뒤로는 계속 null 이다.
//   → 승인 라우트도·입력창도·검증 로직도 다 있는데 ★"지금 필요하다" 는 신호만 도달하지 않았다.★
//
// 클로드 코드로 영입하면 성공하던 이유: 동반자가 access.json 을 직접 편집해 승인해서
//   이 입력창을 아예 거치지 않기 때문. ★대시보드만 쓰는 사용자는 통과할 방법이 없었다.★
describe("OT 조회가 claude 페어링 대기를 표면화한다", () => {
  const claudeOt = (db: any, dir: string, opts: { allowFrom?: string[]; joinState?: string; stored?: unknown } = {}) => {
    const channels = join(dir, "claude-channels");
    process.env.CLAUDE_CHANNELS_DIR = channels;
    const accessDir = join(channels, "telegram-bill");
    mkdirSync(accessDir, { recursive: true });
    writeFileSync(join(accessDir, "access.json"), JSON.stringify({
      dmPolicy: "pairing", allowFrom: opts.allowFrom ?? [], groups: {},
      pending: { abc123: { senderId: "1000000001", chatId: "1000000001", expiresAt: Date.now() + 60_000 } },
    }));
    const steps = [
      { key: "register", state: "done" }, { key: "provision", state: "done" },
      { key: "preflight", state: "done" }, { key: "bundle", state: "done" },
      { key: "join", state: opts.joinState ?? "pending" },
    ];
    const payload: any = { steps };
    if (opts.stored !== undefined) payload.awaiting_input = opts.stored;
    db.query("INSERT INTO ot(id,member_id,stage,steps_json) VALUES('ot_ui','bill','join',?)").run(JSON.stringify(payload));
  };

  test("★핵심★ 합류 대기 + allowFrom 비어 있으면 코드 입력 마커를 내려준다", async () => {
    const { app, dir, db } = setup();
    claudeOt(db, dir);
    const ot = await (await app.request("/ot/ot_ui")).json() as any;
    // 이 한 줄이 실패하면 사용자는 코드를 받고도 넣을 곳이 없다.
    expect(ot.awaiting_input?.kind).toBe("claude_pairing_code");
  });

  test("이미 승인된(allowFrom 있음) 팀원에겐 안 띄운다 — 승인 끝난 화면에 입력창이 남으면 안 된다", async () => {
    const { app, dir, db } = setup();
    claudeOt(db, dir, { allowFrom: ["1000000001"] });
    const ot = await (await app.request("/ot/ot_ui")).json() as any;
    expect(ot.awaiting_input).toBeNull();
  });

  test("합류가 이미 done 이면 안 띄운다", async () => {
    const { app, dir, db } = setup();
    claudeOt(db, dir, { joinState: "done" });
    const ot = await (await app.request("/ot/ot_ui")).json() as any;
    expect(ot.awaiting_input).toBeNull();
  });

  test("★봇 토큰 대기를 덮어쓰지 않는다★ — 같은 칸을 쓰므로 앞 단계가 우선이다", async () => {
    const { app, dir, db } = setup();
    claudeOt(db, dir, { stored: { kind: "bot_token", fields: [{ key: "bot_token" }] } });
    const ot = await (await app.request("/ot/ot_ui")).json() as any;
    expect(ot.awaiting_input.kind).toBe("bot_token");
  });

  test("★활성화 전에는 안 띄운다 — 띄우면 활성화 버튼이 사라져 진행이 막힌다★", async () => {
    // web/Settings.ts: needsActivate = provisionDone && bundlePending && … && !(awaiting?.fields?.length)
    //   이 마커는 fields 가 있으므로, bundle 대기 중에 내보내면 ★활성화 버튼이 숨는다★.
    //   페어링은 활성화 뒤에 생기는 단계라, 그러면 사용자는 활성화도 페어링도 못 하고 갇힌다.
    const { app, dir, db } = setup();
    const channels = join(dir, "claude-channels");
    process.env.CLAUDE_CHANNELS_DIR = channels;
    const accessDir = join(channels, "telegram-bill");
    mkdirSync(accessDir, { recursive: true });
    writeFileSync(join(accessDir, "access.json"), JSON.stringify({ dmPolicy: "pairing", allowFrom: [], groups: {}, pending: {} }));
    const steps = [
      { key: "register", state: "done" }, { key: "provision", state: "done" },
      { key: "preflight", state: "done" }, { key: "bundle", state: "pending" }, { key: "join", state: "pending" },
    ];
    db.query("INSERT INTO ot(id,member_id,stage,steps_json) VALUES('ot_preact','bill','bundle',?)").run(JSON.stringify({ steps }));
    const ot = await (await app.request("/ot/ot_preact")).json() as any;
    expect(ot.awaiting_input).toBeNull();
  });

  test("★join 이 blocked(구독/한도) 면 안 띄운다 — 더 급한 안내를 가리면 안 된다★", async () => {
    // web footer 삼항은 pairing 분기가 needsSubscription 분기보다 ★앞★ 이다(Settings.ts:432 vs :436).
    // subscription_needed 는 join.state="blocked" 로 온다 → 마커를 내면 앰버 경고와
    // '🔄 해결 후 다시 활성화' 버튼이 ★통째로 가려진다★. 결제를 못 고치니 영영 못 푼다.
    const { app, dir, db } = setup();
    const channels = join(dir, "claude-channels");
    process.env.CLAUDE_CHANNELS_DIR = channels;
    const accessDir = join(channels, "telegram-bill");
    mkdirSync(accessDir, { recursive: true });
    writeFileSync(join(accessDir, "access.json"), JSON.stringify({ dmPolicy: "pairing", allowFrom: [], groups: {}, pending: {} }));
    const steps = [
      { key: "register", state: "done" }, { key: "provision", state: "done" },
      { key: "preflight", state: "done" }, { key: "bundle", state: "done" },
      { key: "join", state: "blocked", detail: "subscription_needed: 구독 확인 필요" },
    ];
    db.query("INSERT INTO ot(id,member_id,stage,steps_json) VALUES('ot_sub','bill','join',?)").run(JSON.stringify({ steps }));
    const ot = await (await app.request("/ot/ot_sub")).json() as any;
    expect(ot.awaiting_input).toBeNull();
  });

  test("claude 가 아닌 런타임엔 영향 없다", async () => {
    const agents = [{ ...AGENTS[0], id: "bill", runtime: "openclaw" }, AGENTS[1]];
    const { app, dir, db } = setup(agents);
    claudeOt(db, dir);
    const ot = await (await app.request("/ot/ot_ui")).json() as any;
    expect(ot.awaiting_input).toBeNull();
  });
});

// ★MCP 토글 — 공개 빌드에서는 존재 자체가 안 보인다★ (팀 리드 2026-08-07)
describe("system-op: MCP 창구 토글", () => {
  test("PATCH mcp_enabled 로 켜고 끈다", async () => {
    const { app } = setup();
    const on = await (await app.request("/system-op", patch({ mcp_enabled: true }))).json();
    expect(on.mcp_enabled).toBe(true);
    const off = await (await app.request("/system-op", patch({ mcp_enabled: false }))).json();
    expect(off.mcp_enabled).toBe(false);
  });
});
