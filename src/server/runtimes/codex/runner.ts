/** exec 경로는 stdin을 즉시 EOF로 닫아 입력 대기를 막고 최종답은 출력 파일로 받는다. sessionId는 첫 thread 이벤트에서 얻는다.
 * 신규 실행의 -s는 resume에서 사용할 수 없어 config override로 sandbox를 강제한다. 기본 readOnly이며 명시된 멤버 설정만 쓰기·네트워크를 연다. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import type { CodexSandboxMode } from "../../types";

// 바이너리 env 미설정은 PATH 조회를 사용해야 특정 CPU·OS의 고정 경로 때문에 spawn이 실패하지 않는다.
export const CODEX_BIN = process.env.CODEX_BIN ?? "codex";

export interface CodexTurnOptions {
  /** 팀원 ID는 승인 요청의 주인이므로 필수로 넘겨 tmux·기본값으로 다른 신원을 추측하지 않게 한다. 호출 누락은 컴파일에서 차단한다. */
  agentId: string;
  /** 작업 디렉토리 = 페르소나(AGENTS.md) + 스킬 접근 루트. codex가 cwd의 AGENTS.md를 자동로드. */
  cwd?: string;
  /** 팀원별 정체성 격리(config/auth/session). 미지정 시 기본 ~/.codex. */
  codexHome?: string;
  permissionMode?: import("../../../shared/codexPermissionMode").CodexPermissionMode;
  /** 보낼 프롬프트(채널 메시지 + 팀 컨텍스트). */
  prompt: string;
  /** A completed reaction turn may intentionally have no reply; errors still fail. */
  allowEmptyReply?: boolean;
  /** 멀티턴 맥락 유지: 이전 턴 sessionId 주면 resume. */
  resumeSessionId?: string;
  /** 샌드박스(기본 read-only). */
  sandbox?: CodexSandboxMode;
  /** workspace-write일 때 Codex sandbox network_access 토글. 미지정 시 CLI 기본값. */
  networkAccess?: boolean;
  /** workspace-write일 때 코드로 강제할 쓰기 가능 루트. 미지정 시 cwd 1개, cwd도 없으면 빈 allowlist. */
  writableRoots?: string[];
  /**
   * cogs 팀원 정책으로 정한 실행 설정. cogs 채널 브리지만 채운다 — 없으면 지금 동작 그대로.
   * app-server 경로만 읽는다(exec 경로는 cogs 에서 쓰지 않는다).
   */
  cogsRun?: import("./cogsRunPolicy").CogsCodexRun;
  /** cogs 정책 팀원의 승인 요청 처리(카드). 없으면 거절 — 텔레그램 팝업으로 넘기지 않는다. */
  onCogsApproval?: (req: import("./appServerClient").ApprovalRequest) => Promise<import("./appServerClient").ReviewDecision>;
  /** 모델 오버라이드(미지정 시 codex 기본). */
  model?: string;
  /** 하드 타임아웃(ms). 초과 시 kill(턴 원자성). */
  timeoutMs?: number;
  /** 진행 줄(도구 시작 등) 알림. 미지정이면 러너가 대시보드 표시만 갱신한다.
   *  채널(텔레그램 등)이 "지금 무엇을 하는 중인지" 를 보여주려면 이 통로가 필요하다 —
   *  없으면 러너까지 온 이벤트가 호출자에게 도달하지 않는다. */
  onActivity?: (line: string, itemId?: string, item?: unknown) => void;
  /** 지금 어느 단계인가 — 맨 윗줄에서 교체된다(쌓이지 않는다). */
  onStatus?: (line: string, item?: unknown) => void;
  /** Partial assistant text; reasoning text is never forwarded. */
  onDelta?: (text: string) => void;
  /** Full ordered assistant text for transports that support replacing the current body. */
  onAnswerText?: (text: string) => void;
  /** 이미지는 본문에 경로만 적으면 바이트 파일로만 읽힐 수 있으므로 별도 입력 아이템으로 제공한다. CLI 0.147.0에서 이미지 해석을 확인한 경로다. */
  imagePaths?: readonly string[];
}

