// 배포 판단 — ★층마다 다른 동작을 고르는가★ · ★모르면 멈추는가★
//
// 이 시험이 지켜야 하는 사고 두 개 (둘 다 실제로 났다):
//  1. 2026-08-06 — 화면(src/web)만 바뀐 배포에 ★재시작★ 을 하려 했다. 했으면 화면은 그대로였다.
//  2. 2026-08-05 — 라이브가 옛 커밋인 걸 모르고 재생성을 돌려 ★새 룰 파일에 옛 룰이 되살아났다.★
//
// ★가짜 상류를 만들되, 검사 대상은 진짜 판단 함수다★ — planDeploy 는 순수 함수라 저장소를 안 읽는다.
// (주입하는 건 "무엇이 바뀌었나" 라는 ★사실★ 이지, 판단이 아니다)
import { test, expect } from "bun:test";
import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  planDeploy,
  verifyAfterDeploy,
  LAYER_PATHS,
  CONFIG_NOT_IN_ANY_LAYER,
  type Layer,
  type Plan,
  type PlanInput,
  type TreeState,
  type Ancestry,
  realIsAncestor,
  parseStatusPorcelain,
  UNTRACKED_ALLOWED_PREFIXES,
} from "./deploy-plan";

const repoRoot = () => join(dirname(fileURLToPath(import.meta.url)), "..");

const SHA = {
  server: "a".repeat(40),
  web: "b".repeat(40),
  target: "c".repeat(40),
};
const live = (server: string | null, web: string | null) => ({
  server: { commit: server },
  web: { commit: web },
});
/** 지정한 층에만 변경이 있는 것으로 답하는 가짜. 경로 목록으로 층을 구분한다. */
const changesIn = (layers: Layer[]) => (_from: string, _to: string, paths: readonly string[]) => {
  for (const l of layers) {
    // 그 층에만 있는 경로가 들어왔는지로 판단 (src/server 는 server 에만, src/web 은 web 에만 있다)
    const unique = l === "server" ? "src/server" : "src/web";
    if (paths.includes(unique)) return [`${unique}/x.ts`];
  }
  return [];
};
const always = () => true;

test("★화면만 바뀌면 빌드만 한다 — 재시작하지 않는다★ (2026-08-06 사고)", () => {
  const plan = planDeploy({
    live: live(SHA.server, SHA.web),
    target: SHA.target,
    changedFiles: changesIn(["web"]),
    commitExists: always,
  });
  expect(plan.blocked).toBeNull();
  expect(plan.actions.build).toBe(true);
  expect(plan.actions.restart).toBe(false); // ★여기가 사고 지점이다★
});

test("★대조군★ — 서버만 바뀌면 재시작만 한다(빌드 안 함)", () => {
  const plan = planDeploy({
    live: live(SHA.server, SHA.web),
    target: SHA.target,
    changedFiles: changesIn(["server"]),
    commitExists: always,
  });
  expect(plan.actions.restart).toBe(true);
  expect(plan.actions.build).toBe(false);
});

test("둘 다 바뀌면 둘 다 한다", () => {
  const plan = planDeploy({
    live: live(SHA.server, SHA.web),
    target: SHA.target,
    changedFiles: changesIn(["server", "web"]),
    commitExists: always,
  });
  expect(plan.actions).toEqual({ restart: true, build: true });
});

test("★둘 다 안 바뀌면 아무것도 안 한다★ — 얻는 것 없이 서비스만 끊지 않는다", () => {
  const plan = planDeploy({
    live: live(SHA.server, SHA.web),
    target: SHA.target,
    changedFiles: () => [],
    commitExists: always,
  });
  expect(plan.actions).toEqual({ restart: false, build: false });
  expect(plan.blocked).toBeNull(); // 할 일 없음은 ★정상★ 이다(멈춤이 아니다)
});

test("★커밋을 모르면 멈춘다★ — '최신인가 보다' 로 넘어가지 않는다", () => {
  const plan = planDeploy({
    live: live(SHA.server, null), // 옛 빌드라 표식이 없는 상태
    target: SHA.target,
    changedFiles: changesIn(["web"]),
    commitExists: always,
  });
  expect(plan.blocked).toContain("web");
  expect(plan.actions).toEqual({ restart: false, build: false }); // ★멈췄으면 아무것도 하지 않는다★
});

test("★라이브가 말한 커밋이 저장소에 없으면 멈춘다★ (강제푸시·얕은 클론)", () => {
  const plan = planDeploy({
    live: live(SHA.server, SHA.web),
    target: SHA.target,
    changedFiles: changesIn(["server"]),
    commitExists: (sha) => sha !== SHA.server, // 서버가 말한 커밋만 사라진 상태
  });
  expect(plan.blocked).toContain(SHA.server.slice(0, 8));
  expect(plan.actions).toEqual({ restart: false, build: false });
});

