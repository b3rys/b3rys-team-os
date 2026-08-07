/**
 * ★배포에서 "무엇을 해야 하는가" 를 판단한다.★ 실행은 하지 않는다 — 판단만 찍는다.
 *
 * ■ 왜 이 파일이 따로 있나
 * 실제 배포 스크립트(`scripts/deploy-live.sh`)는 ★git 추적 밖★ 이다(GD 머신 전용 ops · `.gitignore` 방침).
 * 판단 로직을 거기 두면 ★리뷰도 시험도 공개도 안 된다.★ 그래서 판단은 추적되는 이 파일에 두고,
 * 로컬 배포 스크립트는 이걸 ★부르기만★ 한다. (`!/scripts/*.test.ts` 규칙 덕에 시험은 자동으로 추적된다)
 *
 * ■ 판단 기준 — ★층마다 살아나는 방법이 다르다★
 *   · `src/server/**` 등 → 프로세스가 기동할 때 메모리에 올린다 → ★재시작★
 *   · `src/web/**` 등    → 빌드 결과물(`dist/web`)을 요청 시점에 읽는다 → ★빌드★ (재시작은 효과 없음)
 *   · 그 외(skills·rules·docs) → 파일이 바뀐 순간 끝. ★아무것도 안 한다.★
 * 2026-08-06 실측: `src/web` 만 바뀐 배포에 재시작을 하면 ★화면은 그대로다.★ 반대로 `src/server`
 * 가 바뀐 배포에 빌드만 하면 ★옛 코드가 계속 돈다.★ 사람이 매번 이걸 고르고 있었고, 한 번 틀렸다.
 *
 * ■ ★모르면 멈춘다★
 * 라이브가 커밋을 말해주지 않거나(옛 빌드·git 없음), 그 커밋이 이 저장소에 없으면(강제푸시·얕은 클론)
 * ★"최신인가 보다" 로 넘어가지 않는다.★ blocked 로 끝내고 사람이 본다.
 *
 * 사용: bun run scripts/deploy-plan.ts [--health <url>] [--target <ref>] [--json]
 *   종료코드 0 = 판단 성공(할 일이 없어도 0) · 2 = blocked(사람이 봐야 함) · 1 = 사용법·실행 오류
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 층별 경로. ★공유 코드(`src/shared`)와 의존성은 양쪽 모두에 든다★ — 어느 한쪽에만 넣으면
 * 나머지 층이 옛 코드로 남는다. 애매하면 ★넓게 잡는 쪽이 안전하다★(불필요한 작업 < 누락).
 */
export const LAYER_PATHS = {
  server: ["src/server", "src/shared", "package.json", "bun.lock", "bunfig.toml", "tsconfig.json"],
  web: [
    "src/web",
    "src/shared",
    "package.json",
    "bun.lock",
    "tsconfig.json",
    "vite.config.ts",
    "postcss.config.js",
    // ★실측으로 넣었다★: postcss 가 tailwindcss 를 불러 쓰고,
    //   이 파일이 content·safelist·theme 를 정한다. safelist 에 유틸 하나를 넣고 빌드해보니
    //   ★산출물이 바뀌었다★ — index-4M85XvLX.css(53921B) → index-CWIvisIW.css(54140B), 원복하면 원래 해시.
    //   빠져 있으면 이 파일만 바꾼 배포가 ★조용히 누락된다.★
    "tailwind.config.js",
  ],
} as const;

/**
 * ★분류에서 빠진 설정 파일을 잡기 위한 정본 집합★ — 목록을 눈으로 세는 대신 ★디스크와 대조★ 한다.
 * (빠진 것은 diff 에 안 보인다: `tailwind.config.js` 가 실제로 그렇게 빠졌고, 리뷰어가 잡았다)
 * 어느 층에도 영향이 없다고 판단한 파일만 여기 적는다 — ★이유와 함께, 눈에 보이게.★
 */
export const CONFIG_NOT_IN_ANY_LAYER: readonly string[] = [
  // 지금은 없다. 새 설정 파일이 생기면 여기 적든지 층에 넣든지 ★둘 중 하나를 해야 시험이 통과한다.★
];

export type Layer = keyof typeof LAYER_PATHS;

/** 조상 판정 — ★모름을 아니오로 바꾸지 않는다.★ */
export type Ancestry = "yes" | "no" | "unknown";

export interface LivePoint {
  commit: string | null;
}

/**
 * 배포를 실행할 트리 자체의 상태. ★"무엇을 배포하나" 와 "어디서 배포하나" 는 다른 질문이다.★
 * 공유 트리가 기능 브랜치에 올라가 있거나 미커밋이 얹혀 있으면, 팀원은 그 파일들을 직접 읽는다
 * (스킬·룰은 공유 트리에서 바로 읽힌다). 그건 배포 대상이 아니라 ★지금 이미 벌어지고 있는 일★ 이다.
 */
