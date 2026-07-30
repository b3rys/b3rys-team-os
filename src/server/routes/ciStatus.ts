// GET /api/ci-status — 공개 저장소의 최근 CI 결과를 ★읽기만★ 해서 대시보드에 보여준다.
//
// ★왜 여기서 테스트를 돌리지 않나★ (Steve·Codex 리뷰, 2026-07-28)
//   테스트는 DB·파일시스템 상태를 건드린다 — 실제로 과거에 테스트 하나가 라이브 멤버의
//   CLAUDE.md 를 지운 적이 있고, 격리 워크트리에서 돌려도 DB 마이그레이션 로그가 찍힌다.
//   그래서 대시보드는 ★결과를 보여주기만★ 한다. 실행은 CI(GitHub)와 개발자 로컬의 몫이다.
//
// ★토큰을 쓰지 않는 이유★: 저장소가 공개라 인증 없이 읽을 수 있다(실측: 60 req/hr).
//   서버에 토큰을 두면 그 토큰이 새는 경로가 하나 늘어난다. 읽기만 하는데 그럴 이유가 없다.
//   대신 한도가 낮으므로 ★캐시★ 로 요청을 줄인다(5분 = 시간당 12회).
//
// ★실패를 초록으로 만들지 않는다★: 못 가져왔으면 `ok:false` 와 이유를 그대로 내려보낸다.
//   화면은 그걸 "확인 불가" 로 보여준다. ★모르는 것을 정상으로 표시하는 게 제일 위험하다★
//   — 이 대시보드가 고치려는 문제가 정확히 그것이다.
//
// ★★한도(rate limit) 를 지키는 것이 이 파일의 두 번째 책임이다 (Codex 반려, 2026-07-29)★★
//   토큰 없는 GitHub API 는 ★IP 당 60 req/hr★ 이다. 캐시만으로는 부족했다:
//     ① ★동시 요청★ — 캐시가 빈 순간 10명이 열면 ★10번 나간다.★ 캐시는 '응답 후' 에 채워지므로
//        아직 안 끝난 요청은 아무도 막지 못한다. → ★single-flight★ 로 진행중 요청을 공유한다.
//     ② ★한도 소진 후★ — 실패를 캐시하지 않는 정책(위) 때문에 ★막힌 뒤에도 계속 두드린다.★
//        GitHub 는 이걸 남용으로 보고 차단을 늘릴 수 있다. → ★리셋 시각까지는 아예 안 나간다.★
//   ★이 둘은 "실패를 초록으로 만들지 않는다" 와 충돌하지 않는다★ — 여전히 ok:false 를 내려보내고,
//   다만 ★이유에 '언제 다시 시도하는지' 를 같이 적는다.★
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { REPO_ROOT } from "../lib/paths";

const CACHE_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 6_000;

/**
 * ★어느 저장소의 CI 인가 — 설치본마다 다르다.★ (hermes 교차검증 2026-07-30 에서 출발, 빌 실측)
 *
 *  앞선 판은 `https://api.github.com/repos/★b3rys/b3rys-team-os★/actions/runs` 로 ★박아놨다.★
 *  그러면 공개 설치본에서 이런 일이 난다:
 *    · 자기 CI 가 아니라 ★우리 CI 가 자기 대시보드에 뜬다★ — 화면에 거짓을 표시하는 것이다
 *    · GitHub 를 안 쓰는 설치본도 ★5분마다 GitHub API 를 친다★(미인증 한도는 IP 공유)
 *  "우리 맥 사정을 저장소 기본값으로 박는" 형태이고, 이 저장소에서 이미 겪은 종류다.
 *
 *  → 순서: ①`TEAM_CI_REPO`(owner/repo) ②설치본 자신의 git origin ③★못 찾으면 기능을 끈다.★
 *    ③에서 추측하지 않는다 — 모르면 "미설정" 이라고 말하고 ★네트워크를 아예 안 탄다.★
 */
