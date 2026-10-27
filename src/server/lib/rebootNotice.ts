// Mac 재부팅 감지 알림: 서버가 시작할 때 현재 부팅 시각(sysctl kern.boottime)을 마지막으로 저장한 값과 비교해,
// 달라졌으면 팀 그룹방에 b3os 버스로 한 번 알린다. 서버만 재시작한 경우는 부팅 시각이 같아 알리지 않는다.
//
// 설계 메모
// - 처음 실행(저장값 없음)은 알리지 않고 저장만 한다(설치 직후 오탐 방지).
// - 부팅 시각을 읽지 못하면(unknown) 저장값을 건드리지 않고 알리지 않는다.
// - 같은 부팅으로 여러 번 알리지 않도록 알림 시도 전에 새 값을 먼저 저장한다(발송 실패는 로그만, 재시도 폭주 없음).
// - 발송은 서버 안에서 직접 한다: inbox 라우트의 텔레그램 중계는 source=agent 만 하므로(system 발신은 방에 안 감)
//   (1) 기록용 system broadcast 를 message 에 넣고 (2) 설정된 그룹방(getCaptureGroupId)에 코디네이터 봇으로 보낸다.
// - 추가 상태 한 줄: 환경변수 REBOOT_NOTICE_EXTRA_STATUS_FILE(기본값 없음)이 가리키는 텍스트 파일의 첫 줄을 읽기 전용으로 덧붙인다.
//   파일을 누가 쓰는지는 이 저장소 밖의 일이다(예: 운영자가 만든 로컬 스크립트).
import { Database } from "bun:sqlite";
import { closeSync, openSync, readSync } from "node:fs";
import type { AgentRecord } from "../types";
import { ensureThread, insertMessage } from "../db/inbox/messages";
import { getChannel } from "../channels/registry";
import { getCaptureGroupId } from "./captureConfig";
import { pickOpNoticeRecipient } from "./opNotice";

export const KEY_LAST_BOOT = "last_boot_time";
export const TOLERANCE_SEC = 30; // kern.boottime 은 읽을 때마다 1~2초 흔들릴 수 있다

export type BootVerdict = "first" | "same" | "rebooted" | "unknown";

/** `{ sec = 1793000000, usec = 123 } Mon Oct 27 ...` → 1793000000. 읽지 못하면 null. */
export function parseBootTime(out: string): number | null {
  const m = /sec\s*=\s*(\d+)/.exec(out);
  if (!m) return null;
  const sec = Number(m[1]);
  return Number.isFinite(sec) && sec > 1_000_000_000 ? sec : null;
}

export function readBootTime(): number | null {
  try {
    const p = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "kern.boottime"]);
    return p.exitCode === 0 ? parseBootTime(new TextDecoder().decode(p.stdout)) : null;
  } catch {
    return null;
  }
}

export function decideBoot(stored: string | null, current: number | null): BootVerdict {
  if (current === null) return "unknown";
  const prev = stored === null ? NaN : Number(stored);
  if (!Number.isFinite(prev)) return "first";
  return Math.abs(current - prev) > TOLERANCE_SEC ? "rebooted" : "same";
}

export function kst(sec: number): string {
  return new Date((sec + 9 * 3600) * 1000).toISOString().slice(0, 16).replace("T", " ");
}

export const EXTRA_STATUS_ENV = "REBOOT_NOTICE_EXTRA_STATUS_FILE";
const EXTRA_MAX_BYTES = 4096;
const EXTRA_MAX_CHARS = 200;

