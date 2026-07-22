// OWNER 1:1 DM sync 워커 — 30초 주기로 각 런타임 저장소의 OWNER 1:1을 dm_message로 옮긴다(준실시간).
// inotify 같은 상시 감시 아님(저부하): 주기 tick마다 최근 세션만 읽어 '새 것'(dedupe)만 insert.
// 별도 dm_message 테이블이라 버스 dispatch와 격리 — 워커 끄면 그만(문제 시 안전 중단).
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { insertDmMessage, type DmMessageInput } from "../db/dmCapture";
import { appendAudit } from "../db/queries";
import { parseClaudeGdDms } from "../runtimes/claude/dmSource";
import { parseHermesGdDms, parseOpenClawGdDms } from "../db/dmRuntimeParsers";
import { resolveOwnerDmId } from "../runtimes/codex/launcher";

export interface DmSyncMember {
  id: string;
  runtime: string;
  workspacePath: string;
  openclawAgentId?: string | null;
  hermesProfile?: string | null;
  hermesStateDbPath?: string | null;
}

const DEFAULT_INTERVAL_MS = 10_000; // OWNER 2026-07-09: 싱크 주기 10초. env B3OS_DM_SYNC_INTERVAL_MS로 조정(최소 5초).

// 런타임별 OWNER 1:1 저장소 경로 해석. 멤버 id 와 런타임 내부 profile/agent id 가 다를 수 있으므로
// agents.json 의 명시 필드(openclaw_agent_id, hermes_profile/state_db_path)를 우선한다.
// 경로가 없을 때 공유/legacy DB 로 폴백하면 "쿼리 성공 + 0건" 조용한 오답이 되므로 폴백하지 않는다.
const warnedMissingHermesStateDb = new Set<string>();

function cleanId(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v && /^[a-z0-9_-]+$/i.test(v) ? v : null;
}

function openClawAgentId(m: DmSyncMember): string {
  return cleanId(m.openclawAgentId) ?? m.id;
}

function openClawSessionsDir(m: DmSyncMember): string {
  const agentsDir = process.env.B3OS_OPENCLAW_AGENTS_DIR || join(homedir(), ".openclaw", "agents");
  return join(agentsDir, openClawAgentId(m), "sessions");
}

function hermesStateDbPath(m: DmSyncMember): string {
  if (m.hermesStateDbPath?.trim()) return m.hermesStateDbPath.trim();
  const profile = cleanId(m.hermesProfile) ?? m.id;
  return join(homedir(), ".hermes", "profiles", profile, "state.db");
}

// 런타임 → OWNER 1:1 파서 (OWNER 지침: if/else 분기 대신 lookup table). 새 런타임은 여기 한 줄 추가.
// codex(runtime="codex", member=dex)는 1:1 텔레그램 DM 봇이 아니라 버스로 소통 → dm_message 대상 아님(OWNER 2026-07-09 확인).
const PARSERS: Record<string, (m: DmSyncMember, ownerChatId: string) => DmMessageInput[]> = {
  claude_channel: (m, owner) => parseClaudeGdDms(m.id, m.workspacePath, owner),
  openclaw: (m, owner) => {
    const dir = openClawSessionsDir(m);
    const agentId = openClawAgentId(m);
    return existsSync(dir) ? parseOpenClawGdDms(m.id, dir, owner, agentId) : [];
  },
  hermes_agent: (m, owner) => {
    const dbPath = hermesStateDbPath(m);
    if (!existsSync(dbPath)) {
      if (!warnedMissingHermesStateDb.has(m.id)) {
        warnedMissingHermesStateDb.add(m.id);
        console.warn(`[dm_sync] hermes state.db 없음: member=${m.id} path=${dbPath} (공유 ~/.hermes/state.db 폴백 안 함)`);
      }
      return [];
    }
    const stateDb = new Database(dbPath, { readonly: true }); // 매 tick 열고 닫음(SQLite open 저비용)
    try {
      return parseHermesGdDms(m.id, stateDb, owner);
    } finally {
      stateDb.close();
    }
  },
};

function setting(db: Database, key: string): string {
  try {
    const row = db.prepare("SELECT value FROM setting WHERE key=?").get(key) as { value?: string } | undefined;
    return row?.value ?? "";
  } catch {
    return "";
  }
}

/**
 * 팀장 1:1 chat_id.
 *
 * ★설정값만 보면 안 된다(적대 리뷰 2026-07-14).★ 대시보드는 이 칸을 ★"비워도 됨"★ 이라고 안내한다
 * (claude 를 첫 팀원으로 영입하면 페어링에서 자동 도출되기 때문). 그래서 팀장이 안내대로 비워 두면
 * ★DM 캡처만 영영 0건★ 이 되고, syncDmOnce 는 {inserted:0} 을 돌려줘 "새 DM 없음" 과 구별되지 않는다.
 * = 하드코딩을 걷어내면서 ★같은 무동작 실패를 한 층 위에 다시 만드는 것.★
 * → 이미 있는 3단 resolver(설정 → claude 페어링 access.json → env)를 쓴다. 셋 다 없을 때만 skip.
 */
function ownerChatId(db: Database): string {
  return setting(db, "owner_chat_id") || resolveOwnerDmId() || "";
}

// 팀장 chat_id 를 못 찾아 캡처를 건너뛸 때 ★한 번은 알린다★ — 조용한 0건이 제일 나쁘다.
let warnedNoOwner = false;