export function parseRepoFromRemote(url: string): string | null {
  const t = url.trim();
  // git@github.com:owner/repo.git · https://github.com/owner/repo(.git) · ssh://git@github.com/owner/repo
  const m = t.match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  const [, owner, repo] = m;
  if (!owner || !repo || owner === "." || repo === ".") return null;
  return `${owner}/${repo}`;
}

/** 설치본의 origin 을 `.git/config` 에서 읽는다. ★git 을 실행하지 않는다★(요청마다 프로세스를 띄우지 않으려고).
 *
 *  ★워크트리에서는 `.git` 이 디렉토리가 아니라 파일이다★ (2026-07-30 실측) — 안에 `gitdir: <경로>` 한 줄이 있고
 *  진짜 config 는 그 경로의 `commondir` 쪽에 있다. 정상 클론만 상정하면 ★팀원이 워크트리에서 볼 때
 *  "미설정" 으로 보인다★ — 기능이 멀쩡한데 고장난 것처럼 읽힌다. 그래서 파일 형태도 따라간다. */
export function repoFromGitConfig(root: string): string | null {
  try {
    let gitDir = `${root}/.git`;
    // `.git` 이 파일이면 `gitdir: …` 포인터다 → 그 안의 commondir 를 따라 진짜 저장소로 간다
    let head: string;
    try {
      head = readFileSync(gitDir, "utf8");
    } catch {
      head = "";
    }
    const ptr = head.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    if (ptr) {
      const abs = ptr.startsWith("/") ? ptr : `${root}/${ptr}`;
      // 워크트리 gitdir 안의 commondir 가 공용 저장소를 가리킨다(대개 `../..`)
      let common = "";
      try {
        common = readFileSync(`${abs}/commondir`, "utf8").trim();
      } catch {
        common = "";
      }
      gitDir = common ? (common.startsWith("/") ? common : `${abs}/${common}`) : abs;
    }
    const cfg = readFileSync(`${gitDir}/config`, "utf8");
    // [remote "origin"] 블록의 url 한 줄만 본다
    const block = cfg.split(/^\[/m).find((b) => /^remote\s+"origin"\]/.test(b));
    const url = block?.match(/^\s*url\s*=\s*(.+)$/m)?.[1];
    return url ? parseRepoFromRemote(url) : null;
  } catch {
    return null;
  }
}

/** 설정 → git origin → null. null 이면 기능이 꺼진다. */
export function resolveCiRepo(root = REPO_ROOT): string | null {
  const env = (process.env.TEAM_CI_REPO ?? "").trim();
  if (env) return /^[^/\s]+\/[^/\s]+$/.test(env) ? env : null;
  return repoFromGitConfig(root);
}

export const CI_UNCONFIGURED_REASON =
  "GitHub CI 미설정 — 이 설치본의 git origin 이 GitHub 이 아니거나 확인되지 않습니다. " +
  "표시하려면 .env 에 TEAM_CI_REPO=owner/repo 를 적어 주세요.";

function runsUrl(repo: string): string {
  return `https://api.github.com/repos/${repo}/actions/runs?per_page=10`;
}

/** 리셋 시각을 못 읽었을 때 쓰는 보수적 기본 대기. 한도 창이 1시간이라 그 절반. */
const DEFAULT_BACKOFF_MS = 30 * 60_000;

export interface CiRun {
  name: string;
  event: string;
  status: string;
  conclusion: string | null;
  branch: string;
  created_at: string;
  url: string;
}

export interface CiStatusBody {
  ok: boolean;
  /** 못 가져왔을 때의 이유 — 화면이 이걸 그대로 보여준다(초록으로 위장하지 않는다). */
  reason?: string;
  runs: CiRun[];
  /** 이 데이터를 실제로 가져온 시각(UTC ISO). 화면이 "언제 기준" 인지 밝히는 데 쓴다. */
  fetched_at: string | null;
  cached: boolean;
  /** 한도에 걸려 쉬는 중이면 다시 시도할 시각(UTC ISO). 평소에는 없다. */
  retry_after?: string;
  /** ★설정 자체가 안 된 상태★ — 실패가 아니다. GitHub 을 안 쓰는 설치본의 정상 상태이므로
   *  화면이 ★빨간 오류★ 가 아니라 중립으로 그려야 한다(false 일 때만 실린다). */
  configured?: boolean;
}