// ── 배포 후 검증 — ★바뀐 층만 본다★ ─────────────────────────────────────────

test("★화면만 배포했으면 서버 층이 옛 커밋이어도 성공이다★ — 이게 오판의 자리였다", () => {
  const plan: Plan = {
    blocked: null,
    actions: { restart: false, build: true },
    changed: { server: [], web: ["src/web/x.ts"] },
    target: SHA.target,
    warnings: [],
  };
  // 서버는 여전히 옛 커밋 — 재시작을 안 했으니 당연하다
  const v = verifyAfterDeploy(plan, live(SHA.server, SHA.target));
  expect(v.ok).toBe(true);
  expect(v.problems).toEqual([]);
});

test("★대조군★ — 빌드했다는데 화면 커밋이 안 바뀌었으면 실패로 잡는다", () => {
  const plan: Plan = {
    blocked: null,
    actions: { restart: false, build: true },
    changed: { server: [], web: ["src/web/x.ts"] },
    target: SHA.target,
    warnings: [],
  };
  const v = verifyAfterDeploy(plan, live(SHA.server, SHA.web)); // web 이 옛것 그대로
  expect(v.ok).toBe(false);
  expect(v.problems[0]).toContain("web");
});

// ── ★분류에서 빠진 설정 파일을 잡는다★ ────────────────────────────────────────
//
// 왜 이 시험이 있나: `tailwind.config.js` 가 실제로 이 목록에서 빠져 있었다.
// 빠진 것은 diff 에도 목록에도 안 보인다 — ★정본 집합(디스크)과 대조해야만 보인다.★
// 실측으로 확인한 영향: safelist 에 유틸 하나를 넣고 빌드하니 산출물이 바뀌었다
//   index-4M85XvLX.css(53921B) → index-CWIvisIW.css(54140B), 원복하면 원래 해시.
test("★루트의 설정 파일은 모두 어느 층엔가 분류돼 있다★ — 새 설정이 조용히 누락되지 않게", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const configs = readdirSync(repoRoot).filter(
    (f) => /\.config\.(js|ts|mjs|cjs)$/.test(f) || f === "tsconfig.json" || f === "bunfig.toml",
  );
  expect(configs.length).toBeGreaterThan(0); // 하나도 못 찾으면 이 시험이 아무것도 안 재는 것이다

  const classified = new Set<string>([...LAYER_PATHS.server, ...LAYER_PATHS.web, ...CONFIG_NOT_IN_ANY_LAYER]);
  const missing = configs.filter((f) => !classified.has(f));
  expect(missing).toEqual([]); // ★여기 뜨면 층에 넣든지 CONFIG_NOT_IN_ANY_LAYER 에 이유와 함께 적어라★
});

test("★tailwind 설정은 web 층이다★ — 이 파일 변경이 dist 산출물을 바꾸는 것을 실측했다", () => {
  expect(LAYER_PATHS.web).toContain("tailwind.config.js");
  expect(LAYER_PATHS.web).toContain("postcss.config.js"); // tailwind 를 불러 쓰는 쪽
});

// ── ★경고 — 막지는 않지만 드러낸다★ ───────────────────────────────────────────
//
// 왜 필요한가 (2026-08-07 실측):
//  · 공유 라이브 트리에서 기능 브랜치를 checkout 하고 작업하는 일이 하루 다섯 번 났다.
//    팀원은 스킬·룰을 그 트리에서 ★직접 읽으므로★ 그 시간 동안 ★미머지 내용이 이미 팀에 나가 있었다.★
//  · 그 상태로 빌드가 돌아 web 층이 ★미머지 브랜치 커밋★ 을 가리켰는데, 빌드 입력이 안 바뀌었으므로
//    planDeploy 는 "할 일 없음" 을 답했다 — ★맞는 답이지만 그 사실을 말하지 않았다.★
//
// ★막지 않는 이유★: 정당한 상태를 막는 게이트는 우회 습관을 만든다(팀 전례 있음).

/** 트리 상태 헬퍼 — 기본은 ★정상★(main·깨끗·관측 성공) 이고 필요한 것만 덮어쓴다. */
const tree = (over: Partial<TreeState> = {}): TreeState => ({
  branch: "main",
  dirtyTracked: 0,
  untrackedNotAllowed: [],
  observed: true,
  ...over,
});
const cleanTree = tree();
/**
 * ★실제 git 의미를 그대로 흉내낸다★ — `merge-base --is-ancestor A A` 는 ★0(조상)★ 이다
 * (2026-08-07 실측). 자기 자신도 조상이므로 ★정상 상태에서는 언제나 yes★ 다.
 * 처음엔 이 가짜를 `() => false` 로 뒀는데, ★진짜보다 비관적인 가짜가 없던 경고를 정답으로 굳혔다.★
 */
