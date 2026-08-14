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
import {
  classifyServerRequest, isApprovalKind, toInternalDecision, encodeApproval, failSafeNonApproval,
} from "./serverRequestCodec";
import { CodexTurnItemIndex, type ObservedItem } from "./appServerItemIndex";

const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
const HANDSHAKE_TIMEOUT_MS = Number(process.env.B3OS_CODEX_APPSERVER_HANDSHAKE_MS ?? 45_000);

/** 승인요청(ServerRequest) — 상위가 permissionGate/GD 팝업으로 판정해 decision을 돌려준다. */
export interface ApprovalRequest {
  method: string; // execCommandApproval | applyPatchApproval | item/permissions/requestApproval | item/tool/requestUserInput ...
  params: Record<string, unknown>;
  serverRequestId?: string; // ★Phase1 ③: app-server JSON-RPC 요청 id — 팝업↔요청 1:1 상관키.★
  /**
   * ★S2(#106): 이 승인 요청보다 ★먼저 도착한 알림★ 에서 같은 itemId·같은 turn 으로 관측된 항목.★
   *
   * 신세대 `item/fileChange/requestApproval` 은 ★무엇을 바꾸는지 payload 에 담지 않는다★ — itemId 만 준다.
   * 그리고 벤더 프로토콜에 ★item 을 id 로 조회하는 요청이 없다★(ClientRequest 전수 확인).
   * 그래서 클라이언트가 알림을 색인해 두었다가 여기에 실어 준다. ★짝이 없으면 undefined★ — 상위는
   * 그 경우 내용을 지어내지 말고 해석 실패(매번 묻기)로 처리해야 한다.
   */
  observedItem?: ObservedItem;
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

/**
 * ★자식 app-server 가 읽을 설정 위치를 정하는 env.★ 순수 함수라 spawn 없이 잴 수 있다.
 *
 * codexHome 이 없으면 자식은 ★호스트 ~/.codex★ 를 읽는다 — 그러면 그 팀원의 승인정책도
 * 권한 프로파일도 하나도 안 걸린다(2026-08-12 실측: dex 턴이 호스트 설정으로 돌았다).
 */
export function appServerSpawnEnv(codexHome?: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  if (codexHome) env.CODEX_HOME = codexHome;
  return env;
}

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

  /**
   * ★어느 팀원의 설정으로 돌 것인가.★ 안 주면 자식이 ★호스트 ~/.codex★ 를 읽는다.
   *
   * 실제로 그래서 사고가 났다(2026-08-12): 이 값을 안 넘겨서 dex 턴이 호스트 설정으로 돌았고,
   * dex config 의 approval_policy 도 permission 프로파일도 ★하나도 안 걸렸다.★
   * 그걸 보고 나는 "app-server 가 설정을 무시한다" 고 결론냈는데 ★틀렸다★ — 무시한 게 아니라
   * ★다른 파일을 읽고 있었다.★ exec 경로(runner.ts)는 원래 넘긴다. 여기만 빠져 있었다.
   */
  constructor(private readonly spawnOpts: { codexHome?: string } = {}) {}

  /** 이 클라이언트가 어느 팀원 설정으로 띄우는지(시험·진단용). */
  get codexHome(): string | undefined { return this.spawnOpts.codexHome; }