export interface TreeState {
  branch: string | null;
  /** 추적 파일의 미커밋 변경 수. */
  dirtyTracked: number;
  /**
   * ★허용 목록에 없는 미추적 경로.★ 처음엔 미추적을 통째로 무시했는데 그건 틀렸다 —
   * 새로 만든 `skills/`·`rules/` 파일은 ★추적되지 않아도 팀원이 바로 읽는다★ (공유 트리에서 직접 읽으므로).
   * `.worktrees/` 같은 정상 잔재만 걸러내고 나머지는 보여준다.
   */
  untrackedNotAllowed: string[];
  /** 트리 상태를 읽는 데 성공했나. ★실패를 '깨끗함' 으로 바꾸지 않는다.★ */
  observed: boolean;
}

export interface PlanInput {
  live: Record<Layer, LivePoint>;
  target: string;
  /** 주입 가능하게 둔다 — 시험이 진짜 저장소 상태에 기대지 않도록. */
  changedFiles: (from: string, to: string, paths: readonly string[]) => string[];
  commitExists: (sha: string) => boolean;
  /**
   * `sha` 가 `target` 의 조상인가 = 정본 계열 위에 있는가.
   * ★"아니다" 와 "판정 못 했다" 를 합치지 않는다★ — git 은 비조상을 1, 오류를 128 로 준다.
   * 얕은 클론에서 이력이 모자라 실패한 것을 ★계열 이탈로 단정하면 거짓 고발★ 이 된다.
   */
  isAncestor?: (sha: string, target: string) => Ancestry;
  /** 실행 트리 상태. 없으면 그 검사는 건너뛴다(시험·다른 호출부 호환). */
  tree?: TreeState;
  /** 정본 브랜치 이름. 기본 main. */
  canonicalBranch?: string;
}

export interface Plan {
  blocked: string | null;
  actions: { restart: boolean; build: boolean };
  changed: Record<Layer, string[]>;
  target: string;
  /**
   * ★막지는 않지만 사람이 봐야 하는 것.★
   *
   * 왜 blocked 가 아니라 warnings 인가 — ★정당한 상태를 막는 게이트는 우회 습관을 만든다.★
   * (우리 팀에 전례가 있다: 상시 실패하는 게이트가 `--skip` 을 습관으로 만들었다)
   * 여기 담기는 것들은 ★배포를 못 할 이유는 아니지만 모르고 지나가면 안 되는★ 사실이다.
   */
  warnings: string[];
}

/** ★판단 본체.★ 순수 함수다 — 저장소도 네트워크도 안 건드린다(그래서 시험이 진짜를 잰다). */
export function planDeploy(input: PlanInput): Plan {
  const changed: Record<Layer, string[]> = { server: [], web: [] };
  const warnings = treeWarnings(input);
  for (const layer of Object.keys(LAYER_PATHS) as Layer[]) {
    const from = input.live[layer].commit;
    if (!from) {
      return {
        blocked: `${layer} 층이 자기 커밋을 말하지 않는다(표식 없음 또는 git 을 못 읽음). ` +
          `모르는 상태를 '최신' 으로 치지 않는다 — 배포 전에 확인해라.`,
        actions: { restart: false, build: false },
        changed,
        target: input.target,
        warnings,
      };
    }
    if (!input.commitExists(from)) {
      return {
        blocked: `${layer} 층이 말한 커밋 ${from.slice(0, 8)} 이 이 저장소에 없다(강제푸시·얕은 클론 가능성). ` +
          `무엇이 바뀌었는지 계산할 수 없다.`,
        actions: { restart: false, build: false },
        changed,
        target: input.target,
        warnings,
      };
    }
    // ★"다시 배포할 필요가 있나" 와 "정본 계열 위에 있나" 는 다른 질문이다.★
    //   2026-08-07 실측: 팀원이 미머지 브랜치에서 빌드해 web 층이 그 브랜치 커밋을 가리켰는데,
    //   빌드 입력이 안 바뀌었으므로 "할 일 없음" 이 나왔다 — ★맞는 답이지만 그 사실은 말하지 않았다.★
    //   그 커밋은 브랜치가 지워지면 저장소에서 사라진다. 다음 배포의 기준선이 사라지는 것이다.
    //
    //   ★자기 자신은 걸러낼 필요가 없다★ — `git merge-base --is-ancestor A A` 는 ★0(조상)★ 이다.
    //   (처음엔 반대로 알고 단축 조건을 넣었는데, 실제 git 으로 재보니 틀렸다)
    if (input.isAncestor) {
      const verdict = input.isAncestor(from, input.target);
      if (verdict === "no") {
        warnings.push(
          `${layer} 층이 가리키는 ${from.slice(0, 8)} 이 정본(${input.target.slice(0, 8)}) 계열이 아니다 — ` +
            `미머지 브랜치에서 배포했거나, target 이 뒤로 이동(롤백)했을 수 있다. ` +
            `브랜치가 지워지면 그 커밋은 사라진다.`,
        );
      } else if (verdict === "unknown") {
        warnings.push(
          `${layer} 층의 계열을 ★판정하지 못했다★ (${from.slice(0, 8)}) — 얕은 클론이거나 저장소 오류일 수 있다. ` +
            `★'계열 이탈' 로 단정하지 않는다.★ 확인이 필요하다.`,
        );
      }
    }
    changed[layer] = input.changedFiles(from, input.target, LAYER_PATHS[layer]);
  }
  return {
    blocked: null,
    // ★바뀐 층에만 그 층의 동작을 한다.★ 둘 다 안 바뀌었으면 아무것도 안 한다(재시작도 빌드도).
    actions: { restart: changed.server.length > 0, build: changed.web.length > 0 },
    changed,
    target: input.target,
    warnings,
  };
}

