// 라이브 신원 읽기 — ★모르면 null 이어야 한다★ · ★화면 표식은 재시작 없이 바뀌어야 한다★
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHeadCommit, readWebBuild, resetWebBuildCache, captureServerIdentity, BUILD_MANIFEST } from "./deployIdentity";

describe("배포 신원 — 누가 배포했는지 남는다", () => {

const SHA = "0123456789abcdef0123456789abcdef01234567";
const fresh = () => mkdtempSync(join(tmpdir(), "deployid-"));

test("★느슨한 ref★ 를 따라가 커밋을 읽는다", () => {
  const root = fresh();
  mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, ".git", "refs", "heads", "main"), SHA + "\n");
  expect(readHeadCommit(root)).toBe(SHA);
  rmSync(root, { recursive: true, force: true });
});

test("★packed-refs★ 만 있어도 읽는다 (gc 후 흔한 상태)", () => {
  const root = fresh();
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, ".git", "packed-refs"), `# pack-refs with: peeled\n${SHA} refs/heads/main\n`);
  expect(readHeadCommit(root)).toBe(SHA);
  rmSync(root, { recursive: true, force: true });
});

test("detached HEAD 도 읽는다", () => {
  const root = fresh();
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), SHA + "\n");
  expect(readHeadCommit(root)).toBe(SHA);
  rmSync(root, { recursive: true, force: true });
});

test("★워크트리(.git 이 파일)에서도 읽는다★ — HEAD 는 gitdir, refs 는 공용 디렉토리", () => {
  const root = fresh();       // 워크트리
  const common = fresh();     // 본체 .git
  const wtGit = join(common, "worktrees", "wt");
  mkdirSync(join(common, "refs", "heads"), { recursive: true });
  mkdirSync(wtGit, { recursive: true });
  // 본체에만 ref 실체가 있다 — 워크트리 gitdir 에는 없다(진짜 git 배치가 이렇다)
  writeFileSync(join(common, "refs", "heads", "feat"), SHA + "\n");
  writeFileSync(join(wtGit, "HEAD"), "ref: refs/heads/feat\n");
  writeFileSync(join(wtGit, "commondir"), "../..\n");
  writeFileSync(join(root, ".git"), `gitdir: ${wtGit}\n`);
  expect(readHeadCommit(root)).toBe(SHA); // ★공용 디렉토리까지 따라가지 않으면 null 이 나온다★
  rmSync(root, { recursive: true, force: true });
  rmSync(common, { recursive: true, force: true });
});

test("★gitdir 이 상대경로여도 repoRoot 기준으로 푼다★ — 프로세스 cwd 에 맡기지 않는다", () => {
  // worktree 는 절대경로를 쓰지만 서브모듈 등은 상대경로를 쓴다.
  // cwd 기준으로 풀면 ★멀쩡한 배치를 cwd 가 다르다는 이유로 null 로 오판한다.★
  const root = fresh();
  mkdirSync(join(root, "nested", ".gitstore"), { recursive: true });
  writeFileSync(join(root, "nested", ".gitstore", "HEAD"), SHA + "\n");
  mkdirSync(join(root, "nested", "wt"), { recursive: true });
  writeFileSync(join(root, "nested", "wt", ".git"), "gitdir: ../.gitstore\n");
  const prevCwd = process.cwd();
  process.chdir("/"); // ★cwd 를 일부러 엉뚱한 데로★ — 여기 기준으로 풀면 못 찾는다
  try {
    expect(readHeadCommit(join(root, "nested", "wt"))).toBe(SHA);
  } finally {
    process.chdir(prevCwd);
  }
  rmSync(root, { recursive: true, force: true });
});

test("★gitdir 이 가리키는 곳이 없으면 null★ — 끊긴 포인터를 따라가지 않는다", () => {
  const root = fresh();
  writeFileSync(join(root, ".git"), "gitdir: /nonexistent/path/xyz\n");
  expect(readHeadCommit(root)).toBeNull();
  rmSync(root, { recursive: true, force: true });
});

