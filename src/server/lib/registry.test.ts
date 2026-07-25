import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import { openDb, migrate } from "../db/migrate";
import { listAgents } from "../db/queries";
import { detectExplicitTargets } from "./teamRouter";
import { loadRegistry, syncRegistry } from "./registry";
import { writeRegistrySafely } from "./registrySafety";

describe("loadRegistry", () => {
  test("returns [] when agents.json is missing (untracked runtime state, fresh public clone)", () => {
    const dir = mkdtempSync(join(tmpdir(), "team-registry-missing-"));
    try {
      expect(loadRegistry(join(dir, "agents.json"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preserves nicknames from agents.json for router aliases", () => {
    const dir = mkdtempSync(join(tmpdir(), "team-registry-test-"));
    try {
      const path = join(dir, "agents.json");
      writeFileSync(
        path,
        JSON.stringify([
          {
            id: "devon",
            display_name: "Devon",
            nicknames: ["devon", "데본"],
            role: "Codex-based Staff Engineer",
            runtime: "openclaw",
            status_provider: "openclaw_gateway",
            tmux_session: null,
            telegram_bot_username: null,
            workspace_path: "/Users/you/Development/your-workspace",
            persona_file: "/Users/you/Development/your-workspace/SOUL.md",
            moderator_eligible: true,
            avatar_emoji: "D",
          },
        ]),
      );

      const agents = loadRegistry(path);

      expect(agents[0]?.nicknames).toEqual(["devon", "데본"]);
      expect(detectExplicitTargets("@데본 온보딩 체크해줘", agents)).toEqual(["devon"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preserves codex per-member sandbox and network settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "team-registry-codex-test-"));
    try {
      const path = join(dir, "agents.json");
      writeFileSync(
        path,
        JSON.stringify([
          {
            id: "dex",
            display_name: "Dex",
            role: "Step Engineer",
            runtime: "codex",
            status_provider: "codex_cli",
            workspace_path: "/Users/you/Development/your-workspace",
            persona_file: "/Users/you/Development/your-workspace/SOUL.md",
            codex_sandbox: "workspace-write",
            codex_network_access: true,
          },
        ]),
      );

      const agents = loadRegistry(path);

      expect(agents[0]?.codex_sandbox).toBe("workspace-write");
      expect(agents[0]?.codex_network_access).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("syncRegistry removes agents deleted from agents.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "team-registry-sync-test-"));
    try {
      const registryPath = join(dir, "agents.json");
      const db = openDb(join(dir, "team.db"));
      migrate(db);

      writeFileSync(
        registryPath,
        JSON.stringify([
          {
            id: "bill",
            display_name: "Bill",
            role: "Infra",
            runtime: "claude_channel",
            status_provider: "claude_tmux",
            workspace_path: "/tmp/bill",
            persona_file: "/tmp/bill/CLAUDE.md",
          },
          {
            id: "testclaude",
            display_name: "Claude Temp",
            role: "Temporary member",
            runtime: "claude_channel",
            status_provider: "claude_tmux",
            workspace_path: "/tmp/testclaude",
            persona_file: "/tmp/testclaude/CLAUDE.md",
          },
        ]),
      );
      syncRegistry(db, registryPath);
      expect(listAgents(db).map((a) => a.id).sort()).toEqual(["bill", "testclaude"]);

      writeFileSync(
        registryPath,
        JSON.stringify([
          {
            id: "bill",
            display_name: "Bill",
            role: "Infra",
            runtime: "claude_channel",
            status_provider: "claude_tmux",
            workspace_path: "/tmp/bill",
            persona_file: "/tmp/bill/CLAUDE.md",
          },
        ]),
      );
      syncRegistry(db, registryPath);

      expect(listAgents(db).map((a) => a.id)).toEqual(["bill"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("syncRegistry restores an empty registry from a non-empty team.db roster", () => {
    const dir = mkdtempSync(join(tmpdir(), "team-registry-recovery-"));
    try {
      const registryPath = join(dir, "agents.json");
      const db = openDb(join(dir, "team.db"));
      migrate(db);
      const original = [{
        id: "bill", display_name: "Bill", role: "Infra", runtime: "claude_channel",
        status_provider: "claude_tmux", workspace_path: "/tmp/bill", persona_file: "/tmp/bill/CLAUDE.md",
      }];
      writeFileSync(registryPath, JSON.stringify(original));
      syncRegistry(db, registryPath);

      // 사고 입력을 직접 재현: 파일만 [], DB roster는 유지.
      writeFileSync(registryPath, "[]\n");
      const recovered = syncRegistry(db, registryPath, dir);

      expect(recovered.map((a) => a.id)).toEqual(["bill"]);
      expect(listAgents(db).map((a) => a.id)).toEqual(["bill"]);
      expect(JSON.parse(readFileSync(registryPath, "utf-8")).map((a: any) => a.id)).toEqual(["bill"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("syncRegistry prefers a matching backup so registry-only fields survive recovery", () => {
    const dir = mkdtempSync(join(tmpdir(), "team-registry-backup-recovery-"));
    try {
      const registryPath = join(dir, "agents.json");
      const db = openDb(join(dir, "team.db"));
      migrate(db);
      const original = [{
        id: "bill", display_name: "Bill", nicknames: ["빌"], capabilities: ["coordinator"],
        role: "Infra", runtime: "claude_channel", status_provider: "claude_tmux",
        workspace_path: "/tmp/bill", persona_file: "/tmp/bill/CLAUDE.md",
      }];
      writeFileSync(registryPath, JSON.stringify(original));
      syncRegistry(db, registryPath);
      writeFileSync(`${registryPath}.bak`, JSON.stringify(original));
      writeFileSync(registryPath, "[]\n");

      const recovered = syncRegistry(db, registryPath, dir);
      expect(recovered[0]?.nicknames).toEqual(["빌"]);
      expect(recovered[0]?.capabilities).toEqual(["coordinator"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("syncRegistry honors a one-shot explicitly forced empty registry", () => {
    const dir = mkdtempSync(join(tmpdir(), "team-registry-force-empty-"));
    try {
      const registryPath = join(dir, "agents.json");
      const db = openDb(join(dir, "team.db"));
      migrate(db);
      writeFileSync(registryPath, JSON.stringify([{
        id: "temp", display_name: "Temp", role: "Pending", runtime: "claude_channel",
        status_provider: "claude_tmux", workspace_path: "/tmp/temp", persona_file: "/tmp/temp/CLAUDE.md",
      }]));
      syncRegistry(db, registryPath);

      writeRegistrySafely(registryPath, [], { forceEmpty: true, repoRoot: dir });
      expect(syncRegistry(db, registryPath)).toEqual([]);
      expect(listAgents(db)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── 클린 설치 첫 기동: 팀원 0명은 정상 초기 상태라 경고를 찍지 않는다 (2026-07-25 공개 리허설) ──
  test("syncRegistry 는 팀원 0명(새 설치)에 coordinator 경고를 찍지 않는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "team-registry-fresh-install-"));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const registryPath = join(dir, "agents.json");
      const db = openDb(join(dir, "team.db"));
      migrate(db);
      writeFileSync(registryPath, "[]\n");

      expect(syncRegistry(db, registryPath, dir)).toEqual([]);
      expect(warn.mock.calls.flat().join("\n")).not.toContain("coordinator capability");
      // 경고 대신 안내 문구 1줄.
      expect(log.mock.calls.flat().join("\n")).toContain("첫 팀원을 영입하면 coordinator");
      // 오타·누락 audit 도 남기지 않는다(0명은 오류가 아니다).
      const audits = db.prepare(`SELECT COUNT(*) AS n FROM audit_event WHERE action = 'fallback_no_coordinator'`)
        .get() as { n: number };
      expect(audits.n).toBe(0);
    } finally {
      warn.mockRestore();
      log.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("syncRegistry 는 팀원이 있는데 coordinator 가 없으면 계속 경고한다(진짜 누락)", () => {
    const dir = mkdtempSync(join(tmpdir(), "team-registry-no-coordinator-"));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registryPath = join(dir, "agents.json");
      const db = openDb(join(dir, "team.db"));
      migrate(db);
      writeFileSync(registryPath, JSON.stringify([{
        id: "bill", display_name: "Bill", role: "Infra", runtime: "claude_channel",
        status_provider: "claude_tmux", workspace_path: "/tmp/bill", persona_file: "/tmp/bill/CLAUDE.md",
      }]));

      expect(syncRegistry(db, registryPath, dir).map((a) => a.id)).toEqual(["bill"]);
      expect(warn.mock.calls.flat().join("\n")).toContain("coordinator capability");
      const audits = db.prepare(`SELECT COUNT(*) AS n FROM audit_event WHERE action = 'fallback_no_coordinator'`)
        .get() as { n: number };
      expect(audits.n).toBe(1);
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("syncRegistry ignores a stale or forged force-empty marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "team-registry-forged-marker-"));
    try {
      const registryPath = join(dir, "agents.json");
      const db = openDb(join(dir, "team.db"));
      migrate(db);
      writeFileSync(registryPath, JSON.stringify([{
        id: "bill", display_name: "Bill", role: "Infra", runtime: "claude_channel",
        status_provider: "claude_tmux", workspace_path: "/tmp/bill", persona_file: "/tmp/bill/CLAUDE.md",
      }]));
      syncRegistry(db, registryPath);

      writeFileSync(`${registryPath}.force-empty-once`, "stale\n");
      writeFileSync(registryPath, "[]\n");
      expect(syncRegistry(db, registryPath, dir).map((a) => a.id)).toEqual(["bill"]);
      expect(listAgents(db).map((a) => a.id)).toEqual(["bill"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
