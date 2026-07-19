import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOG_DIR = join(__dirname, "../../../logs");

// 로그 디렉토리는 call-time에 해석 — B3OS_AUDIT_LOG_DIR env로 오버라이드 가능(★테스트 격리용★:
// 라이브 logs/ 오염 방지. 팀 하드레슨 — bun test가 실 FS 건드리면 안 됨). 기본 동작은 불변.
function resolveLogDir(): string {
  const dir = process.env.B3OS_AUDIT_LOG_DIR || DEFAULT_LOG_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function todayStamp(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function appendAuditFile(actor: string, action: string, target: string | null, detail: unknown): void {
  const file = join(resolveLogDir(), `audit-${todayStamp()}.log`);
  const line = JSON.stringify({
    at: new Date().toISOString(),
    actor,
    action,
    target,
    detail: detail ?? null,
  });
  try {
    appendFileSync(file, line + "\n", { mode: 0o600 });
  } catch (e) {
    console.error("[audit] file append failed:", e);
  }
}
