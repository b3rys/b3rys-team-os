// 실행파일 절대경로만 풀어도 자식 쉘 내부의 bare name은 해결되지 않으므로 spawn 시 PATH를 보강한다.
import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_BIN_DIRS, withRuntimePath } from "./paths";
import { OPENCLAW_BIN_CANDIDATES, openclawCliCandidates } from "./openclawBridge";

test("withRuntimePath — 런타임 설치 자리를 PATH 앞에 붙이고 기존 PATH 는 뒤에 남긴다", () => {
  const got = withRuntimePath({ PATH: "/usr/bin:/bin", FOO: "bar" });
  const gotPath = got.PATH ?? "";
  expect(got.FOO).toBe("bar");                            // 다른 env 보존
  expect(gotPath.endsWith("/usr/bin:/bin")).toBe(true);   // 기존 PATH 보존

  // 요구를 직접 적는다 — RUNTIME_BIN_DIRS 를 순회해 검사하면 안 된다.
  //   목록을 순회하면 항목이 빠질 때 단언도 같이 약해져 뮤턴트를 못 잡는다(실측으로 확인함).
  //   테스트는 구현이 아니라 요구를 고정해야 한다.
  const required = [
    `${process.env.HOME}/.local/bin`,  // 사용자 전역 설치도 자식 쉘에서 찾아야 한다.
    "/opt/homebrew/bin",
    "/usr/local/bin",                  // Intel Homebrew 설치 경로도 후보에 포함한다.
    `${process.env.HOME}/.bun/bin`,
  ];
  for (const d of required) expect(gotPath.split(":")).toContain(d);
  expect(gotPath.startsWith(`${process.env.HOME}/.local/bin:`)).toBe(true);  // 우선순위 고정
});

test("withRuntimePath — PATH 가 없던 env 도 안전하게 만든다", () => {
  const got = withRuntimePath({ FOO: "bar" });
  expect(got.PATH).toBeTruthy();
  expect((got.PATH ?? "").split(":")).toContain(`${process.env.HOME}/.local/bin`);
});

// 확인(프리플라이트)과 실행이 같은 목록을 본다 — 어긋나면 "설치됨(초록)인데 깨우기 실패" 가 난다.
test("openclaw 후보 목록에 npm -g 자리(~/.local/bin)가 맨 앞에 있다", () => {
  expect(OPENCLAW_BIN_CANDIDATES[0]).toBe(`${process.env.HOME}/.local/bin/openclaw`);
  expect(OPENCLAW_BIN_CANDIDATES).toContain("/opt/homebrew/bin/openclaw");
  expect(OPENCLAW_BIN_CANDIDATES).toContain("/usr/local/bin/openclaw");
});

test("PATH 보강 목록이 openclaw 후보의 디렉터리를 전부 덮는다 (스크립트 안 bare name 도 풀리게)", () => {
  for (const cand of OPENCLAW_BIN_CANDIDATES) {
    const dir = cand.slice(0, cand.lastIndexOf("/"));
    expect(RUNTIME_BIN_DIRS).toContain(dir);
  }
});

// 점검도 OPENCLAW_BIN을 최우선으로 써야 한다. 실제 설치 경로에 기대면 잘못된 우선순위도 통과할 수 있어 후보 함수로 검사한다.
test("★preflight 후보에 OPENCLAW_BIN 이 최우선으로 들어간다★ — 비표준 prefix 오차단 방지", () => {
  const got = openclawCliCandidates({ OPENCLAW_BIN: "/custom/prefix/bin/openclaw" });
  expect(got[0]).toBe("/custom/prefix/bin/openclaw");            // 최우선
  for (const c of OPENCLAW_BIN_CANDIDATES) expect(got).toContain(c); // 기본 후보도 유지
});

test("preflight 후보 — OPENCLAW_BIN 이 없으면 기본 후보만 (빈 값·공백은 무시)", () => {
  expect(openclawCliCandidates({})).toEqual([...OPENCLAW_BIN_CANDIDATES]);
  expect(openclawCliCandidates({ OPENCLAW_BIN: "   " })).toEqual([...OPENCLAW_BIN_CANDIDATES]);
});
