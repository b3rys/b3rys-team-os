import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../db/migrate";
import { createAcceptanceRoutes } from "./acceptance";

function setSetting(db: Database, key: string, value: string) {
  db.query(
    "INSERT INTO setting (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
  ).run(key, value);
}

function setup() {
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

  const app = createAcceptanceRoutes({ db, registryPath, teamOsPath, rootDir: root, membersRoot });
  return { app, db, dir, root, membersRoot, novaWs };
}

beforeEach(() => {
  delete process.env.CAPTURE_TOKEN_FILE;
  delete process.env.CAPTURE_GROUP_FILE;
  delete process.env.CAPTURE_BOT_TOKEN;
  delete process.env.CAPTURE_GROUP_ID;
});

describe("acceptance-check routes", () => {
  test("returns four staged checks for an onboarded member", async () => {
    const { app, dir } = setup();
    try {
      const res = await app.request("/members/nova/acceptance-check");
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(true);
      expect(body.member).toBe("nova");
      expect(body.sections.map((section: any) => section.key)).toEqual(["settings", "rules", "ot", "portability"]);
      expect(body.sections.every((section: any) => Array.isArray(section.checks))).toBe(true);
      expect(body.sections.find((section: any) => section.key === "ot").checks).toContainEqual({
        label: "agents.json 등록",
        status: "pass",
        detail: "runtime=openclaw",
      });
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
