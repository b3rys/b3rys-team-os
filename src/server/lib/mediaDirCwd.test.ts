// WorkingDirectory 없는 launchd 프로세스의 cwd는 /일 수 있다. 그 상태에서도 읽기전용 루트 대신 올바른 미디어 경로를 쓰는지 검사한다.
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
