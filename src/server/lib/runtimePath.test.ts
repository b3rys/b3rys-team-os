// 자식 프로세스 PATH 보강 — 2026-07-27 맥스튜디오 인시던트 후속.
//
// openclaw 실행파일 자체는 resolveOpenclawBin() 이 절대경로로 푼다. 그런데 ★approvals 가 spawn 하는
// 쉘 스크립트(activate-openclaw-agent.sh) 안의 bare name 은 그걸로 안 풀린다★ — 그 맥에선 openclaw
// 팀원 영입이 통째로 실패했다. spawn 하는 쪽에서 PATH 를 씌워야 자식 스크립트 내부까지 커버된다.
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

  // ★요구를 직접 적는다 — RUNTIME_BIN_DIRS 를 순회해 검사하면 안 된다.★
  //   목록을 순회하면 항목이 빠질 때 단언도 같이 약해져 ★뮤턴트를 못 잡는다★(실측으로 확인함).
  //   테스트는 구현이 아니라 요구를 고정해야 한다.
  const required = [
    `${process.env.HOME}/.local/bin`,  // ★맥스튜디오가 여기라 죽었다★
    "/opt/homebrew/bin",
    "/usr/local/bin",                  // 손으로 적던 PATH 목록에서 실제로 빠져 있던 자리
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

// ★확인(프리플라이트)과 실행이 같은 목록을 본다★ — 어긋나면 "설치됨(초록)인데 깨우기 실패" 가 난다.
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

// ★점검(preflight)이 실행부와 같은 우선순위를 쓰는지★ — 2026-07-27 Codex 리뷰 적발 회귀.
//
// 실행부 resolveOpenclawBin() 은 OPENCLAW_BIN 을 최우선으로 존중한다. 점검이 후보 목록만 보면
// ★비표준 prefix 에 설치하고 OPENCLAW_BIN 을 지정한 정상 환경을 "CLI 미설치" 로 오차단★ 한다.
// (원래 사고는 방향이 반대였다 — 점검 통과인데 실행 실패. 같은 부류의 어긋남이다.)
//
// ★파일시스템을 타지 않는 순수 함수로 검사한다.★ 처음엔 서브프로세스로 checkRuntimeAuth 를 태웠는데,
// 이 맥에 /opt/homebrew/bin/openclaw 가 실제로 있어서 ★어느 쪽이든 통과하는 무의미한 테스트★ 였다
// (뮤테이션으로 확인함 — 오늘 세 번째 같은 함정이다). 머신 구성에 흔들리지 않는 형태로 바꾼다.
test("★preflight 후보에 OPENCLAW_BIN 이 최우선으로 들어간다★ — 비표준 prefix 오차단 방지", () => {
  const got = openclawCliCandidates({ OPENCLAW_BIN: "/custom/prefix/bin/openclaw" });
  expect(got[0]).toBe("/custom/prefix/bin/openclaw");            // ★최우선★
  for (const c of OPENCLAW_BIN_CANDIDATES) expect(got).toContain(c); // 기본 후보도 유지
});

test("preflight 후보 — OPENCLAW_BIN 이 없으면 기본 후보만 (빈 값·공백은 무시)", () => {
  expect(openclawCliCandidates({})).toEqual([...OPENCLAW_BIN_CANDIDATES]);
  expect(openclawCliCandidates({ OPENCLAW_BIN: "   " })).toEqual([...OPENCLAW_BIN_CANDIDATES]);
});
