/**
 * ★계약: 대시보드 코드는 네이티브 다이얼로그(prompt/confirm/alert)를 부르지 않는다.★ (2026-07-30)
 *
 * ■ 왜 테스트가 아니라 소스 스캔인가
 * 앱 웹뷰(WKWebView)에서 네이티브 다이얼로그가 억제되면 `prompt()` 는 예외도 없이 ★null 을 돌려준다.★
 * 그러면 버튼을 눌러도 아무 일이 없다 — 실패가 아니라 ★무증상★ 이다. 유닛 테스트는 jsdom/happy-dom 에서
 * 돌기 때문에 이 조건을 재현하지 못한다. 그래서 런타임이 아니라 ★소스를 본다.★
 *
 * ■ 실제로 있었던 일
 * 2026-07-24 #19(0e87b59)가 네이티브 다이얼로그를 인페이지 모달로 전부 교체했다. 그런데 이후
 * #108(644a049)의 태그 기능이 prompt·confirm·alert 를 ★새로 4개 넣었고★, 그걸 잡는 장치가 없어서
 * 그대로 배포됐다. 팀장님이 앱에서 "태그 관리가 안 눌린다" 고 신고하실 때까지 아무도 몰랐다.
 * 되돌림이 아니라 ★새로 추가된 것★ 이었으므로 diff 리뷰로도 눈에 잘 띄지 않았다.
 *
 * ■ 대신 쓸 것 (이미 있다 — 새로 만들지 마라)
 *   components/dialogs.ts — showAlert · showConfirm · showPrompt
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB_ROOT = join(import.meta.dir, "..");

/** 맨 호출 — showConfirm 같은 이름은 앞에 글자가 있어서 걸리지 않는다. */
const BARE_CALL = /(?<![\w$.])(prompt|confirm|alert)\s*\(/;
/** window 를 거쳐 부르는 형태 — 위 패턴은 앞의 '.' 때문에 이걸 놓친다. */
const VIA_WINDOW = /\bwindow\s*\.\s*(prompt|confirm|alert)\s*\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    // 테스트는 제외한다 — 테스트가 window.confirm 을 스텁하는 것은 정당하다.
    if (full.endsWith(".ts") && !full.includes(".test.")) out.push(full);
  }
  return out;
}

/** 주석 줄은 판정에서 뺀다 — 문구 설명에 prompt( 를 적을 수 있다. */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function offenders(): string[] {
  const found: string[] = [];
  for (const file of walk(WEB_ROOT)) {
    readFileSync(file, "utf-8").split("\n").forEach((line, i) => {
      if (isComment(line)) return;
      if (!BARE_CALL.test(line) && !VIA_WINDOW.test(line)) return;
      found.push(`${file.slice(WEB_ROOT.length + 1)}:${i + 1}  ${line.trim().slice(0, 90)}`);
    });
  }
  return found;
}

describe("★계약★ 대시보드는 네이티브 다이얼로그를 쓰지 않는다", () => {
  // ★자기검증★ — 판정기가 실제로 잡는지 먼저 본다. 이게 없으면 정규식이 아무것도 안 잡는 상태로
  //   "위반 0건" 이 되어 가드가 조용히 죽는다(감시기가 자기가 요구하는 걸 못 보는 실패).
  test("판정기가 고쳐진 그 코드들을 실제로 잡는다", () => {
    const removed = [
      `  const raw = prompt(pick("태그 이름을 쉼표로", "Enter tag names"), current);`,
      `    if (!confirm(pick("삭제할까요?", "Delete?"))) return;`,
      `    void manageTags().catch((err) => alert(err.message));`,
      `      window.confirm("정말?");`,
    ];
    for (const line of removed) {
      expect(BARE_CALL.test(line) || VIA_WINDOW.test(line), `못 잡았다: ${line}`).toBe(true);
    }
  });

  test("바꿔 쓰는 함수 이름들은 오탐으로 잡지 않는다", () => {
    for (const line of [
      `import { showAlert, showConfirm, showPrompt } from "./dialogs";`,
      `  const yes = await showConfirm({ title: "지울까요?" });`,
      `  const raw = await showPrompt({ placeholder: "예: 주간보고" });`,
      `  await showAlert(msg);`,
    ]) {
      expect(BARE_CALL.test(line) || VIA_WINDOW.test(line), `오탐: ${line}`).toBe(false);
    }
  });

  test("★src/web 어디에도 네이티브 다이얼로그 호출이 없다★", () => {
    expect(
      offenders(),
      "네이티브 다이얼로그는 앱 웹뷰에서 조용히 무시된다 — components/dialogs.ts 의 showAlert·showConfirm·showPrompt 를 쓸 것",
    ).toEqual([]);
  });
});