const allOnCanonicalLine = (): Ancestry => "yes";
const basePlan = (over: Partial<PlanInput> = {}) =>
  planDeploy({
    live: live(SHA.server, SHA.web),
    target: SHA.target,
    changedFiles: () => [],
    commitExists: always,
    ...over,
  });

test("★실행 트리가 정본 브랜치가 아니면 경고한다★ — 팀원이 그 파일을 읽고 있다", () => {
  const plan = basePlan({ tree: tree({ branch: "hermes/some-work" }) });
  expect(plan.warnings.some((w) => w.includes("hermes/some-work"))).toBe(true);
  expect(plan.blocked).toBeNull(); // ★막지 않는다★
});

test("★미커밋이 있으면 경고한다★ — 커밋도 리뷰도 안 된 내용이 읽힌다", () => {
  const plan = basePlan({ tree: tree({ dirtyTracked: 4 }) });
  expect(plan.warnings.some((w) => w.includes("4건"))).toBe(true);
  expect(plan.blocked).toBeNull();
});

test("★대조군★ — main 이고 깨끗하면 트리 경고가 없다", () => {
  expect(basePlan({ tree: cleanTree }).warnings).toEqual([]);
});

test("★detached HEAD 도 경고한다★ — 브랜치 이름이 없는 것도 정본이 아니다", () => {
  const plan = basePlan({ tree: tree({ branch: null }) });
  expect(plan.warnings.some((w) => w.includes("detached"))).toBe(true);
});

test("★층 커밋이 정본 계열이 아니면 경고한다★ — 브랜치가 지워지면 사라질 커밋이다", () => {
  const plan = basePlan({ tree: cleanTree, isAncestor: (sha) => (sha === SHA.web ? "no" : "yes") });
  expect(plan.warnings.some((w) => w.includes("web") && w.includes(SHA.web.slice(0, 8)))).toBe(true);
  expect(plan.warnings.some((w) => w.startsWith("server"))).toBe(false); // server 는 조상이므로 조용해야 한다
});

test("★대조군★ — 두 층이 모두 정본 계열이면 계열 경고가 없다", () => {
  expect(basePlan({ tree: cleanTree, isAncestor: allOnCanonicalLine }).warnings).toEqual([]);
});

// ★이 시험은 전제가 틀려서 다시 썼다★ — 처음엔 "git 은 자기 자신을 조상으로 안 친다" 고 적고
//   가짜를 `() => false` 로 두었다. ★실측하니 `merge-base --is-ancestor A A` 는 exit 0(조상) 이다.★
//   가짜가 진짜보다 비관적이면 ★실제로는 안 나는 경고를 시험이 정답으로 굳힌다.★
test("★라이브가 이미 target 이면 계열 경고가 없다★ (git: A A → 조상)", () => {
  const plan = planDeploy({
    live: live(SHA.target, SHA.target),
    target: SHA.target,
    changedFiles: () => [],
    commitExists: always,
    tree: cleanTree,
    isAncestor: allOnCanonicalLine, // ★진짜 git 과 같은 의미★
  });
  expect(plan.warnings).toEqual([]);
});

test("★판정 못 한 것을 '계열 이탈' 로 말하지 않는다★ (얕은 클론·저장소 오류)", () => {
  const plan = basePlan({ tree: cleanTree, isAncestor: () => "unknown" });
  expect(plan.warnings.some((w) => w.includes("판정하지 못했다"))).toBe(true);
  expect(plan.warnings.some((w) => w.includes("계열이 아니다"))).toBe(false); // ★단정하면 안 된다★
});

test("★허용 목록 밖 미추적 파일은 경고한다★ — git 이 몰라도 팀원은 읽는다", () => {
  const plan = basePlan({ tree: tree({ untrackedNotAllowed: ["skills/b3os-report/새파일.md"] }) });
  expect(plan.warnings.some((w) => w.includes("추적되지 않는 파일"))).toBe(true);
});

test("★대조군★ — 허용된 미추적(.worktrees/)만 있으면 조용하다", () => {
  // realTreeState 가 걸러내므로 여기엔 애초에 안 들어온다 — 그 계약을 고정한다
  expect(basePlan({ tree: tree({ untrackedNotAllowed: [] }) }).warnings).toEqual([]);
});

