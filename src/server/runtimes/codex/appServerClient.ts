/**
 * codex app-server 클라이언트 (Phase B — dex=Claude 수준의 중간개입/팝업 기반).
 *
 * `codex app-server`를 자식 프로세스로 띄우고 newline-delimited JSON-RPC(stdio)로 대화한다.
 * exec 모드와 달리 ★턴 실행 중 인터럽트/steer + 위험행동 승인요청(팝업)★을 지원한다.
 *
 * 실측 검증(스파이크): initialize·thread/start·turn/start(스트리밍+응답)·turn/steer(expectedTurnId 필수)·
 * turn/interrupt(status=interrupted)·승인요청(execCommandApproval 등 ServerRequest). 전부 동작 확인.
 *
 * ★이 모듈은 순수 프로토콜 클라이언트다 — 팀 버스/permissionGate/텔레그램 배선은 상위(adapter)가 한다.★
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
const HANDSHAKE_TIMEOUT_MS = Number(process.env.B3OS_CODEX_APPSERVER_HANDSHAKE_MS ?? 45_000);

/** 승인요청(ServerRequest) — 상위가 permissionGate/OWNER 팝업으로 판정해 decision을 돌려준다. */
export interface ApprovalRequest {
  method: string; // execCommandApproval | applyPatchApproval | item/permissions/requestApproval | item/tool/requestUserInput ...
  params: Record<string, unknown>;
}
/** 승인 결정. codex ReviewDecision: approved(=이번만) | approved_for_session(=계속) | denied(=거절/이번만거절) | abort. */
export type ReviewDecision = "approved" | "approved_for_session" | "denied" | "abort";

export interface RunTurnHandlers {
  /** 스트리밍 델타(부분 응답 텍스트). */
  onDelta?: (text: string) => void;
  /** 턴 시작 알림(turnId 확보 — interrupt에 필요). */
  onTurnStarted?: (turnId: string) => void;
  /** 승인요청 → decision 반환(비동기). 미지정 시 기본 denied(fail-closed). */
  onApproval?: (req: ApprovalRequest) => Promise<ReviewDecision> | ReviewDecision;
  /** 임의 서버 알림 관찰(로깅/디버그). */
  onNotify?: (method: string, params: unknown) => void;
}

export interface TurnResult {
  finalText: string;
  status: string; // completed | interrupted | timeout | failed | error | rate_limited
  turnId: string | null;
  detail?: string; // 실패 사유(에러 응답/에러 notification/ stderr tail) — 상위가 로그·재시도 판단
}

export interface ThreadStartOptions {
  cwd?: string;
  model?: string;
  approvalPolicy?: string; // AskForApproval (예: on-request)
  sandbox?: string; // SandboxMode
  runtimeWorkspaceRoots?: string[];
  /** 있으면 thread/resume으로 이전 대화 이어감(멀티턴 맥락 유지, 정확성 #1). 실패 시 새 thread 폴백. */
  resumeThreadId?: string;
}

interface Pending { resolve: (v: any) => void; reject: (e: any) => void; method: string; }

