import { reasoningSummaryOf } from "./reasoningSummary";
/** 자식 app-server와 줄 단위 JSON-RPC로 통신해 진행 중 steer·interrupt와 승인 요청을 처리한다.
 * 팀 버스·텔레그램 연결은 상위 어댑터가 담당하므로 이 모듈에는 섞지 않는다. */
import { uiText } from "./uiStrings";
import { cogsActivityLine } from "./cogsActivity";
import { TurnAnswerText } from "./answerText";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  classifyServerRequest, isApprovalKind, toInternalDecision, encodeApproval, failSafeNonApproval,
} from "./serverRequestCodec";
import { CodexTurnItemIndex, type ObservedItem } from "./appServerItemIndex";

const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
const HANDSHAKE_TIMEOUT_MS = Number(process.env.B3OS_CODEX_APPSERVER_HANDSHAKE_MS ?? 45_000);

/** 승인요청(ServerRequest) — 상위가 decision 을 돌려준다. 실행 모드가 approvalPolicy never 라 실사용에서는 오지 않는다. */
export interface ApprovalRequest {
  method: string; // execCommandApproval | applyPatchApproval | item/permissions/requestApproval | item/tool/requestUserInput ...
  params: Record<string, unknown>;
  serverRequestId?: string; // Phase1 ③: app-server JSON-RPC 요청 id — 팝업↔요청 1:1 상관키.
  /** 파일변경 승인 payload는 내용 없이 itemId만 주고 벤더에 ID 조회 요청도 없으므로 먼저 온 알림을 같은 턴·항목으로 색인한다.
   * 짝이 없으면 undefined로 두어 호출자가 내용을 지어내지 않고 매번 확인하게 한다. */
  observedItem?: ObservedItem;
}
/** 승인 결정. codex ReviewDecision: approved(=이번만) | approved_for_session(=계속) | denied(=거절/이번만거절) | abort. */
export type ReviewDecision = "approved" | "approved_for_session" | "denied" | "abort";

export interface RunTurnHandlers {
  /** 스트리밍 델타(부분 응답 텍스트). */
  onDelta?: (text: string) => void;
  /** Full ordered assistant text, including completions of earlier items. */
  onAnswerText?: (text: string) => void;
  /** 턴 시작 알림(turnId 확보 — interrupt에 필요). */
  onTurnStarted?: (turnId: string) => void;
  /** 승인요청 → decision 반환(비동기). 미지정 시 기본 denied(fail-closed). */
  onApproval?: (req: ApprovalRequest) => Promise<ReviewDecision> | ReviewDecision;
  /** 지금 무엇을 하는 중인가 — 사람이 진행 상황을 보게 한다(tmux 팀원의 화면 긁기와 같은 자리). */
  /** itemId 를 함께 준다 — 같은 항목이 나중에 구체화되면 그 줄을 교체 할 수 있다. */
  onActivity?: (line: string, itemId?: string, item?: unknown) => void;
  /** 지금 어느 단계인가 — 맨 윗줄에서 교체된다. 쌓이지 않는다. */
  onStatus?: (line: string, item?: unknown) => void;
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
  approvalPolicy?: string; // AskForApproval — untrusted | on-request | never
  sandbox?: string; // SandboxMode — read-only | workspace-write | danger-full-access
  /** 승인 주체. openclaw 는 "user" 를 명시한다. */
  approvalsReviewer?: string;
  runtimeWorkspaceRoots?: string[];
  /**
   * workspace-write 일 때 turn/start 의 sandboxPolicy 에 싣는 쓰기 루트·인터넷.
   * thread/start 의 sandbox 는 문자열만 받으므로 범위는 매 턴 sandboxPolicy 로 보낸다(턴마다 같은 값을 다시 싣는다).
   * runtimeWorkspaceRoots 와 다른 값이다 — 그것은 experimentalApi 이고 쓰기 허용 목록이 아니다.
   */
  writableRoots?: string[];
  networkAccess?: boolean;
  /** resume으로 이전 대화를 이어가되 실패하면 새 thread에서 진행한다. */
  resumeThreadId?: string;
}