/**
 * 실행 트리 자체를 본다. ★배포 대상과 무관하게, 지금 팀원이 읽고 있는 파일의 상태다.★
 * 스킬·룰은 공유 트리에서 직접 읽히므로 여기가 브랜치이거나 더러우면 ★이미 그 내용이 팀에 나가 있다.★
 */
export function treeWarnings(input: Pick<PlanInput, "tree" | "canonicalBranch">): string[] {
  const out: string[] = [];
  const tree = input.tree;
  if (!tree) return out;
  const canonical = input.canonicalBranch ?? "main";
  if (!tree.observed) {
    out.push(`실행 트리 상태를 ★읽지 못했다★ — '깨끗하다' 는 뜻이 아니다. git 이 동작하는지 확인해라.`);
  }
  if (tree.untrackedNotAllowed.length > 0) {
    const sample = tree.untrackedNotAllowed.slice(0, 3).join(", ");
    out.push(
      `실행 트리에 ★추적되지 않는 파일 ${tree.untrackedNotAllowed.length}개★ 가 있다 (${sample}${tree.untrackedNotAllowed.length > 3 ? " …" : ""}) — ` +
        `git 이 모르는 파일이지만 ★팀원은 이 트리에서 바로 읽고, 빌드도 집어갈 수 있다.★`,
    );
  }
  if (tree.branch !== canonical) {
    out.push(
      `실행 트리가 '${tree.branch ?? "detached"}' 에 있다 (정본은 '${canonical}'). ` +
        `팀원은 스킬·룰을 이 트리에서 직접 읽으므로 ★미머지 내용이 이미 팀에 나가 있다.★`,
    );
  }
  if (tree.dirtyTracked > 0) {
    out.push(
      `실행 트리에 미커밋 변경 ${tree.dirtyTracked}건이 있다 — ★커밋도 리뷰도 안 된 내용을 팀원이 읽는다.★`,
    );
  }
  return out;
}

/**
 * ★배포 후 검증은 '바뀐 층만' 본다.★ 전부 target 과 같은지로 보면, 화면만 바꾼 정상 배포에서
 * 서버 층이 옛 커밋인 것을 ★실패로 오판한다★ (2026-08-06 실측 반례).
 */
