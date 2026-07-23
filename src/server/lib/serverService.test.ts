import { describe, test, expect, afterEach } from "bun:test";
import { serverServiceLabel, serverServicePaths, renderServerPlist, isSupportedPlatform } from "./serverService";
import { REPO_ROOT } from "./personaTemplates";

const savedPrefix = process.env.TEAMOS_LAUNCHD_PREFIX;
const savedUser = process.env.USER;

afterEach(() => {
  if (savedPrefix === undefined) delete process.env.TEAMOS_LAUNCHD_PREFIX;
  else process.env.TEAMOS_LAUNCHD_PREFIX = savedPrefix;
  if (savedUser === undefined) delete process.env.USER;
  else process.env.USER = savedUser;
});

describe("serverServiceLabel — generic prefix (조직/사용자 하드코딩 금지)", () => {
  test("기본은 com.$USER.team-collab", () => {
    delete process.env.TEAMOS_LAUNCHD_PREFIX;
    process.env.USER = "alice";
    expect(serverServiceLabel()).toBe("com.alice.team-collab");
  });

  test("TEAMOS_LAUNCHD_PREFIX override 를 우선한다", () => {
    process.env.TEAMOS_LAUNCHD_PREFIX = "com.example";
    expect(serverServiceLabel()).toBe("com.example.team-collab");
  });

  test("멤버 봇 라벨과 같은 prefix 규칙을 쓴다(비대칭 제거)", () => {
    delete process.env.TEAMOS_LAUNCHD_PREFIX;
    process.env.USER = "bob";
    // 멤버: com.bob.claude-telegram-<id> / 서버: com.bob.team-collab
    expect(serverServiceLabel().startsWith("com.bob.")).toBe(true);
  });

  test("특정 사용자(you)나 조직명이 라벨에 하드코딩돼 있지 않다", () => {
    process.env.TEAMOS_LAUNCHD_PREFIX = "com.example";
    const label = serverServiceLabel();
    expect(label).not.toContain("you");
    expect(label).not.toContain("b3rys");
  });
});

describe("serverServicePaths", () => {
  test("plist 는 ~/Library/LaunchAgents/<label>.plist", () => {
    process.env.TEAMOS_LAUNCHD_PREFIX = "com.example";
    const p = serverServicePaths();
    expect(p.plist).toBe(`${process.env.HOME}/Library/LaunchAgents/com.example.team-collab.plist`);
  });
});

describe("renderServerPlist", () => {
  test("bun 경로를 하드코딩하지 않고 현재 실행 중인 bun(process.execPath)을 쓴다", () => {
    const xml = renderServerPlist();
    expect(xml).toContain(process.execPath);
  });

  test("클론 위치(REPO_ROOT) 기준으로 엔트리·작업디렉토리를 잡는다", () => {
    const xml = renderServerPlist();
    expect(xml).toContain(`${REPO_ROOT}/src/server/index.ts`);
    expect(xml).toContain(`<key>WorkingDirectory</key><string>${REPO_ROOT}</string>`);
  });

  test("서버는 워커를 물고 있는 상시 프로세스 → RunAtLoad + KeepAlive", () => {
    const xml = renderServerPlist();
    expect(xml).toContain("<key>RunAtLoad</key><true/>");
    expect(xml).toContain("<key>KeepAlive</key><true/>");
  });

  // ★회귀 가드: 설정값을 plist 에 구우면 사용자의 .env 를 덮어쓰고 값이 고정된다(.env 를 고쳐도 반영 안 됨).
  //   설정 원천은 .env(WorkingDirectory 에서 bun 이 자동 로드) — plist 는 설정을 갖지 않는다.
  test("설정값(포트/바인드/베이스패스)을 plist 에 굽지 않는다 — .env 가 원천", () => {
    const xml = renderServerPlist();
    expect(xml).not.toContain("<key>TEAM_HTTP_PORT</key>");
    expect(xml).not.toContain("<key>TEAM_BIND</key>");
    expect(xml).not.toContain("<key>BASE_PATH</key>");
  });

  // launchd 최소 환경에는 USER 가 없을 수 있다 → prefix 가 com.local 로 떨어져 멤버 라벨과 어긋난다.
  test("설치 시점 prefix 를 박아 launchd 에서 USER 가 없어도 멤버 라벨이 어긋나지 않는다", () => {
    process.env.TEAMOS_LAUNCHD_PREFIX = "com.example";
    const xml = renderServerPlist();
    expect(xml).toContain("<key>TEAMOS_LAUNCHD_PREFIX</key><string>com.example</string>");
  });

  test("유효한 plist XML 형식", () => {
    const xml = renderServerPlist();
    expect(xml.startsWith('<?xml version="1.0"')).toBe(true);
    expect(xml).toContain("<plist version=\"1.0\">");
    expect(xml.trimEnd().endsWith("</plist>")).toBe(true);
  });
});

describe("플랫폼 가드 (Windows 미지원)", () => {
  test("isSupportedPlatform 은 darwin 에서만 true", () => {
    expect(isSupportedPlatform()).toBe(process.platform === "darwin");
  });
});