/** 환경변수가 가리키는 텍스트 파일의 첫 줄(읽기 전용, 최대 200자). 설정이 없거나 파일이 없거나 비어 있으면 null. */
export function extraStatusLine(path: string | undefined = process.env[EXTRA_STATUS_ENV]): string | null {
  if (!path) return null;
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(EXTRA_MAX_BYTES);
      const n = readSync(fd, buf, 0, EXTRA_MAX_BYTES, 0);
      const first = buf.subarray(0, n).toString("utf8").split(/\r?\n/)[0]!.trim();
      return first ? first.slice(0, EXTRA_MAX_CHARS) : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

export const SYSTEM_HEAD = "[b3os 시스템 알림]";

export function buildBody(prev: number | null, cur: number, extraLine: string | null): string {
  const lines = [
    SYSTEM_HEAD, // 그룹방에는 코디네이터 봇 이름으로 올라가므로, 그 팀원이 쓴 글로 읽히지 않게 첫 줄에 밝힌다
    `Mac 재부팅 감지 — 이번 부팅 ${kst(cur)} KST` + (prev ? ` (직전 기록 ${kst(prev)})` : ""),
    "점검 항목: 팀원 세션이 모두 살아 있는지(/team), 스케줄러 잡이 돌고 있는지, 텔레그램·슬랙 연결, 모델 로그인 상태",
  ];
  if (extraLine) lines.push(extraLine);
  lines.push("(서버가 시작될 때 한 번만 알립니다)");
  return lines.join("\n");
}

export interface RebootDeps {
  bootTime?: () => number | null;
  extraLine?: () => string | null;
  /** 본문과 스레드 키를 받아 그룹방에 게시. 게시까지 성공해야 true. */
  post: (body: string, threadKey: string) => Promise<boolean>;
  log?: (line: string) => void;
}

function getSetting(db: Database, key: string): string | null {
  const r = db.prepare("SELECT value FROM setting WHERE key = ?").get(key) as { value: string } | null;
  return r ? r.value : null;
}

function setSetting(db: Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO setting (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, value);
}

/** 서버 시작 시 한 번 호출. 반환: 무슨 일이 있었는지(시험·로그용). */
export async function checkReboot(db: Database, deps: RebootDeps): Promise<BootVerdict | "sent" | "send_failed"> {
  const log = deps.log ?? ((l: string) => console.log(`[reboot-notice] ${l}`));
  const cur = (deps.bootTime ?? readBootTime)();
  const stored = getSetting(db, KEY_LAST_BOOT);
  const verdict = decideBoot(stored, cur);
  if (verdict === "unknown") {
    log("부팅 시각을 읽지 못해 건너뜀");
    return verdict;
  }
  if (verdict === "same") return verdict;
  setSetting(db, KEY_LAST_BOOT, String(cur)); // 알림 시도 전에 저장: 같은 부팅을 두 번 알리지 않는다
  if (verdict === "first") {
    log("처음 기록(알림 없음)");
    return verdict;
  }
  const body = buildBody(stored === null ? null : Number(stored), cur as number, (deps.extraLine ?? extraStatusLine)());
  const threadKey = `reboot-${kst(cur as number).replace(/[- :]/g, "").slice(0, 12)}`;
  const ok = await deps.post(body, threadKey).catch(() => false);
  log(ok ? "재부팅 알림 발송" : "재부팅 알림 발송 실패(재시도 안 함)");
  return ok ? "sent" : "send_failed";
}

/** 운영용 poster: 기록용 broadcast 를 넣고 그룹방에 코디네이터 봇으로 게시한다. 그룹/봇이 없으면 기록만 하고 false. */
export function groupPoster(db: Database, agents: () => AgentRecord[]): (body: string, threadKey: string) => Promise<boolean> {
  return async (body, threadKey) => {
    try {
      const { thread_id } = ensureThread(db, { thread_id: threadKey, from_agent_id: "system", to_agent_id: "broadcast", type: "broadcast", body });
      insertMessage(db, {
        from_agent_id: "system", to_agent_id: "broadcast", type: "broadcast", body, source: "system",
        meta: { op_notice: true, no_wake: true }, hop_count: 0, priority: "normal", thread_id,
      });
    } catch (e) {
      console.error("[reboot-notice] record failed:", (e as Error).message);
    }
    const group = getCaptureGroupId();
    const list = agents();
    const sender = list.find((a) => a.id === pickOpNoticeRecipient(list, ""));
    if (!group || !sender) return false;
    const r = await getChannel("telegram").send({ agent: sender, target: group, text: body });
    return r.ok;
  };
}
