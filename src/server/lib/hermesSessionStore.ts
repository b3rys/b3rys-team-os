/**
 * hermes 브리지의 (팀원, 버스 스레드) → hermes session id 저장소.
 *
 * 브리지는 턴마다 `hermes -z` 를 별개 프로세스로 띄운다. 프로세스는 턴이 끝나면 죽지만
 * hermes 는 대화를 자기 세션 DB(`~/.hermes/profiles/<p>/state.db`)에 남기고 `--usage-file` 에
 * `session_id` 를 적어 준다. 다음 턴에 `--resume <id>` 를 붙이면 그 대화를 이어간다.
 * 여기는 그 id 를 스레드별로 기억하는 곳이다 — 이 파일이 없으면 매 턴이 첫 대화다.
 *
 * 저장 위치: `var/hermes-sessions/<agent-id>.json` (`HERMES_SESSIONS_DIR` 로 재지정 — 테스트 격리).
 * 모양: `{ "<thread-id>": { "session_id": "20260920_125701_61e9a9", "updated_at": "…" } }`
 *
 * 기억은 보조 장치다 — 읽기·쓰기 실패가 턴을 죽이지 않는다(새 세션으로 시작하면 된다).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./paths";

interface SessionEntry {
  session_id: string;
  updated_at: string;
}
type SessionFile = Record<string, SessionEntry>;

/** 이보다 오래 안 쓰인 스레드의 세션은 저장 시 버린다 — hermes 쪽 세션도 그쯤이면 압축·만료된다. */
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** 한 팀원 파일의 상한 — 넘으면 오래된 것부터 버린다(스레드는 계속 생기고 파일은 매 턴 읽힌다). */
const MAX_THREADS_PER_AGENT = 500;

const SESSION_ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;

function sessionsDir(): string {
  return process.env.HERMES_SESSIONS_DIR ?? join(REPO_ROOT, "var", "hermes-sessions");
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

function filePath(agentId: string): string {
  return join(sessionsDir(), `${safeName(agentId)}.json`);
}

function readFile(agentId: string): SessionFile {
  try {
    const parsed = JSON.parse(readFileSync(filePath(agentId), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: SessionFile = {};
    for (const [thread, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Partial<SessionEntry>;
      if (typeof e.session_id !== "string" || !SESSION_ID_RE.test(e.session_id)) continue;
      out[thread] = { session_id: e.session_id, updated_at: typeof e.updated_at === "string" ? e.updated_at : "" };
    }
    return out;
  } catch {
    return {}; // 없음·깨짐 = 기억 없음
  }
}

function writeFile(agentId: string, data: SessionFile): void {
  const dir = sessionsDir();
  mkdirSync(dir, { recursive: true });
  const target = filePath(agentId);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, target); // 원자적 교체 — 반쯤 쓰인 파일을 다음 턴이 읽지 않게
}

function prune(data: SessionFile, now: number): SessionFile {
  const entries = Object.entries(data).filter(([, e]) => {
    const t = Date.parse(e.updated_at);
    return Number.isFinite(t) ? now - t <= SESSION_TTL_MS : false;
  });
  entries.sort((a, b) => Date.parse(b[1].updated_at) - Date.parse(a[1].updated_at));
  return Object.fromEntries(entries.slice(0, MAX_THREADS_PER_AGENT));
}

/** 이 팀원이 이 스레드에서 마지막으로 쓴 hermes session id. 없으면 null. */
export function getHermesSession(agentId: string, threadId: string): string | null {
  if (!threadId) return null;
  return readFile(agentId)[threadId]?.session_id ?? null;
}

/** 턴이 끝난 뒤 usage-file 의 session_id 를 기록한다. 실패해도 던지지 않는다. */
export function setHermesSession(agentId: string, threadId: string, sessionId: string): boolean {
  if (!threadId || !SESSION_ID_RE.test(sessionId)) return false;
  try {
    const now = Date.now();
    const data = prune(readFile(agentId), now);
    data[threadId] = { session_id: sessionId, updated_at: new Date(now).toISOString() };
    writeFile(agentId, data);
    return true;
  } catch {
    return false;
  }
}

/** hermes 가 그 세션을 모른다고 했을 때 지운다 — 다음 턴이 또 같은 id 로 실패하지 않게. */
export function clearHermesSession(agentId: string, threadId: string): void {
  try {
    const data = readFile(agentId);
    if (!(threadId in data)) return;
    delete data[threadId];
    writeFile(agentId, data);
  } catch {
    /* 무시 — 기억은 보조 장치다 */
  }
}
