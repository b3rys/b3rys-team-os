/** 팀원 소유 브리지에서 그룹 턴을 받아야 프로세스별 clientPool이 중복 app-server와 동시 resume를 만들지 않는다.
 * 폴링 offset이 없는 입구이므로 messageId로 멱등 처리한다. 직렬 큐만으로는 중복 실행을 막지 못하며 202는 답이 아닌 접수다. */
import { createServer, type Server } from "node:http";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { writeFileSync, renameSync, rmSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** bridge window 가 받는 한 건. capture 가 정한 것만 담는다 — 브리지는 오너 판정을 하지 않는다. */
export interface BridgeWindowRequest {
  agentId: string;
  groupId: string;
  threadId: string;
  messageId: string;
  body: string;
  origTgMessageId?: string;
  teamContext?: string;
  attachments?: { kind: string; value: string; note?: string }[];
  /**
   * 없으면 그룹 턴(기존). "greeting" = 막 만든 팀원의 첫 인사 — 브리지가 평소 1:1 처리로 팀장 방(groupId)에 답한다.
   * 브리지가 돌고 있다는 증거가 이 인사라서, 서버가 대신 쓰지 않고 이 창구로 넣는다.
   */
  kind?: "greeting";
}

/**
 * 제어 신호 한 건 — 턴이 아니다. 턴 직렬 큐에 넣지 않고 바로 처리한다(승인 대기 중인 턴 뒤에 결정이 줄 서면 서로 기다린다).
 * 받는 쪽은 이 값으로 실행하지 않는다 — DB 를 다시 읽는 계기일 뿐이다. 그래서 중복·역순·유실이 안전하다.
 */
export interface BridgeControlRequest {
  agentId: string;
  kind: "cogs_permission";
  /** 보내는 쪽이 붙이는 전달 식별자(로그용). 승인 요청 id 와 다른 값이다. */
  eventId: string;
  /** 바뀐 승인 요청. 없으면 그 팀원의 대기 전부를 다시 본다(정책 변경·서버 재시작). */
  requestId?: string;
}

/** bridge window 파일에 적히는 것. 토큰은 이 파일 밖으로 나가지 않는다 — 로그·audit·에러에 안 싣는다. */
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
 * 파일 경로는 pid 파일 옆이다 — 브리지가 이미 그 자리에 자기 표식을 쓴다.
 * `CODEX_BRIDGE_PID_FILE` 이 없으면 bridge window 를 열 자리가 없다는 뜻이라 null 을 준다.
 */
export function windowFilePathFor(pidFile: string | undefined, agentId: string): string | null {
  if (!pidFile) return null;
  return join(dirname(pidFile), `${agentId}.window.json`);
}

/**
 * 임시파일 → rename 으로 원자 교체. 반쯤 쓰인 파일을 서버가 읽는 일이 없어야 한다.
 * 권한은 0600 — 같은 기계의 다른 사용자가 토큰을 읽으면 안 된다.
 */
export function writeWindowFile(path: string, data: BridgeWindowFile): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, path);
}

/** 브리지 재시작 때 포트가 바뀌므로 호출마다 window 파일을 다시 읽는다. 캐시하면 종료된 포트로 보내 전달이 누락된다. */
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

/** 토큰 → content-type → 상한 → JSON 객체. /turn·/control 이 같이 쓴다. */
function decideEnvelope(
  req: unknown,
  opts: { presentedToken: string | null; expectedToken: string; contentType: string | null; byteLength: number },
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
  return { accept: true };
}

/**
 * 요청을 받을지 판정한다. 순수 함수라 서버 없이 잴 수 있다.
 * 거절 사유를 문자열로 돌려준다 — 토큰 값은 절대 담지 않는다.
 */
export function decideWindowRequest(
  req: Partial<BridgeWindowRequest> | null,
  opts: { selfAgentId: string; presentedToken: string | null; expectedToken: string; contentType: string | null; byteLength: number },
): { accept: true } | { accept: false; status: number; reason: string } {
  const head = decideEnvelope(req, opts);
  if (!head.accept) return head;
  req = req!;
  for (const k of ["agentId", "groupId", "threadId", "messageId", "body"] as const) {
    if (typeof req[k] !== "string" || !(req[k] as string).trim()) {
      return { accept: false, status: 400, reason: `missing_${k}` };
    }
  }
  // 남의 신원으로 도는 것을 막는다 — 이 bridge window는 자기 팀원 것만 받는다.
  if (req.agentId !== opts.selfAgentId) return { accept: false, status: 403, reason: "agent_mismatch" };
  if (req.kind !== undefined && req.kind !== "greeting") return { accept: false, status: 400, reason: "bad_kind" };
  return { accept: true };
}

/** 제어 신호 판정. 인증·형식·상한은 /turn 과 같은 함수로 본다. */
export function decideControlRequest(
  req: Partial<BridgeControlRequest> | null,
  opts: { selfAgentId: string; presentedToken: string | null; expectedToken: string; contentType: string | null; byteLength: number },
): { accept: true } | { accept: false; status: number; reason: string } {
  const head = decideEnvelope(req, opts);
  if (!head.accept) return head;
  for (const k of ["agentId", "eventId"] as const) {
    if (typeof req![k] !== "string" || !(req![k] as string).trim()) return { accept: false, status: 400, reason: `missing_${k}` };
  }
  if (req!.agentId !== opts.selfAgentId) return { accept: false, status: 403, reason: "agent_mismatch" };
  if (req!.kind !== "cogs_permission") return { accept: false, status: 400, reason: "bad_kind" };
  if (req!.requestId !== undefined && (typeof req!.requestId !== "string" || !/^prm_[a-f0-9]+$/.test(req!.requestId))) {
    return { accept: false, status: 400, reason: "bad_requestId" };
  }
  return { accept: true };
}

