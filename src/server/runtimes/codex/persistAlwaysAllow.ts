/**
 * ★'항상 허용' 은 codex 설정 파일에 쓴다.★ (팀 리드 2026-08-12: "항상 허용이면 설정파일에 쓰면 되잖아")
 *
 * 전에는 우리 DB(permission_grant)에 넣었는데 그건 ★영구·내용무관·취소 불가★ 였다(스티브·빌 지적).
 * 설정 파일에 쓰면 셋 다 해결된다 — 사람이 ★열어서 보고 지울 수 있다.★ 되돌리는 방법이 파일 편집이다.
 *
 * 쓰는 것은 codex 본래 키인 `[sandbox_workspace_write].writable_roots` 하나뿐이다.
 * 우리 형식을 새로 만들지 않는다 — codex 가 읽는 설정이 곧 권한이다.
 *
 * ★2026-08-13 현재 이 함수는 사실상 호출되지 않는다.★
 *   `bridge.ts` 가 target 이 ★절대경로 하나(공백 없음)★ 일 때만 부르는데, 실제 승인 행의 target 은
 *   `파일 1개 · add /private/tmp/… #지문` · `/bin/zsh -lc '…' #지문` 처럼 ★공백과 지문이 붙은 사람용 문자열★ 이다.
 *   그래서 지금은 어떤 승인도 writable_roots 를 넓히지 않는다. ★이 사실을 모르면 "항상 허용하면 열린다" 로 오해한다.★
 *   되살리려면 팝업을 만들 때 ★정규화된 절대경로 배열★ 을 payload 에 따로 싣고 그걸 읽어야 한다(별건).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 이 경로를 앞으로 묻지 않고 쓰게 한다. 이미 있으면 그대로(중복 추가 안 함). */
export function addWritableRoot(configPath: string, targetPath: string): { changed: boolean; root: string } {
  // 파일 하나가 아니라 ★그 파일이 있는 폴더★ 를 연다 — 같은 작업의 다음 파일에서 또 묻지 않게.
  const root = dirname(targetPath);
  let text = "";
  try { text = readFileSync(configPath, "utf-8"); } catch { /* 없으면 새로 만든다 */ }

  if (roots(text).includes(root)) return { changed: false, root };

  const next = roots(text).concat(root);
  const line = `writable_roots = [${next.map((r) => JSON.stringify(r)).join(", ")}]`;

  let out: string;
  if (/^writable_roots\s*=.*$/m.test(text)) {
    out = text.replace(/^writable_roots\s*=.*$/m, line);
  } else if (/^\[sandbox_workspace_write\]\s*$/m.test(text)) {
    out = text.replace(/^\[sandbox_workspace_write\]\s*$/m, `[sandbox_workspace_write]\n${line}`);
  } else {
    out = `${text.replace(/\s*$/, "")}\n\n[sandbox_workspace_write]\n${line}\n`;
  }
  writeFileSync(configPath, out, "utf-8");
  return { changed: true, root };
}

/** 현재 writable_roots 값들. 없으면 빈 배열. */
export function roots(text: string): string[] {
  const m = /^writable_roots\s*=\s*\[([^\]]*)\]/m.exec(text);
  if (!m) return [];
  return [...m[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => JSON.parse(`"${x[1]}"`));
}
