import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
