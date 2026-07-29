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
import { Hono } from "hono";

const CACHE_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 6_000;
const RUNS_URL =
  "https://api.github.com/repos/b3rys/b3rys-team-os/actions/runs?per_page=10";

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
}

/** GitHub 응답 → 화면이 쓰는 최소 형태. 필드가 없으면 빈 문자열로 두고 ★추측하지 않는다.★ */
export function normalizeRuns(raw: unknown): CiRun[] {
  const runs = (raw as { workflow_runs?: unknown[] } | null)?.workflow_runs;
  if (!Array.isArray(runs)) return [];
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

  const defaultFetch = async (): Promise<unknown> => {
    const res = await fetch(RUNS_URL, {
      headers: { accept: "application/vnd.github+json", "user-agent": "b3os-dashboard" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`github ${res.status}`);
    return await res.json();
  };
  const fetchRuns = deps?.fetchRuns ?? defaultFetch;

  app.get("/ci-status", async (c) => {
    const t = now();
    if (cache && t - cache.at < CACHE_MS) {
      return c.json({ ...cache.body, cached: true });
    }
    try {
      const raw = await fetchRuns();
      const body: CiStatusBody = {
        ok: true,
        runs: normalizeRuns(raw),
        fetched_at: new Date(t).toISOString(),
        cached: false,
      };
      cache = { at: t, body };
      return c.json(body);
    } catch (e) {
      // ★실패를 캐시하지 않는다★ — 캐시하면 일시적 오류가 5분간 굳는다.
      //   그리고 ★직전 성공값을 대신 보여주지도 않는다★: 그러면 낡은 초록이 현재처럼 보인다.
      const body: CiStatusBody = {
        ok: false,
        reason: e instanceof Error ? e.message : String(e),
        runs: [],
        fetched_at: null,
        cached: false,
      };
      return c.json(body);
    }
  });

  return app;
}
