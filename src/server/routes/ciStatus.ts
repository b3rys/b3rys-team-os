// 대시보드는 파일·DB를 바꾸는 테스트를 실행하지 않고 공개 저장소의 CI 결과만 읽는다.
// 공개 CI는 인증 없이 읽을 수 있으므로 서버에 토큰을 두어 유출 경로를 늘리지 않는다.
// 미인증 API 한도는 5분 캐시·진행 중 요청 공유·리셋 전 요청 차단으로 지키며, 조회 실패는 ok:false로 반환한다.
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { REPO_ROOT } from "../lib/paths";

const CACHE_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 6_000;

/** CI 저장소는 TEAM_CI_REPO, 설치본 git origin 순으로 찾는다. 둘 다 유효하지 않으면 추측하거나 요청하지 않고 미설정으로 둔다. */
/** GitHub 이 실제로 허용하는 모양만 받는다. 여기서 넓히면 그대로 요청 URL 이 된다. */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]+$/;

/** `owner/repo` 두 조각이 GitHub 이름 규칙에 맞나. 아니면 null(추측하지 않는다). */
export function normalizeRepoSlug(owner: string, repo: string): string | null {
  const r = repo.replace(/\.git$/i, "");
  if (!OWNER_RE.test(owner) || !REPO_RE.test(r)) return null;
  if (r === "." || r === "..") return null;
  return `${owner}/${r}`;
}

export function parseRepoFromRemote(url: string): string | null {
  const t = url.trim();
  if (!t) return null;

  // GitHub가 아닌 원격에 기능이 켜지지 않도록 호스트를 파싱해 정확히 비교한다. 접두·접미·경로의 부분일치는 허용하지 않는다.
  const host = (h: string): boolean => h.toLowerCase().replace(/\.$/, "") === "github.com";

  // ① scp 형식: [user@]host:owner/repo(.git)   스킴이 없을 때만 (ssh:// 는 ②가 본다)
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    const m = t.match(/^(?:[^@\s/]+@)?([^:/\s]+):([^/\s]+)\/([^/\s]+?)\/?$/);
    if (m) {
      const [, h, owner, repo] = m;
      return h && host(h) && owner && repo ? normalizeRepoSlug(owner, repo) : null;
    }
    return null;
  }

  // ② 스킴이 있는 형식: https:// · ssh:// · git://
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if (!host(u.hostname)) return null;
  // query·fragment는 경로로 보정하지 않고 거절한다. URL과 scp 형식 모두 같은 원격 식별 규칙을 적용한다.
  if (u.search || u.hash) return null;
  // 빈 조각도 실패다 — `acme//widgets` 를 filter 로 지우면 없던 주소를 정상으로 만든다.
  //   맨 끝 슬래시 하나만 흔한 표기라 허용한다.
  const path = u.pathname.replace(/\/$/, "");
  const seg = path.split("/").slice(1); // 맨 앞은 항상 "" (pathname 은 / 로 시작)
  if (seg.length !== 2 || !seg[0] || !seg[1]) return null;
  return normalizeRepoSlug(seg[0], seg[1]);
}

/** 요청마다 프로세스를 띄우지 않도록 .git/config를 직접 읽는다.
 * 워크트리의 .git은 파일이므로 gitdir과 commondir를 따라 공유 config를 찾는다. */
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
  if (env) {
    // 저장소 이름은 API 경로에 들어가므로 query·fragment나 임의 경로가 섞이지 않게 이름 형식을 제한한다.
    const parts = env.split("/");
    return parts.length === 2 ? normalizeRepoSlug(parts[0]!, parts[1]!) : null;
  }
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
  /** 설정 자체가 안 된 상태 — 실패가 아니다. GitHub 을 안 쓰는 설치본의 정상 상태이므로
   *  화면이 빨간 오류가 아니라 중립으로 그려야 한다(false 일 때만 실린다). */
  configured?: boolean;
}

/** resetMs는 epoch 밀리초이며, DB 시각 문자열을 뜻하는 ...At/..._at와 구분하기 위해 단위를 이름에 쓴다. */
export class RateLimitedError extends Error {
  constructor(public resetMs: number, message: string) {
    super(message);
    this.name = "RateLimitedError";
  }
}

/** 상류 응답이 우리가 아는 모양이 아닐 때. 빈 배열로 삼키지 않기 위해 오류로 올린다. */
export class MalformedUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedUpstreamError";
  }
}

/** 403은 권한 오류일 수도 있으므로 x-ratelimit-remaining: 0일 때만 한도로 판단한다.
 * 재시도 시각은 retry-after 초, x-ratelimit-reset epoch 초, 기본 백오프 순으로 구한다. */
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

/** workflow_runs가 배열이 아니면 오류를 던진다. 빈 목록으로 바꾸면 상류 오류와 실제 실행 0건을 구분할 수 없다. */
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
  /** 테스트 주입용 — 주변 git 설정에 결과가 달라지면 안 된다. 기본은 실제 해석기. */
  ciRepo?: () => string | null;
}): Hono {
  const app = new Hono();
  const now = deps?.now ?? (() => Date.now());
  const ciRepo = deps?.ciRepo ?? (() => resolveCiRepo());
  let cache: { at: number; body: CiStatusBody } | null = null;
  /** single-flight — 진행중인 요청. 동시 요청은 이걸 함께 기다린다(추가 호출 0). */
  let inFlight: Promise<CiRun[]> | null = null;
  /** 한도에 걸린 동안은 이 시각까지 아예 안 나간다. */
  let blockedUntil = 0;

  const defaultFetch = async (): Promise<unknown> => {
    const repo = ciRepo();
    // 여기 오면 안 된다 — 핸들러가 미설정을 먼저 걸러낸다. 방어적으로 한 번 더 막는다.
    if (!repo) throw new Error(CI_UNCONFIGURED_REASON);
    const res = await fetch(runsUrl(repo), {
      headers: {
        accept: "application/vnd.github+json",
        // 버전을 고정한다 — 안 보내면 GitHub 이 기본값을 바꿀 때 응답 모양이 조용히 달라진다.
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
    // 미설정이면 네트워크를 아예 안 탄다. 캐시보다도 앞이다 — 켜지지도 않은 기능이
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
    // 한도로 쉬는 중 — 호출하지 않고 즉시 답한다. (초록으로 위장하지는 않는다)
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
      // 진행중인 요청이 있으면 새로 부르지 않고 그것을 기다린다.
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
      // 일시 오류와 낡은 성공값은 캐시하지 않는다. 한도 초과만 리셋 시각을 기억해 차단 중 추가 요청을 막는다.
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
