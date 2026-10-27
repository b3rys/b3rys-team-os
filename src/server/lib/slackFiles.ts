// Slack 첨부 파일 수신: 멘션 메시지의 files 를 봇 토큰으로 내려받아 로컬 폴더에 두고, 버스 본문에 붙일 경로 목록을 만든다.
// 외부 입력이므로 받는 곳(files.slack.com)·개수·크기·파일명·저장 경로를 모두 제한한다. 토큰은 slack 호스트에만 보낸다.
import { mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Database } from "bun:sqlite";
import { HOME } from "./paths";
import { loadAgentCreds } from "./slack";
import { appendAudit } from "../db/queries";

export interface SlackFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
}

export type SlackFileResult =
  | { ok: true; name: string; path: string; size: number; mimetype: string }
  | { ok: false; name: string; reason: string };

export const SLACK_FILE_MAX_BYTES = Number(process.env.TEAM_SLACK_FILE_MAX_MB ?? "300") * 1024 * 1024;
export const SLACK_FILE_MAX_COUNT = 5;
const ALLOWED_HOST = "files.slack.com";

export function slackFilesDir(): string {
  return process.env.TEAM_SLACK_FILES_DIR ?? join(HOME, ".b3os", "slack-files");
}

/** 경로 구분자·제어문자·앞 점을 없애고 100자로 자른다. 비면 file. */
export function sanitizeFileName(raw: string | undefined): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(-100);
  return cleaned || "file";
}

/** 토큰을 보내도 되는 주소인지: https + files.slack.com 만. */
export function isAllowedSlackFileUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === ALLOWED_HOST;
  } catch {
    return false;
  }
}

function safeDir(root: string, key: string): string {
  const dir = resolve(root, key.replace(/[^\w.-]/g, "_"));
  mkdirSync(dir, { recursive: true });
  const realRoot = realpathSync(root);
  const realDir = realpathSync(dir);
  if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) throw new Error("저장 경로가 폴더 밖");
  return realDir;
}

/** files 를 차례로 받는다. tokens 는 앞에서부터 시도(받는 봇 → files:read 있는 같은 워크스페이스 봇). */
export async function downloadSlackFiles(
  files: SlackFile[],
  tokens: string[],
  key: string,
  opts: { fetchFn?: typeof fetch; root?: string } = {},
): Promise<SlackFileResult[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const root = opts.root ?? slackFilesDir();
  const results: SlackFileResult[] = [];
  if (files.length === 0) return results;
  mkdirSync(root, { recursive: true });
  const dir = safeDir(root, key);
  for (const [i, f] of files.entries()) {
    const name = sanitizeFileName(f.name ?? f.title);
    if (i >= SLACK_FILE_MAX_COUNT) { results.push({ ok: false, name, reason: `한 메시지 ${SLACK_FILE_MAX_COUNT}개 초과` }); continue; }
    if ((f.size ?? 0) > SLACK_FILE_MAX_BYTES) { results.push({ ok: false, name, reason: `크기 상한 ${SLACK_FILE_MAX_BYTES >> 20}MB 초과` }); continue; }
    const url = f.url_private_download ?? f.url_private;
    if (!isAllowedSlackFileUrl(url)) { results.push({ ok: false, name, reason: "슬랙 파일 주소가 아님" }); continue; }
    let last = "받을 토큰 없음";
    let done = false;
    for (const token of tokens) {
      try {
        const r = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });
        if (r.status !== 200) { last = `HTTP ${r.status}`; continue; }
        const ct = r.headers.get("content-type") ?? "";
        // files:read 가 없으면 슬랙은 200 + 로그인 HTML 을 준다.
        if (ct.startsWith("text/html") && !(f.mimetype ?? "").startsWith("text/html")) { last = "권한 없음(files:read)"; continue; }
        const buf = new Uint8Array(await r.arrayBuffer());
        if (buf.byteLength > SLACK_FILE_MAX_BYTES) { last = `크기 상한 ${SLACK_FILE_MAX_BYTES >> 20}MB 초과`; break; }
        const path = join(dir, `${i + 1}-${name}`);
        writeFileSync(path, buf, { mode: 0o600 });
        results.push({ ok: true, name, path, size: buf.byteLength, mimetype: f.mimetype ?? ct });
        done = true;
        break;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
    }
    if (!done) results.push({ ok: false, name, reason: last });
  }
  return results;
}

/** 버스 본문 끝에 붙이는 첨부 목록. */
export function formatSlackFiles(results: SlackFileResult[]): string {
  if (results.length === 0) return "";
  const lines = results.map((r, i) =>
    r.ok
      ? `${i + 1}. ${r.name} (${r.mimetype}, ${(r.size / 1024 / 1024).toFixed(1)}MB) → ${r.path}`
      : `${i + 1}. ${r.name} — 받지 못함: ${r.reason}`,
  );
  return `[슬랙 첨부 파일]\n${lines.join("\n")}`;
}

/** 이 팀원이 같은 슬랙 메시지(ts)를 이미 받았는가 — 웹훅 재전송·소켓/폴링 중복 판정. */
export function receivedSlackMessage(db: Database, agentId: string, slackMessageTs: string): boolean {
  const prior = db
    .prepare(
      `SELECT id FROM message
       WHERE to_agent_id = ?
         AND source = 'user'
         AND (meta_json LIKE ? OR meta_json LIKE ?)
       LIMIT 1`,
    )
    .get(agentId, `%"message_ts":"${slackMessageTs}"%`, `%"thread_ts":"${slackMessageTs}"%`);
  return !!prior;
}

/** 멘션 본문 + 첨부 목록. 첨부가 없으면 글 그대로, 모든 수신자가 이미 받은 메시지면 null(다시 받지 않는다).
 *  토큰은 받는 봇 먼저, 그다음 다른 팀원 봇(files:read 가 일부 봇에만 있을 수 있다). */
export async function bodyWithSlackFiles(o: {
  db: Database;
  textBody: string;
  files: SlackFile[];
  channel: string;
  messageTs?: string;
  targetIds: string[];
  allIds: string[];
  fetchFn?: typeof fetch;
}): Promise<string | null> {
  if (o.files.length === 0) return o.textBody;
  if (o.messageTs && o.targetIds.every((id) => receivedSlackMessage(o.db, id, o.messageTs!))) return null;
  const tokens: string[] = [];
  for (const id of [...o.targetIds, ...o.allIds]) {
    const t = loadAgentCreds(id)?.bot_token;
    if (t && !tokens.includes(t)) tokens.push(t);
  }
  const results = await downloadSlackFiles(o.files, tokens, `${o.channel}_${o.messageTs ?? Date.now()}`, { fetchFn: o.fetchFn });
  appendAudit(o.db, "slack:user", "slack_files_received", null, {
    channel: o.channel,
    ok: results.filter((r) => r.ok).length,
    failed: results.flatMap((r) => (r.ok ? [] : [r.reason])),
  });
  return [o.textBody, formatSlackFiles(results)].filter(Boolean).join("\n\n");
}
