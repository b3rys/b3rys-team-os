/**
 * ★계약: DB 시각 문자열을 맨 `new Date()` 로 파싱하지 않는다.★ (2026-07-13)
 *
 * ■ 무엇이 문제인가
 * SQLite `datetime('now')` 은 ★UTC 인데 타임존 표기가 없는★ 문자열을 저장한다: "2026-07-13 04:48:15".
 * JS 는 이런 문자열을 ★로컬 타임존★ 으로 읽는다 → KST 서버에서 ★정확히 9시간★ 어긋난다.
 *   · 지표: elapsed 가 9시간 부풀어 ★방금 답한 에이전트가 blocked 로 뒤집혔다★ (statusProbe, 실제 발생)
 *   · 화면: 보고서 시각이 ★9시간 이르게★ 표시됐다 (Reports, 실제 발생)
 *   · 감사: waited_ms 가 62초를 ★32,462,745ms(9시간)★ 로 기록했다 (실제 발생)
 * ★셋 다 "코드가 아니라 숫자가 거짓말한" 사고다. 틀린 시각은 포맷 문제가 아니라 틀린 사실이다.★
 *
 * ■ ★왜 이 가드가 '테스트' 가 아니라 '소스 스캔' 인가★
 * ★`bun test` 는 TZ=UTC 로 돈다. 서버는 KST 로 돈다.★ (실측: 테스트 안 오프셋 0, 프로덕션 +9)
 * TZ=UTC 에서는 Z 를 붙이든 말든 결과가 같다 → ★이 버그는 평범한 유닛 테스트로 원리적으로 못 잡는다.★
 * 실제로 statusProbe 의 기존 테스트 5개는 전부 통과하고 있었고 ★버그는 살아 있었다.★
 * (그 테스트들이 toISOString() 을 먹였기 때문이다 — ★프로덕션이 넘기는 형식이 아니었다.★)
 * → 그래서 런타임이 아니라 ★소스를 본다.★ 이건 우회로가 아니라 이 문제에 맞는 유일한 자리다.
 *
 * ■ 올바른 파서 (이미 있다 — 새로 만들지 마라)
 *   · 서버: parseCapturedAt (statusProbe) · toUtcIso/timeKST (shared)
 *   · 웹  : parseSqliteDate / formatLocal (web/lib/datetime.ts) ← GD 가 2026-07-04 에 만든 단일 출처
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

/**
 * DB 시각을 담는 이름들 — 이 이름이 `new Date(...)` 안에 그대로 들어가면 의심한다.
 * ★스네이크(created_at)와 카멜(lastActivityAt) 둘 다 잡아야 한다.★
 * 처음엔 `_at` 만 봤다가 ★오늘 실제로 고친 `lastActivityAt` 을 놓쳤다★ — 아래 자기검증이 그걸 잡았다.
 */
const TS_FIELD = /\b\w*(_at|At)\b/;

/** 같은 줄에서 UTC 로 명시했으면 안전하다. */
const NORMALIZED = /parseSqliteDate|parseCapturedAt|toUtcIso|Date\.UTC|\+\s*"Z"|\+\s*'Z'|"Z"\s*\)|replace\(" ", "T"\)\s*\+/;

/**
 * ★허용 — 확인해서 안전한 곳만. 이유를 반드시 적는다.★
 * ★근거 없이 목록에 넣는 순간 이 가드는 아무것도 막지 못한다.★ (오늘 내가 판정기를 다섯 번 잘못 믿었다)
 */
const ALLOW: Record<string, string> = {
  // startedAt 은 Date.now() 가 넣은 ★숫자★ 다 (inFlight Map, wakeDispatcher:1515). new Date(number) 는 UTC 로 정확하다.
  "server/bus/wakeDispatcher.ts:1540": "startedAt: number (Date.now) — 문자열이 아니다",
  // run_at 은 API 입력이고 zod `z.string().datetime()` 이 ★ISO-8601(Z 포함)을 강제★ 한다 (scheduler.ts:18). DB 값이 아니다.
  "server/routes/scheduler.ts:116": "zod .datetime() 이 ISO-Z 를 강제 — DB 문자열이 아니다",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".git" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith(".ts") && !e.includes(".test.")) out.push(p);
  }
  return out;
}

describe("★계약★ DB 시각(Z 없는 UTC)을 로컬로 오독하지 않는다", () => {
  test("★맨 new Date(<...._at>) 가 없다★ — 있으면 KST 서버에서 9시간 거짓말한다", () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const src = readFileSync(file, "utf-8");
      src.split("\n").forEach((line, i) => {
        const m = /new Date\(([^)]*)\)/.exec(line);
        if (!m) return;
        const arg = m[1] ?? "";
        if (!arg.trim()) return;                    // new Date() = 현재시각, 안전
        if (!TS_FIELD.test(arg)) return;            // DB 시각 필드가 아니다
        if (NORMALIZED.test(line)) return;          // UTC 로 명시했다
        const where = `${file.slice(ROOT.length + 1)}:${i + 1}`;
        if (ALLOW[where]) return;                   // 확인해서 안전 (이유는 ALLOW 에)
        offenders.push(`${where}  ${line.trim().slice(0, 90)}`);
      });
    }
    expect(
      offenders,
      `★DB 시각을 Z 없이 파싱하는 곳★ (KST 서버에서 정확히 9시간 어긋난다):\n  ${offenders.join("\n  ")}\n\n` +
        `고치는 법: 웹=parseSqliteDate(web/lib/datetime.ts) · 서버=parseCapturedAt / toUtcIso.\n` +
        `★새 헬퍼를 만들지 마라 — 이미 있다. 안 쓴 게 문제였다.★`,
    ).toEqual([]);
  });

  // ★가드 자체가 동작하는지 증명한다★ — 가드가 아무것도 못 잡는 가드일 수 있다(오늘 내가 그런 쿼리를 썼다).
  test("★가드가 진짜 잡는다★ (탐지 규칙 자체를 핀다)", () => {
    const bad = `  const elapsed = Date.now() - new Date(lastActivityAt).getTime();`;
    const good = `  const at = parseCapturedAt(row.captured_at);`;
    const alsoGood = `  const d = new Date(s.replace(" ", "T") + "Z");`;
    const hit = (l: string) => {
      const m = /new Date\(([^)]*)\)/.exec(l);
      return !!m && !!m[1]?.trim() && TS_FIELD.test(m[1]) && !NORMALIZED.test(l);
    };
    expect(hit(bad)).toBe(true);        // ★실제로 오늘 고친 그 줄★
    expect(hit(good)).toBe(false);
    expect(hit(alsoGood)).toBe(false);
  });
});
