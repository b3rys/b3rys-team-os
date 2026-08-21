/**
 * ★미디어 폴더는 실행 위치(cwd)에 기대면 안 된다.★
 *
 * 라이브에서 난 일: dex 브리지는 launchd 가 ★작업 디렉토리 없이★ 띄운다 → `process.cwd()` 가 `/` 다.
 * 옛 기본값 `join(process.cwd(), "..", "team-media")` 는 그때 ★`/team-media`★ 로 풀렸고,
 * 루트는 읽기전용이라 팀장님이 보낸 사진이 전부 `EROFS: mkdir /team-media` 로 실패했다.
 * ★서버는 plist 에 WorkingDirectory 가 있어 멀쩡했다★ — 그래서 시험도 라이브 그룹 경로도 이 결함을 못 봤다.
 *
 * ★이 시험은 cwd 를 실제로 `/` 로 바꿔놓고 잰다★ — 그게 이 결함이 사는 유일한 조건이다.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, "mediaStore.ts");
const ORIG_CWD = process.cwd();
afterEach(() => process.chdir(ORIG_CWD));

/** 옛 구현 그대로 — 이 시험이 무엇을 막는지 보여주는 대조군. */
const legacyResolve = (): string => join(process.cwd(), "..", "team-media");

describe("미디어 폴더는 cwd 와 무관해야 한다", () => {
  test("★cwd 가 / 여도 같은 폴더를 가리킨다★ (브리지가 그 상태로 뜬다)", async () => {
    delete process.env.TEAM_MEDIA_DIR;
    const fromRepo = (await import(`${MODULE}?a=${Date.now()}`)).DEFAULT_MEDIA_DIR as string;

    process.chdir("/");
    const fromRoot = (await import(`${MODULE}?b=${Date.now()}`)).DEFAULT_MEDIA_DIR as string;

    expect(fromRoot, "★실행 위치가 바뀌면 저장 폴더가 바뀐다 = 라이브에서 사진이 죽는다★").toBe(fromRepo);
    expect(fromRoot.startsWith("/team-media"), "★루트로 풀리면 EROFS 다★").toBe(false);
  });

  test("★대조군 — 옛 방식은 cwd 를 따라 움직인다★ (이 시험이 실제로 무언가를 재고 있다는 증거)", () => {
    process.chdir("/");
    expect(legacyResolve(), "옛 식은 cwd=/ 에서 루트로 간다").toBe("/team-media");
  });

  test("TEAM_MEDIA_DIR 을 주면 그것을 쓴다 (기존 계약 유지)", async () => {
    process.env.TEAM_MEDIA_DIR = "/tmp/some-media";
    const v = (await import(`${MODULE}?c=${Date.now()}`)).DEFAULT_MEDIA_DIR as string;
    delete process.env.TEAM_MEDIA_DIR;
    expect(v).toBe("/tmp/some-media");
  });
});
