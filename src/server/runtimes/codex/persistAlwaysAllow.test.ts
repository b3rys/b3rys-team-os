// ★'항상 허용' 은 codex 설정 파일에 쓴다★ (팀 리드 2026-08-12)
//
// 전에는 우리 DB(permission_grant)에 넣었다 — 영구·내용무관·★취소 경로가 코드에 없었다.★
// 설정 파일이면 사람이 열어서 지울 수 있다. 되돌리는 방법이 파일 편집이다.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWritableRoot, roots } from "./persistAlwaysAllow";

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
  expect(roots(readFileSync(p, "utf-8"))).toEqual(["/w", "/data/proj"]); // ★기존 것을 지우지 않는다★
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
  expect(text).toContain('sandbox_mode = "workspace-write"'); // ★기존 설정을 날리지 않는다★
});

test("공백·특수문자 경로도 그대로 살아난다", () => {
  const p = tmpCfg('[sandbox_workspace_write]\nwritable_roots = []\n');
  addWritableRoot(p, "/data/my proj/x.txt");
  expect(roots(readFileSync(p, "utf-8"))).toEqual(["/data/my proj"]);
});
