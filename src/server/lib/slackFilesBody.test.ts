import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, migrate } from "../db/migrate";
import { ensureThread, acceptInbound } from "../db/inboxQueries";
import { bodyWithSlackFiles } from "./slackFiles";

const tokensDir = mkdtempSync(join(tmpdir(), "slacktok-"));
const filesDir = mkdtempSync(join(tmpdir(), "slackfiles-"));
const TS = "1761555000.000100";
const FILE = { name: "교체 영상.mov", mimetype: "video/quicktime", size: 4, url_private_download: "https://files.slack.com/files-pri/T-F/download/x.mov" };

beforeAll(() => {
  process.env.SLACK_TOKENS_DIR = tokensDir;
  process.env.TEAM_SLACK_FILES_DIR = filesDir;
  writeFileSync(join(tokensDir, "steve.env"), "SLACK_BOT_TOKEN=xoxb-steve\n");
  writeFileSync(join(tokensDir, "demis.env"), "SLACK_BOT_TOKEN=xoxb-demis\n");
});

function setup() {
  const db = openDb(":memory:");
  migrate(db);
  for (const id of ["user", "steve", "demis"]) {
    db.prepare("INSERT INTO agent (id, display_name, role, runtime, status_provider, workspace_path, persona_file) VALUES (?, ?, 'dev', 'codex', 'codex_cli', '/tmp', '/tmp/AGENTS.md')").run(id, id);
  }
  return db;
}

const okVideo = () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "video/quicktime" } });
const tokenOf = (init?: RequestInit) => String((init?.headers as Record<string, string>).Authorization).replace("Bearer ", "");

test("글 없이 영상만 와도 본문에 로컬 경로가 붙고, 받는 봇 토큰을 먼저 쓰고 안 되면 다른 봇 토큰을 쓴다", async () => {
  const db = setup();
  const tokens: string[] = [];
  const fetchFn = (async (_u: string, init?: RequestInit) => {
    tokens.push(tokenOf(init));
    // 받는 봇(steve)은 files:read 가 없고 demis 만 있다 — 슬랙은 권한이 없으면 로그인 HTML 을 준다.
    return tokenOf(init) === "xoxb-demis" ? okVideo() : new Response("<html/>", { status: 200, headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;
  const body = await bodyWithSlackFiles({ db, textBody: "", files: [FILE], channel: "C1", messageTs: TS, targetIds: ["steve"], allIds: ["steve", "demis"], fetchFn });
  expect(body).toContain("[슬랙 첨부 파일]");
  const path = body!.match(/→ (\S.*)$/m)?.[1];
  expect(path && existsSync(path)).toBe(true);
  expect(tokens).toEqual(["xoxb-steve", "xoxb-demis"]);
});

test("모든 수신자가 이미 받은 메시지면 다시 받지 않는다(null)", async () => {
  const db = setup();
  const { thread_id } = ensureThread(db, { from_agent_id: "user", to_agent_id: "steve", type: "dm", body: "x" });
  acceptInbound(db, {
    thread_id, from_agent_id: "user", to_agent_id: "steve", body: "x", type: "dm", source: "user", hop_count: 0, priority: "normal",
    meta: { slack: { channel: "C1", thread_ts: TS, message_ts: TS } },
  }, { dedupeWindowSec: 60, broadcast: () => {} });
  let calls = 0;
  const fetchFn = (async () => { calls++; return okVideo(); }) as unknown as typeof fetch;
  const body = await bodyWithSlackFiles({ db, textBody: "", files: [FILE], channel: "C1", messageTs: TS, targetIds: ["steve"], allIds: ["steve"], fetchFn });
  expect(body).toBeNull();
  expect(calls).toBe(0);
});

test("첨부가 없으면 글 그대로이고 내려받지 않는다", async () => {
  const db = setup();
  let calls = 0;
  const fetchFn = (async () => { calls++; return okVideo(); }) as unknown as typeof fetch;
  expect(await bodyWithSlackFiles({ db, textBody: "안녕", files: [], channel: "C1", messageTs: TS, targetIds: ["steve"], allIds: [], fetchFn })).toBe("안녕");
  expect(calls).toBe(0);
});