export interface CodexTurnResult {
  ok: boolean;
  reply: string;
  sessionId?: string;
  detail: string;
  elapsedMs: number;
}

/** JSONL stdout에서 session id 추출(이벤트 타입 변화에 관대하게). */
export function extractSessionId(jsonl: string): string | undefined {
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      const id =
        (o.thread_id as string) ??
        (o.session_id as string) ??
        (o.sessionId as string) ??
        ((o.session as Record<string, unknown> | undefined)?.id as string) ??
        ((o.thread as Record<string, unknown> | undefined)?.id as string);
      if (typeof id === "string" && id) return id;
    } catch {
      /* tolerant */
    }
  }
  return undefined;
}

function writableRootsFor(opts: CodexTurnOptions, sandbox: CodexSandboxMode): string[] {
  if (sandbox !== "workspace-write") return [];
  const roots = opts.writableRoots ?? (opts.cwd ? [opts.cwd] : []);
  return [...new Set(roots.map((root) => resolve(root)))];
}

function tomlStringArray(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(",")}]`;
}

function configArgs(opts: CodexTurnOptions, sandbox: CodexSandboxMode): string[] {
  const args: string[] = [];
  if (sandbox === "workspace-write") {
    args.push("-c", `sandbox_workspace_write.writable_roots=${tomlStringArray(writableRootsFor(opts, sandbox))}`);
    if (opts.networkAccess !== undefined) {
      args.push("-c", `sandbox_workspace_write.network_access=${opts.networkAccess ? "true" : "false"}`);
    }
  }
  return args;
}

/** Codex CLI 인자 구성. prompt 앞 "--" 옵션 종료와 resume 시 -s 미사용을 테스트로 고정한다. */
export function buildCodexArgs(opts: CodexTurnOptions, lastMsgFile: string, sandbox = opts.sandbox ?? "read-only"): string[] {
  const common = ["--json", "--skip-git-repo-check", "-o", lastMsgFile];
  if (opts.model) common.push("-m", opts.model);
  const cfg = configArgs(opts, sandbox);

  // prompt 앞 --로 옵션 해석을 끝내야 -로 시작하는 채팅이 CLI 플래그로 해석돼 샌드박스를 우회하지 않는다.
  return opts.resumeSessionId
    ? [
        "exec",
        "resume",
        opts.resumeSessionId,
        "--ignore-user-config",
        "-c",
        `sandbox_mode="${sandbox}"`,
        ...cfg,
        ...common,
        "--",
        opts.prompt,
      ] // resume: -s 금지(gotcha), config override로 sandbox 강제
    : ["exec", "--ignore-user-config", "-s", sandbox, ...cfg, ...common, "--", opts.prompt]; // 신규턴도 user config 무시 + -s 로 sandbox 지정
}

/** 로그에 프롬프트 본문을 남기지 않도록 옵션 종료자 뒤 인자는 가린다. */
export function redactPromptArg(args: string[]): string[] {
  const promptIndex = args.indexOf("--");
  if (promptIndex < 0) return args;
  return [...args.slice(0, promptIndex + 1), "[prompt redacted]"];
}

/**
 * Codex 한 턴 실행(헤드리스). 답 텍스트 + sessionId 반환. 발신은 호출자(어댑터) 책임.
 */
/** DEPRECATED: 제품 경로·app-server 폴백에 사용하지 않는다. 일회성 exec는 steer·서브에이전트 생존·승인창 기능을 제공하지 않는다.
 * 기존 시험·도구 호출 호환을 위해서만 남긴다. */
export async function runCodexTurn(opts: CodexTurnOptions): Promise<CodexTurnResult> {
  const started = Date.now();
  // cogs 정책은 app-server 경로만 집행한다. exec 로 오면 정책 없이 돌게 되므로 막는다.
  if (opts.cogsRun && opts.cogsRun.mode !== "legacy") {
    return { ok: false, reply: "", detail: "cogs_policy_requires_app_server", elapsedMs: 0 };
  }
  const sandbox = opts.sandbox ?? "read-only";
  // 기본값을 두지 않는다 — 240초는 라이브에서 도달하지 않는 죽은 값 이었다.
  //   이 함수는 DEPRECATED 고, 유일한 제품 호출부(`runtimeSubscription.ts`)는 자기 상한을 명시로 넘긴다.
  //   그런데 숫자가 남아 있으면 "우리 정책이 240초" 로 읽힌다. 조용히 기본값을 주는 대신 크게 실패한다.
  const timeoutMs = opts.timeoutMs;
  if (timeoutMs == null) {
    throw new Error("runCodexTurn: timeoutMs 를 명시하세요 (DEPRECATED 경로 — 기본값을 두지 않습니다)");
  }
  const writableRoots = writableRootsFor(opts, sandbox);

  const lastMsgDir = mkdtempSync(join(tmpdir(), "codexrt-"));
  const lastMsgFile = join(lastMsgDir, "last.txt");

  const args = buildCodexArgs(opts, lastMsgFile, sandbox);

  const env = { ...process.env };
  // 팀원 신원을 명시해 실행 환경에서 다른 발신자를 추측하지 않게 한다.
  if (opts.agentId) env.GD_AGENT_ID = opts.agentId;
  if (!env.TEAM_DB_PATH) {
    env.TEAM_DB_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../../team.db");
  }
  if (opts.codexHome) env.CODEX_HOME = opts.codexHome;

  return await new Promise<CodexTurnResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    // codex exec는 stdin도 읽는다 → 'ignore'로 즉시 EOF(안 그러면 hang). 프롬프트는 arg로 전달.
    console.log(
      `[codex-runner] spawn bin=${CODEX_BIN} cwd=${opts.cwd ?? "(none)"} codex_home=${opts.codexHome ?? env.CODEX_HOME ?? "(default)"} sandbox=${sandbox} network_access=${opts.networkAccess ?? "(default)"} writable_roots=${JSON.stringify(writableRoots)} resume=${opts.resumeSessionId ? "yes" : "no"} args=${JSON.stringify(redactPromptArg(args))}`,
    );
    const proc = spawn(CODEX_BIN, args, { env, cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      proc.kill("SIGKILL");
      cleanup();
      resolve({ ok: false, reply: "", detail: `timeout_${timeoutMs}ms_killed`, elapsedMs: Date.now() - started });
    }, timeoutMs);

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    const cleanup = () => {
      clearTimeout(timer);
      try {
        rmSync(lastMsgDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    };

    proc.on("error", (e) => {
      if (done) return;
      done = true;
      cleanup();
      resolve({ ok: false, reply: "", detail: `spawn_error:${e.message}`, elapsedMs: Date.now() - started });
    });

    proc.on("close", (code) => {
      if (done) return;
      done = true;
      let reply = "";
      try {
        reply = readFileSync(lastMsgFile, "utf-8").trim();
      } catch {
        reply = "";
      }
      const sessionId = extractSessionId(stdout) ?? opts.resumeSessionId;
      cleanup();
      const ok = code === 0 && reply.length > 0;
      resolve({
        ok,
        reply,
        sessionId,
        detail: ok ? "ok" : `exit_${code}${stderr ? ":" + stderr.slice(-200) : ""}`,
        elapsedMs: Date.now() - started,
      });
    });
  });
}

/** 테스트 주입용 시그니처(어댑터가 이걸 호출). 기본 = 실제 runCodexTurn. */
export type CodexCaller = (opts: CodexTurnOptions) => Promise<CodexTurnResult>;
