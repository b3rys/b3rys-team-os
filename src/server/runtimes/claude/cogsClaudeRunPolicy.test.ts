/**
 * cogs 클로드 정책 → 실행 설정과 [항상] 규칙(순수). 정책이 없는 팀원은 지금 그대로, 깨진 정책·낮은 CLI 는 막는다.
 */
import { describe, expect, test } from "bun:test";
import { readPolicy } from "../../lib/cogsPermissions/policy";
import { alwaysRuleFor, cliSupported, resolveCogsClaudeRun, type CogsClaudeRun } from "./cogsClaudeRunPolicy";

const W = "/Users/t/b3os/members/flo";
const CONTROL = ["/Users/t/b3rys-team-os/agents.json", "/Users/t/b3rys-team-os"];
const ctx = { workspace: W, cliVersion: "2.1.287 (Claude Code)\n", controlPaths: CONTROL };
const claude = (over: Record<string, unknown> = {}) =>
  readPolicy({ runtime: "claude", schema_version: 1, revision: 1, mode: "auto", allow: [], ...over }, "claude");
const enforced = (r: CogsClaudeRun) => r as Extract<CogsClaudeRun, { mode: "enforced" }>;

describe("정책 → 실행 설정", () => {
  test("absent = legacy(지금 그대로, 자동 전환 없음)", () => {
    expect(resolveCogsClaudeRun(readPolicy(undefined, "claude"), ctx)).toEqual({ mode: "legacy" });
  });
  test("깨진 정책·모르는 규칙·버전 오류 = 막음(absent 로 흡수하지 않는다)", () => {
    expect(resolveCogsClaudeRun(readPolicy({ runtime: "claude", schema_version: 9 }, "claude"), ctx)).toEqual({ mode: "blocked", reason: "schema_version" });
    expect(resolveCogsClaudeRun(claude({ allow: ["Bash(rm -rf /)\n"] }), ctx)).toEqual({ mode: "blocked", reason: "allow" });
    expect(resolveCogsClaudeRun(readPolicy({ runtime: "codex", schema_version: 1, revision: 1, full: true, network: true, writable_roots: [] }, "codex"), ctx))
      .toEqual({ mode: "blocked", reason: "runtime_mismatch" });
  });
  test("실측 버전보다 낮은 CLI = 막음", () => {
    expect(resolveCogsClaudeRun(claude(), { ...ctx, cliVersion: "2.1.286 (Claude Code)" })).toEqual({ mode: "blocked", reason: "cli_unsupported" });
    expect(resolveCogsClaudeRun(claude(), { ...ctx, cliVersion: "garbage" })).toEqual({ mode: "blocked", reason: "cli_unsupported" });
    expect(cliSupported("2.1.287 (Claude Code)")).toBe(true);
    expect(cliSupported("2.2.0 (Claude Code)")).toBe(true);
    expect(cliSupported("3.0.0 (Claude Code)")).toBe(true);
    expect(cliSupported("2.0.999 (Claude Code)")).toBe(false);
  });
  test("작업 폴더가 정규 절대 경로가 아니면 막음", () => {
    for (const workspace of ["rel", "/a/../b", "/"]) {
      expect(resolveCogsClaudeRun(claude(), { ...ctx, workspace })).toEqual({ mode: "blocked", reason: "workspace" });
    }
  });
  test("valid = 샌드박스 강제(밖 실행 금지) + 인터넷 + 훅·플러그인 끔", () => {
    const r = enforced(resolveCogsClaudeRun(claude(), ctx));
    expect(r.mode).toBe("enforced");
    expect(r.settings).toMatchObject({
      disableAllHooks: true, enabledPlugins: {}, autoMemoryEnabled: false,
      sandbox: { enabled: true, allowUnsandboxedCommands: false, network: { allowedDomains: ["*"] } },
    });
  });
  test("기본 허용은 작업 폴더 안 읽기·쓰기와 웹뿐 — Bash 는 없다", () => {
    const r = enforced(resolveCogsClaudeRun(claude(), ctx));
    expect(r.allowed).toEqual(["WebFetch", "WebSearch", `Read(/${W}/**)`, `Glob(/${W}/**)`, `Grep(/${W}/**)`, `Write(/${W}/**)`, `Edit(/${W}/**)`]);
    expect(r.allowed.some((rule) => rule.startsWith("Bash"))).toBe(false);
  });
  test("정책 allow 는 기본 뒤에 붙고 중복은 한 번만", () => {
    const r = enforced(resolveCogsClaudeRun(claude({ allow: ["Bash(git status)", "WebFetch"] }), ctx));
    expect(r.allowed.filter((rule) => rule === "WebFetch")).toHaveLength(1);
    expect(r.allowed.at(-1)).toBe("Bash(git status)");
  });
  test("보호 파일·제어 경로·시크릿은 deny 에 있다(allow 와 겹쳐도 deny 가 남는다)", () => {
    const r = enforced(resolveCogsClaudeRun(claude({ allow: [`Write(/${W}/CLAUDE.md)`] }), ctx));
    const deny = (r.settings.permissions as { deny: string[] }).deny;
    for (const rule of [`Write(/${W}/CLAUDE.md)`, `Edit(/${W}/SOUL.md)`, `Write(/${W}/.claude/**)`,
      "Write(//Users/t/b3rys-team-os/agents.json)", "Edit(//Users/t/b3rys-team-os/**)", "Read(//Users/t/b3rys-team-os/agents.json)",
      "Read(**/.env)", "Write(**/.env.*)", "Read(~/.claude/**)"]) {
      expect(deny).toContain(rule);
    }
  });
  test("정책 내용이 바뀌면 도장이 바뀐다", () => {
    const a = enforced(resolveCogsClaudeRun(claude({ allow: [] }), ctx));
    const b = enforced(resolveCogsClaudeRun(claude({ allow: ["Bash(git status)"] }), ctx));
    expect(a.stamp).not.toBe(b.stamp);
  });
});