/** 한도 초과를 ★다른 실패와 구분★ 하기 위한 전용 오류.
 *  ★resetMs 는 epoch 밀리초(숫자)다★ — 이 저장소에서 `...At`/`..._at` 는 ★DB 시각 문자열★ 을 뜻하므로
 *  그 이름을 쓰면 안 된다(utcTimestamp.contract 가 잡는다). 이름에 단위를 박아 오독을 막는다. */
export class RateLimitedError extends Error {
  constructor(public resetMs: number, message: string) {
    super(message);
    this.name = "RateLimitedError";
  }
}

/** 상류 응답이 우리가 아는 모양이 아닐 때. ★빈 배열로 삼키지 않기 위해★ 오류로 올린다. */
export class MalformedUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedUpstreamError";
  }
}

/**
 * 429·403 응답에서 ★언제 풀리는지★ 를 뽑는다.
 *
 * ★403 을 전부 한도로 보면 안 된다★ — 권한 오류도 403 이다.
 * GitHub 은 한도 소진 시 `x-ratelimit-remaining: 0` 을 같이 준다. 그 조합일 때만 한도로 본다.
 * 우선순위: `retry-after`(초) → `x-ratelimit-reset`(epoch 초) → 기본 백오프.
 */
export function parseRateLimit(
  status: number,
  headers: { get(name: string): string | null },
  nowMs: number,
): number | null {
  const remaining = headers.get("x-ratelimit-remaining");
  const isLimited = status === 429 || (status === 403 && remaining === "0");
  if (!isLimited) return null;

  const retryAfter = Number(headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return nowMs + retryAfter * 1000;
  }
  const reset = Number(headers.get("x-ratelimit-reset"));
  // 초 단위 epoch. 과거 값이면 신뢰하지 않고 기본 백오프로 떨어진다.
  if (Number.isFinite(reset) && reset * 1000 > nowMs) {
    return reset * 1000;
  }
  return nowMs + DEFAULT_BACKOFF_MS;
}

/**
 * GitHub 응답 → 화면이 쓰는 최소 형태. 필드가 없으면 빈 문자열로 두고 ★추측하지 않는다.★
 *
 * ★`workflow_runs` 가 배열이 아니면 던진다★ (Codex 반려, 2026-07-29):
 *   예전엔 `[]` 를 돌려줬는데, 그러면 상류가 깨졌을 때 화면이 ★"실행 0건" = 정상★ 으로 보인다.
 *   ★진짜 0건과 구분이 안 된다.★ 모르는 것은 모른다고 해야 한다 — 이 파일의 존재 이유다.
 */
export function normalizeRuns(raw: unknown): CiRun[] {
  const runs = (raw as { workflow_runs?: unknown[] } | null)?.workflow_runs;
  if (!Array.isArray(runs)) {
    throw new MalformedUpstreamError("upstream: workflow_runs 가 배열이 아님");
  }
  return runs.slice(0, 10).map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return {
      name: String(o.name ?? ""),
      event: String(o.event ?? ""),
      status: String(o.status ?? ""),
      conclusion: o.conclusion == null ? null : String(o.conclusion),
      branch: String(o.head_branch ?? ""),
      created_at: String(o.created_at ?? ""),
      url: String(o.html_url ?? ""),
    };
  });
}

