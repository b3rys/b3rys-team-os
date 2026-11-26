import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { openDb, migrate } from "../db/migrate";
import { listAgents } from "../db/queries";
import { loadRegistry, syncRegistry } from "./registry";
import { writeRegistrySafely } from "./registrySafety";

// agents.json written by older versions carries fields this version no longer reads.
const legacy = (name: string) => ["co", "gs", "_", name].join("");

function member(id: string, extra: Record<string, unknown>) {
  return {
    id, display_name: id, role: "Dev", runtime: "claude_channel", status_provider: "claude_tmux",
    tmux_session: null, telegram_bot_username: null,
    workspace_path: `/tmp/${id}`, persona_file: `/tmp/${id}/SOUL.md`, moderator_eligible: false,
    ...extra,
  };
}

describe("agents.json with fields from older versions", () => {
  const entries = [
    member("alpha", {
      [legacy("inbox")]: { api_base: "https://chat.example.invalid", token_file: "/tmp/none", allow_from: [1, "2"] },
      [legacy("permissions")]: { revision: 3, claude: { mode: "folder" } },
      [legacy("tool_scope")]: "full",
    }),
    member("beta", { channel: { kind: "b3chat", api_base: "https://chat.example.invalid", allow_from: ["1"], owner_chat: "1" } }),
    member("gamma", { runtime: "codex", status_provider: "codex_cli", [legacy("tool_scope")]: "folder" }),
  ];

  test("loadRegistry reads every member and ignores the old fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-legacy-"));
    try {
      const path = join(dir, "agents.json");
      writeFileSync(path, JSON.stringify(entries));
      const loaded = loadRegistry(path);
      expect(loaded.map((a) => a.id)).toEqual(["alpha", "beta", "gamma"]);
      for (const a of loaded) {
        expect(Object.keys(a).some((k) => k.startsWith(legacy("")))).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("syncRegistry loads them into the database without error", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-legacy-"));
    try {
      const path = join(dir, "agents.json");
      writeFileSync(path, JSON.stringify(entries));
      const db = openDb(":memory:");
      migrate(db);
      syncRegistry(db, path, dir);
      expect(listAgents(db).map((a) => a.id).sort()).toEqual(["alpha", "beta", "gamma"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rewriting the file through the safe writer keeps those fields untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-legacy-"));
    try {
      const path = join(dir, "agents.json");
      writeFileSync(path, JSON.stringify(entries));
      const list = JSON.parse(readFileSync(path, "utf8")) as Array<Record<string, unknown>>;
      list[0]!.display_name = "Alpha";
      writeRegistrySafely(path, list, { repoRoot: dir });
      const after = JSON.parse(readFileSync(path, "utf8")) as Array<Record<string, unknown>>;
      expect(after[0]!.display_name).toBe("Alpha");
      expect(after[0]![legacy("permissions")]).toEqual({ revision: 3, claude: { mode: "folder" } });
      expect(after[2]![legacy("tool_scope")]).toBe("folder");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