/** thread/start의 sandbox는 문자열이고 turn/start의 sandboxPolicy는 객체이므로 같은 실행 모드도 각 요청의 형식에 맞춰 인코딩한다. */
export function sandboxModeToTurnPolicyType(mode: string): string {
  switch (mode) {
    case "read-only": return "readOnly";
    case "workspace-write": return "workspaceWrite";
    case "danger-full-access": return "dangerFullAccess";
    default: return mode; // 모르는 값은 그대로 — codex 가 거부하면 그게 답이다
  }
}

export type TurnSandboxPolicy = { type: string; writableRoots?: string[]; networkAccess?: boolean };

/** turn/start sandboxPolicy. 범위 칸은 workspace-write 에서만, 그리고 부른 쪽이 준 것만 싣는다(안 주면 지금과 같은 모양). */
export function turnSandboxPolicy(opts: Pick<ThreadStartOptions, "sandbox" | "writableRoots" | "networkAccess">): TurnSandboxPolicy {
  const type = sandboxModeToTurnPolicyType(opts.sandbox ?? "");
  if (opts.sandbox !== "workspace-write") return { type };
  return {
    type,
    ...(opts.writableRoots ? { writableRoots: [...opts.writableRoots] } : {}),
    ...(opts.networkAccess !== undefined ? { networkAccess: opts.networkAccess } : {}),
  };
}

interface Pending { resolve: (v: any) => void; reject: (e: any) => void; method: string; }

/** CODEX_HOME을 명시해야 자식이 호스트 ~/.codex 대신 해당 팀원의 승인정책·권한 설정을 읽는다. */
export function appServerSpawnEnv(codexHome?: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  if (codexHome) env.CODEX_HOME = codexHome;
  return env;
}

/** Codex는 tmux 화면이 없으므로 app-server item 이벤트로 activity_line을 채운다. */
/** 턴 단계는 반복해서 오므로 맨 윗줄을 교체한다. 작업 이력처럼 누적하면 상태 표시가 화면을 채운다. */
export function statusLineOf(item: unknown): string | null {
  const it = (item ?? {}) as Record<string, unknown>;
  const type = typeof it.type === "string" ? it.type : "";
  if (type === "reasoning") {
    // 요약이 실려 오면 무엇을 생각하는 중인지까지 보여준다.
    const head = reasoningSummaryOf(item);
    return head ? uiText("reasoning_summary",{summary:head.length > 60 ? head.slice(0,59)+"…":head}) : uiText("reasoning");
  }
  if (type === "agentMessage") return uiText("answering");
  return null;
}

