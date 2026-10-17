// 지속 허용은 사람이 열어 보고 취소할 수 있는 Codex 설정 파일로 기록한다. 복원은 해당 설정 항목 편집으로 한다.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWritableRoot, roots } from "./persistAlwaysAllow";

describe("codex '항상 허용' — 설정에 남겨 다시 묻지 않는다", () => {

const tmpCfg = (body = "") => {
  const p = join(mkdtempSync(join(tmpdir(), "cfg-")), "config.toml");
  writeFileSync(p, body, "utf-8");
  return p;
};

test("★허용한 경로가 설정에 남는다★ — 다음부터 안 묻는다", () => {
  const p = tmpCfg('sandbox_mode = "workspace-write"\n\n[sandbox_workspace_write]\nwritable_roots = ["/w"]\n');
  const r = addWritableRoot(p, "/data/proj/file.txt");
  expect(r.changed).toBe(true);
  expect(r.root).toBe("/data/proj"); // 파일이 아니라 그 폴더를 연다
  expect(roots(readFileSync(p, "utf-8"))).toEqual(["/w", "/data/proj"]); // 기존 것을 지우지 않는다
});

test("두 번 눌러도 중복으로 쌓이지 않는다", () => {
  const p = tmpCfg('[sandbox_workspace_write]\nwritable_roots = ["/w"]\n');
  addWritableRoot(p, "/data/x.txt");
  const second = addWritableRoot(p, "/data/y.txt"); // 같은 폴더
  expect(second.changed).toBe(false);
  expect(roots(readFileSync(p, "utf-8"))).toEqual(["/w", "/data"]);
});

test("writable_roots 가 없던 설정에도 붙는다", () => {
  const p = tmpCfg('sandbox_mode = "workspace-write"\n');
  addWritableRoot(p, "/data/x.txt");
  const text = readFileSync(p, "utf-8");
  expect(roots(text)).toEqual(["/data"]);
  expect(text).toContain("[sandbox_workspace_write]");
  expect(text).toContain('sandbox_mode = "workspace-write"'); // 기존 설정을 날리지 않는다
});

test("공백·특수문자 경로도 그대로 살아난다", () => {
  const p = tmpCfg('[sandbox_workspace_write]\nwritable_roots = []\n');
  addWritableRoot(p, "/data/my proj/x.txt");
  expect(roots(readFileSync(p, "utf-8"))).toEqual(["/data/my proj"]);
});
});
