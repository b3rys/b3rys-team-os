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

const CACHE_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 6_000;
const RUNS_URL =
  "https://api.github.com/repos/b3rys/b3rys-team-os/actions/runs?per_page=10";

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
}): Hono {
  const app = new Hono();
  const now = deps?.now ?? (() => Date.now());
  let cache: { at: number; body: CiStatusBody } | null = null;
  /** ★single-flight★ — 진행중인 요청. 동시 요청은 이걸 함께 기다린다(추가 호출 0). */
  let inFlight: Promise<CiRun[]> | null = null;
  /** 한도에 걸린 동안은 이 시각까지 ★아예 안 나간다.★ */
  let blockedUntil = 0;

  const defaultFetch = async (): Promise<unknown> => {
    const res = await fetch(RUNS_URL, {
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