/** 항목 id — 같은 항목의 시작/완료를 잇는 열쇠. */
export function itemIdOf(item: unknown): string | undefined {
  const id = (item as { id?: unknown } | null)?.id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/** 진행 줄로 보여줄 것이 없는 항목 — 사람이 방금 보낸 말의 되울림 등. */
const NOISE_ITEM_TYPES = new Set(["userMessage", "user_message", "userMessageDelta"]);

export function activityLineOf(item: unknown): string | null {
 const type=(item as {type?:unknown}|null)?.type;
 if (typeof type!=="string" || NOISE_ITEM_TYPES.has(type) || type==="reasoning" || type==="agentMessage") return null;
 return cogsActivityLine(item);
}

/** 입력 조립을 순수 함수로 분리해 프로세스 없이 이미지 누락을 검증한다.
 * CLI 0.147.0의 localImage는 imageUrl이 아닌 path를 요구하며, 그림은 이를 가리키는 텍스트보다 앞에 넣는다. */
/** 이어받기 실패와 성공이 같은 로그로 보이지 않도록 실패 사유를 기록한다. 문자열 생성을 분리해 로그 계약을 프로세스 없이 검증한다. */
export function resumeFailureLine(threadId: string, e: unknown): string {
  const why = e instanceof Error ? e.message : String(e);
  return `[codex] thread/resume 실패 → 새 대화로 시작한다 (앞 맥락 없음) · thread=${threadId} · ${why}`;
}

export function buildTurnInput(
  text: string,
  imagePaths?: readonly string[],
): Array<Record<string, unknown>> {
  return [
    ...(imagePaths ?? []).map((path) => ({ type: "localImage", path })),
    { type: "text", text, text_elements: [] },
  ];
}

/** item/·turn/ 진행 알림만 무응답 시계를 되돌린다. account/rateLimits/updated 같은 주기 진단과 모르는 method까지 세면 멈춘 턴이 영원히 살아남는다.
 * CLI 0.147.0 기준이며 이후 버전이 다른 namespace로 진행을 보내면 판정 범위를 재검토한다. */
function isTurnProgress(method: string): boolean {
  return method.startsWith("item/") || method.startsWith("turn/");
}

export class CodexAppServerClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private threadId: string | null = null;
  /** thread 설정의 암묵적 승계를 가정하지 않고 turn/start에도 실행 모드를 명시해 두 요청의 경계를 맞춘다. */
  private turnPolicy: { approvalPolicy?: string; sandboxPolicy?: TurnSandboxPolicy; approvalsReviewer?: string } = {};
  /** 공개 — 진행 중 턴에 끼어들려면(steer) 밖에서 turnId 유무를 볼 수 있어야 한다. 쓰기는 내부에서만. */
  currentTurnId: string | null = null;
  private activeHandlers: RunTurnHandlers | null = null;
  private turnResolve: ((r: TurnResult) => void) | null = null;
  /** 무응답 시계 관측값 — 마지막 진행 신호 시각과 이 턴에 받은 신호 수(타임아웃 사유에 싣는다). */
  private lastActivityAtMs = 0;
  private turnActivityCount = 0;
  private closed = false;
  /** 풀이 죽은 것을 돌려주지 않게 밖에서 상태를 볼 수 있어야 한다. */
  get isClosed(): boolean { return this.closed; }

  /** 팀원 CODEX_HOME을 넘기지 않으면 자식이 호스트 ~/.codex를 읽어 해당 팀원의 승인정책·권한 프로파일이 적용되지 않는다. */
  constructor(private readonly spawnOpts: { codexHome?: string; warn?: (line: string) => void } = {}) {}

  /** 진단 줄을 내보내는 통로. 시험이 가로챌 수 있게 주입 가능하다(기본은 콘솔). */
  private warn(line: string): void {
    (this.spawnOpts.warn ?? console.warn)(line);
  }

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
    // stderr tail을 실패·타임아웃 detail에 남겨 한도 등 원인을 진단한다.
    proc.stderr.on("data", (d) => { this.stderrTail = (this.stderrTail + d.toString()).slice(-2000); });
    proc.on("close", () => { this.closed = true; this.failAll(new Error("app-server closed")); });
    proc.on("error", (e) => { this.closed = true; this.failAll(e); });
    // app-server가 초기화에 응답하지 않아도 영구 대기하지 않도록 제한시간을 둔다. exec로 폴백하지 않는다.
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
    if (opts.approvalsReviewer) params.approvalsReviewer = opts.approvalsReviewer;
    if (opts.runtimeWorkspaceRoots) params.runtimeWorkspaceRoots = opts.runtimeWorkspaceRoots;
    // turn/start 에 다시 실을 값 — sandbox 는 문자열(thread)이 아니라 객체(turn) 라 모양이 다르다.
    this.turnPolicy = {
      ...(opts.approvalPolicy ? { approvalPolicy: opts.approvalPolicy } : {}),
      ...(opts.sandbox ? { sandboxPolicy: turnSandboxPolicy(opts) } : {}),
      ...(opts.approvalsReviewer ? { approvalsReviewer: opts.approvalsReviewer } : {}),
    };
    // resume 실패는 새 thread로 폴백해 맥락을 복구하지 못해도 요청 처리를 진행한다.
    let id: string | undefined;
    if (opts.resumeThreadId) {
      try {
        const r = await this.withTimeout(this.request("thread/resume", { ...params, threadId: opts.resumeThreadId }), HANDSHAKE_TIMEOUT_MS, "thread/resume") as { thread?: { id?: string } };
        id = r?.thread?.id;
      } catch (e) {
        this.warn(resumeFailureLine(opts.resumeThreadId, e));
      }
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
   * 견고성: timeoutMs 내 turn/completed 없으면 interrupt 후 status="timeout"으로 정리(무응답 턴이 런타임 막지 않게).
   * exec 폴백이 없으므로 예외는 여기서 정면 처리한다.
   */
  /** 이미지는 본문 경로가 아니라 localImage 입력 아이템으로 넣어야 실제로 읽힌다. CLI 0.147.0은 imageUrl 대신 path 필드를 요구한다. */
  runTurn(
    text: string,
    handlers: RunTurnHandlers = {},
    timeoutMs = 300_000,
    imagePaths?: readonly string[],
  ): Promise<TurnResult> {
    if (!this.threadId) throw new Error("startThread first");
    this.activeHandlers = handlers;
    this.currentTurnId = null;
    this.answer.reset(); // 턴 경계 버퍼 리셋(이전 턴 텍스트 누출 방지)
    this.approvalWaits = 0; // 턴 시작 시 승인 대기 ref-count 리셋(이전 턴 누수 방지)
    // S2: 이전 턴의 파일변경 관측을 버린다 — 이전 턴 내용이 이번 턴 승인에 붙으면 사람이 승인한 것과
    //   실행되는 것이 갈린다. (조회 시 turnId 대조가 한 겹 더 막지만, 여기서 먼저 비운다.)
    this.itemIndex.beginTurn();
    return new Promise<TurnResult>((resolve) => {
      let settled = false;
      const finish = (r: TurnResult) => { if (settled) return; settled = true; this.clearTurnTimer(); this.turnResolve = null; this.activeHandlers = null; resolve(r); };
      // 타이머를 인스턴스 필드로(pause/resume 가능) — 승인 팝업 대기 중엔 턴 타이머 정지(M5.3).
      this.turnTimeoutMs = timeoutMs;
      // 이 상한은 '일한 시간' 이 아니라 '조용한 시간' 이다 — 진행 신호가 올 때마다 noteTurnAlive() 가 다시 건다.
      this.lastActivityAtMs = Date.now();
      this.turnActivityCount = 0;
      this.armTurnTimer = () => setTimeout(() => {
        // 여기까지 왔다 = 상한만큼 아무 소식이 없었다. 멈춘 턴이라 끊는다(살아 있으면 타이머가 리셋됐다).
        void this.interrupt().catch(() => {});
        const quietSec = Math.round((Date.now() - this.lastActivityAtMs) / 1000);
        // 무엇을 재서 끊었는지 사유에 남긴다 — 안 남기면 '오래 걸려서 끊겼다' 로 읽힌다(실제와 다르다).
        const why = `idle ${quietSec}s (진행신호 ${this.turnActivityCount}건 뒤 무응답)`;
        finish({ finalText: this.answer.text(), status: "timeout", turnId: this.currentTurnId, detail: [why, this.rateLimitTail, this.stderrTail ? `stderr: ${this.stderrTail.slice(-400)}` : ""].filter(Boolean).join(" | ") });
      }, this.turnTimeoutMs);
      this.turnTimer = this.armTurnTimer();
      this.turnResolve = finish;
      this.notify("turn/start", {
        threadId: this.threadId,
        // 그림이 글자보다 앞선다 — 뒤에 두면 "이 그림" 이 앞 문장을 못 가리킨다(스파이크에서 앞에 두고 확인).
        input: buildTurnInput(text, imagePaths),
        ...this.turnPolicy, // thread 에 준 실행 모드를 턴에도 그대로 (openclaw 와 같은 모양)
      })
        .catch(() => finish({ finalText: "", status: "error", turnId: this.currentTurnId }));
    });
  }

  private clearTurnTimer(): void { if (this.turnTimer) { clearTimeout(this.turnTimer); this.turnTimer = null; } }
  /** 승인 대기 중에는 사람의 판단 시간을 턴 무응답으로 세지 않도록 타이머를 꺼둔다. 진행 알림으로 재무장하지 않고 모든 승인 종료 뒤 resumeTurnTimer만 재개한다. */
  private noteTurnAlive(): void {
    if (!this.turnResolve || !this.armTurnTimer) return; // 진행 중인 턴이 없으면 아무 일도 안 한다
    this.lastActivityAtMs = Date.now();
    this.turnActivityCount++;
    if (this.approvalWaits > 0) return; // 승인 대기 중 — 꺼둔 시계를 여기서 켜지 않는다
    this.clearTurnTimer();
    this.turnTimer = this.armTurnTimer();
  }
  /** M5.3: 승인 팝업 대기 시작 — 턴 타이머 정지(사람 대기 중엔 타임아웃 안 되게). ref-count 증가(Phase1 ③). */
  private pauseTurnTimer(): void { this.approvalWaits++; this.clearTurnTimer(); }
  /** 승인 대기 수를 감소시키고 모두 끝난 뒤에만 타이머를 재개한다. 첫 결정만으로 재개하면 다른 승인창을 보는 동안 조기 만료된다. */
  private resumeTurnTimer(): void {
    if (this.approvalWaits > 0) this.approvalWaits--;
    if (this.approvalWaits === 0 && this.turnResolve && !this.turnTimer && this.armTurnTimer) this.turnTimer = this.armTurnTimer();
  }

  /** 진행 중 턴을 새 지시로 전환(중간 steer). expectedTurnId 필수(실측). */
  async steer(text: string, imagePaths?: readonly string[]): Promise<void> {
    if (!this.threadId || !this.currentTurnId) throw new Error("no active turn to steer");
    const expectedTurnId = this.currentTurnId;
    const result = await this.request("turn/steer", {
      threadId: this.threadId,
      expectedTurnId,
      // 중간에 보낸 그림도 봐야 한다 — 턴 시작과 같은 모양이다. 안 실으면 사람이 도중에 붙인
      //   화면 사진이 글자만 남고 사라진다(그게 이 결함의 원래 모습이었다).
      input: buildTurnInput(text, imagePaths),
    }, 10_000);
    if (result?.turnId !== expectedTurnId) throw new Error("steer response turnId mismatch");
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

  //  내부
  private send(obj: Record<string, unknown>): void {
    if (this.closed || !this.proc) throw new Error("client closed");
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }
  /** 요청(응답 기대). */
  private request(method: string, params: unknown, timeoutMs?: number): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: response timeout`));
      }, timeoutMs) : undefined;
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); }, method,
      });
      try { this.send({ id, method, params }); }
      catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }
  /** 결과는 알림으로 오더라도 호출 에러는 턴 실패로 처리해야 실패를 버리고 계속 기다리지 않는다. */
  private notify(method: string, params: unknown): Promise<void> {
    const id = this.nextId++;
    // turn/start의 JSON-RPC 에러는 버리지 않고 활성 턴을 즉시 실패 종료한다.
    this.pending.set(id, {
      resolve: () => {},
      reject: (e: any) => {
        if (method === "turn/start") {
          this.failActiveTurn("failed", `${method}_error: ${e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300)}`);
        }
      },
      method,
    });
    try { this.send({ id, method, params }); } catch (e) {
      // closed 상태의 동기 예외도 활성 턴을 종료해 타이머·미완료 promise가 남지 않게 한다.
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
    const text = this.answer.text(); // 부분 델타도 보존(타임아웃 경로와 일관)
    this.answer.reset();
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
      // respond는 closed 상태에서 예외를 낼 수 있으므로 void 호출의 처리되지 않은 거부도 잡는다.
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
    // Phase1 ②: 모든 요청에 {decision} 반환하던 것을 method별 분기로 교체(11종 중 승인 4종만 decision류).
    // 근거=serverRequestCodec(Ames 0.144.6 schema 검증). 잘못된 result는 Codex pending을 오류/폴백에 의존시키거나 hang.
    const kind = classifyServerRequest(method);
    if (kind === "unknown") { this.respondError(id, -32601, `unknown server request: ${method}`); return; }

    if (isApprovalKind(kind)) {
      // 승인성: onApproval(사람 팝업 가능)로 내부 결정 → method별 codec 인코딩.
      const handler = this.activeHandlers?.onApproval;
      let decision: ReturnType<typeof toInternalDecision> = "decline"; // fail-closed 기본
      // S2: 이 승인이 가리키는 항목을 먼저 온 알림 에서 찾아 실어 준다(조회 요청이 없으므로 '기억' 으로).
      //   같은 turn·같은 itemId 일 때만 붙는다 — 어긋나면 undefined 라 상위가 매번 묻는 경로로 간다.
      const observedItem = this.itemIndex.lookup(params?.itemId, params?.turnId) ?? undefined;
      // M5.3: 승인 대기(팝업) 동안 턴 타이머 정지 → 사람이 폰으로 승인하는 시간이 turn timeout에 안 잡힘.
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
    // 진행 신호마다 무응답 시계를 되돌려 일하는 턴을 자르지 않고 조용히 멈춘 턴만 종료한다.
    if (isTurnProgress(method)) this.noteTurnAlive();
    this.activeHandlers?.onNotify?.(method, params);
    // S2: 파일변경 항목을 itemId 로 색인해 둔다 — 승인 요청은 내용을 안 담아 오므로 여기서만 볼 수 있다.
    //   파일변경과 무관한 알림은 observe 안에서 무시된다.
    this.itemIndex.observe(method, params);
    // 완료 알림만 기다리면 failed·error·aborted에서 제한시간까지 멈추므로 턴 종료·오류 신호도 즉시 정리하고 사유를 보존한다.
    if ((method.startsWith("turn/") && /error|fail|abort|cancel/i.test(method)) || method === "error") {
      this.failActiveTurn("failed", `${method}: ${JSON.stringify(params ?? {}).slice(0, 300)}`);
      return;
    }
    // 한도 상태를 실패·타임아웃 detail에 포함해 원인을 진단한다. 한도 상태를 이용한 즉시 실패 처리는 별도 기능이다.
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
        if (t) {
          const before = this.answer.text();
          this.answer.delta(String(t), params?.itemId, params?.phase);
          this.publishAnswer(before);
        } // 완결 텍스트가 없을 때 사용할 delta를 누적한다.
        break;
      }
      case "item/started": {
        if (params?.item?.type === "agentMessage") this.answer.observe(itemIdOf(params.item), params.item.phase);
        const status = statusLineOf(params?.item);
        if (status) { this.activeHandlers?.onStatus?.(status, params?.item); break; }
        const line = activityLineOf(params?.item);
        if (line) this.activeHandlers?.onActivity?.(line, itemIdOf(params?.item), params?.item);
        break;
      }
      case "item/completed": {
        // 검색어는 여기서야 채워져 온다. item/started 는 query="" · action=null 로 빈 채 온다
        //   (0.147.0 실측). 그래서 시작 시점 줄만 만들면 "웹 검색" 에서 영영 멈춘다.
        //   같은 itemId 를 주어 호출자가 그 줄을 구체적인 것으로 바꾸게 한다.
        {
          const status = statusLineOf(params?.item);
          if (status) this.activeHandlers?.onStatus?.(status, params?.item);
          else {
            const line = activityLineOf(params?.item);
            if (line) this.activeHandlers?.onActivity?.(line, itemIdOf(params?.item), params?.item);
          }
        }
        if (params?.item?.type === "agentMessage" && typeof params.item.text === "string") {
          const before = this.answer.text();
          this.answer.complete(params.item.text, itemIdOf(params.item), params.item.phase);
          this.publishAnswer(before);
        }
        break;
      }
      case "turn/completed": {
        const status = params?.turn?.status ?? "completed";
        const resolve = this.turnResolve;
        this.turnResolve = null;
        this.activeHandlers = null;
        // 완결 텍스트가 비면 누적 delta를 사용해 정상 답을 실패로 오판하지 않는다.
        const finalText = this.answer.text();
        resolve?.({ finalText, status, turnId: this.currentTurnId });
        this.answer.reset();
        break;
      }
    }
  }
  private publishAnswer(before: string): void {
    const text = this.answer.text();
    if (text === before) return;
    if (this.activeHandlers?.onAnswerText) this.activeHandlers.onAnswerText(text);
    else if (text.startsWith(before)) this.activeHandlers?.onDelta?.(text.slice(before.length));
  }
  private answer = new TurnAnswerText();
  private stderrTail = "";
  private rateLimitTail = "";
  private approvalWaits = 0; // 동시 승인 대기 ref-count(Phase1 ③) — 0일 때만 턴 타이머 재개.
  /** S2: 파일변경 항목 turn 단위 색인 — 승인 요청에 내용이 없어 알림에서만 알 수 있다. */
  private itemIndex = new CodexTurnItemIndex();
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private turnTimeoutMs = 0;
  private armTurnTimer: (() => ReturnType<typeof setTimeout>) | null = null;
}