test("★트리 상태를 못 읽으면 '깨끗함' 이 아니라 '모름' 이다★", () => {
  const plan = basePlan({ tree: tree({ observed: false }) });
  expect(plan.warnings.some((w) => w.includes("읽지 못했다"))).toBe(true);
});

test("★멈춘 경우에도 경고는 함께 나온다★ — 멈춘 이유와 트리 상태를 같이 봐야 한다", () => {
  const plan = planDeploy({
    live: live(SHA.server, null), // web 표식 없음 → blocked
    target: SHA.target,
    changedFiles: () => [],
    commitExists: always,
    tree: tree({ branch: "wip", dirtyTracked: 2 }),
  });
  expect(plan.blocked).not.toBeNull();
  expect(plan.warnings.length).toBeGreaterThan(0);
});

test("★tree 를 안 주면 그 검사는 건너뛴다★ — 다른 호출부가 깨지지 않는다", () => {
  expect(basePlan().warnings).toEqual([]);
});

// ── ★porcelain 파서 — 허용 목록 경계를 직접 잰다★ ─────────────────────────────
//
// 리뷰 메모(codex): 지금까지 시험은 TreeState 를 ★주입★ 해서 treeWarnings 만 봤다.
// 그러면 ★"어떤 미추적을 허용으로 걸러내는가" 라는 판단 자체는 아무도 안 본다.★
// (같은 이음매에서 realIsAncestor 뮤턴트가 이미 한 번 살아남았다)

test("★추적 변경과 미추적을 갈라 센다★", () => {
  const r = parseStatusPorcelain([" M src/a.ts", "?? new.md", "A  src/b.ts", ""]);
  expect(r.dirtyTracked).toBe(2);
  expect(r.untrackedNotAllowed).toEqual(["new.md"]);
});

test("★허용 목록에 있는 미추적만 걸러낸다★ — 나머지는 남긴다", () => {
  const r = parseStatusPorcelain([
    "?? .worktrees/foo/",
    "?? node_modules/x",
    "?? dist/web/a.js",
    "?? skills/b3os-report/새파일.md", // ★팀원이 바로 읽는 자리★
    "?? rules/새룰.md",
  ]);
  expect(r.untrackedNotAllowed).toEqual(["skills/b3os-report/새파일.md", "rules/새룰.md"]);
});

test("★이름이 비슷할 뿐인 경로는 걸러내지 않는다★ — prefix 함정", () => {
  const r = parseStatusPorcelain(["?? .worktrees-backup/x", "?? distribution/y", "?? node_modules_old/z"]);
  expect(r.untrackedNotAllowed).toHaveLength(3); // 셋 다 남아야 한다
});

test("★허용 목록 자체가 비어 있지 않다★ — 비면 이 파서가 아무것도 안 거른다", () => {
  expect(UNTRACKED_ALLOWED_PREFIXES.length).toBeGreaterThan(0);
});

// ── ★진짜 git 에 대고 재는 시험★ ──────────────────────────────────────────────
//
// 위 시험들은 전부 ★가짜를 주입해서★ planDeploy 를 잰다. 그래서 `realIsAncestor` 가 git 의
// 종료코드를 ★어떻게 옮기는지★ 는 하나도 확인되지 않았다 — 실제로 뮤턴트(unknown→no 합치기)가
// ★살아남았다.★ 여기서만 진짜 저장소를 쓴다.
//
// 고정하는 사실(2026-08-07 실측): `A A` → 0(조상) · 비조상 → 1 · 없는 ref → 128

test("★realIsAncestor 가 git 종료코드를 3값으로 옮긴다★ — unknown 을 no 로 합치지 않는다", () => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot(), encoding: "utf8" }).trim();
  const parent = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: repoRoot(), encoding: "utf8" }).trim();

  expect(realIsAncestor(head, head)).toBe("yes"); // ★자기 자신도 조상이다★ (exit 0)
  expect(realIsAncestor(head, parent)).toBe("no"); // 앞선 커밋은 부모의 조상이 아니다 (exit 1)
  expect(realIsAncestor("dead".repeat(10), head)).toBe("unknown"); // 없는 ref (exit 128)
});

test("★공유 코드는 양쪽 층에 다 든다★ — 한쪽만 반영되면 나머지가 옛 코드로 남는다", () => {
  expect(LAYER_PATHS.server).toContain("src/shared");
  expect(LAYER_PATHS.web).toContain("src/shared");
  // 층을 가르는 고유 경로도 실제로 갈라져 있어야 판단이 성립한다
  expect(LAYER_PATHS.server).toContain("src/server");
  expect(LAYER_PATHS.web).toContain("src/web");
  expect(LAYER_PATHS.server).not.toContain("src/web");
  expect(LAYER_PATHS.web).not.toContain("src/server");
});
