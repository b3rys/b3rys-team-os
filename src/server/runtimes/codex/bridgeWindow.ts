/**
 * ★브리지의 로컬 창구.★ 서버(telegramCapture)가 그룹 턴을 이 창구로 넣는다.
 *
 * 왜 브리지인가 — 다른 런타임과 같은 모양이다. openclaw·hermes 도 서버가 턴을 도는 게 아니라
 * ★런타임을 소유한 프로세스★ 를 부른다(`OPENCLAW_GATEWAY_URL`). codex 에서 그 자리는 브리지다.
 * 서버가 따로 돌리면 `clientPool` 이 ★모듈 전역(프로세스마다 따로)★ 이라 같은 팀원에 app-server
 * 자식이 둘 뜨고, 같은 세션 행을 동시에 resume 한다(`serialTurnQueue` 주석의 그 사고).
 *
 * ★이 창구는 자기 폴링을 안 지나는 새 입구다★ — 브리지의 중복 방지(update_id offset)가 여기엔
 * 없다. 그래서 ★messageId 를 멱등키로 여기서 직접 막는다★ (리뷰 지적). 막지 않으면 같은 요청이
 * 두 번 들어올 때 큐가 ★겹치지 않게 하지만 두 번 돌린다★ = dex 가 두 번 답한다.
 *
 * ★202 는 "접수" 지 "답했다" 가 아니다.★ 턴 결과와 배달은 이 응답에 실리지 않는다 —
 * 답은 팀원이 `send.sh` 로 직접 보낸다(서버는 팀원 대신 말하지 않는다).
 */
import { createServer, type Server } from "node:http";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { writeFileSync, renameSync, rmSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 창구가 받는 한 건. capture 가 정한 것만 담는다 — 브리지는 오너 판정을 하지 않는다. */
export interface BridgeWindowRequest {
  agentId: string;
  groupId: string;
  threadId: string;
  messageId: string;
  body: string;
  origTgMessageId?: string;
  teamContext?: string;
  attachments?: { kind: string; value: string; note?: string }[];
}

/** 창구 파일에 적히는 것. ★토큰은 이 파일 밖으로 나가지 않는다★ — 로그·audit·에러에 안 싣는다. */
export interface BridgeWindowFile {
  port: number;
  token: string;
  pid: number;
  agentId: string;
}

/** 본문 상한 — 입구에서 자른다(그룹 메시지에 첨부 목록까지 실려도 넉넉하다). */
export const WINDOW_BODY_LIMIT_BYTES = 256 * 1024;

/** 멱등 기억을 얼마나 들고 있나. 재시도·중복 요청은 이 창 안에서만 오면 막힌다. */
export const WINDOW_DEDUPE_TTL_MS = 10 * 60 * 1000;

/**
 * ★파일 경로는 pid 파일 옆이다★ — 브리지가 이미 그 자리에 자기 표식을 쓴다.
 * `CODEX_BRIDGE_PID_FILE` 이 없으면 창구를 열 자리가 없다는 뜻이라 null 을 준다.
 */
export function windowFilePathFor(pidFile: string | undefined, agentId: string): string | null {
  if (!pidFile) return null;
  return join(dirname(pidFile), `${agentId}.window.json`);
}

/**
 * ★임시파일 → rename 으로 원자 교체.★ 반쯤 쓰인 파일을 서버가 읽는 일이 없어야 한다.
 * 권한은 0600 — 같은 기계의 다른 사용자가 토큰을 읽으면 안 된다.
 */
export function writeWindowFile(path: string, data: BridgeWindowFile): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * 창구 파일을 읽는다. ★부르는 쪽은 매 호출 전에 다시 읽는다★ — 브리지가 재시작하면 포트가
 * 바뀌는데 캐시하고 있으면 ★조용히 안 간다★(리뷰 지적).
 */
export function readWindowFile(path: string): BridgeWindowFile | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<BridgeWindowFile>;
    if (typeof raw.port !== "number" || !Number.isInteger(raw.port) || raw.port <= 0) return null;
    if (typeof raw.token !== "string" || raw.token.length < 16) return null;
    if (typeof raw.pid !== "number" || !Number.isInteger(raw.pid)) return null;
    if (typeof raw.agentId !== "string" || !raw.agentId) return null;
    return { port: raw.port, token: raw.token, pid: raw.pid, agentId: raw.agentId };
  } catch {
    return null;
  }
}