/**
 * messageId 로 중복을 막는다. 진행중과 최근 완료를 같이 본다 —
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
  /** 턴을 큐에 넣는다. 기다리지 않는다 — bridge window 는 접수(202)까지만 책임진다. */
  enqueue: (req: BridgeWindowRequest) => void;
  /** 제어 신호. 없으면 /control 은 404. 큐를 거치지 않고 바로 부른다 — 오래 걸리는 일을 여기서 하지 않는다. */
  onControl?: (req: BridgeControlRequest) => void;
  log?: (line: string) => void;
  now?: () => number;
}

export interface BridgeWindowHandle {
  port: number;
  close: () => void;
}

/**
 * bridge window 를 연다. 127.0.0.1 에만 붙는다 — 밖에서 이 bridge window에 닿을 수 없어야 한다.
 * 열지 못하면 null 을 준다(bridge window 없이도 1:1 은 그대로 돈다 — bridge window 실패가 브리지를 죽이지 않는다).
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
      const isControl = req.url === "/control" && deps.onControl !== undefined;
      if (req.method !== "POST" || (req.url !== "/turn" && !isControl)) return reject(404, "not_found");
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
      const opts = {
        selfAgentId: deps.agentId,
        presentedToken: (req.headers["x-b3os-token"] as string | undefined) ?? null,
        expectedToken: token,
        contentType: (req.headers["content-type"] as string | undefined) ?? null,
        byteLength: raw.length,
      };
      if (isControl) {
        const v = decideControlRequest(parsed as Partial<BridgeControlRequest> | null, opts);
        if (!v.accept) {
          deps.log?.(`[codex-bridge] 제어 거절: ${v.reason}`);
          return reject(v.status, v.reason);
        }
        deps.onControl!(parsed as unknown as BridgeControlRequest);
        // 200 = 받아서 다시 보기를 시작했다. 결정이 실행됐다는 뜻이 아니다.
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true }));
      }
      const verdict = decideWindowRequest(parsed, opts);
      if (!verdict.accept) {
        // 거절 사유는 남기되 토큰은 안 남긴다.
        deps.log?.(`[codex-bridge] 창구 거절: ${verdict.reason}`);
        return reject(verdict.status, verdict.reason);
      }
      const body = parsed as BridgeWindowRequest;
      if (!dedupe.admit(body.messageId, now())) {
        // 이미 받은 것 — 큐에 두 번 넣지 않는다. 200 으로 "이미 접수" 를 알린다.
        deps.log?.(`[codex-bridge] 창구 중복 무시: msg=${body.messageId}`);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, duplicate: true }));
      }
      deps.enqueue(body);
      // 202 = 큐에 넣었다. 턴이 끝났다는 뜻도, 답이 갔다는 뜻도 아니다.
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

  // 파일을 못 쓰면 bridge window 를 연 채로 두지 않는다.
  //   파일이 없으면 부르는 쪽이 이 포트를 알 수 없으니 아무도 못 부르는 리스너 가 남는다.
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
        // 자기 것만 지운다 — 다른 인스턴스가 이미 덮어썼으면 그건 그쪽 파일이다.
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

/** 그룹 턴은 자동 발신을 끈 deps와 명시적 답 파일 작성 지침을 함께 만든다. 한쪽만 적용하면 답이 누락되거나 두 번 발신된다. */
export function groupTurnCall<T extends { sendMessage?: unknown; editMessage?: unknown }>(
  deps: T,
  input: { body: string; threadId: string; messageId: string; replyPath: string },
): { deps: T; body: string } {
  return { deps: noAutopostDeps(deps), body: groupTurnBody(input) };
}

/**
 * 발신을 떼어낸 deps. `groupTurnCall` 안에서만 쓴다 — 밖으로 내보내지 않는다.
 * 리액션은 떼지 않는다 — "그 팀원이 받았다" 는 사람이 보는 신호이고 발신과 다른 값이다.
 */
function noAutopostDeps<T extends { sendMessage?: unknown; editMessage?: unknown }>(deps: T): T {
  return { ...deps, sendMessage: async () => null, editMessage: async () => false };
}

/** 답 본문은 셸 명령에 넣지 않고 파일로 쓰게 해 따옴표·백틱·heredoc 종료자가 해석되지 않게 한다.
 * 현재 never는 셸에도 승인창이 없으므로 이 선택의 근거는 승인 회피가 아니라 본문 인용의 보존이다. */
function groupTurnBody(input: {
  body: string;
  threadId: string;
  messageId: string;
  replyPath: string;
}): string {
  return [
    input.body,
    "",
    `(그룹방 메시지 · thread=${input.threadId} · in-reply-to=${input.messageId})`,
    "",
    "★답은 아래 파일에 써야 방에 전달된다.★ 이 턴의 본문은 아무 데도 안 간다 —",
    "서버가 대신 게시하지 않는다. 답할 내용을 ★파일 쓰기 도구로★ 이 경로에 쓴다:",
    "",
    `  ${input.replyPath}`,
    "",
    "★셸 명령을 실행하지 마라★ — 보내는 일은 브리지가 한다. 파일만 쓰면 방에 올라간다.",
    "★안 쓰면 안 나간다★ — 답할 차례가 아니라고 판단하면 그냥 쓰지 마라. 그것도 정상이다.",
    "파일에는 ★방에 그대로 올라갈 본문만★ 쓴다(설명·따옴표·코드펜스로 감싸지 않는다).",
  ].join("\n");
}
