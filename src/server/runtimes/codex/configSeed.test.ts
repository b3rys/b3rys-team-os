import { test, expect, describe } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  renderSeededCodexConfig, renderFallbackCodexConfig,
  removeTopLevelKey, removeTable, removeTablesWithPrefix, removeLinesReferencing,
} from "./configSeed";

const HOST_HOME = "/Users/host/.codex";
const HOST = `model = "gpt-5.5"
sandbox_mode = "workspace-write"
approval_policy = "untrusted"

[tui.model_availability_nux]
seen = true

[plugins."gmail@openai-curated"]
enabled = true

[mcp_servers.node_repl]
command = "/Applications/Codex.app/Contents/Resources/cua_node/bin/node_repl"

[mcp_servers.node_repl.env]
NODE_REPL_TRUSTED_CODE_PATHS = "/Users/host/.codex"
CODEX_HOME = "/Users/host/.codex"
BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"

[sandbox_workspace_write]
network_access = false
writable_roots = ["/Users/host/somewhere"]

[projects."/Users/host"]
trust_level = "trusted"

[projects."/Users/host/Development/bill"]
trust_level = "trusted"
`;

const seed = (host: string | null = HOST, workdir = "/tmp/newbie") =>
  renderSeededCodexConfig(host, { workdir, hostCodexHome: HOST_HOME });

describe("codex config 시드 — 능력은 상속, 정책·신뢰·정체성은 제외", () => {
  test("★능력은 물려받는다★ — 플러그인·MCP 정의·모델. 없으면 새 팀원이 기존 팀원보다 좁다", () => {
    const cfg = seed();
    expect(cfg).toContain('[plugins."gmail@openai-curated"]');
    expect(cfg).toContain("[mcp_servers.node_repl]");
    expect(cfg).toContain('model = "gpt-5.5"');
    expect(cfg).toContain("BROWSER_USE_AVAILABLE_BACKENDS"); // 능력 쪽 env 는 남는다
  });

  test("★① 정책은 걷어낸다★ — 실행 모드는 프로토콜 한 곳에서만 정해진다", () => {
    const cfg = seed();
    expect(cfg).not.toContain("sandbox_mode");
    expect(cfg).not.toContain("approval_policy");
    expect(cfg).not.toContain("[sandbox_workspace_write]");
    expect(cfg).not.toContain('writable_roots = ["/Users/host/somewhere"]');
  });

  test("★② 신뢰는 물려주지 않는다 — 그 팀원 작업 폴더 하나만★ (trust 는 능력이 아니라 권한)", () => {
    const cfg = seed();
    const projects = cfg.split("\n").filter((l) => l.trim().startsWith("[projects."));
    expect(projects).toEqual(['[projects."/tmp/newbie"]']); // 호스트 것 0개, 내 것 1개
    expect(cfg).not.toContain("/Users/host/Development/bill"); // 다른 팀원 폴더를 신뢰하지 않는다
    expect(cfg).toContain('trust_level = "trusted"');
  });

  test("★③ 정체성은 새지 않는다★ — 호스트 CODEX_HOME 을 가리키는 줄은 값 기준으로 전부 걷는다", () => {
    const cfg = seed();
    expect(cfg).not.toContain("CODEX_HOME");
    expect(cfg).not.toContain("NODE_REPL_TRUSTED_CODE_PATHS"); // 이름이 달라도 값이 호스트면 걷는다
    expect(cfg).not.toContain(HOST_HOME);
  });

  test("★대조군 — 호스트 설정이 없으면 빈 설정으로 뜬다★ (상속할 것이 없어도 팀원은 떠야 한다)", () => {
    expect(seed(null)).toBe(renderFallbackCodexConfig());
    expect(seed("   \n ")).toBe(renderFallbackCodexConfig());
  });

  test("★공백 있는 경로도 안전하다★ — 따옴표 없이 넣으면 TOML 이 깨진다", () => {
    expect(seed(HOST, "/tmp/my workspace")).toContain('[projects."/tmp/my workspace"]');
  });

  // ★합성 입력만으로는 오늘 같은 것이 안 보인다★ — 실제 호스트 설정으로 한 번 돌린다.
  //   이 기계에 파일이 없으면(다른 개발자·CI) 조용히 건너뛴다. 있으면 불변식을 잰다.
  test("실제 호스트 설정을 입력으로 — 정책·신뢰·정체성이 하나도 새지 않는다", () => {
    const hostPath = join(homedir(), ".codex", "config.toml");
    if (!existsSync(hostPath)) return; // 환경에 없으면 이 시험은 할 말이 없다
    const real = readFileSync(hostPath, "utf-8");
    const cfg = renderSeededCodexConfig(real, {
      workdir: "/tmp/newbie",
      hostCodexHome: join(homedir(), ".codex"),
    });
    const projects = cfg.split("\n").filter((l) => l.trim().startsWith("[projects."));
    expect(projects).toEqual(['[projects."/tmp/newbie"]']);
    expect(cfg).not.toContain("CODEX_HOME");
    expect(cfg).not.toContain(join(homedir(), ".codex"));
    expect(cfg).not.toContain("sandbox_mode");
    expect(cfg).not.toContain("approval_policy");
    expect(cfg).not.toContain("[sandbox_workspace_write]");
  });
});

describe("TOML 편집 도우미", () => {
  test("최상위 키만 지운다 — 테이블 안의 같은 이름은 남긴다", () => {
    const out = removeTopLevelKey('a = 1\n\n[t]\na = 2\n', "a");
    expect(out).not.toContain("a = 1");
    expect(out).toContain("[t]\na = 2");
  });

  test("★테이블은 다음 헤더 직전까지만 지운다★ — 더 지우면 뒤 설정이 사라진다", () => {
    const out = removeTable('[s]\nk = 1\nj = 2\n\n[other]\nk = 3\n', "s");
    expect(out).not.toContain("k = 1");
    expect(out).toContain("[other]\nk = 3");
  });

  test("★접두사 테이블은 전부, 그러나 그것만 지운다★", () => {
    const src = '[projects."/a"]\nt = 1\n\n[projects."/b"]\nt = 2\n\n[plugins."x"]\ne = true\n';
    const out = removeTablesWithPrefix(src, "projects.");
    expect(out).not.toContain("[projects.");
    expect(out).toContain('[plugins."x"]');
    expect(out).toContain("e = true");
  });

  test("★값 기준으로 지운다★ — 키 이름이 달라도 값이 그 경로면 걷는다. 남의 값은 안 건드린다", () => {
    const src = 'A = "/h/.codex"\nB = "/other"\n\n[t]\nC = "/h/.codex/x"\n';
    const out = removeLinesReferencing(src, "/h/.codex");
    expect(out).not.toContain("A =");
    expect(out).not.toContain("C =");
    expect(out).toContain('B = "/other"');
  });

  test("빈 needle 로는 아무것도 안 지운다 — 실수로 전체가 날아가면 안 된다", () => {
    const src = 'A = 1\nB = 2\n';
    expect(removeLinesReferencing(src, "")).toBe(src);
  });
});