describe("[항상] 규칙 = 실제 요청에서 최소 범위, 판별 못 하면 숨김", () => {
  const where = { workspace: W, controlPaths: CONTROL };
  const bash = (command: string, extra: Record<string, unknown> = {}) => alwaysRuleFor("Bash", { command, ...extra }, where);
  test("허용 목록 명령은 정확한 명령 그대로(접두·wildcard 없음)", () => {
    expect(bash("git status")).toEqual({ rule: "Bash(git status)" });
    expect(bash("  git   push  origin main ")).toEqual({ rule: "Bash(git push origin main)" });
    expect(bash("swift test --filter ChatStoreTests")).toEqual({ rule: "Bash(swift test --filter ChatStoreTests)" });
  });
  test("복합·파이프·리다이렉션·치환·글롭·따옴표는 숨김", () => {
    for (const command of ["git status && rm -rf x", "ls | sh", "cat a > b", "echo $(id)", "ls `id`", "ls *.md",
      "git commit -m 'x'", "git log; id", "ls\nid", "git status &", "git\tstatus", "git status\t--short", "ls -la\u000bid"]) {
      expect(bash(command).rule).toBeNull();
    }
  });
  test("허용 목록 밖(인터프리터·경로 실행·환경 변수 접두·알 수 없는 명령)은 숨김", () => {
    for (const command of ["python3 x.py", "bash run.sh", "node a.js", "./build.sh", "/bin/ls", "FOO=1 ls", "curl example.com", "rm file", "make"]) {
      expect(bash(command)).toMatchObject({ rule: null });
    }
  });
  test("샌드박스 밖 실행 요청은 숨김", () => {
    expect(bash("git status", { dangerouslyDisableSandbox: true })).toEqual({ rule: null, why: "unsandboxed" });
  });
  test("파일 도구는 정확한 절대 경로 하나, 보호 대상·흐린 경로는 숨김", () => {
    expect(alwaysRuleFor("Write", { file_path: "/Users/t/data/out.txt" }, where)).toEqual({ rule: "Write(//Users/t/data/out.txt)" });
    expect(alwaysRuleFor("Read", { file_path: "/etc/hosts" }, where)).toEqual({ rule: "Read(//etc/hosts)" });
    for (const file_path of [`${W}/CLAUDE.md`, `${W}/.claude/settings.json`, "/Users/t/b3rys-team-os/agents.json",
      "/Users/t/b3rys-team-os/src/x.ts", "/Users/t/app/.env", "/Users/t/app/.env.local", "rel/path", "/a/../b", "/a/*", "/a/"]) {
      expect(alwaysRuleFor("Edit", { file_path }, where).rule).toBeNull();
    }
  });
  test("웹은 도메인 하나, 그 밖 도구는 숨김", () => {
    expect(alwaysRuleFor("WebFetch", { url: "https://docs.example.com/a?b=1" }, where)).toEqual({ rule: "WebFetch(domain:docs.example.com)" });
    expect(alwaysRuleFor("WebFetch", { url: "file:///etc/passwd" }, where).rule).toBeNull();
    expect(alwaysRuleFor("Task", { prompt: "x" }, where)).toEqual({ rule: null, why: "unsupported_tool" });
  });
  test("만든 규칙은 정책 스키마를 통과한다(저장 가능한 모양)", () => {
    for (const r of [bash("git status"), alwaysRuleFor("Write", { file_path: "/Users/t/data/out.txt" }, where),
      alwaysRuleFor("WebFetch", { url: "https://a.example.com" }, where)]) {
      expect(readPolicy({ runtime: "claude", schema_version: 1, revision: 1, mode: "auto", allow: [r.rule] }, "claude").state).toBe("valid");
    }
  });
});
