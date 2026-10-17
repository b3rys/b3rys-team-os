/** 지속 허용은 사람이 보고 취소할 수 있도록 Codex writable_roots 설정으로 기록한다.
 * 현재 호출부는 공백 없는 단일 절대경로만 허용하나 실제 target은 표시·해시 문자열이어서 설정을 넓히지 않는다. 재활성화하려면 정규화된 절대경로 배열을 payload로 따로 전달하는 후속 변경이 필요하다. */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 이 경로를 앞으로 묻지 않고 쓰게 한다. 이미 있으면 그대로(중복 추가 안 함). */
export function addWritableRoot(configPath: string, targetPath: string): { changed: boolean; root: string } {
  // 파일 하나가 아니라 그 파일이 있는 폴더 를 연다 — 같은 작업의 다음 파일에서 또 묻지 않게.
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
