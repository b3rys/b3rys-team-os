/**
 * codex runtime — "두뇌" 호출 (OpenAI Codex CLI `codex exec` 직접 구동).
 *
 * 이 파일이 하는 일: 에이전트 워크스페이스(cwd)에서 `codex exec`를 헤드리스로 한 번 돌려 답 텍스트를 받는다.
 * 페르소나는 cwd 의 AGENTS.md 가 자동로드됨(claude의 CLAUDE.md처럼) — 그래서 룰로딩 블록이 그대로 두뇌 컨텍스트가 된다.
 *
 * 출처: codex-channel-poc(2026-06-27 GD 검증)에서 이식. 검증된 gotcha 반영:
 *   - stdin 'ignore'로 즉시 EOF(안 그러면 codex가 stdin 대기 → hang).
 *   - 최종답은 -o lastMsgFile 로 받음(JSONL 파싱 없이 견고).
 *   - sessionId = JSONL 첫 이벤트 thread_id(멀티턴 resume 키).
 *   - 신규턴은 `exec -s <sandbox>`, 재개턴은 `exec resume <id>`(-s 금지 gotcha) + config override로 sandbox 강제.
 *   - read-only sandbox 기본. 멤버별 설정이 있을 때만 workspace-write/network_access를 열어 blast radius를 줄인다.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import type { CodexSandboxMode } from "../../types";

// 아키텍처/OS 무관(하네스, GD 2026-07-02): env 미설정 시 bare 이름 → PATH lookup(OPENCLAW_BIN 패턴과 동일). Apple-Silicon 고정경로 하드코딩은 Intel/Linux서 spawn 실패.
export const CODEX_BIN = process.env.CODEX_BIN ?? "codex";

export interface CodexTurnOptions {
  /** ★이 턴이 '누구' 인가.★ 팀원 스크립트(_me.sh)가 tmux 세션으로 ★추측하지 않게★ 명시적으로 넘긴다.
   *  (2026-07-13: hermes 가 구버전 _me.sh 의 tmux 폴백 때문에 ★전 발신이 'bill' 로 위장★됐다) */
  agentId?: string;
  /** 작업 디렉토리 = 페르소나(AGENTS.md) + 스킬 접근 루트. codex가 cwd의 AGENTS.md를 자동로드. */
  cwd?: string;
  /** 팀원별 정체성 격리(config/auth/session). 미지정 시 기본 ~/.codex. */
  codexHome?: string;
  /** 보낼 프롬프트(채널 메시지 + 팀 컨텍스트). */
  prompt: string;
  /** 멀티턴 맥락 유지: 이전 턴 sessionId 주면 resume. */
  resumeSessionId?: string;
  /** 샌드박스(기본 read-only). */
  sandbox?: CodexSandboxMode;
  /** workspace-write일 때 Codex sandbox network_access 토글. 미지정 시 CLI 기본값. */
  networkAccess?: boolean;
  /** workspace-write일 때 코드로 강제할 쓰기 가능 루트. 미지정 시 cwd 1개, cwd도 없으면 빈 allowlist. */
  writableRoots?: string[];
  /** 모델 오버라이드(미지정 시 codex 기본). */
  model?: string;
  /** 하드 타임아웃(ms). 초과 시 kill(턴 원자성). */
  timeoutMs?: number;
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

  // ★보안(하네스 BLOCKER fix 2026-06-28): prompt 앞에 "--"로 옵션 파싱 종료.
  // 없으면 "-"로 시작하는 채팅 메시지(예: --dangerously-bypass-approvals-and-sandbox)가
  // codex의 flag로 해석돼 read-only 샌드박스 탈출=호스트 RCE. "--" 뒤는 무조건 PROMPT.
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
export async function runCodexTurn(opts: CodexTurnOptions): Promise<CodexTurnResult> {
  const started = Date.now();
  const sandbox = opts.sandbox ?? "read-only";
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const writableRoots = writableRootsFor(opts, sandbox);

  const lastMsgDir = mkdtempSync(join(tmpdir(), "codexrt-"));
  const lastMsgFile = join(lastMsgDir, "last.txt");

  const args = buildCodexArgs(opts, lastMsgFile, sandbox);

  const env = { ...process.env };
  // ★정체를 명시한다 — 추측하게 두면 틀린 답을 조용히 준다.★ (hermes 위장 사고, 2026-07-13)
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
