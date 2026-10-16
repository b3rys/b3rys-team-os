// 발신자 ID를 추측하면 답이 다른 팀원에게 전달된다. 신원은 명부와 대조하고 해석 실패는 중단해야 한다. 저장소 밖 사본은 이 검사 범위가 아니다.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SKILLS = join(import.meta.dir, "..", "..", "..", "skills");

function shellFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) shellFiles(p, out);
    else if (e.endsWith(".sh")) out.push(p);
  }
  return out;
}

/** 신원 해석 실패를 기본값으로 삼키는 패턴. '모르면 멈춘다' 를 무력화한다. */
const SWALLOWS_FAILURE = /_me\.sh[^\n]*\|\|\s*echo\s+\S/;

/** tmux 세션 이름에서 id 를 지어내는 패턴 (DB 대조 없이 접두사만 떼는 것). */
const GUESSES_FROM_TMUX = /echo\s+"?\$\{SESSION#claude-\}"?/;

describe("★계약★ 신원은 추측하지 않는다 — 모르면 실패한다", () => {
  test("★_me.sh 실패를 기본값으로 삼키는 곳이 없다★ (|| echo unknown = 유령 이름으로 행세하기)", () => {
    const offenders: string[] = [];
    for (const f of shellFiles(SKILLS)) {
      const src = readFileSync(f, "utf-8");
      src.split("\n").forEach((line, i) => {
        if (SWALLOWS_FAILURE.test(line)) offenders.push(`${f.slice(SKILLS.length + 1)}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(
      offenders,
      `★신원 해석 실패를 기본값으로 덮는 곳★:\n  ${offenders.join("\n  ")}\n\n` +
        `이러면 해석이 틀려도 스크립트가 ★성공한 척★ 한다. 실패는 실패로 두고 exit 1 하라.\n` +
        `(--as / --from 같은 ★명시적 지정★ 은 허용된다 — 그건 추측이 아니라 선언이다)`,
    ).toEqual([]);
  });

  test("★정본 _me.sh 는 DB 대조 없이 tmux 이름에서 id 를 지어내지 않는다★", () => {
    const me = readFileSync(join(SKILLS, "b3os-team-inbox", "scripts", "_me.sh"), "utf-8");
    const bare = me.split("\n").filter((l) => GUESSES_FROM_TMUX.test(l) && !l.trim().startsWith("#"));
    expect(
      bare,
      `★tmux 세션 이름을 그대로 id 로 내보내는 줄★:\n  ${bare.join("\n  ")}\n` +
        `claude-<id> 는 ★DB 의 agent.id 와 대조한 뒤에만★ 인정한다.`,
    ).toEqual([]);
    expect(me, "★$TMUX 밖에서 tmux 에 물으면 '남의 최근 세션' 을 받는다 — 반드시 가드해야 한다★").toContain('${TMUX:-}');
    expect(me, "★GD_AGENT_ID 도 DB 에 있는 id 일 때만 인정해야 한다★").toContain("FROM agent WHERE id =");
    expect(me, "★다 실패하면 멈춰야 한다★").toContain("exit 1");
  });

  // 가드 자체를 핀다 — 아무것도 못 잡는 가드는 가드가 아니다 (오늘 그런 쿼리를 써서 크게 틀렸다)
  test("★가드가 진짜 잡는다★ (탐지 규칙 자체를 검증)", () => {
    expect(SWALLOWS_FAILURE.test(`ME="$("$DIR/_me.sh" 2>/dev/null || echo unknown)"`)).toBe(true);  // 고친 그 줄
    expect(SWALLOWS_FAILURE.test(`ME="$("$HERE/_me.sh")" || { echo "중단" >&2; exit 1; }`)).toBe(false);
    expect(GUESSES_FROM_TMUX.test(`    echo "${"$"}{SESSION#claude-}"`)).toBe(true);
  });
});
