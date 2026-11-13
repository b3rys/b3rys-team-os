import { test, expect, describe } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  renderSeededCodexConfig, renderFallbackCodexConfig,
  removeTopLevelKey, removeTable, removeTablesWithPrefix, removeLinesReferencing,
  CODEX_TEAM_DEFAULT, codexSeedModel, hostModelDrift, removeTopLevelStringKey, parsesAsToml,
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
  test("★능력은 물려받는다★ — 플러그인·MCP 정의(모델은 opts.model 이 없을 때만). 없으면 새 팀원이 기존 팀원보다 좁다", () => {
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
    expect(seed(null)).toContain('[projects."/tmp/newbie"]');
    expect(seed(null)).toContain('trust_level = "trusted"');
    expect(seed("   \n ")).toBe(seed(null));
  });

  test("★공백 있는 경로도 안전하다★ — 따옴표 없이 넣으면 TOML 이 깨진다", () => {
    expect(seed(HOST, "/tmp/my workspace")).toContain('[projects."/tmp/my workspace"]');
  });

  // 실제 호스트 설정이 있으면 동일한 불변식을 확인한다. 파일 없는 개발 환경·CI는 이 항목을 건너뛴다.
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

  test("★그 팀원 자신의 폴더는 안 걷는다★ — 호스트가 ~/.codex 면 ~/.codex-agents/<팀원> 은 남아야 한다", () => {
    const src = 'A = "/h/.codex"\nB = "/h/.codex-agents/newbie"\nC = "/h/.codexfoo"\nD = "/h/.codex/sub"\n';
    const out = removeLinesReferencing(src, "/h/.codex");
    expect(out).not.toContain("A =");        // 그 경로 자체
    expect(out).not.toContain("D =");        // 하위 경로
    expect(out).toContain('B = "/h/.codex-agents/newbie"'); // 다른 폴더다
    expect(out).toContain('C = "/h/.codexfoo"');            // 이름만 비슷한 것
  });

  test("★최상위 키 제거는 [profiles.*] 안까지 보지 않는다★ — 지금 계약의 경계를 적어둔다", () => {
    // removeTopLevelKey 는 첫 테이블 헤더 앞만 본다. 프로파일 테이블 안에 정책 키가 있으면 남는다.
    // 지금 호스트 설정에는 그런 프로파일이 없어 무해하지만, 생기면 이 시험이 그 사실을 알려준다.
    const src = 'sandbox_mode = "x"\n\n[profiles.dev]\nsandbox_mode = "y"\n';
    const out = removeTopLevelKey(src, "sandbox_mode");
    expect(out).not.toContain('sandbox_mode = "x"');
    expect(out).toContain('sandbox_mode = "y"'); // 남는다 — 알고 있는 경계다
  });

  test("빈 needle 로는 아무것도 안 지운다 — 실수로 전체가 날아가면 안 된다", () => {
    const src = 'A = 1\nB = 2\n';
    expect(removeLinesReferencing(src, "")).toBe(src);
  });
});

