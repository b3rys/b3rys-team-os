// codex 런처(M4) 순수 렌더러 테스트 — fs/launchctl 부작용 없음. 보안핀: 토큰이 plist/wrapper 평문에 안 들어감.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { codexBridgeLaunchdLabel, codexBridgePaths, renderLaunchWrapper, renderBridgePlist, ensureCodexHome, renderMinimalCodexConfig, persistOwnerChatIdIfEmpty } from "./launcher";

describe("persistOwnerChatIdIfEmpty — 자동저장(자연 도출값 persist, 사용자 입력 보호)", () => {
  test("기존 owner_chat_id 는 절대 덮지 않는다(사용자 입력 우선)", () => {
    const db = new Database(":memory:");
    db.query("CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)").run();
    db.query("INSERT INTO setting (key, value) VALUES ('owner_chat_id', '99999')").run();
    expect(persistOwnerChatIdIfEmpty(db)).toBe("99999");
    expect((db.query("SELECT value FROM setting WHERE key='owner_chat_id'").get() as { value: string }).value).toBe("99999");
    db.close();
  });

  test("setting 테이블 없어도 던지지 않고 null(best-effort)", () => {
    const db = new Database(":memory:");
    expect(persistOwnerChatIdIfEmpty(db)).toBeNull();
    db.close();
  });
});