/** 길이가 달라도 상수 시간에 비교한다 — 길이만으로 토큰을 좁히지 못하게. */
export function tokensMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    // 길이가 다르면 어차피 불일치지만, 그 사실만으로 빠르게 반환하지 않는다.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/**
 * ★요청을 받을지 판정한다.★ 순수 함수라 서버 없이 잴 수 있다.
 * 거절 사유를 문자열로 돌려준다 — ★토큰 값은 절대 담지 않는다.★
 */
export function decideWindowRequest(
  req: Partial<BridgeWindowRequest> | null,
  opts: { selfAgentId: string; presentedToken: string | null; expectedToken: string; contentType: string | null; byteLength: number },
): { accept: true } | { accept: false; status: number; reason: string } {
  if (!opts.presentedToken || !tokensMatch(opts.presentedToken, opts.expectedToken)) {
    return { accept: false, status: 401, reason: "bad_token" };
  }
  if (!opts.contentType || !opts.contentType.toLowerCase().startsWith("application/json")) {
    return { accept: false, status: 415, reason: "bad_content_type" };
  }
  if (opts.byteLength > WINDOW_BODY_LIMIT_BYTES) {
    return { accept: false, status: 413, reason: "body_too_large" };
  }
  if (!req || typeof req !== "object") return { accept: false, status: 400, reason: "bad_json" };
  for (const k of ["agentId", "groupId", "threadId", "messageId", "body"] as const) {
    if (typeof req[k] !== "string" || !(req[k] as string).trim()) {
      return { accept: false, status: 400, reason: `missing_${k}` };
    }
  }
  // ★남의 신원으로 도는 것을 막는다★ — 이 창구는 자기 팀원 것만 받는다.
  if (req.agentId !== opts.selfAgentId) return { accept: false, status: 403, reason: "agent_mismatch" };
  return { accept: true };
}

/**
 * ★messageId 로 중복을 막는다.★ 진행중과 최근 완료를 같이 본다 —
 * 끝난 직후 다시 오는 재시도도 같은 턴을 두 번 돌리면 안 된다.
 */
export class WindowDedupe {
  private seen = new Map<string, number>();
  constructor(private readonly ttlMs = WINDOW_DEDUPE_TTL_MS) {}

  /** 처음 보는 것이면 true(받는다). 이미 본 것이면 false. */
  admit(messageId: string, nowMs: number): boolean {
    this.sweep(nowMs);
    if (this.seen.has(messageId)) return false;
    this.seen.set(messageId, nowMs);
    return true;
  }

  private sweep(nowMs: number): void {
    for (const [id, at] of this.seen) if (nowMs - at > this.ttlMs) this.seen.delete(id);
  }
}

export interface BridgeWindowDeps {
  agentId: string;
  pidFile: string | undefined;
  /** 턴을 큐에 넣는다. ★기다리지 않는다★ — 창구는 접수(202)까지만 책임진다. */
  enqueue: (req: BridgeWindowRequest) => void;
  log?: (line: string) => void;
  now?: () => number;
}

export interface BridgeWindowHandle {
  port: number;
  close: () => void;
}

/**
 * 창구를 연다. ★127.0.0.1 에만 붙는다★ — 밖에서 이 창구에 닿을 수 없어야 한다.
 * 열지 못하면 null 을 준다(창구 없이도 1:1 은 그대로 돈다 — 창구 실패가 브리지를 죽이지 않는다).
 */
