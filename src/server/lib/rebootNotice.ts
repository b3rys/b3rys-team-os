// 재부팅은 서버 재시작과 겉으로 같아 보여 팀장이 알 길이 없다. 서버 기동 때 OS 부팅 시각을 지난 값과 비교해
// 바뀌었을 때만 coordinator 에게 op 알림을 한 번 보낸다. 그룹방에 올리지 않고, 외부 입력은 본문에 넣지 않는다.
import type { Database } from "bun:sqlite";
import type { AgentRecord } from "../types";
import { emitOpNotice, pickOpNoticeRecipient, auditOpNotice } from "./opNotice";

export const BOOT_TIME_SETTING_KEY = "last_boot_time_sec";

/** NTP 시각 보정으로 kern.boottime 이 몇 초 흔들릴 수 있다. 그보다 크게 달라야 재부팅으로 본다. */
export const BOOT_TIME_TOLERANCE_SEC = 120;

/** `sysctl -n kern.boottime` 출력("{ sec = 1793..., usec = ... } Fri Nov ...")에서 sec 를 읽는다. */
export function parseBootTime(out: string): number | null {
  const m = /\bsec\s*=\s*(\d+)/.exec(out);
  if (!m) return null;
  const sec = Number(m[1]);
  return Number.isSafeInteger(sec) && sec > 0 ? sec : null;
}

/** 이 기계의 부팅 시각(초). macOS 가 아니거나 못 읽으면 null — 그때는 알리지 않는다. */
export function readBootTimeSec(): number | null {
  if (process.platform !== "darwin") return null;
  try {
    const r = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "kern.boottime"], { stdout: "pipe", stderr: "ignore" });
    if (r.exitCode !== 0) return null;
    return parseBootTime(r.stdout.toString());
  } catch {
    return null;
  }
}

/** 고정 문구. 시각은 설치본의 시간대로 쓴다. */
export function buildRebootBody(bootSec: number): string {
  const when = new Date(bootSec * 1000).toLocaleString();
  return [
    `[team op] 이 Mac 이 재부팅됐습니다 — 부팅 시각 ${when}.`,
    `재부팅 전에 진행 중이던 일·예약 작업이 끊기지 않았는지 확인하고, 팀장님께 직접 보고해 주세요(이 알림은 system 발신이라 회신 대상이 없습니다).`,
  ].join("\n");
}

export type RebootCheckResult =
  | "disabled"
  | "unknown"
  | "first_run"
  | "same_boot"
  | "notified"
  | "no_recipient"
  | "send_failed";

/**
 * 서버 기동 때 한 번 부른다. 새 부팅 시각을 알림보다 먼저 저장해 같은 부팅에 두 번 알리지 않는다.
 * 발송이 실패해도 재시도하지 않는다.
 */
export function checkRebootNotice(
  db: Database,
  agents: AgentRecord[],
  opts: { bootSec?: number | null; enabled?: boolean; /** 시험용: 읽은 직후·저장 전 */ afterRead?: () => void } = {},
): RebootCheckResult {
  const enabled = opts.enabled ?? process.env.REBOOT_OP_NOTICE !== "0";
  if (!enabled) return "disabled";
  const bootSec = opts.bootSec !== undefined ? opts.bootSec : readBootTimeSec();
  if (bootSec == null) return "unknown";

  // 읽기와 저장을 한 IMMEDIATE transaction 으로 묶는다 — 두 서버가 같은 DB 로 겹쳐 떠도 이전 값을 읽는 쪽은 하나뿐이다.
  const prev = db
    .transaction((): number | null => {
      const row = db.prepare("SELECT value FROM setting WHERE key = ?").get(BOOT_TIME_SETTING_KEY) as
        | { value: string }
        | null;
      opts.afterRead?.();
      db.prepare("INSERT OR REPLACE INTO setting (key, value) VALUES (?, ?)").run(BOOT_TIME_SETTING_KEY, String(bootSec));
      return row ? Number(row.value) : null;
    })
    .immediate();

  if (prev == null || !Number.isFinite(prev)) return "first_run";
  if (Math.abs(bootSec - prev) <= BOOT_TIME_TOLERANCE_SEC) return "same_boot";

  const to = pickOpNoticeRecipient(agents, "");
  if (!to) {
    auditOpNotice(db, "op_notice_no_recipient", "reboot", { boot_sec: bootSec });
    return "no_recipient";
  }
  const id = emitOpNotice(db, { to, body: buildRebootBody(bootSec), threadKey: "op-reboot", priority: "normal" });
  if (!id) {
    auditOpNotice(db, "op_notice_failed", "reboot", { kind: "reboot", to, boot_sec: bootSec, prev_boot_sec: prev });
    return "send_failed";
  }
  auditOpNotice(db, "op_notice_sent", "reboot", { kind: "reboot", to, boot_sec: bootSec, prev_boot_sec: prev, message_id: id });
  return "notified";
}
