/**
 * ★계약: 팀원 신원(agent id)을 추측하지 않는다. 모르면 실패한다.★ (2026-07-13)
 *
 * ■ 이 계약이 생긴 이유 — ★온종일 남의 이름으로 말했다★
 * hermes 가 보낸 모든 메시지가 ★from=bill 로 기록됐다.★ 그래서
 *   · hermes 의 팬아웃 질문이 bill 이 보낸 것처럼 보였고
 *   · 기여자들의 답이 ★hermes 가 아니라 bill 에게★ 갔고
 *   · hermes 는 자기가 물어본 답을 ★영영 받지 못했다★ → 수집이 조용히 실패했다.
 * ★그 상태로 잰 모든 baseline 이 무효였다.★ 원인은 단 하나 — ★_me.sh 가 신원을 '추측' 했다.★
 *
 * ■ 추측의 두 얼굴 (둘 다 금지)
 *   ① ★tmux 세션 이름에서 지어내기★: `claude-<id>` 접두사를 떼어 그대로 믿는다.
 *      더 나쁜 건 ★$TMUX 밖에서 tmux 에 묻는 것★ — tmux 는 '서버의 가장 최근 세션' 을 돌려준다.
 *      즉 ★전혀 다른 팀원의 id 를 받아 그 사람인 척한다.★ (실측: /tmp 에서 실행 → 남의 id 반환)
 *   ② ★실패를 기본값으로 삼키기★: `|| echo unknown` / `|| echo ""` .
 *      ack.sh 가 이랬다 → 해석 실패 시 ★'unknown' 이라는 없는 팀원 이름으로 읽음 처리★ 를 찍었다.
 *      ★서버는 읽었다고 믿고, 진짜 수신자는 영영 안 읽은 상태로 남는다.★
 *
 * ■ 올바른 해석 (정본 _me.sh)
 *   GD_AGENT_ID(★DB 에 존재하는 id 일 때만★) → 현재 폴더 ↔ agent.workspace_path →
 *   tmux 세션 ↔ agent.tmux_session(★$TMUX 안에서만★) → 레거시 claude-<id>(★DB 대조★) → ★exit 1★
 *   ★어느 단계도 지어내지 않는다. 전부 DB 와 대조한다. 다 실패하면 멈춘다.★
 *
 * ■ 이 가드가 잡지 ★못하는★ 것 (정직하게)
 *   ★저장소 밖의 복사본은 못 본다.★ 실제로 오늘 사고를 낸 건 hermes 프로필의 ★낡은 복사본★ 이었다.
 *   공개 릴리스(b3rys-team-os)에도 아직 추측 버전이 나가 있다 — ★그건 다른 저장소라 여기서 못 막는다.★
 *   못 잡는 걸 잡는다고 하지 않는다. ★배포 경로의 동기화는 사람이 확인해야 한다.★
 */
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

/** 신원 해석 실패를 기본값으로 삼키는 패턴. ★'모르면 멈춘다' 를 무력화한다.★ */
const SWALLOWS_FAILURE = /_me\.sh[^\n]*\|\|\s*echo\s+\S/;

/** tmux 세션 이름에서 id 를 ★지어내는★ 패턴 (DB 대조 없이 접두사만 떼는 것). */
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
    // 그리고 반드시 존재해야 하는 방어들 — 하나라도 빠지면 오늘의 사고가 재현된다
    expect(me, "★$TMUX 밖에서 tmux 에 물으면 '남의 최근 세션' 을 받는다 — 반드시 가드해야 한다★").toContain('${TMUX:-}');
    expect(me, "★GD_AGENT_ID 도 DB 에 있는 id 일 때만 인정해야 한다★").toContain("FROM agent WHERE id =");
    expect(me, "★다 실패하면 멈춰야 한다★").toContain("exit 1");
  });

  // ★가드 자체를 핀다★ — 아무것도 못 잡는 가드는 가드가 아니다 (오늘 그런 쿼리를 써서 크게 틀렸다)
  test("★가드가 진짜 잡는다★ (탐지 규칙 자체를 검증)", () => {
    expect(SWALLOWS_FAILURE.test(`ME="$("$DIR/_me.sh" 2>/dev/null || echo unknown)"`)).toBe(true);  // ★고친 그 줄★
    expect(SWALLOWS_FAILURE.test(`ME="$("$HERE/_me.sh")" || { echo "중단" >&2; exit 1; }`)).toBe(false);
    expect(GUESSES_FROM_TMUX.test(`    echo "${"$"}{SESSION#claude-}"`)).toBe(true);
  });
});
