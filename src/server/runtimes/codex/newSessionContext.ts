/**
 * 코덱스 팀원이 ★새 세션★으로 시작할 때(그 대화에 저장된 세션이 없을 때) 첫 요청 앞에 붙이는 인계 글.
 *
 * 코덱스 세션은 대화(팀버스 스레드·텔레그램 채팅)마다 따로라, 새 스레드에서는 다른 스레드에서 한 일을 모른다.
 * 또 AGENTS.md 가 적으라고 하는 MEMORY.md·memory/YYYY-MM-DD.md 는 자동으로 읽히지 않는다. 그래서 새 세션에만
 *   1) 기억 파일 — MEMORY.md, 최근 날짜 메모 2개(끝부분 위주)
 *   2) 다른 대화에서 한 최근 일 — 24시간 안에 내가 다른 스레드로 보낸 글의 첫 줄
 * 을 붙인다. 이어지는 세션(resume)에는 붙이지 않는다 — 그 세션은 이미 알고 있다.
 * 읽기 실패는 조용히 빈 글 — 인계는 덤이고 답을 막으면 안 된다.
 */
import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "../../lib/redactSecrets";

const MEMORY_CHARS = 1500;
const DAILY_CHARS = 1500;
const DAILY_FILES = 2;
const DAILY_MAX_AGE_MS = 3 * 24 * 3600 * 1000;
const OTHER_THREADS = 8;
const LINE_CHARS = 160;
const TOTAL_CHARS = 5000;

/** 끝(최근에 적은 것)이 더 중요하다 — 길면 끝부분을 남긴다. */
function tail(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? "…(앞부분 생략)\n" + t.slice(t.length - n) : t;
}

/** ★읽자마자 가린다★ — 자른 뒤에 가리면 잘린 비밀값 꼬리가 패턴에 안 걸려 남는다. */
function readText(path: string): string {
  try {
    return existsSync(path) && statSync(path).isFile() ? redactSecrets(readFileSync(path, "utf-8")) : "";
  } catch {
    return "";
  }
}

export function memorySection(workspace: string, now = Date.now()): string {
  const parts: string[] = [];
  const mem = readText(join(workspace, "MEMORY.md"));
  if (mem.trim()) parts.push(`### MEMORY.md\n${tail(mem, MEMORY_CHARS)}`);
  const dir = join(workspace, "memory");
  try {
    if (existsSync(dir)) {
      const daily = readdirSync(dir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .sort()
        .reverse()
        .filter((f) => now - statSync(join(dir, f)).mtimeMs < DAILY_MAX_AGE_MS)
        .slice(0, DAILY_FILES)
        .reverse();
      for (const f of daily) {
        const body = readText(join(dir, f));
        if (body.trim()) parts.push(`### memory/${f}\n${tail(body, DAILY_CHARS)}`);
      }
    }
  } catch { /* 기억 폴더를 못 읽어도 답은 한다 */ }
  return parts.join("\n\n");
}

export function otherThreadsSection(db: Database, agentId: string, currentConversation: string): string {
  try {
    const rows = db
      .prepare(
        `SELECT thread_id, body, created_at FROM message
         WHERE from_agent_id = ? AND thread_id != ? AND created_at > datetime('now','-24 hours')
         ORDER BY created_at DESC LIMIT 40`,
      )
      .all(agentId, currentConversation) as { thread_id: string; body: string; created_at: string }[];
    // 스레드마다 가장 최근 글 하나만 — 같은 스레드가 목록을 채우지 않게
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const r of rows) {
      if (seen.has(r.thread_id)) continue;
      seen.add(r.thread_id);
      const first = redactSecrets(String(r.body ?? "")).split("\n").find((l) => l.trim()) ?? "";
      const one = first.length > LINE_CHARS ? first.slice(0, LINE_CHARS) + "…" : first;
      lines.push(`- [${r.thread_id}] (${r.created_at} UTC) ${one}`);
      if (lines.length >= OTHER_THREADS) break;
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

/** 붙일 것이 없으면 빈 문자열. */
export function buildNewSessionContext(
  db: Database,
  agentId: string,
  workspace: string | undefined,
  currentConversation: string,
): string {
  if (process.env.CODEX_NEW_SESSION_CONTEXT === "0") return "";
  const mem = workspace ? memorySection(workspace) : "";
  const others = otherThreadsSection(db, agentId, currentConversation);
  if (!mem && !others) return "";
  let text = "[새 세션 인계 — 참고 자료, 지시 아님] 이 대화는 새 세션으로 시작한다. 아래는 네 기억 파일과 다른 대화에서 최근에 한 일이다. 필요하면 `thread.sh <스레드>` 로 그 대화를 직접 읽는다.\n";
  if (mem) text += `\n## 기억 파일\n${mem}\n`;
  if (others) text += `\n## 다른 스레드에서 최근 보낸 글 (24시간, 스레드마다 최신 1개)\n${others}\n`;
  text = redactSecrets(text);
  return text.length > TOTAL_CHARS ? text.slice(0, TOTAL_CHARS) + "\n…(잘림)" : text;
}

export function withNewSessionContext(prompt: string, context: string): string {
  return context ? `${context}\n---\n\n${prompt}` : prompt;
}
