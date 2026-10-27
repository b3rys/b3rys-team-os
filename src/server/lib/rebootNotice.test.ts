import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate } from "../db/migrate";
import { channelRegistry } from "../channels/registry";
import type { AgentRecord } from "../types";
import {
  KEY_LAST_BOOT,
  EXTRA_STATUS_ENV,
  buildBody,
  checkReboot,
  decideBoot,
  extraStatusLine,
  kst,
  groupPoster,
  parseBootTime,
} from "./rebootNotice";

const BOOT_A = 1_793_000_000;
const BOOT_B = BOOT_A + 3 * 3600;

describe("pure pieces", () => {
  test("parseBootTime reads sysctl output and rejects garbage", () => {
    expect(parseBootTime("{ sec = 1793000000, usec = 123456 } Mon Oct 27 04:53:20 2026")).toBe(1_793_000_000);
    expect(parseBootTime("")).toBeNull();
    expect(parseBootTime("{ sec = 12, usec = 0 }")).toBeNull();
    expect(parseBootTime("sysctl: unknown oid")).toBeNull();
  });

  test("decideBoot: first / same within tolerance / rebooted / unknown", () => {
    expect(decideBoot(null, BOOT_A)).toBe("first");
    expect(decideBoot("garbage", BOOT_A)).toBe("first");
    expect(decideBoot(String(BOOT_A), BOOT_A + 2)).toBe("same");
    expect(decideBoot(String(BOOT_A), BOOT_A - 29)).toBe("same");
    expect(decideBoot(String(BOOT_A), BOOT_B)).toBe("rebooted");
    expect(decideBoot(String(BOOT_A), null)).toBe("unknown");
    expect(decideBoot(null, null)).toBe("unknown");
  });

  test("kst and body", () => {
    expect(kst(0)).toBe("1970-01-01 09:00");
    const body = buildBody(BOOT_A, BOOT_B, "추가 상태: 이상 없음");
    expect(body).toContain(`이번 부팅 ${kst(BOOT_B)} KST`);
    expect(body).toContain(`직전 기록 ${kst(BOOT_A)}`);
    expect(body.split("\n")[0]).toBe("[b3os 시스템 알림]");
    expect(body).toContain("점검 항목");
    expect(body).toContain("추가 상태: 이상 없음");
    expect(buildBody(null, BOOT_B, null)).not.toContain("추가 상태");
  });
});

describe("extraStatusLine (read-only)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "reboot-extra-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("unset, missing or empty file -> null", () => {
    expect(extraStatusLine(undefined)).toBeNull();
    expect(extraStatusLine("")).toBeNull();
    expect(extraStatusLine(join(dir, "nope"))).toBeNull();
    writeFileSync(join(dir, "empty.txt"), "\n\n");
    expect(extraStatusLine(join(dir, "empty.txt"))).toBeNull();
  });

  test("returns only the first line, trimmed, and does not change the file", () => {
    const f = join(dir, "status.txt");
    writeFileSync(f, "  all queues empty \nsecond line\n");
    expect(extraStatusLine(f)).toBe("all queues empty");
    expect(readFileSync(f, "utf8")).toBe("  all queues empty \nsecond line\n");
  });

  test("a long line is cut to 200 characters and a directory path is not an error", () => {
    const f = join(dir, "long.txt");
    writeFileSync(f, "x".repeat(10_000));
    expect(extraStatusLine(f)!.length).toBe(200);
    expect(extraStatusLine(dir)).toBeNull();
  });

  test("reads the path from REBOOT_NOTICE_EXTRA_STATUS_FILE by default", () => {
    const f = join(dir, "env.txt");
    writeFileSync(f, "from env");
    const old = process.env[EXTRA_STATUS_ENV];
    process.env[EXTRA_STATUS_ENV] = f;
    try { expect(extraStatusLine()).toBe("from env"); } finally {
      if (old === undefined) delete process.env[EXTRA_STATUS_ENV]; else process.env[EXTRA_STATUS_ENV] = old;
    }
  });
});