export function createCiStatusRoutes(deps?: {
  /** 테스트 주입용 — 실제 네트워크를 타지 않게 한다(테스트가 환경을 타면 안 된다). */
  fetchRuns?: () => Promise<unknown>;
  now?: () => number;
  /** 테스트 주입용 — ★주변 git 설정에 결과가 달라지면 안 된다.★ 기본은 실제 해석기. */
  ciRepo?: () => string | null;
}): Hono {
  const app = new Hono();
  const now = deps?.now ?? (() => Date.now());
  const ciRepo = deps?.ciRepo ?? (() => resolveCiRepo());
  let cache: { at: number; body: CiStatusBody } | null = null;
  /** ★single-flight★ — 진행중인 요청. 동시 요청은 이걸 함께 기다린다(추가 호출 0). */
  let inFlight: Promise<CiRun[]> | null = null;
  /** 한도에 걸린 동안은 이 시각까지 ★아예 안 나간다.★ */
  let blockedUntil = 0;

  const defaultFetch = async (): Promise<unknown> => {
    const repo = ciRepo();
    // ★여기 오면 안 된다★ — 핸들러가 미설정을 먼저 걸러낸다. 방어적으로 한 번 더 막는다.
    if (!repo) throw new Error(CI_UNCONFIGURED_REASON);
    const res = await fetch(runsUrl(repo), {
      headers: {
        accept: "application/vnd.github+json",
        // ★버전을 고정한다★ — 안 보내면 GitHub 이 기본값을 바꿀 때 응답 모양이 조용히 달라진다.
        "x-github-api-version": "2022-11-28",
        "user-agent": "b3os-dashboard",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const resetMs = parseRateLimit(res.status, res.headers, now());
      if (resetMs !== null) {
        throw new RateLimitedError(resetMs, `github ${res.status} rate limited`);
      }
      throw new Error(`github ${res.status}`);
    }
    return await res.json();
  };
  const fetchRuns = deps?.fetchRuns ?? defaultFetch;

  app.get("/ci-status", async (c) => {
    const t = now();
    // ★미설정이면 네트워크를 아예 안 탄다.★ 캐시보다도 앞이다 — 켜지지도 않은 기능이
    //   한 번이라도 GitHub 을 치면 안 된다. deps.fetchRuns 를 주입한 테스트는 이 관문을 지난다.
    if (!deps?.fetchRuns && !ciRepo()) {
      return c.json({
        ok: false,
        reason: CI_UNCONFIGURED_REASON,
        runs: [],
        fetched_at: null,
        cached: false,
        configured: false,
      } satisfies CiStatusBody);
    }
    if (cache && t - cache.at < CACHE_MS) {
      return c.json({ ...cache.body, cached: true });
    }
    // ★한도로 쉬는 중 — 호출하지 않고 즉시 답한다.★ (초록으로 위장하지는 않는다)
    if (t < blockedUntil) {
      const body: CiStatusBody = {
        ok: false,
        reason: "GitHub API 한도 초과 — 리셋까지 요청하지 않습니다",
        runs: [],
        fetched_at: null,
        cached: false,
        retry_after: new Date(blockedUntil).toISOString(),
      };
      return c.json(body);
    }

    try {
      // 진행중인 요청이 있으면 ★새로 부르지 않고 그것을 기다린다.★
      if (!inFlight) {
        inFlight = (async () => normalizeRuns(await fetchRuns()))().finally(() => {
          inFlight = null;
        });
      }
      const runs = await inFlight;
      const body: CiStatusBody = {
        ok: true,
        runs,
        fetched_at: new Date(t).toISOString(),
        cached: false,
      };
      cache = { at: t, body };
      return c.json(body);
    } catch (e) {
      // ★실패를 캐시하지 않는다★ — 캐시하면 일시적 오류가 5분간 굳는다.
      //   그리고 ★직전 성공값을 대신 보여주지도 않는다★: 그러면 낡은 초록이 현재처럼 보인다.
      //   ★단 하나의 예외가 한도 초과다★ — 그건 '쉬는 시각' 을 기억한다. 계속 두드리면
      //   GitHub 이 차단을 늘리기 때문이고, 이건 결과를 숨기는 게 아니라 ★요청을 줄이는 것★ 이다.
      const body: CiStatusBody = {
        ok: false,
        reason: e instanceof Error ? e.message : String(e),
        runs: [],
        fetched_at: null,
        cached: false,
      };
      if (e instanceof RateLimitedError) {
        blockedUntil = e.resetMs;
        body.retry_after = new Date(e.resetMs).toISOString();
      }
      return c.json(body);
    }
  });

  return app;
}