describe("codex config 시드 — 모델은 호스트가 아니라 팀 기본", () => {
  const team = { model: "gpt-6.1-sol", effort: "medium" };
  const OLD_HOST = `model = "gpt-5.6-sol"\nmodel_reasoning_effort = "low"\n\n[mcp_servers.node_repl]\ncommand = "x"\nmodel = "inner-keeps"\n`;

  test("★호스트의 옛 모델·추론값을 물려주지 않는다★ — 맥마다 새 팀원 모델이 달라지던 원인", () => {
    const cfg = renderSeededCodexConfig(OLD_HOST, { workdir: "/tmp/newbie", hostCodexHome: HOST_HOME, model: team });
    expect(cfg).not.toContain('"gpt-5.6-sol"');
    expect(cfg).not.toContain('"low"');
    expect(cfg.split("\n").slice(0, 2)).toEqual(['model = "gpt-6.1-sol"', 'model_reasoning_effort = "medium"']);
    expect(cfg.match(/^model\s*=/gm)?.length).toBe(2); // 최상위 하나 + 테이블 안 하나 — 중복 키 없음
    expect(cfg).toContain('model = "inner-keeps"');    // 테이블 안의 같은 이름은 건드리지 않는다
    expect(cfg).toContain("[mcp_servers.node_repl]");   // 능력 상속은 그대로
  });

  test("호스트 설정이 없어도 팀 기본 모델로 시드한다", () => {
    const cfg = renderSeededCodexConfig(null, { workdir: "/tmp/newbie", hostCodexHome: HOST_HOME, model: team });
    expect(cfg).toContain('model = "gpt-6.1-sol"');
    expect(cfg).toContain('model_reasoning_effort = "medium"');
  });

  test("팀 기본은 gpt-6.1-sol · medium, env 로 설치본마다 덮을 수 있다", () => {
    expect(CODEX_TEAM_DEFAULT).toEqual({ model: "gpt-6.1-sol", effort: "medium" });
    expect(codexSeedModel({})).toEqual(team);
    expect(codexSeedModel({ B3OS_CODEX_DEFAULT_MODEL: " gpt-x ", B3OS_CODEX_DEFAULT_EFFORT: "high" })).toEqual({ model: "gpt-x", effort: "high" });
    expect(codexSeedModel({ B3OS_CODEX_DEFAULT_MODEL: "  " })).toEqual(team);
  });

  test("호스트 값이 팀 기본과 다르면 경고, 같거나 없으면 조용하다", () => {
    expect(hostModelDrift(OLD_HOST, team)).toContain("gpt-5.6-sol · low");
    expect(hostModelDrift('model = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\n', team)).toBeNull();
    expect(hostModelDrift('[t]\nmodel = "old"\n', team)).toBeNull(); // 테이블 안 값은 최상위 모델이 아니다
    expect(hostModelDrift(null, team)).toBeNull();
  });
});

describe("codex config 시드 — 호스트 TOML 표기가 달라도 결과는 읽히는 TOML", () => {
  const team = { model: "gpt-6.1-sol", effort: "medium" };
  const render = (host: string) => renderSeededCodexConfig(host, { workdir: "/tmp/newbie", hostCodexHome: HOST_HOME, model: team });
  const Q = '"""', S = "\'\'\'";
  const hosts: Record<string, string> = {
    "따옴표 키": `"model" = "old"\n'model_reasoning_effort' = "low"\n[mcp_servers.a]\ncommand = "x"\n`,
    "여러 줄 basic + 줄 이음": `model = ${Q}\\\nold${Q}\nmodel_reasoning_effort = "low"\n[mcp_servers.a]\ncommand = "x"\n`,
    "여러 줄 literal": `model = ${S}\nold\n${S}\n[mcp_servers.a]\ncommand = "x"\n`,
    "한 줄 여러 줄표기": `model = ${Q}old${Q}\n[mcp_servers.a]\ncommand = "x"\n`,
    "주석 붙은 값": `model = "old" # 9월\n[mcp_servers.a]\ncommand = "x"\n`,
  };
  for (const [name, host] of Object.entries(hosts)) {
    test(`${name}: 호스트는 읽히고, 결과도 읽히며 모델은 팀 기본`, () => {
      expect(parsesAsToml(host)).toBe(true);
      const cfg = render(host);
      const parsed = Bun.TOML.parse(cfg) as Record<string, unknown>;
      expect(parsed.model).toBe("gpt-6.1-sol");
      expect(parsed.model_reasoning_effort).toBe("medium");
      expect((parsed.mcp_servers as Record<string, unknown>).a).toBeDefined(); // 능력 상속은 유지
    });
  }

  test("못 본 표기로 결과가 깨지면 빈 설정 + 팀 모델로 시드한다(깨진 config 는 재시드도 안 되므로)", () => {
    const cfg = render('model = """\nold\n# 닫는 따옴표가 없다\n'); // 호스트 자체가 깨진 경우
    const parsed = Bun.TOML.parse(cfg) as Record<string, unknown>;
    expect(parsed.model).toBe("gpt-6.1-sol");
  });

  test("removeTopLevelStringKey 는 테이블 안의 같은 이름을 건드리지 않는다", () => {
    expect(removeTopLevelStringKey('model = "a"\n[t]\nmodel = "b"\n', "model")).toBe('[t]\nmodel = "b"\n');
  });
});