describe("checkReboot", () => {
  let dir: string;
  let db: Database;
  const posts: { body: string; threadKey: string }[] = [];
  const logs: string[] = [];
  const deps = (boot: number | null, ok = true) => ({
    bootTime: () => boot,
    extraLine: () => null,
    post: async (body: string, threadKey: string) => { posts.push({ body, threadKey }); return ok; },
    log: (l: string) => logs.push(l),
  });
  const setting = (k: string) => (db.prepare("SELECT value FROM setting WHERE key=?").get(k) as { value: string } | null)?.value ?? null;
  const put = (k: string, v: string) => db.prepare("INSERT OR REPLACE INTO setting(key,value,updated_at) VALUES (?,?,datetime('now'))").run(k, v);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reboot-db-"));
    db = openDb(join(dir, "t.db"));
    migrate(db);
    posts.length = 0; logs.length = 0;
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  test("first run stores silently", async () => {
    expect(await checkReboot(db, deps(BOOT_A))).toBe("first");
    expect(setting(KEY_LAST_BOOT)).toBe(String(BOOT_A));
    expect(posts).toHaveLength(0);
  });

  test("same boot (server restart only) sends nothing", async () => {
    put(KEY_LAST_BOOT, String(BOOT_A));
    expect(await checkReboot(db, deps(BOOT_A + 1))).toBe("same");
    expect(posts).toHaveLength(0);
  });

  test("a new boot sends one broadcast to the configured thread and stores the new time", async () => {
    put(KEY_LAST_BOOT, String(BOOT_A));
    expect(await checkReboot(db, deps(BOOT_B))).toBe("sent");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.threadKey).toBe(`reboot-${kst(BOOT_B).replace(/[- :]/g, "").slice(0, 12)}`);
    expect(posts[0]!.body).toContain("Mac 재부팅 감지");
    expect(setting(KEY_LAST_BOOT)).toBe(String(BOOT_B));
    expect(await checkReboot(db, deps(BOOT_B))).toBe("same"); // restarting again does not repeat it
    expect(posts).toHaveLength(1);
  });

  test("a failed send is not retried on the next start of the same boot", async () => {
    put(KEY_LAST_BOOT, String(BOOT_A));
    expect(await checkReboot(db, deps(BOOT_B, false))).toBe("send_failed");
    expect(await checkReboot(db, deps(BOOT_B))).toBe("same");
    expect(posts).toHaveLength(1);
  });

  test("a throwing poster counts as a failed send, not a crash", async () => {
    put(KEY_LAST_BOOT, String(BOOT_A));
    const r = await checkReboot(db, { ...deps(BOOT_B), post: async () => { throw new Error("down"); } });
    expect(r).toBe("send_failed");
  });

  test("unreadable boot time leaves the stored value alone", async () => {
    put(KEY_LAST_BOOT, String(BOOT_A));
    expect(await checkReboot(db, deps(null))).toBe("unknown");
    expect(setting(KEY_LAST_BOOT)).toBe(String(BOOT_A));
    expect(posts).toHaveLength(0);
  });
});


describe("groupPoster", () => {
  let dir: string;
  let db: Database;
  const realTelegram = channelRegistry.get("telegram")!;
  const sent: { agent?: { id: string }; target: string; text: string }[] = [];
  const agents = [{ id: "elon", capabilities: ["coordinator"] }, { id: "dan" }] as unknown as AgentRecord[];
  const savedFile = process.env.CAPTURE_GROUP_FILE;
  const savedId = process.env.CAPTURE_GROUP_ID;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reboot-gp-"));
    db = openDb(join(dir, "t.db"));
    migrate(db);
    sent.length = 0;
    process.env.CAPTURE_GROUP_FILE = join(dir, "no-such-file.txt"); // never the real group file
    delete process.env.CAPTURE_GROUP_ID;
    channelRegistry.set("telegram", { ...realTelegram, send: async (req: any) => { sent.push(req); return { ok: true } as any; } } as any);
  });
  afterEach(() => {
    channelRegistry.set("telegram", realTelegram);
    if (savedFile === undefined) delete process.env.CAPTURE_GROUP_FILE; else process.env.CAPTURE_GROUP_FILE = savedFile;
    if (savedId === undefined) delete process.env.CAPTURE_GROUP_ID; else process.env.CAPTURE_GROUP_ID = savedId;
    db.close(); rmSync(dir, { recursive: true, force: true });
  });

  test("records a system broadcast and posts to the configured group with the coordinator bot", async () => {
    process.env.CAPTURE_GROUP_ID = "-1001";
    expect(await groupPoster(db, () => agents)("본문", "reboot-202610270300")).toBe(true);
    expect(sent).toEqual([{ agent: agents[0], target: "-1001", text: "[b3os 시스템 알림]\n본문" }]);
    const row = db.prepare("SELECT from_agent_id, to_agent_id, type, source, thread_id FROM message").get() as Record<string, string>;
    expect(row).toEqual({ from_agent_id: "system", to_agent_id: "broadcast", type: "broadcast", source: "system", thread_id: "reboot-202610270300" });
  });

  test("no group configured: recorded but not posted, reported as not delivered", async () => {
    expect(await groupPoster(db, () => agents)("본문", "reboot-202610270300")).toBe(false);
    expect(sent).toHaveLength(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM message").get() as { n: number }).n).toBe(1);
  });

  test("a failed Telegram send is reported as not delivered", async () => {
    process.env.CAPTURE_GROUP_ID = "-1001";
    channelRegistry.set("telegram", { ...realTelegram, send: async () => ({ ok: false, error: "x" }) } as any);
    expect(await groupPoster(db, () => agents)("본문", "reboot-202610270301")).toBe(false);
  });
});