test("★git 이 없으면 null★ — 추측한 값을 내지 않는다", () => {
  const root = fresh();
  expect(readHeadCommit(root)).toBeNull();
  rmSync(root, { recursive: true, force: true });
});

test("★ref 가 어디에도 없으면 null★ (참조는 있는데 대상이 없는 상태)", () => {
  const root = fresh();
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/gone\n");
  expect(readHeadCommit(root)).toBeNull();
  rmSync(root, { recursive: true, force: true });
});

test("★sha 모양이 아니면 null★ — 쓰레기를 커밋이라고 말하지 않는다", () => {
  const root = fresh();
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "not-a-sha\n");
  expect(readHeadCommit(root)).toBeNull();
  rmSync(root, { recursive: true, force: true });
});

test("빌드 표식을 읽는다", () => {
  resetWebBuildCache();
  const dist = fresh();
  writeFileSync(join(dist, BUILD_MANIFEST), JSON.stringify({ commit: SHA, built_at: "2026-08-07T00:00:00Z" }));
  expect(readWebBuild(dist)).toEqual({ commit: SHA, at: "2026-08-07T00:00:00Z" });
  rmSync(dist, { recursive: true, force: true });
});

// ★이 시험의 이름을 한 번 고쳤다★ — 처음엔 "그리고 캐시하지 않는다" 라고 적었는데,
//   ★그 주장을 깨는 뮤턴트를 못 만들었다★: 없음을 캐시해도 캐시 키가 mtime 이라 다음 호출에서
//   어차피 다시 읽힌다. ★검사하지 않는 것을 이름이 주장하고 있었다.★ 실제로 검사하는 것만 남긴다.
test("★표식이 없다가 나중에 생기면 보인다★ (빌드 전 → 빌드 후)", () => {
  resetWebBuildCache();
  const dist = fresh();
  expect(readWebBuild(dist)).toEqual({ commit: null, at: null });
  // 이제 빌드가 표식을 남긴다 — ★재시작 없이★ 새 값이 보여야 한다
  writeFileSync(join(dist, BUILD_MANIFEST), JSON.stringify({ commit: SHA, built_at: "2026-08-07T01:00:00Z" }));
  expect(readWebBuild(dist).commit).toBe(SHA);
  rmSync(dist, { recursive: true, force: true });
});

test("★깨진 표식은 null★ — 반쯤 쓰인 JSON 을 커밋이라고 말하지 않는다", () => {
  resetWebBuildCache();
  const dist = fresh();
  writeFileSync(join(dist, BUILD_MANIFEST), '{"commit": "abc');
  expect(readWebBuild(dist)).toEqual({ commit: null, at: null });
  rmSync(dist, { recursive: true, force: true });
});

test("★빌드가 새 값을 쓰면 재시작 없이 반영된다★ — 화면 층의 존재 이유다", () => {
  resetWebBuildCache();
  const dist = fresh();
  const file = join(dist, BUILD_MANIFEST);
  const older = "1".repeat(40);
  writeFileSync(file, JSON.stringify({ commit: older, built_at: "2026-08-07T00:00:00Z" }));
  expect(readWebBuild(dist).commit).toBe(older);

  writeFileSync(file, JSON.stringify({ commit: SHA, built_at: "2026-08-07T02:00:00Z" }));
  // mtime 이 같은 초에 걸려 캐시가 살아남지 않도록 명시적으로 밀어준다(캐시 키는 mtime 이다)
  const future = new Date(Date.now() + 5000);
  utimesSync(file, future, future);
  expect(readWebBuild(dist).commit).toBe(SHA); // ★기동 시 캐시했다면 옛 값이 나온다★
  rmSync(dist, { recursive: true, force: true });
});

test("서버 신원은 ★기동 시각과 함께★ 굳는다", () => {
  const root = fresh();
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), SHA + "\n");
  const at = new Date("2026-08-07T03:04:05Z");
  expect(captureServerIdentity(root, at)).toEqual({ commit: SHA, at: "2026-08-07T03:04:05.000Z" });
  rmSync(root, { recursive: true, force: true });
});
});
