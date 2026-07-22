// slackSocket — Slack Socket Mode 수신 런타임.
// mode=socket인 에이전트별로 apps.connections.open으로 outbound wss를 열고, 들어오는
// events_api(app_mention)를 기존 handleAppMention 파이프(웹훅과 동일)에 흘린다.
// 끊기면 지수 백오프 재연결. webhook과 병행 가능 — handleAppMention 내부 dedupe(60s)가 중복 흡수.
//
// 프로토콜(Slack Socket Mode):
//   1) POST apps.connections.open (Authorization: Bearer xapp-…) → { ok, url(wss) }
//   2) wss 연결 → {type:"hello"} 수신 시 연결 확정
//   3) {type:"events_api", envelope_id, payload} 수신 → 즉시 {envelope_id} ACK(3초 내) → payload.event 처리
//   4) {type:"disconnect"} 또는 close/error → 재연결
// app token(xapp-)에는 connections:write scope 필요. bot token(xoxb)은 chat.postMessage용으로 별도.
import type { Database } from "bun:sqlite";
import { loadAgentCreds } from "../lib/slack";
import { appendAudit } from "../db/queries";
import { handleAppMention, type SlackEvent } from "../routes/slack";
import type { AgentRecord, WsEvent } from "../types";

interface Deps {
  db: Database;
  broadcast: (e: WsEvent) => void;
  agents: () => AgentRecord[];
}

const ENABLED = (process.env.TEAM_SLACK_SOCKET_ENABLED ?? "1") !== "0";
const RECONCILE_MS = Number(process.env.TEAM_SLACK_SOCKET_RECONCILE_MS ?? 15_000);
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
// 토큰 갱신 전엔 안 풀리는 오류 — 무한재시도 대신 중단+에스컬레이션(TEAM-OS stop_rule). 토큰 변경 시 reconcile가 재생성.
// missing_scope/no_permission은 제외 — 토큰 변경 없이 Slack 설정에서 고칠 수 있어 transient로 두고 재시도 지속(설정 수정 시 자동 복구). (Demis/하네스 재검증)
const PERMANENT_AUTH_ERRORS = new Set([
  "invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired",
]);

interface SlackSocketMessage {
  type?: string;
  envelope_id?: string;
  reason?: string;
  payload?: { type?: string; event?: SlackEvent };
}

interface Conn {
  ws: WebSocket | null;
  appToken: string;
  backoff: number;
  stopped: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  lastOpenError: string | null; // 같은 open 실패 반복 시 audit 1회만(영구 실패 audit 폭증 방지)
}

/** 소켓 연결 대상 판정(순수·테스트용) — mode=socket이고 app_token+bot_token 둘 다 있어야. webhook·토큰부족 에이전트는 제외(먹통 방지: webhook은 그대로 동작). */
export function socketEligible(
  agent: { slack_connection_mode?: string | null },
  creds: { app_token?: string | null; bot_token?: string | null } | null,
): boolean {
  return agent.slack_connection_mode === "socket" && !!creds?.app_token && !!creds?.bot_token;
}