  /** app-server 스폰 + initialize 핸드셰이크. */
  async start(): Promise<void> {
    const proc = spawn(CODEX_BIN, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: appServerSpawnEnv(this.spawnOpts.codexHome),
    });
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
   * exec 폴백이 없으므로 예외는 여기서 정면 처리한다.
   */
  runTurn(text: string, handlers: RunTurnHandlers = {}, timeoutMs = 300_000): Promise<TurnResult> {
    if (!this.threadId) throw new Error("startThread first");
    this.activeHandlers = handlers;
    this.currentTurnId = null;
    this.lastFinal = "";
    this.deltaBuf = ""; // ★턴 경계 버퍼 리셋(이전 턴 텍스트 누출 방지)★
    this.approvalWaits = 0; // ★턴 시작 시 승인 대기 ref-count 리셋(이전 턴 누수 방지)★
    // ★S2: 이전 턴의 파일변경 관측을 버린다 — 이전 턴 내용이 이번 턴 승인에 붙으면 사람이 승인한 것과
    //   실행되는 것이 갈린다. (조회 시 turnId 대조가 한 겹 더 막지만, 여기서 먼저 비운다.)★
    this.itemIndex.beginTurn();
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
  /** ★M5.3: 승인 팝업 대기 시작 — 턴 타이머 정지(사람 대기 중엔 타임아웃 안 되게). ref-count 증가(Phase1 ③).★ */
  private pauseTurnTimer(): void { this.approvalWaits++; this.clearTurnTimer(); }
  /** ★M5.3+③: 승인 응답 후 — ref-count 감소, ★모든★ 승인 대기가 끝나야 턴 타이머 재개.
   *  (Ames ③ 지적: ref-count 없으면 동시 승인 2건 중 첫 응답이 두 번째 사람-대기 중에 타이머를 조기 재개해 오타임아웃.) */
  private resumeTurnTimer(): void {
    if (this.approvalWaits > 0) this.approvalWaits--;
    if (this.approvalWaits === 0 && this.turnResolve && !this.turnTimer && this.armTurnTimer) this.turnTimer = this.armTurnTimer();
  }

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
  /** JSON-RPC error 응답 — 잘못 매핑된 {decision} 대신 pending을 즉시 해소(unknown/제공불가 요청용). */
  private respondError(id: number | string, code: number, message: string): void {
    this.send({ id, error: { code, message } });
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
    // ★Phase1 ②: 모든 요청에 {decision} 반환하던 것을 method별 분기로 교체(11종 중 승인 4종만 decision류).★
    // 근거=serverRequestCodec(Ames 0.144.6 schema 검증). 잘못된 result는 Codex pending을 오류/폴백에 의존시키거나 hang.
    const kind = classifyServerRequest(method);
    if (kind === "unknown") { this.respondError(id, -32601, `unknown server request: ${method}`); return; }

    if (isApprovalKind(kind)) {
      // 승인성: onApproval(사람 팝업 가능)로 내부 결정 → method별 codec 인코딩.
      const handler = this.activeHandlers?.onApproval;
      let decision: ReturnType<typeof toInternalDecision> = "decline"; // ★fail-closed 기본★
      // ★S2: 이 승인이 가리키는 항목을 ★먼저 온 알림★ 에서 찾아 실어 준다(조회 요청이 없으므로 '기억' 으로).
      //   같은 turn·같은 itemId 일 때만 붙는다 — 어긋나면 undefined 라 상위가 매번 묻는 경로로 간다.★
      const observedItem = this.itemIndex.lookup(params?.itemId, params?.turnId) ?? undefined;
      // ★M5.3: 승인 대기(팝업) 동안 턴 타이머 정지 → 사람이 폰으로 승인하는 시간이 turn timeout에 안 잡힘.★
      this.pauseTurnTimer();
      try {
        if (handler) decision = toInternalDecision(await handler({ method, params, serverRequestId: String(id), observedItem }));
      } catch { decision = "decline"; }
      finally { this.resumeTurnTimer(); } // 결정 받으면 즉시 재개(예외에도 보장)
      const out = encodeApproval(kind, decision, params);
      if (out.kind === "result") this.respond(id, out.result);
      else this.respondError(id, out.code, out.message);
      return;
    }

    // 비승인성(6종): 사람 대기 불필요 → 즉시 fail-safe result 또는 JSON-RPC error(진짜 값 필요한 auth/attestation).
    // (요청 종류별 정상 응답을 만드는 전용 provider는 후속; 현재는 검증된 fail-safe로 pending을 안전 해소.)
    const out = failSafeNonApproval(kind, Date.now() / 1000);
    if (out.kind === "result") this.respond(id, out.result);
    else this.respondError(id, out.code, out.message);
  }

  private handleNotification(method: string, params: any): void {
    this.activeHandlers?.onNotify?.(method, params);
    // ★S2: 파일변경 항목을 itemId 로 색인해 둔다 — 승인 요청은 내용을 안 담아 오므로 여기서만 볼 수 있다.
    //   파일변경과 무관한 알림은 observe 안에서 무시된다.★
    this.itemIndex.observe(method, params);
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
  private approvalWaits = 0; // 동시 승인 대기 ref-count(Phase1 ③) — 0일 때만 턴 타이머 재개.
  /** ★S2: 파일변경 항목 turn 단위 색인 — 승인 요청에 내용이 없어 알림에서만 알 수 있다.★ */
  private itemIndex = new CodexTurnItemIndex();
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private turnTimeoutMs = 0;
  private armTurnTimer: (() => ReturnType<typeof setTimeout>) | null = null;
}