/** DM 적재 on/off — 팀원 세션 기록을 읽는 기능이라 끌 수 있다(OWNER 2026-07-14). 기본 on, "off" 면 캡처 안 함.
 *  매 tick 읽으므로 재시작 없이 즉시 반영. 꺼도 버스·위임·발신은 그대로 돈다(dm_message 는 크리티컬 아님). */
function dmCaptureEnabled(db: Database): boolean {
  return setting(db, "dm_capture") !== "off";
}

export interface DmSyncResult {
  inserted: number;
  scanned: number;
  byMember: Record<string, number>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function recordSyncHealth(db: Database, member: DmSyncMember, state: "ok" | "error", scanned: number, inserted: number, error: string | null): void {
  db.prepare(
    `INSERT INTO dm_sync_health
       (member_id,runtime,state,scanned,inserted,last_success_at,last_error_at,error,updated_at)
     VALUES (?,?,?,?,?,CASE WHEN ?='ok' THEN datetime('now') END,CASE WHEN ?='error' THEN datetime('now') END,?,datetime('now'))
     ON CONFLICT(member_id) DO UPDATE SET
       runtime=excluded.runtime,state=excluded.state,scanned=excluded.scanned,inserted=excluded.inserted,
       last_success_at=CASE WHEN excluded.state='ok' THEN datetime('now') ELSE dm_sync_health.last_success_at END,
       last_error_at=CASE WHEN excluded.state='error' THEN datetime('now') ELSE dm_sync_health.last_error_at END,
       error=excluded.error,updated_at=datetime('now')`,
  ).run(member.id, member.runtime, state, scanned, inserted, state, state, error);
}

/** 한 번 sync. 멤버별 파서 예외는 격리(한 멤버 실패가 나머지 안 막음). */
export function syncDmOnce(
  db: Database,
  members: DmSyncMember[],
  parsers: Record<string, (m: DmSyncMember, ownerChatId: string) => DmMessageInput[]> = PARSERS,
): DmSyncResult {
  let inserted = 0;
  let scanned = 0;
  const byMember: Record<string, number> = {};
  if (!dmCaptureEnabled(db)) return { inserted, scanned, byMember }; // 설정에서 껐음
  const owner = ownerChatId(db);
  if (!owner) {
    if (!warnedNoOwner) {
      warnedNoOwner = true;
      console.warn(
        "[dm_sync] 팀장 chat_id 를 찾지 못해 1:1 DM 캡처를 건너뜁니다 " +
          "(설정 owner_chat_id · claude 페어링 · OWNER_CHAT_ID 전부 없음). 대시보드 설정에서 채우세요.",
      );
    }
    return { inserted, scanned, byMember };
  }
  warnedNoOwner = false; // 다시 찾았으면 경고 리셋
  for (const m of members) {
    const parser = parsers[m.runtime];
    if (!parser) continue; // 미지원 런타임은 조용히 skip (파서 붙기 전)
    let msgs: DmMessageInput[] = [];
    try {
      msgs = parser(m, owner);
    } catch (error) {
      const detail = errorText(error);
      // 실패는 health와 audit 양쪽에 남긴다. health는 현재 판정용, audit은 원인/시각 추적용이다.
      // audit은 같은 멤버의 연속 실패 전이 때만 기록해 10초 폴링 로그 폭증을 막는다.
      const previous = db.prepare("SELECT state,error FROM dm_sync_health WHERE member_id=?").get(m.id) as { state?: string; error?: string | null } | undefined;
      recordSyncHealth(db, m, "error", 0, 0, detail);
      if (previous?.state !== "error" || previous.error !== detail) {
        appendAudit(db, "system", "dm_sync_member_failed", m.id, { runtime: m.runtime, error: detail });
        console.error(`[dm_sync] ${m.id} (${m.runtime}) parser failed: ${detail}`);
      }
      continue; // 멤버별 격리: 다음 멤버는 계속 처리
    }
    scanned += msgs.length;
    let ins = 0;
    for (const msg of msgs) {
      if (insertDmMessage(db, msg)) ins++; // dedupe_key로 이미 있으면 false(중복 skip)
    }
    if (ins) byMember[m.id] = ins;
    inserted += ins;
    recordSyncHealth(db, m, "ok", msgs.length, ins, null);
  }
  return { inserted, scanned, byMember };
}

/**
 * 30초 주기 sync 워커 시작. env B3OS_DM_SYNC_INTERVAL_MS로 조정(최소 5초).
 * 반환된 함수를 호출하면 중단. 한 틱 예외는 워커를 죽이지 않음(격리).
 */
export function startDmSyncWorker(db: Database, getMembers: () => DmSyncMember[]): () => void {
  // Devon 리뷰 minor(2026-07-09): env 가 비숫자면 Number()=NaN → Math.max(5000,NaN)=NaN 이라 폴링이 깨짐.
  //   Number.isFinite 로 검증, 불량이면 기본 30초.
  const parsed = Number(process.env.B3OS_DM_SYNC_INTERVAL_MS);
  const intervalMs = Math.max(5_000, Number.isFinite(parsed) ? parsed : DEFAULT_INTERVAL_MS);
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    try {
      syncDmOnce(db, getMembers());
    } catch {
      /* 워커 격리 — 한 틱 실패가 워커 루프를 죽이지 않음 */
    }
  };
  const handle = setInterval(tick, intervalMs);
  tick(); // 즉시 1회
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
