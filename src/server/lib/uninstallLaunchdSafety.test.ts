/**
 * uninstall.sh — LaunchAgent 정지 안전성 (행위 테스트)
 *
 * ★왜 정적 검사가 아니라 실행 테스트인가★
 *   이 결함은 "코드에 무엇이 쓰여 있나" 가 아니라 "실제로 무엇을 호출하나" 의 문제다.
 *   launchd 라벨은 gui/$UID 사용자 전역 네임스페이스라 HOME 격리가 닿지 않는다. 그래서
 *   HOME 을 임시 디렉터리로 바꾼 테스트에서도 ★같은 라벨의 라이브 서비스가 그대로 bootout★ 됐다.
 *   실측(수정 전): 격리 fixture 로 uninstall 을 돌리자 com.<USER>.team-collab 과
 *   com.<USER>.team-os-boot 가 bootout 됐다 = 라이브 b3os 정지.
 *
 * 실제 launchctl 은 부르지 않는다 — PATH 앞에 shim 을 놓고 호출만 기록한다.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";


const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const UNINSTALL = join(REPO_ROOT, "uninstall.sh");
const PREFIX = `com.${process.env.USER || "local"}`;

type Fixture = { home: string; calls: string; repo: string };

/** 격리 fixture 를 만든다. plists=true 면 "이 설치본이 만든" plist 를 실제로 놓는다. */
function makeFixture(opts: { profile: string; plists: boolean }): Fixture {
  const work = mkdtempSync(join(tmpdir(), "uninstall-launchd-"));
  const home = join(work, "home");
  const shims = join(work, "shims");
  const repo = join(work, "repo");
  const calls = join(work, "calls.log");
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(shims, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(calls, "");

  // shim: 호출 기록만. print 에 성공을 돌려줘 "서비스가 살아있는" 상황을 재현한다
  //       (그래야 가드가 없을 때 bootout 까지 진행되어 위험이 드러난다).
  writeFileSync(join(shims, "launchctl"), `#!/usr/bin/env bash\necho "launchctl $*" >> "${calls}"\nexit 0\n`);
  writeFileSync(join(shims, "tmux"), `#!/usr/bin/env bash\necho "tmux $*" >> "${calls}"\nexit 1\n`);
  chmodSync(join(shims, "launchctl"), 0o755);
  chmodSync(join(shims, "tmux"), 0o755);

  copyFileSync(UNINSTALL, join(repo, "uninstall.sh"));
  writeFileSync(
    join(repo, "agents.json"),
    JSON.stringify([{ id: "guardtest", runtime: "hermes_agent", hermes_profile: opts.profile }]),
  );

  if (opts.plists) {
    // ★plist 경로는 uninstall.sh 의 SELF 와 정확히 같은 방식으로 구해야 한다★
    //   SELF = "$(cd "$(dirname "$0")" && pwd)". macOS 는 /var → /private/var 심링크가 있어
    //   node 의 realpathSync 와 bash 의 cd+pwd 가 다른 문자열을 낼 수 있고, 그러면
    //   plist_is_self 가 영원히 불일치해 테스트가 거짓 FAIL 을 낸다. 그래서 bash 에게 직접 묻는다.
    const repoReal = new TextDecoder()
      .decode(Bun.spawnSync(["bash", "-c", `cd "${repo}" && pwd`]).stdout)
      .trim();
    const agents = join(home, "Library", "LaunchAgents");
    for (const label of [`${PREFIX}.team-collab`, `${PREFIX}.team-os-boot`]) {
      writeFileSync(
        join(agents, `${label}.plist`),
        `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>WorkingDirectory</key><string>${repoReal}</string>\n</dict></plist>\n`,
      );
    }
    // hermes 게이트웨이 plist 는 레포 경로를 안 담는다 — 이 HOME 에 존재하는지로만 판별한다.
    writeFileSync(
      join(agents, `ai.hermes.gateway-${opts.profile}.plist`),
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>Label</key><string>ai.hermes.gateway-${opts.profile}</string>\n</dict></plist>\n`,
    );
    mkdirSync(join(home, ".hermes", "profiles", opts.profile), { recursive: true });
  }
  return { home, calls, repo };
}

function runUninstall(f: Fixture): string {
  const shims = join(f.repo, "..", "shims");
  Bun.spawnSync(["bash", join(f.repo, "uninstall.sh"), "--yes", "--keep-data"], {
    env: { ...process.env, HOME: f.home, PATH: `${shims}:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  return readFileSync(f.calls, "utf-8");
}

const bootouts = (log: string) =>
  log.split("\n").filter((l) => l.startsWith("launchctl bootout")).map((l) => l.replace(/^.*\//, ""));

describe("uninstall.sh — 다른 설치본의 LaunchAgent 를 내리지 않는다", () => {
  test("★plist 가 이 HOME 에 없으면 bootout 을 한 건도 하지 않는다★ (격리 테스트가 라이브를 죽이던 결함)", () => {
    // 라이브와 겹치는 프로필명을 일부러 쓴다 — 최악 시나리오.
    const f = makeFixture({ profile: "ames", plists: false });
    const stopped = bootouts(runUninstall(f));
    expect(stopped).toEqual([]);
  });

  test("plist 가 없으면 서버·부팅 LaunchAgent 도 건드리지 않는다", () => {
    const f = makeFixture({ profile: "none-such", plists: false });
    const log = runUninstall(f);
    expect(log).not.toContain(`bootout gui/`);
    expect(log).not.toContain(`${PREFIX}.team-collab`.concat(" ")); // bootout 인자로 등장하지 않음
  });

  test("★정당한 uninstall 은 그대로 동작한다★ (가드가 과잉이 아님을 증명)", () => {
    const profile = "mytestprofile";
    const f = makeFixture({ profile, plists: true });
    const stopped = bootouts(runUninstall(f));
    expect(stopped).toContain(`${PREFIX}.team-collab`);
    expect(stopped).toContain(`${PREFIX}.team-os-boot`);
    expect(stopped).toContain(`ai.hermes.gateway-${profile}`);
    // plist 도 실제로 삭제된다
    const agents = join(f.home, "Library", "LaunchAgents");
    expect(existsSync(join(agents, `${PREFIX}.team-collab.plist`))).toBe(false);
    expect(existsSync(join(agents, `ai.hermes.gateway-${profile}.plist`))).toBe(false);
  });
});

describe("uninstall.sh — 정지 분기가 '내 것임이 증명될 때만' 기준을 쓴다", () => {
  const SRC = readFileSync(UNINSTALL, "utf-8");

  test("서버·부팅·멤버 정지 분기가 managed_by_this_install 을 쓴다", () => {
    // owned_by_other_install 은 안내 문구 판별용으로만 남는다.
    const stopBranches = SRC.split("\n").filter((l) => l.includes("managed_by_this_install"));
    expect(stopBranches.length).toBeGreaterThanOrEqual(5); // 정의 1 + 호출 4곳 이상
  });

  test("plist 가 없을 때 '내 것' 으로 간주하지 않는다", () => {
    const fn = SRC.match(/managed_by_this_install\(\)\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).toContain('[ -f "$plist" ] || return 1');
  });
});
