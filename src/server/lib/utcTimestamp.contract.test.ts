// SQLite의 시간대 없는 UTC 문자열을 new Date로 읽으면 로컬 시각이 된다. UTC 환경의 테스트에서는 차이가 숨으므로 소스에서 직접 파싱을 검사한다.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

// DB 시각 필드는 스네이크·카멜 표기를 모두 쓰므로 두 이름 형식을 함께 탐지한다.
const TS_FIELD = /\b\w*(_at|At)\b/;

/** 같은 줄에서 UTC 로 명시했으면 안전하다. */
const NORMALIZED = /parseSqliteDate|parseCapturedAt|toUtcIso|Date\.UTC|\+\s*"Z"|\+\s*'Z'|"Z"\s*\)|replace\(" ", "T"\)\s*\+/;

// 줄 삽입으로 면제가 어긋나지 않도록 파일과 특징적인 코드 조각으로 대조한다. 각 면제에는 UTC 파싱이 안전한 근거가 필요하다.
interface AllowEntry {
  file: string;
  /** 그 줄에 반드시 들어 있는 조각. 좁게 적는다 — 넓으면 다른 위반까지 같이 덮는다. */
  snippet: string;
  reason: string;
}
const ALLOW: AllowEntry[] = [
  {
    // run_at은 DB 문자열이 아닌 API 입력이다. z.string().datetime()이 Z 포함 ISO를 강제하므로 new Date가 UTC로 읽는다.
    file: "server/routes/scheduler.ts",
    snippet: "new Date(input.run_at)",
    reason: "zod .datetime() 이 ISO-Z 를 강제 — DB 문자열이 아니다",
  },
];

function isAllowed(file: string, line: string): boolean {
  return ALLOW.some((a) => file === a.file && line.includes(a.snippet));
}

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
        const rel = file.slice(ROOT.length + 1);
        if (isAllowed(rel, line)) return;           // 확인해서 안전 (이유는 ALLOW 에)
        offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`);
      });
    }
    expect(
      offenders,
      `★DB 시각을 Z 없이 파싱하는 곳★ (KST 서버에서 정확히 9시간 어긋난다):\n  ${offenders.join("\n  ")}\n\n` +
        `고치는 법: 웹=parseSqliteDate(web/lib/datetime.ts) · 서버=parseCapturedAt / toUtcIso.\n` +
        `★새 헬퍼를 만들지 마라 — 이미 있다. 안 쓴 게 문제였다.★`,
    ).toEqual([]);
  });

  // 실패 입력으로 검사 자체가 위반을 탐지하는지도 확인한다.
  test("★가드가 진짜 잡는다★ (탐지 규칙 자체를 핀다)", () => {
    const bad = `  const elapsed = Date.now() - new Date(lastActivityAt).getTime();`;
    const good = `  const at = parseCapturedAt(row.captured_at);`;
    const alsoGood = `  const d = new Date(s.replace(" ", "T") + "Z");`;
    const hit = (l: string) => {
      const m = /new Date\(([^)]*)\)/.exec(l);
      return !!m && !!m[1]?.trim() && TS_FIELD.test(m[1]) && !NORMALIZED.test(l);
    };
    expect(hit(bad)).toBe(true);        // 카멜 표기 DB 시각도 검사해야 한다.
    expect(hit(good)).toBe(false);
    expect(hit(alsoGood)).toBe(false);
  });
});

// 대상 코드가 사라진 뒤 면제만 남지 않도록 목록의 실제 매칭도 검사한다.
describe("★면제 목록이 썩지 않는가★", () => {
  test("모든 면제 항목은 실제로 최소 한 줄을 덮는다 — 안 덮으면 죽은 기록이다", () => {
    const dead: string[] = [];
    for (const a of ALLOW) {
      const path = join(ROOT, a.file);
      let hit = false;
      try {
        hit = readFileSync(path, "utf-8").split("\n").some((l) => l.includes(a.snippet));
      } catch {
        /* 파일 자체가 사라졌다 → 죽은 항목 */
      }
      if (!hit) dead.push(`${a.file}  snippet=${JSON.stringify(a.snippet)}  (${a.reason})`);
    }
    expect(
      dead,
      `★아무 줄도 안 덮는 면제 항목★ — 코드가 변했는데 면제 기록만 남았다.\n  ${dead.join("\n  ")}\n\n` +
        `지우거나, 대상이 옮겨갔으면 snippet 을 맞춰라.`,
    ).toEqual([]);
  });

  test("★면제의 전제까지 못박는다★ — run_at 면제는 zod .datetime() 이 Z 를 강제한다는 전제 위에 서 있다", () => {
    // datetime 검증이 제거되면 면제 근거가 사라지므로 Z 없는 입력과 오프셋 입력 거부를 함께 검사한다.
    const src = readFileSync(join(ROOT, "server/routes/scheduler.ts"), "utf-8");
    expect(src).toContain("run_at: z.string().datetime()");
  });
});
