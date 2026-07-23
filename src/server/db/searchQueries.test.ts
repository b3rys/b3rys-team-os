import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "./migrate";
import { createSearchRoutes } from "../routes/search";
import { rebuildSearchIndex, searchTeam } from "./searchQueries";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  db.exec(`
    INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file)
    VALUES ('codex', 'Codex', 'PM', 'openclaw', 'openclaw_gateway', '/dev/null', '/dev/null'),
           ('hermes', 'Hermes', 'CSO', 'hermes_agent', 'hermes_gateway', '/dev/null', '/dev/null');
    INSERT INTO thread (id, title, kind, participants_json, opened_by)
    VALUES ('team-search-20260601', 'Team search', 'dm', '["codex","hermes"]', 'codex');
    INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, hop_count, delivery_status, created_at)
    VALUES ('m1', 'team-search-20260601', 'codex', 'hermes', 'dm', '헤르메스 영입 후 Chat not found blocker가 해소됐다', 'agent', 0, 'delivered', '2026-06-01 00:00:00'),
           ('m2', 'team-search-20260601', 'codex', 'hermes', 'dm', '팀 검색은 버스 메시지와 문서를 함께 찾는다', 'agent', 0, 'delivered', '2026-06-01 00:02:00');
    INSERT INTO audit_event (actor, action, target, detail_json, at)
    VALUES ('codex', 'router_alias_added', 'hermes', '{"aliases":["헤르메스","cso"]}', '2026-06-01 00:01:00');
  `);
  return db;
}