export async function startBridgeWindow(deps: BridgeWindowDeps): Promise<BridgeWindowHandle | null> {
  const filePath = windowFilePathFor(deps.pidFile, deps.agentId);
  if (!filePath) {
    deps.log?.("[codex-bridge] 창구 못 엶: pid 파일 경로가 없다");
    return null;
  }
  const token = randomBytes(32).toString("hex");
  const dedupe = new WindowDedupe();
  const now = deps.now ?? (() => Date.now());

  const server: Server = createServer((req, res) => {
    void (async () => {
      const reject = (status: number, reason: string) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason }));
      };
      if (req.method !== "POST" || req.url !== "/turn") return reject(404, "not_found");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > WINDOW_BODY_LIMIT_BYTES) return reject(413, "body_too_large");
        chunks.push(c as Buffer);
      }
      const raw = Buffer.concat(chunks);
      let parsed: Partial<BridgeWindowRequest> | null = null;
      try {
        parsed = JSON.parse(raw.toString("utf8")) as Partial<BridgeWindowRequest>;
      } catch {
        parsed = null;
      }
      const verdict = decideWindowRequest(parsed, {
        selfAgentId: deps.agentId,
        presentedToken: (req.headers["x-b3os-token"] as string | undefined) ?? null,
        expectedToken: token,
        contentType: (req.headers["content-type"] as string | undefined) ?? null,
        byteLength: raw.length,
      });
      if (!verdict.accept) {
        // ★거절 사유는 남기되 토큰은 안 남긴다.★
        deps.log?.(`[codex-bridge] 창구 거절: ${verdict.reason}`);
        return reject(verdict.status, verdict.reason);
      }
      const body = parsed as BridgeWindowRequest;
      if (!dedupe.admit(body.messageId, now())) {
        // 이미 받은 것 — ★큐에 두 번 넣지 않는다.★ 200 으로 "이미 접수" 를 알린다.
        deps.log?.(`[codex-bridge] 창구 중복 무시: msg=${body.messageId}`);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, duplicate: true }));
      }
      deps.enqueue(body);
      // ★202 = 큐에 넣었다.★ 턴이 끝났다는 뜻도, 답이 갔다는 뜻도 아니다.
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, queued: true }));
    })().catch(() => {
      try {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "window_error" }));
      } catch {
        /* 응답 실패가 브리지를 죽이지 않는다 */
      }
    });
  });

  const port = await new Promise<number | null>((resolve) => {
    server.once("error", () => resolve(null));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : null);
    });
  });
  if (port === null) {
    deps.log?.("[codex-bridge] 창구 못 엶: listen 실패");
    return null;
  }

  // ★파일을 못 쓰면 창구를 연 채로 두지 않는다★ (리뷰 지적).
  //   파일이 없으면 부르는 쪽이 이 포트를 알 수 없으니 ★아무도 못 부르는 리스너★ 가 남는다.
  //   그런 리스너는 프로세스를 붙잡고 있어 종료도 방해한다. 열었으면 닫고 실패로 돌려준다.
  try {
    writeWindowFile(filePath, { port, token, pid: process.pid, agentId: deps.agentId });
  } catch (e) {
    try {
      server.close();
    } catch {
      /* 닫기 실패가 이 실패를 가리지 않는다 */
    }
    deps.log?.(`[codex-bridge] 창구 못 엶: 파일 기록 실패(${(e as Error).message})`);
    return null;
  }
  deps.log?.(`[codex-bridge] 창구 열림 127.0.0.1:${port} (${filePath})`);

  return {
    port,
    close: () => {
      try {
        // ★자기 것만 지운다★ — 다른 인스턴스가 이미 덮어썼으면 그건 그쪽 파일이다.
        const cur = readWindowFile(filePath);
        if (cur && cur.pid === process.pid) rmSync(filePath, { force: true });
      } catch {
        /* 정리 실패가 종료를 막지 않는다 */
      }
      try {
        server.close();
      } catch {
        /* noop */
      }
    },
  };
}

/**
 * ★그룹 턴의 본문 — 답을 어디로 보낼지 함께 준다.★
 *
 * 서버는 팀원 대신 말하지 않는다(hermes 와 같은 계약). 턴 본문은 ★그 팀원의 메모★ 이고,
 * 방에 말하려면 팀원이 ★직접★ `send.sh --to broadcast` 를 불러야 한다 —
 * 그래야 버스에 남고, 거기서 방으로 릴레이된다. ★보낸 것만 말한 것이다.★
 *
 * 이 문장이 없으면 턴은 돌지만 ★답이 아무 데도 안 간다★(자동 게시를 막았으므로).
 */
export function groupTurnBody(input: {
  repoRoot: string;
  body: string;
  threadId: string;
  messageId: string;
}): string {
  const send = `${input.repoRoot}/skills/b3os-team-inbox/scripts/send.sh`;
  return [
    input.body,
    "",
    `(그룹방 메시지 · thread=${input.threadId} · in-reply-to=${input.messageId})`,
    "",
    "★답은 이 명령으로 보내야 전달된다.★ 이 턴의 본문은 아무 데도 안 간다 —",
    "서버가 대신 게시하지 않는다. 끝에 최종 답으로 한 번 실행하라:",
    `${send} --to broadcast --thread ${input.threadId} --in-reply-to ${input.messageId} --body '<답>'`,
  ].join("\n");
}
