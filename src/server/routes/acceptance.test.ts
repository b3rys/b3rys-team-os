import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../db/migrate";
import type { TeamOsScheduled } from "../lib/teamosProbe";
import { createAcceptanceRoutes } from "./acceptance";

const healthyServices: TeamOsScheduled[] = [
  { label: "com.test.team-collab", kind: "service", detail: "상시", description: "team-collab", source: "launchd", running: true, enabled: true },
  { label: "com.test.caffeinate", kind: "service", detail: "상시", description: "caffeinate", source: "launchd", running: true, enabled: true },
  { label: "ai.openclaw.gateway", kind: "service", detail: "상시", description: "gateway", source: "launchd", running: true, enabled: true },
];

function setSetting(db: Database, key: string, value: string) {
  db.query(
    "INSERT INTO setting (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
  ).run(key, value);
}

function setup(services: TeamOsScheduled[] = healthyServices) {
  const db = new Database(":memory:");
  migrate(db);
  const dir = mkdtempSync(join(tmpdir(), "acceptance-test-"));
  const root = join(dir, "repo");
  const membersRoot = join(dir, "members");
  const rulesDir = join(root, "rules");
  const novaWs = join(membersRoot, "nova");
  mkdirSync(rulesDir, { recursive: true });
  mkdirSync(novaWs, { recursive: true });
  const teamOsPath = join(rulesDir, "TEAM-OS.md");
  const registryPath = join(root, "agents.json");
  writeFileSync(
    teamOsPath,
    `# TEAM-OS

## 1. Mission & Identity

테스트 팀.

## 2. 그룹 커뮤니케이션 우선순위

owner 판정은 @멘션 우선.

## 4. 공통 응답 규칙

BWF 정의.

## 10. 과제 관리

Tasks 칸반 사용.
`,
    "utf-8",
  );
  writeFileSync(
    registryPath,
    JSON.stringify(
      [
        {
          id: "nova",
          display_name: "Nova",
          role: "dev",
          runtime: "openclaw",
          status_provider: "openclaw_gateway",
          tmux_session: null,
          telegram_bot_username: null,
          workspace_path: novaWs,
          persona_file: join(novaWs, "SOUL.md"),
          moderator_eligible: false,
          avatar_emoji: "N",
        },
      ],
      null,
      2,
    ),
    "utf-8",
  );
  writeFileSync(join(novaWs, "AGENTS.md"), "# AGENTS\n\n## 📚 룰 로딩\n\n필독.\n", "utf-8");
  writeFileSync(join(novaWs, "SOUL.md"), "# Nova\n", "utf-8");

  process.env.CAPTURE_TOKEN_FILE = join(dir, "capture.token");
  process.env.CAPTURE_GROUP_FILE = join(dir, "capture.group");
  process.env.CAPTURE_BOT_TOKEN = "123456:ABCdefGHIjklMNOpqrSTUvwxYZ012345";
  process.env.CAPTURE_GROUP_ID = "-100123";
  setSetting(db, "team_name", "테스트팀");
  setSetting(db, "owner_name", "Owner");
  setSetting(db, "router_enabled", "true");

  const app = createAcceptanceRoutes({
    db,
    registryPath,
    teamOsPath,
    rootDir: root,
    membersRoot,
    teamOsSnapshot: () => ({ scheduled: services }),
  });
  return { app, db, dir, root, membersRoot, novaWs };
}

/** 방금 install.sh 를 돌린 새 사용자 상태 — 팀원 0명 · 설정 전무(팀 이름·팀장·capture·라우터 미설정). */
function setupFreshInstall() {
  const db = new Database(":memory:");
  migrate(db);
  const dir = mkdtempSync(join(tmpdir(), "acceptance-fresh-"));
  const root = join(dir, "repo");
  const membersRoot = join(dir, "members");
  const rulesDir = join(root, "rules");
  mkdirSync(rulesDir, { recursive: true });
  const teamOsPath = join(rulesDir, "TEAM-OS.md");
  const registryPath = join(root, "agents.json");
  writeFileSync(
    teamOsPath,
    "# TEAM-OS\n\nowner 판정은 @멘션 우선.\n\nBWF 정의.\n\nTasks 칸반 사용.\n",
    "utf-8",
  );
  writeFileSync(registryPath, "[]\n", "utf-8");

  const app = createAcceptanceRoutes({
    db,
    registryPath,
    teamOsPath,
    rootDir: root,
    membersRoot,
    // 새 설치엔 launchd 등록이 없다(수동 실행).
    teamOsSnapshot: () => ({ scheduled: [] }),
  });
  return { app, db, dir, root, membersRoot };
}

