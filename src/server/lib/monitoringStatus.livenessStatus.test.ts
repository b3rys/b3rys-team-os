import { describe, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOT_LIVENESS_KNOWN_STATUSES, readLivenessStatus } from "./monitoringStatus";

const SCRIPT = join(import.meta.dir, "../../../scripts/bot-liveness-monitor.sh");

/** 스크립트가 실제로 내는 status 값을 소스에서 뽑는다. */
function emittedStatuses(): string[] {
  const src = readFileSync(SCRIPT, "utf-8");
  const found = new Set<string>();
  for (const m of src.matchAll(/finish_status\s+([a-z][a-z0-9-]*)/gi)) found.add(m[1]!.toLowerCase());
  return [...found].sort();
}

function logWith(resultLine: string): string {
  const dir = mkdtempSync(join(tmpdir(), "liveness-status-"));
  const path = join(dir, "bot-liveness-monitor.log");
  writeFileSync(path, `2026-08-04 10:00:00 bot-liveness START (dry_run=0)\n${resultLine}\n`);
  return path;
}

describe("bot-liveness status ↔ 파서 결합", () => {
  // ★이 테스트가 이 PR 의 핵심★
  //   스크립트에 새 status 를 추가하고 파서를 안 고치면 여기서 실패한다. 안 그러면 그 값은
  //   한국어 휴리스틱으로 떨어져 "추측"으로 판정되고, 아무도 그 사실을 모른다.
  test("스크립트가 내는 모든 status 를 파서가 알고 있다", () => {
    const emitted = emittedStatuses();
    expect(emitted.length).toBeGreaterThan(0); // 정규식이 안 맞으면 빈 배열로 헛통과한다
    const unknown = emitted.filter((s) => !BOT_LIVENESS_KNOWN_STATUSES.includes(s));
    expect(unknown).toEqual([]);
  });

  test("정상 판정", () => {
    for (const s of ["ok", "healed", "healed-unreported"]) {
      expect(readLivenessStatus(logWith(`2026-08-04 10:00:01 bot-liveness DONE status=${s}`)).healthy).toBe(true);
    }
  });

  test("이상 판정 — 알리지 못한 경우도 이상이다", () => {
    for (const s of ["issues", "issues-unreported", "error"]) {
      expect(readLivenessStatus(logWith(`2026-08-04 10:00:01 bot-liveness DONE status=${s}`)).healthy).toBe(false);
    }
  });

  test("판정하지 않는 상태는 null — 휴리스틱으로 떨어져서가 아니라 의도된 null 이다", () => {
    for (const s of ["skipped", "reset"]) {
      expect(readLivenessStatus(logWith(`2026-08-04 10:00:01 bot-liveness DONE status=${s}`)).healthy).toBeNull();
    }
  });

  test("접미사가 붙은 값이 짧은 값으로 잘려 매칭되지 않는다", () => {
    // `issues-unreported` 를 `issues` 로 자르면 안 되고, 모르는 접미사는 아예 매칭되면 안 된다.
    const unknownSuffix = readLivenessStatus(
      logWith("2026-08-04 10:00:01 bot-liveness DONE status=issues-somethingnew"),
    );
    expect(unknownSuffix.healthy).not.toBe(false); // 허용목록에 없으므로 명시 판정이면 안 된다
  });
});
