// GET /api/monitoring — 모니터링 탭 read-only 집계 (GD 2026-07-10, Bill 핸드오프).
//   새 쓰기 0, 새 probe 0. 서버측 15초 캐시로 요청마다 로그/db 풀조회 방지(부하0).
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { readLivenessStatus, readDmHealth, readHermesRuntimeHealth, readOpenClawTelegramIngressStatus, readHopMetrics } from "../lib/monitoringStatus";

interface MonitoringDeps {
  db: Database;
}

const CACHE_MS = 15_000;

export function createMonitoringRoutes(deps: MonitoringDeps): Hono {
  const app = new Hono();
  let cache: { at: number; body: Record<string, unknown> } | null = null;

  app.get("/monitoring", (c) => {
    const now = Date.now();
    if (cache && now - cache.at < CACHE_MS) {
      return c.json({ ...cache.body, cached: true });
    }
    const body = {
      liveness: readLivenessStatus(),
      dmHealth: readDmHealth(deps.db),
      hermes: readHermesRuntimeHealth(deps.db),
      ingress: readOpenClawTelegramIngressStatus(deps.db),
      hopMetrics: readHopMetrics(deps.db),
      generatedAt: new Date().toISOString(),
      cacheMs: CACHE_MS,
    };
    cache = { at: now, body };
    return c.json({ ...body, cached: false });
  });

  return app;
}