/** team.db 로스터에 팀원 N명을 심는다 — '레지스트리는 0/손상인데 DB엔 팀원이 있다'(=유실·손상) 재현용. */
function insertDbAgents(db: Database, ids: string[]) {
  for (const id of ids) {
    db.prepare(
      `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
       VALUES (?, ?, 'dev', 'openclaw', 'openclaw_gateway', ?, ?)`,
    ).run(id, id, `/tmp/${id}`, `/tmp/${id}/SOUL.md`);
  }
}

function insertScheduledJob(db: Database, id: string, status: "failed" | "cancelled", enabled: 0 | 1) {
  db.prepare(
    `INSERT INTO scheduled_job
       (id, kind, schedule_kind, status, enabled, title, created_by, timezone,
        next_run_at, last_run_at, schedule_expr, payload_json)
     VALUES (?, 'recurring', 'cron', ?, ?, ?, 'test', 'Asia/Seoul',
             datetime('now', '+1 day'), '2026-07-23 12:34:00', '{}', '{}')`,
  ).run(id, status, enabled, id);
}

function insertOrphanWakes(db: Database, count: number) {
  db.prepare(
    `INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
     VALUES ('worker', 'Worker', 'dev', 'openclaw', 'openclaw_gateway', '/tmp/worker', '/tmp/worker/SOUL.md')`,
  ).run();
  db.prepare(
    `INSERT INTO thread (id, title, kind, participants_json, opened_by)
     VALUES ('infra-test', 'Infra test', 'dm', '[]', 'test')`,
  ).run();
  for (let i = 0; i < count; i += 1) {
    const id = `orphan-${i}`;
    db.prepare(
      `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source)
       VALUES (?, 'infra-test', 'test', 'worker', 'dm', 'test', 'system')`,
    ).run(id);
    db.prepare(
      `INSERT INTO message_recipient (message_id, agent_id, delivery_state, lease_until)
       VALUES (?, 'worker', 'wake_dispatched', datetime('now', '-2 hours'))`,
    ).run(id);
  }
}

beforeEach(() => {
  delete process.env.CAPTURE_TOKEN_FILE;
  delete process.env.CAPTURE_GROUP_FILE;
  delete process.env.CAPTURE_BOT_TOKEN;
  delete process.env.CAPTURE_GROUP_ID;
});