describe("team search V0", () => {
  test("indexes messages, audit rows, docs, rules, reports, and registry", () => {
    const db = makeDb();
    const root = mkdtempSync(join(tmpdir(), "team-search-"));
    try {
      const docs = join(root, "docs");
      const reports = join(root, "reports");
      const rules = join(root, "rules");
      mkdirSync(docs);
      mkdirSync(reports);
      mkdirSync(rules);
      writeFileSync(join(docs, "TEAM_SEARCH_SPEC.md"), "# Team Search\n\nDevon implements FTS search.");
      writeFileSync(join(reports, "handoff.md"), "# Handoff\n\nDemis suggested trigram tokenizer evaluation.");
      writeFileSync(join(rules, "SHARED.md"), "# Shared\n\nHermes workspace is registered.");
      const registry = join(root, "agents.json");
      writeFileSync(registry, JSON.stringify([{ id: "devon", role: "Staff Engineer" }]));

      const rebuilt = rebuildSearchIndex(db, { docsDir: docs, reportsDir: reports, rulesDir: rules, registryPath: registry });
      expect(rebuilt.indexed.message).toBe(2);
      expect(rebuilt.indexed.audit).toBe(1);
      expect(rebuilt.indexed.doc).toBeGreaterThan(0);
      expect(rebuilt.indexed.report).toBeGreaterThan(0);
      expect(rebuilt.indexed.rule).toBeGreaterThan(0);
      expect(rebuilt.indexed.registry).toBe(1);

      expect(searchTeam(db, "헤르메스", 10).some((r) => r.source_type === "message")).toBe(true);
      expect(searchTeam(db, "Chat not found", 10).some((r) => r.message_id === "m1")).toBe(true);
      expect(searchTeam(db, "trigram", 10).some((r) => r.source_type === "report")).toBe(true);
      expect(searchTeam(db, "devon", 10, "registry").some((r) => r.source_type === "registry")).toBe(true);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("LIKE fallback covers short Korean terms that FTS tokenizers can miss", () => {
    const db = makeDb();
    try {
      rebuildSearchIndex(db, { docsDir: "/no-docs", reportsDir: "/no-reports", rulesDir: "/no-rules", registryPath: "/no-registry" });
      const results = searchTeam(db, "영입", 10);
      expect(results.some((r) => r.match_type === "like" && r.message_id === "m1")).toBe(true);
      expect(searchTeam(db, "검색", 10).some((r) => r.match_type === "like" && r.message_id === "m2")).toBe(true);
      expect(searchTeam(db, "버스", 10).some((r) => r.match_type === "like" && r.message_id === "m2")).toBe(true);
    } finally {
      db.close();
    }
  });

  test("deduplicates LIKE fallback rows after FTS matches", () => {
    const db = makeDb();
    try {
      rebuildSearchIndex(db, { docsDir: "/no-docs", reportsDir: "/no-reports", rulesDir: "/no-rules", registryPath: "/no-registry" });
      const results = searchTeam(db, "found", 10);
      const ids = results.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      db.close();
    }
  });

  test("query aliases find renamed canonical docs without requiring exact wording", () => {
    const db = makeDb();
    const root = mkdtempSync(join(tmpdir(), "team-search-alias-"));
    try {
      const docs = join(root, "docs");
      const reports = join(root, "reports");
      const rules = join(root, "rules");
      mkdirSync(docs);
      mkdirSync(reports);
      mkdirSync(rules);
      writeFileSync(
        join(docs, "TEAM_OS_SKILL_PACKAGING_PLAN_20260603.md"),
        "# Packaging\n\nteam-os-starter is a self-contained skill package with install notes.",
      );
      writeFileSync(
        join(docs, "COMMUNICATION_FLOW.md"),
        "# Communication\n\nwakeDispatcher and TEAM_BUS deliver runtime wake messages.",
      );
      const registry = join(root, "agents.json");
      writeFileSync(registry, JSON.stringify([{ id: "devon", role: "Staff Engineer" }]));
      db.prepare(
        `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, hop_count, delivery_status, created_at)
         VALUES ('m3', 'team-search-20260601', 'codex', 'hermes', 'dm', 'b3rys-team-os 공개 스킬 설치 가이드 런타임 메시지 전달 owner 답장 질문', 'agent', 0, 'delivered', '2026-06-01 00:03:00')`,
      ).run();
      rebuildSearchIndex(db, { docsDir: docs, reportsDir: reports, rulesDir: rules, registryPath: registry });

      expect(searchTeam(db, "b3rys-team-os 공개 스킬 설치 가이드", 5)[0]?.source_ref).toContain("TEAM_OS_SKILL_PACKAGING_PLAN");
      expect(searchTeam(db, "런타임을 깨우고 메시지를 전달하는 구조", 5)[0]?.source_ref).toContain("COMMUNICATION_FLOW");
      expect(searchTeam(db, "devon Codex-based Staff Engineer", 5)[0]?.source_ref).toContain("agents.json");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("GET search is read-only and reindex requires explicit confirmation", async () => {
    const db = makeDb();
    const root = mkdtempSync(join(tmpdir(), "team-search-route-"));
    try {
      const docs = join(root, "docs");
      const reports = join(root, "reports");
      const rules = join(root, "rules");
      mkdirSync(docs);
      mkdirSync(reports);
      mkdirSync(rules);
      const registry = join(root, "agents.json");
      writeFileSync(registry, JSON.stringify([{ id: "devon", role: "Staff Engineer" }]));
      rebuildSearchIndex(db, { docsDir: docs, reportsDir: reports, rulesDir: rules, registryPath: registry });

      const countBefore = (db.prepare("SELECT COUNT(*) AS n FROM team_search_chunk").get() as { n: number }).n;
      const app = createSearchRoutes({ db, docsDir: docs, reportsDir: reports, rulesDir: rules, registryPath: registry });
      const getResponse = await app.request("/search?q=%EA%B2%80%EC%83%89&limit=20");
      const getJson = await getResponse.json();
      const countAfter = (db.prepare("SELECT COUNT(*) AS n FROM team_search_chunk").get() as { n: number }).n;

      expect(getResponse.status).toBe(200);
      expect(getJson.ok).toBe(true);
      expect(getJson.mode).toBe("lexical");
      expect(countAfter).toBe(countBefore);

      const rejectedReindex = await app.request("/search/reindex", { method: "POST" });
      expect(rejectedReindex.status).toBe(400);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("GET search status and debug metadata support quality-loop triage", async () => {
    const db = makeDb();
    const root = mkdtempSync(join(tmpdir(), "team-search-status-"));
    try {
      const docs = join(root, "docs");
      const reports = join(root, "reports");
      const rules = join(root, "rules");
      mkdirSync(docs);
      mkdirSync(reports);
      mkdirSync(rules);
      const registry = join(root, "agents.json");
      writeFileSync(registry, JSON.stringify([{ id: "devon", role: "Staff Engineer" }]));
      rebuildSearchIndex(db, { docsDir: docs, reportsDir: reports, rulesDir: rules, registryPath: registry });
      const countBefore = (db.prepare("SELECT COUNT(*) AS n FROM team_search_chunk").get() as { n: number }).n;
      const app = createSearchRoutes({ db, docsDir: docs, reportsDir: reports, rulesDir: rules, registryPath: registry });

      const statusResponse = await app.request("/search/status");
      const statusJson = await statusResponse.json();
      const countAfterStatus = (db.prepare("SELECT COUNT(*) AS n FROM team_search_chunk").get() as { n: number }).n;
      expect(statusResponse.status).toBe(200);
      expect(statusJson.ok).toBe(true);
      expect(statusJson.chunk_count_total).toBe(countBefore);
      expect(statusJson.chunk_count_by_source.message).toBe(2);
      expect(Array.isArray(statusJson.source_status)).toBe(true);
      const messageStatus = statusJson.source_status.find((row: { source_type: string }) => row.source_type === "message");
      expect(messageStatus.stale_after_seconds).toBe(60);
      expect(countAfterStatus).toBe(countBefore);

      const debugResponse = await app.request("/search?q=%ED%97%A4%EB%A5%B4%EB%A9%94%EC%8A%A4&debug=true&limit=5");
      const debugJson = await debugResponse.json();
      expect(debugResponse.status).toBe(200);
      expect(debugJson.ok).toBe(true);
      expect(debugJson.results[0].debug.chunk_id).toBe(debugJson.results[0].id);
      expect(debugJson.results[0].debug.source_type).toBe(debugJson.results[0].source_type);
      expect(debugJson.results[0].debug.indexed_at).toBe(debugJson.results[0].indexed_at);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("search status allows short live-write lag before marking message and audit stale", async () => {
    const db = makeDb();
    try {
      rebuildSearchIndex(db, { docsDir: "/no-docs", reportsDir: "/no-reports", rulesDir: "/no-rules", registryPath: "/no-registry" });
      db.prepare("UPDATE team_search_chunk SET indexed_at = '2026-06-01 00:02:00'").run();
      db.prepare(
        `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, hop_count, delivery_status, created_at)
         VALUES ('m3', 'team-search-20260601', 'codex', 'hermes', 'dm', 'short lag message', 'agent', 0, 'delivered', '2026-06-01 00:02:30')`,
      ).run();
      db.prepare(
        `INSERT INTO audit_event (actor, action, target, detail_json, at)
         VALUES ('codex', 'search_status_checked', 'team-search', '{}', '2026-06-01 00:03:00')`,
      ).run();

      const app = createSearchRoutes({
        db,
        docsDir: "/no-docs",
        reportsDir: "/no-reports",
        rulesDir: "/no-rules",
        registryPath: "/no-registry",
      });
      const statusResponse = await app.request("/search/status");
      const statusJson = await statusResponse.json();
      expect(statusJson.stale).toBe(false);

      db.prepare(
        `INSERT INTO message (id, thread_id, from_agent_id, to_agent_id, type, body, source, hop_count, delivery_status, created_at)
         VALUES ('m4', 'team-search-20260601', 'codex', 'hermes', 'dm', 'old lag message', 'agent', 0, 'delivered', '2026-06-01 00:04:00')`,
      ).run();
      const staleResponse = await app.request("/search/status");
      const staleJson = await staleResponse.json();
      const staleMessage = staleJson.source_status.find((row: { source_type: string }) => row.source_type === "message");
      expect(staleMessage.lag_seconds).toBe(120);
      expect(staleMessage.stale).toBe(true);
      expect(staleJson.stale).toBe(true);
    } finally {
      db.close();
    }
  });

  test("search modes expose disabled vector behavior without changing lexical fallback", async () => {
    const db = makeDb();
    const prev = process.env.TEAM_SEARCH_VECTOR_ENABLED;
    process.env.TEAM_SEARCH_VECTOR_ENABLED = "false";
    try {
      rebuildSearchIndex(db, { docsDir: "/no-docs", reportsDir: "/no-reports", rulesDir: "/no-rules", registryPath: "/no-registry" });
      const app = createSearchRoutes({
        db,
        docsDir: "/no-docs",
        reportsDir: "/no-reports",
        rulesDir: "/no-rules",
        registryPath: "/no-registry",
      });

      const semanticResponse = await app.request("/search?q=delivery&mode=semantic");
      const semanticJson = await semanticResponse.json();
      expect(semanticResponse.status).toBe(503);
      expect(semanticJson.ok).toBe(false);
      expect(semanticJson.warnings[0]).toContain("run /search/vector/reindex first");

      const hybridResponse = await app.request("/search?q=Chat%20not%20found&mode=hybrid");
      const hybridJson = await hybridResponse.json();
      expect(hybridResponse.status).toBe(200);
      expect(hybridJson.ok).toBe(true);
      expect(hybridJson.mode).toBe("hybrid");
      expect(hybridJson.effective_mode).toBe("lexical");
      expect(hybridJson.warnings[0]).toContain("lexical fallback");
      expect(hybridJson.results.some((r: { message_id: string | null }) => r.message_id === "m1")).toBe(true);

      const invalidResponse = await app.request("/search?q=Chat&mode=unknown");
      expect(invalidResponse.status).toBe(400);
    } finally {
      if (prev === undefined) delete process.env.TEAM_SEARCH_VECTOR_ENABLED;
      else process.env.TEAM_SEARCH_VECTOR_ENABLED = prev;
      db.close();
    }
  });

  test("vector reindex route is gated by confirmation and vector enablement", async () => {
    const db = makeDb();
    const prev = process.env.TEAM_SEARCH_VECTOR_ENABLED;
    process.env.TEAM_SEARCH_VECTOR_ENABLED = "false";
    try {
      rebuildSearchIndex(db, { docsDir: "/no-docs", reportsDir: "/no-reports", rulesDir: "/no-rules", registryPath: "/no-registry" });
      const app = createSearchRoutes({
        db,
        docsDir: "/no-docs",
        reportsDir: "/no-reports",
        rulesDir: "/no-rules",
        registryPath: "/no-registry",
      });

      const rejected = await app.request("/search/vector/reindex", { method: "POST" });
      expect(rejected.status).toBe(400);

      const response = await app.request("/search/vector/reindex?confirm=local-vector-reindex", { method: "POST" });
      const json = await response.json();
      expect(response.status).toBe(503);
      expect(json.ok).toBe(false);
      expect(json.error).toBe("vector disabled");
    } finally {
      if (prev === undefined) delete process.env.TEAM_SEARCH_VECTOR_ENABLED;
      else process.env.TEAM_SEARCH_VECTOR_ENABLED = prev;
      db.close();
    }
  });
});