export function startSlackSocket(deps: Deps): () => void {
  if (!ENABLED) {
    console.log("[slack-socket] disabled (TEAM_SLACK_SOCKET_ENABLED=0)");
    return () => {};
  }

  const conns = new Map<string, Conn>();

  // mode=socket이고 app_token+bot_token이 모두 있는 에이전트.
  const wantSocketAgents = (): { id: string; appToken: string }[] => {
    const out: { id: string; appToken: string }[] = [];
    for (const a of deps.agents()) {
      const creds = loadAgentCreds(a.id);
      if (socketEligible(a, creds)) out.push({ id: a.id, appToken: creds!.app_token! });
    }
    return out;
  };

  const scheduleReconnect = (agentId: string, conn: Conn): void => {
    if (conn.stopped || conn.reconnectTimer) return;
    const base = Math.min(conn.backoff || BASE_BACKOFF_MS, MAX_BACKOFF_MS);
    const jitter = Math.floor(Math.random() * 0.3 * base); // 0~30% jitter — Slack 장애 시 전 에이전트 lockstep 재연결(thundering herd) 완화
    conn.backoff = Math.min((conn.backoff || BASE_BACKOFF_MS) * 2, MAX_BACKOFF_MS);
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      void openConnection(agentId, conn);
    }, base + jitter);
  };

  const openConnection = async (agentId: string, conn: Conn): Promise<void> => {
    if (conn.stopped) return;
    try {
      const res = await fetch("https://slack.com/api/apps.connections.open", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${conn.appToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });
      const data = (await res.json()) as { ok: boolean; url?: string; error?: string };
      if (!data.ok || !data.url) {
        const err = data.error ?? "unknown";
        console.warn(`[slack-socket] ${agentId} apps.connections.open 실패: ${err}`);
        if (err !== conn.lastOpenError) { // 동일 실패 반복은 audit 1회만(폭증 방지)
          appendAudit(deps.db, agentId, "slack_socket_open_failed", null, { error: err });
          conn.lastOpenError = err;
        }
        // 영구 인증오류는 재시도 무의미 → 중단+에스컬레이션. 토큰 갱신 시 reconcile가 재생성.
        if (PERMANENT_AUTH_ERRORS.has(err)) {
          console.warn(`[slack-socket] ${agentId} 영구 인증오류(${err}) — 재시도 중단. App Token 갱신 필요.`);
          appendAudit(deps.db, agentId, "slack_socket_gave_up", null, { error: err });
          conn.stopped = true;
          return;
        }
        scheduleReconnect(agentId, conn); // 일시적 오류는 백오프 재시도
        return;
      }
      // 핸드셰이크(await) 중 closeConn/reconcile로 종료·해제됐으면 소켓 열지 않는다(누수·유령 수신 방지).
      if (conn.stopped) return;

      const ws = new WebSocket(data.url);
      conn.ws = ws;

      ws.addEventListener("open", () => {
        console.log(`[slack-socket] ${agentId} wss open`);
      });

      ws.addEventListener("message", (ev: MessageEvent) => {
        if (conn.stopped) { try { ws.close(); } catch { /* noop */ } return; } // 해제된 연결은 수신 처리 안 함(이중 안전망)
        let msg: SlackSocketMessage;
        try {
          msg = JSON.parse(typeof ev.data === "string" ? ev.data : "") as SlackSocketMessage;
        } catch {
          return;
        }
        if (!msg || typeof msg !== "object") return;

        if (msg.type === "hello") {
          conn.backoff = 0; // 연결 확정 — 백오프 리셋
          conn.lastOpenError = null; // 성공했으니 다음 실패는 다시 audit
          console.log(`[slack-socket] ${agentId} connected (hello)`);
          appendAudit(deps.db, agentId, "slack_socket_connected", null, {});
          return;
        }

        if (msg.type === "disconnect") {
          console.log(`[slack-socket] ${agentId} disconnect: ${msg.reason}`);
          try {
            ws.close();
          } catch {
            /* close handler reconnects */
          }
          return;
        }

        if (msg.type === "events_api" && msg.envelope_id) {
          // ACK 먼저 (3초 내 필수) — payload echo 불필요.
          try {
            ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
          } catch {
            /* best-effort ack */
          }
          const payload = msg.payload;
          if (payload?.type === "event_callback" && payload.event?.type === "app_mention") {
            console.log(`[slack-socket] ${agentId} ← app_mention (socket 수신, ch=${payload.event.channel ?? "?"})`);
            handleAppMention(
              { db: deps.db, broadcast: deps.broadcast, agents: deps.agents() },
              payload.event,
            ).catch((e) => console.warn(`[slack-socket] ${agentId} handleAppMention error: ${e}`));
          }
        }
      });

      ws.addEventListener("close", () => {
        conn.ws = null;
        if (conn.stopped) return;
        scheduleReconnect(agentId, conn);
      });

      ws.addEventListener("error", () => {
        console.warn(`[slack-socket] ${agentId} wss error`);
        try {
          ws.close(); // close 핸들러가 재연결 — 여기서 직접 schedule하지 않음(중복 방지)
        } catch {
          scheduleReconnect(agentId, conn);
        }
      });
    } catch (e) {
      console.warn(`[slack-socket] ${agentId} open 예외: ${e}`);
      scheduleReconnect(agentId, conn);
    }
  };

  const closeConn = (agentId: string): void => {
    const conn = conns.get(agentId);
    if (!conn) return;
    conn.stopped = true;
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    try {
      conn.ws?.close();
    } catch {
      /* best-effort */
    }
    conns.delete(agentId);
  };

  // mode=socket 집합과 현재 연결을 맞춘다(추가/제거). mode·토큰 변경을 재시작 없이 흡수.
  const reconcile = (): void => {
    const want = wantSocketAgents();
    const wantIds = new Set(want.map((w) => w.id));
    for (const id of [...conns.keys()]) {
      if (!wantIds.has(id)) {
        console.log(`[slack-socket] ${id} socket 해제 — 연결 종료`);
        closeConn(id);
      }
    }
    for (const w of want) {
      const existing = conns.get(w.id);
      if (existing && existing.appToken === w.appToken) continue; // 이미 같은 토큰으로 연결 중
      if (existing) { console.log(`[slack-socket] ${w.id} app_token 변경 — 재연결`); closeConn(w.id); } // 토큰 회전 → 끊고 새 토큰으로
      const conn: Conn = { ws: null, appToken: w.appToken, backoff: 0, stopped: false, reconnectTimer: null, lastOpenError: null };
      conns.set(w.id, conn);
      console.log(`[slack-socket] ${w.id} socket 시작`);
      void openConnection(w.id, conn);
    }
  };

  reconcile();
  const timer = setInterval(reconcile, RECONCILE_MS);

  return () => {
    clearInterval(timer);
    for (const id of [...conns.keys()]) closeConn(id);
    console.log("[slack-socket] stopped");
  };
}