export function verifyAfterDeploy(plan: Plan, after: Record<Layer, LivePoint>): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const layer of Object.keys(LAYER_PATHS) as Layer[]) {
    const didAct = layer === "server" ? plan.actions.restart : plan.actions.build;
    if (!didAct) continue; // 안 건드린 층은 옛 커밋이 정상이다
    const now = after[layer].commit;
    if (now !== plan.target) {
      problems.push(`${layer} 층이 아직 ${now ? now.slice(0, 8) : "모름"} 이다 — ${plan.target.slice(0, 8)} 이어야 한다`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// ── 실제 저장소·라이브를 읽는 얇은 껍데기 (위 순수 함수에 주입한다) ──────────────

function git(args: string[]): { ok: boolean; out: string; status: number | null } {
  const r = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), status: r.status };
}

export function realChangedFiles(from: string, to: string, paths: readonly string[]): string[] {
  // ★A..B 가 아니라 A B★ — 비선형 이력(롤백·강제푸시)에서도 두 지점 비교는 성립한다.
  const r = git(["diff", "--name-only", from, to, "--", ...paths]);
  return r.ok && r.out ? r.out.split("\n").filter(Boolean) : [];
}

export function realCommitExists(sha: string): boolean {
  return git(["cat-file", "-e", `${sha}^{commit}`]).ok;
}

/**
 * ★git 의 종료코드를 그대로 옮긴다★ — 0=조상, 1=비조상, 그 밖(128 등)=판정 실패.
 * 실측(2026-08-07): `A A` → 0 · 비조상 → 1 · 없는 ref → 128.
 * 셋을 boolean 하나로 뭉치면 ★얕은 클론의 이력 부족을 '계열 이탈' 로 거짓 고발한다.★
 */
export function realIsAncestor(sha: string, target: string): Ancestry {
  const r = git(["merge-base", "--is-ancestor", sha, target]);
  if (r.status === 0) return "yes";
  if (r.status === 1) return "no";
  return "unknown";
}

/**
 * 실행 트리 상태를 읽는다.
 *
 * ★미추적을 통째로 버리지 않는다★ — 처음엔 `.worktrees/` 잔재를 피하려고 `??` 를 전부 무시했는데,
 * 그러면 ★새로 만든 skills/·rules/ 파일처럼 팀원이 바로 읽는 것까지 '깨끗함' 으로 나온다.★
 * 허용 목록에 있는 경로만 걸러내고 나머지는 센다.
 */
export const UNTRACKED_ALLOWED_PREFIXES = [".worktrees/", "node_modules/", "dist/"] as const;

export function realTreeState(): TreeState {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  // `--untracked-files=all` — 디렉토리 하나로 뭉뚱그리지 않고 파일 단위로 본다.
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  const lines = status.ok ? status.out.split("\n").filter((l) => l.trim()) : [];
  const dirtyTracked = lines.filter((l) => !l.startsWith("??")).length;
  const untrackedNotAllowed = lines
    .filter((l) => l.startsWith("??"))
    .map((l) => l.slice(3).trim())
    .filter((path) => !UNTRACKED_ALLOWED_PREFIXES.some((pre) => path.startsWith(pre)));
  const name = branch.ok ? branch.out : "";
  return {
    branch: name && name !== "HEAD" ? name : null,
    dirtyTracked,
    untrackedNotAllowed,
    // ★관측 실패를 '깨끗함' 으로 바꾸지 않는다.★
    observed: status.ok && branch.ok,
  };
}

async function fetchLive(healthUrl: string): Promise<Record<Layer, LivePoint>> {
  const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
  const body = (await res.json()) as { server?: { commit?: unknown }; web?: { commit?: unknown } };
  const pick = (v: unknown): string | null => (typeof v === "string" && /^[0-9a-f]{40}$/.test(v) ? v : null);
  return { server: { commit: pick(body.server?.commit) }, web: { commit: pick(body.web?.commit) } };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const arg = (name: string, fallback: string): string => {
    const i = argv.indexOf(name);
    const v = i >= 0 ? argv[i + 1] : undefined;
    return v ?? fallback;
  };
  const healthUrl = arg("--health", `http://127.0.0.1:${process.env.TEAM_HTTP_PORT ?? 7878}/health`);
  const targetRef = arg("--target", "origin/main");
  const asJson = argv.includes("--json");

  const targetSha = git(["rev-parse", targetRef]);
  if (!targetSha.ok) {
    console.error(`✗ 목표를 못 읽는다: ${targetRef}`);
    process.exit(1);
  }

  let live: Record<Layer, LivePoint>;
  try {
    live = await fetchLive(healthUrl);
  } catch (e) {
    console.error(`✗ 라이브에 물어보지 못했다(${healthUrl}): ${(e as Error).message}`);
    console.error(`  서버가 떠 있는지 확인해라. ★응답이 없다고 '안 떠 있다'로 단정하지 마라★ — 주소·포트도 본다.`);
    process.exit(2);
  }

  const plan = planDeploy({
    live,
    target: targetSha.out,
    changedFiles: realChangedFiles,
    commitExists: realCommitExists,
    isAncestor: realIsAncestor,
    tree: realTreeState(),
    canonicalBranch: arg("--canonical-branch", "main"),
  });

  if (asJson) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    const short = (s: string | null) => (s ? s.slice(0, 8) : "모름");
    console.log(`라이브: server=${short(live.server.commit)}  web=${short(live.web.commit)}`);
    console.log(`목표:   ${short(plan.target)} (${targetRef})`);
    if (plan.blocked) {
      console.log(`\n★멈춤★ — ${plan.blocked}`);
    } else {
      console.log(`바뀐 층: server ${plan.changed.server.length}개 · web ${plan.changed.web.length}개`);
      const todo = [plan.actions.restart ? "재시작" : null, plan.actions.build ? "빌드" : null].filter(Boolean);
      console.log(`→ 할 일: ${todo.length ? todo.join(" + ") : "없음 (이미 반영돼 있다)"}`);
    }
    // ★멈추지 않는다. 다만 조용히 지나가지도 않는다.★ blocked 여부와 무관하게 항상 보여준다.
    for (const w of plan.warnings) console.log(`\n⚠ ${w}`);
  }
  process.exit(plan.blocked ? 2 : 0);
}
