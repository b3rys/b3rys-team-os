// 배포 판단 — ★층마다 다른 동작을 고르는가★ · ★모르면 멈추는가★
//
// 이 시험이 지켜야 하는 사고 두 개 (둘 다 실제로 났다):
//  1. 2026-08-06 — 화면(src/web)만 바뀐 배포에 ★재시작★ 을 하려 했다. 했으면 화면은 그대로였다.
//  2. 2026-08-05 — 라이브가 옛 커밋인 걸 모르고 재생성을 돌려 ★새 룰 파일에 옛 룰이 되살아났다.★
//
// ★가짜 상류를 만들되, 검사 대상은 진짜 판단 함수다★ — planDeploy 는 순수 함수라 저장소를 안 읽는다.
// (주입하는 건 "무엇이 바뀌었나" 라는 ★사실★ 이지, 판단이 아니다)
import { test, expect } from "bun:test";
import { planDeploy, verifyAfterDeploy, LAYER_PATHS, type Layer, type Plan } from "./deploy-plan";

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
  };
  const v = verifyAfterDeploy(plan, live(SHA.server, SHA.web)); // web 이 옛것 그대로
  expect(v.ok).toBe(false);
  expect(v.problems[0]).toContain("web");
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