describe("codex launcher (M4) — 순수 렌더러", () => {
  test("라벨 = prefix.codex-bridge-<id>", () => {
    expect(codexBridgeLaunchdLabel("cody")).toMatch(/\.codex-bridge-cody$/);
  });

  test("paths: plist/wrapper/token/workdir/log 구성", () => {
    const p = codexBridgePaths("cody");
    expect(p.plist).toMatch(/LaunchAgents\/.*codex-bridge-cody\.plist$/);
    expect(p.wrapper).toMatch(/codex-bridge\/cody-launch\.sh$/);
    expect(p.tokenFile).toMatch(/var\/secrets\/cody\.bot-token$/);
    expect(p.workdir).toMatch(/\/cody$/);
  });

  test("plist: Label + wrapper 참조 + KeepAlive, 토큰 없음", () => {
    const p = codexBridgePaths("cody");
    const xml = renderBridgePlist(p);
    expect(xml).toContain(p.label);
    expect(xml).toContain(p.wrapper);
    expect(xml).toContain("KeepAlive");
    expect(xml).not.toContain("bot-token\n"); // 토큰값 자체는 plist에 없음(wrapper가 파일서 읽음)
    expect(xml).not.toMatch(/[0-9]{8,}:[A-Za-z0-9_-]{30,}/); // 텔레그램 토큰 형식 없음
  });

  test("wrapper: 토큰 파일→env(평문 노출 없음) + bridge.ts exec", () => {
    const p = codexBridgePaths("cody");
    const sh = renderLaunchWrapper(p);
    expect(sh).toContain(`TOKEN_FILE="${p.tokenFile}"`); // 토큰 경로
    expect(sh).toContain(`export CODEX_BOT_TOKEN="$(cat "$TOKEN_FILE")"`); // 파일서 env로(변수 경유)
    expect(sh).toContain(`export CODEX_WORKDIR="${p.workdir}"`);
    expect(sh).toContain(`export CODEX_ALLOW_FROM="${p.allowFrom}"`); // ★발신자 게이트 시드 배선(P0) — 이게 있어야 게이트가 라이브에서 켜짐
    expect(sh).toContain("export B3OS_REPO_ROOT=");
    expect(sh).toContain("export TEAM_BASE_URL=");
    expect(sh).toContain("export CODEX_SCHEDULE_TOOL_ENABLED=");
    expect(sh).toContain("bridge.ts");
    expect(sh).not.toMatch(/[0-9]{8,}:[A-Za-z0-9_-]{30,}/); // 평문 토큰 없음
    // PATH 에 bun 설치경로가 있어야 launchd 최소 PATH 에서도 exec bun 이 해석됨(없으면 respawn-loop). claude launcher 와 동일 세트.
    expect(sh).toContain(`export PATH="${process.env.HOME ?? ""}/.bun/bin:`); // ~/.bun/bin 선두(공식 인스톨러 경로)
    expect(sh).toContain("/usr/local/bin"); // Intel homebrew
  });

  test("ensureCodexHome: CODEX_HOME 디렉토리 보장(없으면 codex exec 즉사→Codi 인시던트 재발)", () => {
    const tmp = join(tmpdir(), `codex-home-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const p = { ...codexBridgePaths("cody"), codexHome: tmp };
    expect(existsSync(tmp)).toBe(false);
    ensureCodexHome(p); // 디렉토리 생성 + (호스트 ~/.codex 있으면) auth seed
    expect(existsSync(tmp)).toBe(true);
    rmSync(tmp, { recursive: true, force: true });
  });

  // ★계약이 바뀌었다(2026-08-18 제품 결정) — 호스트 설정을 ★상속한다★.★
  //   예전 계약: 호스트의 trust/MCP/plugins 를 절대 물려주지 않는다.
  //   왜 바꿨나: 새로 영입한 팀원이 이미 있던 팀원보다 기능이 좁아 같은 과제를 맡길 수 없었다.
  //   상속 결과는 호스트 파일 유무에 따라 갈리므로 configSeed.test.ts 에서 고정 입력으로 잰다.
  //   여기서는 ★호스트가 있든 없든 항상 성립해야 하는 것★ 만 잰다.

  test("★우리 실행 정책을 config 에 쓰지 않는다★ — dex 만 잠겨 있던 원인(2026-08-14)", () => {
    const cfg = renderMinimalCodexConfig({ workdir: "/tmp/cody workspace" });
    // 실측: 12명 중 dex 만 타 프로젝트·홈 쓰기가 거절됐다. openclaw 의 codex-home 에는
    // 아래 네 항목이 0건인데 dex 것에만 4건 있었다 — codex 한계가 아니라 이 함수가 만든 차이였다.
    // ★상속으로 바뀐 뒤에도 이 계약은 그대로다★ — 호스트에 정책이 있어도 걷어내고 물려준다.
    expect(cfg).not.toContain("sandbox_mode");
    expect(cfg).not.toContain("approval_policy");
    expect(cfg).not.toContain("[sandbox_workspace_write]");
    expect(cfg).not.toContain("[permissions."); // 프로파일을 다시 넣으면 승인이 죽는다(2026-08-12 실측)
  });

  test("ensureCodexHome: 파일이 없으면 시드한다(내용은 호스트 상속 − 정책)", () => {
    const tmp = join(tmpdir(), `codex-home-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const p = { ...codexBridgePaths("cody"), codexHome: tmp, workdir: "/tmp/cody" };
    ensureCodexHome(p);
    const cfgPath = join(tmp, "config.toml");
    expect(existsSync(cfgPath)).toBe(true);
    const cfg = readFileSync(cfgPath, "utf-8");
    // ★정책은 어느 경우에도 안 들어간다★ — 호스트에 있어도 걷어낸다.
    expect(cfg).not.toContain("sandbox_mode");
    expect(cfg).not.toContain("approval_policy");
    // 능력(플러그인·MCP)은 호스트에 있으면 물려받는다 — 그 판정은 configSeed.test.ts 에서
    // 고정 입력으로 잰다. 여기서는 이 기계의 호스트 파일 유무에 결과가 갈리므로 재지 않는다.
    rmSync(tmp, { recursive: true, force: true });
  });

  test("ensureCodexHome: 기존 per-agent config는 덮어쓰지 않음", () => {
    const tmp = join(tmpdir(), `codex-home-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const p = { ...codexBridgePaths("cody"), codexHome: tmp, workdir: "/tmp/cody" };
    ensureCodexHome(p);
    const cfgPath = join(tmp, "config.toml");
    writeFileSync(cfgPath, "# custom per-agent config\n", "utf-8");
    ensureCodexHome(p);
    expect(readFileSync(cfgPath, "utf-8")).toBe("# custom per-agent config\n");
    rmSync(tmp, { recursive: true, force: true });
  });
});