describe("acceptance-check routes", () => {
  test("returns five staged checks including healthy infra for an onboarded member", async () => {
    const { app, dir } = setup();
    try {
      const res = await app.request("/members/nova/acceptance-check");
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(true);
      expect(body.member).toBe("nova");
      expect(body.sections.map((section: any) => section.key)).toEqual(["settings", "rules", "ot", "portability", "infra"]);
      expect(body.sections.every((section: any) => Array.isArray(section.checks))).toBe(true);
      expect(body.sections.find((section: any) => section.key === "ot").checks).toContainEqual({
        label: "agents.json 등록",
        status: "pass",
        detail: "runtime=openclaw",
      });
      const infra = body.sections.find((section: any) => section.key === "infra");
      expect(infra.label).toBe("인프라/운영");
      expect(
        infra.checks
          .filter((entry: any) => entry.label.endsWith("서비스: team-collab"))
          .every((entry: any) => entry.status === "pass"),
      ).toBe(true);
      expect(infra.checks).toContainEqual({ label: "고아 wake", status: "info", detail: "없음" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("infra keeps stopped or missing optional services informational", async () => {
    const optionalServices = healthyServices
      .filter((service) => service.label !== "ai.openclaw.gateway")
      .map((service) => service.label.endsWith("caffeinate") ? { ...service, running: false } : service);
    const { app, dir } = setup(optionalServices);
    try {
      const body = (await (await app.request("/acceptance-check")).json()) as any;
      const infra = body.sections.find((section: any) => section.key === "infra");
      expect(infra.checks).toContainEqual({
        label: "선택 서비스: caffeinate",
        status: "info",
        detail: "미설정 — 선택",
      });
      expect(infra.checks).toContainEqual({
        label: "선택 서비스: gateway",
        status: "info",
        detail: "미설정 — 선택",
      });
      expect(body.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("infra treats a missing team-collab launchd service as a healthy manual server run", async () => {
    const manuallyStartedServices = healthyServices.filter((service) => !service.label.endsWith("team-collab"));
    const { app, dir } = setup(manuallyStartedServices);
    try {
      const body = (await (await app.request("/acceptance-check")).json()) as any;
      const infra = body.sections.find((section: any) => section.key === "infra");
      expect(infra.checks).toContainEqual({
        label: "필수 서비스: team-collab",
        status: "pass",
        detail: "수동 실행 — launchd 상시서비스 미설치(리부팅 자동복구 없음)",
      });
      expect(body.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("infra keeps a stopped team-collab launchd service informational while failed jobs fail", async () => {
    const stoppedServices = healthyServices.map((service) =>
      service.label.endsWith("team-collab") ? { ...service, running: false } : service,
    );
    const { app, db, dir } = setup(stoppedServices);
    try {
      insertScheduledJob(db, "broken-recurring", "failed", 1);
      insertOrphanWakes(db, 11);

      const body = (await (await app.request("/acceptance-check")).json()) as any;
      const infra = body.sections.find((section: any) => section.key === "infra");
      expect(infra.checks).toContainEqual(
        expect.objectContaining({
          label: "필수 서비스: team-collab",
          status: "info",
          detail: "launchd 등록됨·stopped — 현재 서버는 수동 실행 중",
        }),
      );
      expect(infra.checks).toContainEqual(
        expect.objectContaining({
          label: "예약 잡 실패",
          status: "fail",
          detail: expect.stringContaining("broken-recurring"),
        }),
      );
      expect(infra.checks).toContainEqual(
        { label: "고아 wake", status: "info", detail: "reconcile 후보 11개" },
      );
      expect(body.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("infra reports retired jobs and a small orphan-wake backlog as info", async () => {
    const { app, db, dir } = setup();
    try {
      insertScheduledJob(db, "retired-recurring", "cancelled", 0);
      insertOrphanWakes(db, 3);

      const body = (await (await app.request("/acceptance-check")).json()) as any;
      const infra = body.sections.find((section: any) => section.key === "infra");
      expect(infra.checks).toContainEqual({ label: "은퇴 잡", status: "info", detail: "은퇴 1개" });
      expect(infra.checks).toContainEqual({ label: "고아 wake", status: "info", detail: "reconcile 후보 3개" });
      expect(body.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ports check-portability blockers into item failures", async () => {
    const { app, dir, novaWs } = setup();
    try {
      // 절대경로 하드코딩 = 포터빌리티 블로커(다른 머신서 안 됨). 팀고유 실값 탐지는 제거됨(public=source)이라 포맷/경로 기반으로 검증.
      writeFileSync(join(novaWs, "SOUL.md"), "hardcoded path: /Users/someone/project/config\n", "utf-8");
      const body = (await (await app.request("/members/nova/acceptance-check")).json()) as any;
      const portability = body.sections.find((section: any) => section.key === "portability");
      expect(portability.checks.some((entry: any) => entry.label === "BLOCKER" && entry.status === "fail")).toBe(true);
      expect(body.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── public=source: 팀고유 실값(chat_id·group_id)은 소스에 박지 않고 settings 에서 읽어 동적 탐지 (Codex 리뷰) ──
  test("config 기반 내부ID 탐지 — 설정된 owner_chat_id 가 렌더 파일에 있으면 internal-id BLOCKER", async () => {
    const { app, db, dir, novaWs } = setup();
    try {
      setSetting(db, "owner_chat_id", "1000000001");
      writeFileSync(join(novaWs, "SOUL.md"), "DM owner at 1000000001 for approvals\n", "utf-8");
      const body = (await (await app.request("/members/nova/acceptance-check")).json()) as any;
      const portability = body.sections.find((s: any) => s.key === "portability");
      expect(
        portability.checks.some(
          (e: any) => e.label === "BLOCKER" && e.status === "fail" && /internal-id/.test(e.detail),
        ),
      ).toBe(true);
      expect(body.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("설정 안 된 숫자는 skip — 미등록 값은 블록하지 않는다(공개 이식성)", async () => {
    const { app, dir, novaWs } = setup();
    try {
      // owner_chat_id 미설정 + 이 숫자는 어떤 설정값도 아님(기본 capture_group_id -100123 과도 다름) → 블록 없음.
      writeFileSync(join(novaWs, "SOUL.md"), "arbitrary number 999888777 not a configured id\n", "utf-8");
      const body = (await (await app.request("/members/nova/acceptance-check")).json()) as any;
      const portability = body.sections.find((s: any) => s.key === "portability");
      expect(portability.checks.some((e: any) => e.label === "BLOCKER" && e.status === "fail")).toBe(false);
      expect(body.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("숫자경계 — 설정값이 더 긴 숫자의 부분열이면 오검출 안 함", async () => {
    const { app, db, dir, novaWs } = setup();
    try {
      setSetting(db, "owner_chat_id", "1000000001");
      // 설정값(1000000001)이 더 긴 숫자 10000000010 의 부분열(뒤에 0) → 숫자경계 lookahead 로 매칭 안 됨.
      writeFileSync(join(novaWs, "SOUL.md"), "unrelated ledger id 10000000010 here\n", "utf-8");
      const body = (await (await app.request("/members/nova/acceptance-check")).json()) as any;
      const portability = body.sections.find((s: any) => s.key === "portability");
      expect(
        portability.checks.some(
          (e: any) => e.label === "BLOCKER" && e.status === "fail" && /internal-id/.test(e.detail),
        ),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("masks blocker line content so secrets are never returned", async () => {
    const { app, dir, novaWs } = setup();
    const token = "sk-ABCdefGHIjklMNOpqrSTUvwxYZ012345";
    try {
      writeFileSync(join(novaWs, "SOUL.md"), `capture token = ${token}\n`, "utf-8");
      const body = (await (await app.request("/members/nova/acceptance-check")).json()) as any;
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain("capture token =");
      const portability = body.sections.find((section: any) => section.key === "portability");
      expect(portability.checks).toContainEqual({
        label: "BLOCKER",
        status: "fail",
        detail: "members/nova/SOUL.md:1 (secret 패턴 검출)",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects traversal-like member ids before scanning files", async () => {
    const { app, dir } = setup();
    try {
      const res = await app.request("/acceptance-check/..%2F..%2Fx");
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        ok: false,
        error: "member_invalid",
        detail: "member must match ^[a-z0-9._-]{1,40}$",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips ot section without a member", async () => {
    const { app, dir } = setup();
    try {
      const body = (await (await app.request("/acceptance-check")).json()) as any;
      const ot = body.sections.find((section: any) => section.key === "ot");
      expect(ot.checks).toContainEqual({
        label: "member",
        status: "info",
        detail: "인자 없음 - OT 단계 스킵",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── 클린 설치 첫 경험: 정상 초기 상태를 fail 로 찍지 않는다 (2026-07-25 공개 리허설) ──
  const settingsCheck = (body: any, label: string) =>
    body.sections.find((section: any) => section.key === "settings").checks.find((c: any) => c.label === label);

  test("클린 설치(팀원 0명)는 fail 0 — '팀 이름 미설정'은 info + 다음 할 일 안내", async () => {
    const { app, dir } = setupFreshInstall();
    try {
      const body = (await (await app.request("/acceptance-check")).json()) as any;
      expect(body.summary.fail).toBe(0);
      expect(body.ok).toBe(true);
      expect(settingsCheck(body, "팀 이름")).toEqual({
        label: "팀 이름",
        status: "info",
        detail: "미설정 — 새 설치의 정상 상태(팀원 0명)",
        fix: "다음 할 일: Settings 에서 팀 이름을 정하고 첫 팀원을 영입하세요.",
      });
      expect(settingsCheck(body, "agents.json 로드")).toEqual({
        label: "agents.json 로드",
        status: "pass",
        detail: "성공 — 팀원 0명",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── ★major A(Bill 적대검증 2026-07-25)★ 레지스트리 로드 실패를 '팀원 0명 = 새 설치' 로 삼키면
  //    손상된 라이브에서 인수체크가 "새 설치입니다, 이상 없습니다" 라고 적극적 거짓 주장을 한다.
  //    → 로드 실패는 fail 로 노출하고 freshInstall 신호에서 제외한다. 네 가지 손상 유형 전부 고정. ──
  const corruptions: Array<{ name: string; corrupt: (registryPath: string) => void }> = [
    { name: "JSON 잘림", corrupt: (p) => writeFileSync(p, '[{"id":"bill",', "utf-8") },
    { name: "배열 아닌 객체", corrupt: (p) => writeFileSync(p, '{"id":"bill"}', "utf-8") },
    { name: "권한 없음(chmod 000)", corrupt: (p) => chmodSync(p, 0o000) },
  ];
  for (const { name, corrupt } of corruptions) {
    test(`손상된 agents.json(${name}) → '새 설치' 라고 하지 않는다 (로드 fail + 팀 이름 fail)`, async () => {
      const { app, db, dir, root } = setupFreshInstall();
      try {
        insertDbAgents(db, ["bill", "codex", "steve"]); // team.db 로스터는 살아있다(대시보드는 3명을 보여준다)
        corrupt(join(root, "agents.json"));

        const body = (await (await app.request("/acceptance-check")).json()) as any;
        expect(body.ok).toBe(false);
        const load = settingsCheck(body, "agents.json 로드");
        expect(load.status).toBe("fail");
        expect(load.detail).toContain("team.db 로스터 3명");
        // 팀 이름은 '새 설치의 정상 상태' 로 둘 수 없다 — 새 설치가 아니다.
        expect(settingsCheck(body, "팀 이름")).toEqual({ label: "팀 이름", status: "fail", detail: "미설정" });
      } finally {
        try { chmodSync(join(root, "agents.json"), 0o644); } catch { /* 이미 정상 */ }
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("agents.json 파일만 사라졌는데 team.db 에 팀원이 있으면 유실 의심 fail — '새 설치' 아님", async () => {
    const { app, db, dir, root } = setupFreshInstall();
    try {
      insertDbAgents(db, ["bill", "codex"]);
      rmSync(join(root, "agents.json"));

      const body = (await (await app.request("/acceptance-check")).json()) as any;
      expect(body.ok).toBe(false);
      const load = settingsCheck(body, "agents.json 로드");
      expect(load.status).toBe("fail");
      expect(load.detail).toContain("레지스트리 유실 의심");
      expect(settingsCheck(body, "팀 이름").status).toBe("fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("팀이 구성된 뒤(팀원 존재) 팀 이름이 비면 그건 진짜 누락 — fail 유지", async () => {
    const { app, db, dir } = setup();
    try {
      db.query("DELETE FROM setting WHERE key = 'team_name'").run();
      const body = (await (await app.request("/acceptance-check")).json()) as any;
      const settings = body.sections.find((section: any) => section.key === "settings");
      expect(settings.checks).toContainEqual({ label: "팀 이름", status: "fail", detail: "미설정" });
      expect(body.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("streams section events and summary event from the canonical member prefix", async () => {
    const { app, dir } = setup();
    try {
      const res = await app.request("/members/nova/acceptance-check/stream");
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await res.text();
      expect(text).toContain("event: section");
      expect(text).toContain('"key":"settings"');
      expect(text).toContain("event: summary");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
