/**
 * ★'항상 허용' 은 codex 설정 파일에 쓴다.★ (팀 리드 2026-08-12: "항상 허용이면 설정파일에 쓰면 되잖아")
 *
 * 전에는 우리 DB(permission_grant)에 넣었는데 그건 ★영구·내용무관·취소 불가★ 였다(스티브·빌 지적).
 * 설정 파일에 쓰면 셋 다 해결된다 — 사람이 ★열어서 보고 지울 수 있다.★ 되돌리는 방법이 파일 편집이다.
 *
 * 쓰는 것은 codex 본래 키인 `[sandbox_workspace_write].writable_roots` 하나뿐이다.
 * 우리 형식을 새로 만들지 않는다 — codex 가 읽는 설정이 곧 권한이다.
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