export class CodexAppServerClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private threadId: string | null = null;
  private currentTurnId: string | null = null;
  private activeHandlers: RunTurnHandlers | null = null;
  private turnResolve: ((r: TurnResult) => void) | null = null;
  private closed = false;

  /** app-server 스폰 + initialize 핸드셰이크. */
  async start(): Promise<void> {
    const proc = spawn(CODEX_BIN, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    proc.stdout.on("data", (d) => this.onData(d.toString()));
    // ★견고성 #3: stderr를 버리지 말고 tail 보관 → 실패/타임아웃 시 detail에 실어 진단(rate-limit 텍스트가 여기 옴).★
    proc.stderr.on("data", (d) => { this.stderrTail = (this.stderrTail + d.toString()).slice(-2000); });
    proc.on("close", () => { this.closed = true; this.failAll(new Error("app-server closed")); });
    proc.on("error", (e) => { this.closed = true; this.failAll(e); });
    // ★정확성 #2 픽스: initialize에 타임아웃 — app-server 무응답 시 영구 hang 방지(exec 폴백 없음).★
    await this.withTimeout(this.request("initialize", {
      clientInfo: { name: "b3os-bridge", title: "b3os", version: "0.1" },
      capabilities: null,
    }), HANDSHAKE_TIMEOUT_MS, "initialize");
  }

  private withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => { this.close(); reject(new Error(`${what}_timeout after ${ms}ms`)); }, ms);
      p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }

  /** 대화(thread) 시작 → threadId 확보. */
  async startThread(opts: ThreadStartOptions = {}): Promise<string> {
    const params: Record<string, unknown> = {};
    if (opts.cwd) params.cwd = opts.cwd;
    if (opts.model) params.model = opts.model;
    if (opts.approvalPolicy) params.approvalPolicy = opts.approvalPolicy;
    if (opts.sandbox) params.sandbox = opts.sandbox;
    if (opts.runtimeWorkspaceRoots) params.runtimeWorkspaceRoots = opts.runtimeWorkspaceRoots;
    // ★정확성 #1: resumeThreadId 있으면 thread/resume으로 이전 맥락 이어감. 실패하면 새 thread 폴백(무맥락이라도 진행).★
    let id: string | undefined;
    if (opts.resumeThreadId) {
      try {
        const r = await this.withTimeout(this.request("thread/resume", { ...params, threadId: opts.resumeThreadId }), HANDSHAKE_TIMEOUT_MS, "thread/resume") as { thread?: { id?: string } };
        id = r?.thread?.id;
      } catch { /* resume 실패 → 아래 새 thread 폴백 */ }
    }
    if (!id) {
      const res = await this.withTimeout(this.request("thread/start", params), HANDSHAKE_TIMEOUT_MS, "thread/start") as { thread?: { id?: string } };
      id = res?.thread?.id;
    }
    if (!id) throw new Error("thread/start: no thread id");
    this.threadId = id;
    return id;
  }

  /**
   * 한 턴 실행 — 텍스트 입력 → 스트리밍/승인 처리 → 최종 텍스트.
   * ★견고성: timeoutMs 내 turn/completed 없으면 interrupt 후 status="timeout"으로 정리(무응답 턴이 런타임 막지 않게).★
   * exec 폴백이 없으므로(OWNER 방침) 예외는 여기서 정면 처리한다.
   */
  runTurn(text: string, handlers: RunTurnHandlers = {}, timeoutMs = 300_000): Promise<TurnResult> {
    if (!this.threadId) throw new Error("startThread first");
    this.activeHandlers = handlers;
    this.currentTurnId = null;
    this.lastFinal = "";
    this.deltaBuf = ""; // ★턴 경계 버퍼 리셋(이전 턴 텍스트 누출 방지)★
    return new Promise<TurnResult>((resolve) => {
      let settled = false;
      const finish = (r: TurnResult) => { if (settled) return; settled = true; this.clearTurnTimer(); this.turnResolve = null; this.activeHandlers = null; resolve(r); };
      // ★타이머를 인스턴스 필드로(pause/resume 가능) — 승인 팝업 대기 중엔 턴 타이머 정지(M5.3).★
      this.turnTimeoutMs = timeoutMs;
      this.armTurnTimer = () => setTimeout(() => {
        void this.interrupt().catch(() => {});
        finish({ finalText: this.lastFinal || this.deltaBuf, status: "timeout", turnId: this.currentTurnId, detail: [this.rateLimitTail, this.stderrTail ? `stderr: ${this.stderrTail.slice(-400)}` : ""].filter(Boolean).join(" | ") || undefined });
      }, this.turnTimeoutMs);
      this.turnTimer = this.armTurnTimer();
      this.turnResolve = finish;
      this.notify("turn/start", { threadId: this.threadId, input: [{ type: "text", text, text_elements: [] }] })
        .catch(() => finish({ finalText: "", status: "error", turnId: this.currentTurnId }));
    });
  }

  private clearTurnTimer(): void { if (this.turnTimer) { clearTimeout(this.turnTimer); this.turnTimer = null; } }
  /** ★M5.3: 승인 팝업 대기 시작 — 턴 타이머 정지(사람 대기 중엔 타임아웃 안 되게).★ */
  private pauseTurnTimer(): void { this.clearTurnTimer(); }
  /** ★M5.3: 승인 응답 후 — 턴 타이머 재개(codex 활성 작업에만 타임아웃 적용).★ */
  private resumeTurnTimer(): void { if (this.turnResolve && !this.turnTimer && this.armTurnTimer) this.turnTimer = this.armTurnTimer(); }

  /** 진행 중 턴을 새 지시로 전환(중간 steer). expectedTurnId 필수(실측). */
  async steer(text: string): Promise<void> {
    if (!this.threadId || !this.currentTurnId) throw new Error("no active turn to steer");
    await this.notify("turn/steer", { threadId: this.threadId, expectedTurnId: this.currentTurnId, input: [{ type: "text", text, text_elements: [] }] });
  }

  /** 진행 중 턴을 완전 중단(interrupt). */
  async interrupt(): Promise<void> {
    if (!this.threadId || !this.currentTurnId) throw new Error("no active turn to interrupt");
    await this.notify("turn/interrupt", { threadId: this.threadId, turnId: this.currentTurnId });
  }

  /** 현재 thread id(sessionId=멀티턴 resume 키로 상위에 반환). */
  get currentThreadId(): string | null {
    return this.threadId;
  }

  close(): void {
    this.closed = true;
    try { this.proc?.kill("SIGTERM"); } catch { /* noop */ }
    this.proc = null;
  }

  // ── 내부 ──────────────────────────────────────────────
  private send(obj: Record<string, unknown>): void {
    if (this.closed || !this.proc) throw new Error("client closed");
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }
  /** 요청(응답 기대). */
  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.send({ id, method, params });
    });
  }
  /** 알림성 호출(turn/start·steer·interrupt): 결과는 notification 스트림으로 오지만, ★에러 응답은 턴 실패로 승격★(견고성 #1). */
  private notify(method: string, params: unknown): Promise<void> {
    const id = this.nextId++;
    // ★견고성 #1 픽스: turn/start의 JSON-RPC 에러 응답(rate limit 등)을 noop으로 버리지 않고 활성 턴을 즉시 실패 종료.★
    this.pending.set(id, {
      resolve: () => {},
      reject: (e: any) => {
        if (method === "turn/start" || method === "turn/steer") {
          this.failActiveTurn("failed", `${method}_error: ${e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300)}`);
        }
      },
      method,
    });
    try { this.send({ id, method, params }); } catch (e) {
      // closed 상태 동기 throw → 활성 턴 실패 종료(견고성 #6: 타이머 누수/미settle 방지).
      this.failActiveTurn("error", `send_failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return Promise.resolve();
  }

  /** 활성 턴을 실패로 즉시 종료(에러 응답/에러 notification 공용). finalText 있으면 보존(at-most-once). */
  private failActiveTurn(status: string, detail: string): void {
    const r = this.turnResolve;
    if (!r) return;
    this.turnResolve = null;
    this.activeHandlers = null;
    const text = this.lastFinal || this.deltaBuf; // 부분 델타도 보존(타임아웃 경로와 일관)
    this.lastFinal = "";
    this.deltaBuf = "";
    r({ finalText: text, status, turnId: this.currentTurnId, detail: `${detail}${this.rateLimitTail ? ` | ${this.rateLimitTail}` : ""}${this.stderrTail ? ` | stderr: ${this.stderrTail.slice(-400)}` : ""}` });
  }
  private respond(id: number | string, result: unknown): void {
    this.send({ id, result });
  }
  private failAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    if (this.turnResolve) { this.turnResolve({ finalText: "", status: "error", turnId: this.currentTurnId }); this.turnResolve = null; }
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: any): void {
    // 1) server→client 요청(승인 등): method + id
    if (typeof msg.method === "string" && msg.id !== undefined) {
      // ★견고성 #5: void 호출의 unhandled rejection 방지(respond가 closed 시 throw할 수 있음).★
      void this.handleServerRequest(msg.id, msg.method, msg.params ?? {}).catch(() => {});
      return;
    }
    // 2) notification: method, id 없음
    if (typeof msg.method === "string" && msg.id === undefined) {
      this.handleNotification(msg.method, msg.params ?? {});
      return;
    }
    // 3) 우리 요청에 대한 응답
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
    }
  }

  private async handleServerRequest(id: number | string, method: string, params: Record<string, unknown>): Promise<void> {
    const handler = this.activeHandlers?.onApproval;
    let decision: ReviewDecision = "denied"; // ★fail-closed 기본★
    // ★M5.3: 승인 판정(팝업 대기 가능) 동안 턴 타이머 정지 → 사람이 폰으로 승인하는 시간이 turn timeout에 안 잡힘.★
    this.pauseTurnTimer();
    try {
      if (handler) decision = await handler({ method, params });
    } catch { decision = "denied"; }
    // ★하네스 HIGH 4(a) 픽스: respond가 EPIPE 등으로 throw해도 resume이 스킵되어 턴이 hang하지 않게 finally로.★
    try { this.respond(id, { decision }); }
    finally { this.resumeTurnTimer(); } // codex가 결정 받고 작업 재개 → 턴 타이머 재개(예외에도 보장)
  }

  private handleNotification(method: string, params: any): void {
    this.activeHandlers?.onNotify?.(method, params);
    // ★견고성 #2 픽스: 턴 종료를 turn/completed 하나로만 인식하면 turn/failed·error·aborted에서 300초 hang.★
    // completed 외 turn-level 종료/에러 신호를 잡아 즉시 실패 종료(rate-limit 사유를 params에서 끌어올림).
    if ((method.startsWith("turn/") && /error|fail|abort|cancel/i.test(method)) || method === "error") {
      this.failActiveTurn("failed", `${method}: ${JSON.stringify(params ?? {}).slice(0, 300)}`);
      return;
    }
    // ★rate-limit 진단(하네스 #2): account/rateLimits 상태를 캡처해 실패/타임아웃 detail에 실음
    // → 실 리밋 신호 method를 못 관측한 상태에서도 "리밋 때문인지"를 사후 진단(fast-fail 자체는 별도 과제).★
    if (method === "account/rateLimits/updated") {
      try {
        const rl = params?.rateLimits;
        const pri = rl?.primary?.usedPercent, sec = rl?.secondary?.usedPercent;
        if (pri != null || sec != null) this.rateLimitTail = `rateLimits primary=${pri ?? "?"}% secondary=${sec ?? "?"}%`;
      } catch { /* noop */ }
      return;
    }
    switch (method) {
      case "turn/started": {
        const turnId = params?.turn?.id ?? null;
        this.currentTurnId = turnId;
        if (turnId) this.activeHandlers?.onTurnStarted?.(turnId);
        break;
      }
      case "item/agentMessage/delta": {
        const t = params?.delta ?? params?.text ?? "";
        if (t) { this.deltaBuf += String(t); this.activeHandlers?.onDelta?.(String(t)); } // ★#4: delta 누적(완결텍스트 빈 경우 폴백)★
        break;
      }
      case "item/completed": {
        if (params?.item?.type === "agentMessage" && typeof params.item.text === "string") {
          this.lastFinal = params.item.text;
        }
        break;
      }
      case "turn/completed": {
        const status = params?.turn?.status ?? "completed";
        const resolve = this.turnResolve;
        this.turnResolve = null;
        this.activeHandlers = null;
        // ★#4 폴백: item/completed 텍스트가 비면 누적 delta 사용(멀쩡한 답을 실패로 오판 방지).★
        const finalText = this.lastFinal || this.deltaBuf;
        resolve?.({ finalText, status, turnId: this.currentTurnId });
        this.lastFinal = "";
        this.deltaBuf = "";
        break;
      }
    }
  }
  private lastFinal = "";
  private deltaBuf = "";
  private stderrTail = "";
  private rateLimitTail = "";
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private turnTimeoutMs = 0;
  private armTurnTimer: (() => ReturnType<typeof setTimeout>) | null = null;
}
