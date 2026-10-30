// 런타임 인증 preflight: 영입 활성화 전에 claude/codex 로그인 상태를 사전점검한다.
//   = provision(토큰 저장) 후 bundle(활성화) 사이에서 "이 런타임이 oauth 로그인돼 있나"만 본다.
//   미로그인이면 활성화를 막아, tmux headless 프롬프트 갇힘(claude)·exit 1 실패(codex)를 사전에 차단.
//
// 보안: credential 값은 절대 읽지/출력/로그하지 않는다. 파일은 키 존재 여부만, codex는 status 문자열만 본다.
//   토큰/oauth 값을 detail/응답에 절대 넣지 않는다.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { appendAuditFile } from "./auditFile";
import { HOME, OPENCLAW_ROOT } from "./paths";
import { openclawCliCandidates } from "./openclawBridge";

// codex 풀패스(iTerm alias 깨짐 회피) — reference_codex_binary_path.
const CODEX_BIN = "/opt/homebrew/bin/codex";
// app-server의 현재 실행 모드·이미지 입력 계약을 검증한 최소 버전.
export const MIN_CODEX_VERSION = "0.147.0";

export function supportedCodexVersion(output: string): boolean {
  const match = /^codex(?:-cli)?\s+(\d+)\.(\d+)\.(\d+)(?:\s|$)/m.exec(output.trim());
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  const minimum = MIN_CODEX_VERSION.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (actual[i]! !== minimum[i]!) return actual[i]! > minimum[i]!;
  }
  return true;
}

/** 출력은 상태 판정에만 쓰고 계정 정보는 응답·로그로 내보내지 않는다. */
async function codexStatusCommand(bin: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; output: string; timedOut?: boolean }> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const finish = (ok: boolean, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, output, timedOut });
    };
    const timer = setTimeout(() => { proc.kill("SIGKILL"); finish(false, true); }, timeoutMs);
    proc.stdout.on("data", (d) => { output = (output + d.toString()).slice(-4096); });
    proc.stderr.on("data", (d) => { output = (output + d.toString()).slice(-4096); });
    proc.on("error", () => finish(false));
    proc.on("close", (code) => finish(code === 0));
  });
}

export async function checkCodexCliStatus(bin: string, loginTimeoutMs = 20_000): Promise<RuntimeAuthResult> {
  const base = { runtime: "codex", loggedIn: false, fixHint: CODEX_FIX_HINT };
  const version = await codexStatusCommand(bin, ["--version"], 5000);
  if (!version.ok) return { ...base, detail: "codex 바이너리 실행 불가", fixHint: CODEX_UNRUNNABLE_HINT };
  if (!supportedCodexVersion(version.output)) return {
    ...base, detail: `codex 최소 버전 ${MIN_CODEX_VERSION} 필요`,
    fixHint: `Codex CLI를 ${MIN_CODEX_VERSION} 이상으로 업데이트한 뒤 다시 확인하세요.`,
  };
  const status = await codexStatusCommand(bin, ["login", "status"], loginTimeoutMs);
  if (status.timedOut) return { ...base, detail: "codex 로그인 상태 확인 시간 초과", fixHint: "서버 컴퓨터에서 codex login status를 확인한 뒤 다시 확인하세요." };
  return { ...base, loggedIn: status.ok, detail: status.ok ? "Codex 로그인 상태 확인됨(login status)" : "Codex 미로그인(login status 실패)", fixHint: status.ok ? "" : CODEX_FIX_HINT };
}

// openclaw는 자체 인증 저장소를 쓰므로 codex 인증 파일에 의존하지 않는다. 전역·per-agent 경로의 존재만 확인한다.
function openclawAuthExists(): boolean {
  try {
    // 구독 로그인은 전역 auth.profiles에만 저장될 수 있어 per-agent와 전역 레이아웃을 모두 인정한다. 비밀값은 읽지 않고 키 존재만 본다.
    try {
      const gj = `${OPENCLAW_ROOT}/openclaw.json`;
      if (existsSync(gj)) {
        const j = JSON.parse(readFileSync(gj, "utf-8")) as { auth?: { profiles?: Record<string, unknown> } };
        const profs = j?.auth?.profiles;
        if (profs && typeof profs === "object" && Object.keys(profs).length > 0) return true;
      }
    } catch { /* 파싱 실패 → per-agent 폴백 */ }
    // (기존 레이아웃) per-agent `~/.openclaw/agents/<name>/agent/auth-profiles.json`.
    const agentsDir = `${OPENCLAW_ROOT}/agents`;
    if (!existsSync(agentsDir)) return false;
    for (const name of readdirSync(agentsDir)) {
      try {
        if (existsSync(`${agentsDir}/${name}/agent/auth-profiles.json`)) return true;
      } catch { /* 개별 항목 실패 무시 */ }
    }
    return false;
  } catch { return false; }
}

// 점검과 활성화가 같은 프로필·글로벌 인증 후보를 사용해야 한쪽만 통과하는 불일치를 막는다. 비밀값은 읽지 않는다.
function hermesAuthExists(): boolean {
  if (existsSync(`${HOME}/.hermes/auth.json`)) return true;
  try {
    const profilesDir = `${HOME}/.hermes/profiles`;
    if (!existsSync(profilesDir)) return false;
    for (const name of readdirSync(profilesDir)) {
      try {
        if (existsSync(`${profilesDir}/${name}/auth.json`)) return true;
      } catch { /* 개별 항목 실패 무시 */ }
    }
    return false;
  } catch { return false; }
}

export interface RuntimeAuthResult {
  runtime: string;
  loggedIn: boolean;
  detail: string; // 사람이 보는 상태 설명(값/토큰 절대 미포함)
  fixHint: string; // 미로그인 시 GD 안내 문구
}

/** UI와 서버 preflight가 함께 쓰는 secret-free 런타임 준비 상태. */
export interface RuntimeReadiness {
  runtime: string;
  installed: boolean;
  authenticated: boolean;
  ready: boolean;
  detail: string;
  fixHint: string;
}

function authResultToReadiness(result: RuntimeAuthResult): RuntimeReadiness {
  const missing = /미설치|바이너리 없음|실행파일 없음|python3 미설치|실행 불가/.test(result.detail);
  return {
    runtime: result.runtime,
    installed: !missing,
    authenticated: result.loggedIn,
    ready: result.loggedIn,
    detail: result.detail,
    fixHint: result.fixHint,
  };
}

// Codex는 CLI 상태 명령, OpenClaw와 Hermes는 각자의 인증 저장소로 점검한다.
const CODEX_FIX_HINT = "이 서버가 실행되는 컴퓨터의 터미널에서 `codex login` 으로 ChatGPT 로그인 후 다시 활성화하세요";
// 바이너리 자체가 없을 때(homebrew cleanup/업데이트로 사라짐 등) — '미로그인'과 구분해 명확히 안내.
const CODEX_MISSING_HINT = "codex CLI가 설치되지 않았습니다. 이 서버 컴퓨터 터미널에서 `brew install --cask codex` 로 설치하고 `codex login` 으로 ChatGPT 로그인 후 다시 확인하세요";
// openclaw 는 자체 auth store(전역 auth.profiles 또는 per-agent auth-profiles.json)로 인증한다 — codex login 이 아님.
const RUNTIME_SETUP_DOC = "절차: skills/b3os/references/runtime-setup.md";
const OPENCLAW_FIX_HINT = `openclaw 인증을 완료하세요(전역 auth.profiles 또는 per-agent auth-profiles.json). 이 서버 컴퓨터에서 \`npm install -g openclaw@latest\` → \`openclaw onboard --install-daemon\` → \`openclaw doctor\` 완료 후 다시 활성화하세요. ${RUNTIME_SETUP_DOC}#openclaw`;
const CLAUDE_FIX_HINT = "이 서버가 실행되는 컴퓨터의 터미널에서 `claude` 를 한 번 실행해 oauth 로그인 후 다시 활성화하세요";
const CLAUDE_MISSING_HINT = "Claude Code CLI가 설치되지 않았습니다. 이 서버 컴퓨터에서 `npm install -g @anthropic-ai/claude-code` 로 설치하고 `claude` 를 실행해 로그인한 뒤 다시 활성화하세요";

// 설치와 로그인을 구분하려고 바이너리를 먼저 찾는다. launchd의 제한 PATH를 보완하도록 표준 설치 경로도 탐색한다.
function binaryExists(cmd: string, ...paths: string[]): boolean {
  try { if (typeof Bun !== "undefined" && Bun.which(cmd)) return true; } catch { /* Bun.which 실패 무시 */ }
  return paths.some((p) => { try { return existsSync(p); } catch { return false; } });
}

// 점검과 실행이 같은 codex 설치를 보도록 CODEX_BIN을 우선한다. 해당 파일이 없으면 PATH와 표준 설치 경로를 탐색한다.
export function resolveCodexBin(env: Record<string, string | undefined> = process.env): string | null {
  const explicit = env.CODEX_BIN;
  if (explicit) { try { if (existsSync(explicit)) return explicit; } catch { /* 아래로 */ } }
  return resolveBinPath("codex", explicit ?? CODEX_BIN, "/opt/homebrew/bin/codex", "/usr/local/bin/codex", `${HOME}/.local/bin/codex`);
}

/** 실행할 바이너리 절대경로 해석 — Bun.which(PATH) 우선, 없으면 첫 존재 경로. 없으면 null. */
function resolveBinPath(cmd: string, ...paths: string[]): string | null {
  try { const w = (typeof Bun !== "undefined" && Bun.which) ? Bun.which(cmd) : null; if (w) return w; } catch { /* ignore */ }
  for (const p of paths) { try { if (p && existsSync(p)) return p; } catch { /* ignore */ } }
  return null;
}

const CODEX_UNRUNNABLE_HINT = "codex 바이너리가 설치돼 있지만 실행되지 않습니다 — macOS XProtect 격리 또는 OpenAI 코드서명 인증서 폐기 가능성. 이 서버 컴퓨터 터미널에서 `codex --version` 으로 확인하고, 최신 서명본으로 재설치하세요: `brew install codex` (npm 옛 설치가 있으면 먼저 제거).";

/** claude_channel: 바이너리 존재(미설치 구분) → ~/.claude.json 'oauthAccount' 키(로그인 여부). 값은 안 봄. */
function checkClaudeAuth(): RuntimeAuthResult {
  const base: RuntimeAuthResult = { runtime: "claude_channel", loggedIn: false, detail: "", fixHint: CLAUDE_FIX_HINT };
  // 설치 누락을 로그인 누락으로 안내하지 않도록 바이너리를 먼저 확인한다.
  if (!binaryExists("claude", `${HOME}/.claude/local/claude`, "/opt/homebrew/bin/claude", `${HOME}/.bun/bin/claude`, `${HOME}/.local/bin/claude`)) {
    return { ...base, loggedIn: false, detail: "Claude Code CLI 미설치(바이너리 없음)", fixHint: CLAUDE_MISSING_HINT };
  }
  // claude_channel은 tmux 주입과 bun 실행에 의존한다. tmux는 macOS 기본 도구가 아니므로 활성화 전에 설치를 확인한다.
  if (!binaryExists("tmux", process.env.TMUX_BIN ?? "/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux")) {
    return { ...base, loggedIn: false, detail: "tmux 미설치(claude_channel 주입에 필요)", fixHint: "tmux가 필요합니다: 이 서버 컴퓨터 터미널에서 `brew install tmux`(또는 OS 패키지 매니저)로 설치 후 다시 활성화하세요. Homebrew 자체가 없으면 https://brew.sh 로 먼저 설치하거나, repo 폴더에서 `bash install.sh` 를 다시 실행하면 tmux 까지 자동 준비됩니다" };
  }
  if (!binaryExists("bun", "/opt/homebrew/bin/bun", `${HOME}/.bun/bin/bun`, "/usr/local/bin/bun", `${HOME}/.local/bin/bun`)) {
    return { ...base, loggedIn: false, detail: "bun 미설치(claude_channel 실행에 필요)", fixHint: "bun이 필요합니다: 이 서버 컴퓨터에 bun 설치(https://bun.sh) 후 다시 활성화하세요" };
  }
  try {
    // 파일을 파싱은 하되 키 존재만 본다 — 토큰/계정값은 절대 detail/로그에 넣지 않음.
    const obj = JSON.parse(readFileSync(`${HOME}/.claude.json`, "utf-8"));
    // 키 존재만 보면 oauthAccount가 null/""/{} 여도 통과(false-positive) → 값 truthiness까지 확인.
    // (값 내용은 boolean 판정에만 쓰고 detail/로그엔 절대 넣지 않음)
    const acct = !!obj && typeof obj === "object" ? (obj as Record<string, unknown>).oauthAccount : undefined;
    const loggedIn = acct != null && acct !== "" && !(typeof acct === "object" && Object.keys(acct).length === 0);
    return { ...base, loggedIn, detail: loggedIn ? "claude oauth 로그인 확인됨" : "claude oauth 미로그인(oauthAccount 없음/빈값)" };
  } catch {
    // 파일 없음 / 파싱 실패 → 미로그인으로 처리(값은 노출 안 함).
    return { ...base, loggedIn: false, detail: "claude oauth 미로그인(~/.claude.json 없음/파싱 실패)" };
  }
}

const HERMES_FIX_HINT = `이 서버가 실행되는 컴퓨터 터미널에서 hermes 인증(oauth)을 완료한 뒤 다시 활성화하세요. \`hermes setup\` 또는 \`hermes auth\` 실행 후 재확인하세요. ${RUNTIME_SETUP_DOC}#hermes-agent`;
const HERMES_MISSING_HINT = `hermes CLI가 설치되지 않았습니다. 이 서버 컴퓨터에서 \`curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash\` 로 설치하고 \`hermes setup\` 또는 \`hermes auth\` 로 인증한 뒤 다시 활성화하세요. ${RUNTIME_SETUP_DOC}#hermes-agent`;
// Hermes는 codex와 인증 백엔드가 다르므로 자체 인증 경로만 확인한다. 비밀값은 읽지 않는다.
function checkHermesAuth(): RuntimeAuthResult {
  const base: RuntimeAuthResult = { runtime: "hermes_agent", loggedIn: false, detail: "", fixHint: HERMES_FIX_HINT };
  if (!binaryExists("hermes", `${HOME}/.local/bin/hermes`, "/opt/homebrew/bin/hermes")) {
    return { ...base, loggedIn: false, detail: "hermes CLI 미설치(바이너리 없음)", fixHint: HERMES_MISSING_HINT };
  }
  // 활성화 스크립트가 프로필·plist·토큰 처리에 python3를 사용하므로 실행 전에 의존성을 확인한다.
  if (!binaryExists("python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3")) {
    return { ...base, loggedIn: false, detail: "python3 미설치(hermes 런타임은 python3 필요)", fixHint: `openclaw/hermes 런타임은 python3 가 필요합니다. 이 서버 컴퓨터에 python3 설치 후 다시 활성화하세요. ${RUNTIME_SETUP_DOC}` };
  }
  // 글로벌 인증만 보면 프로필 전용 사용자를 오차단할 수 있어 활성화 스크립트와 같은 seed 출처를 확인한다.
  const loggedIn = hermesAuthExists();
  return { ...base, loggedIn, detail: loggedIn ? "hermes 인증 확인됨(~/.hermes/profiles/*/auth.json 또는 ~/.hermes/auth.json)" : "hermes 미인증(~/.hermes/profiles/*/auth.json·~/.hermes/auth.json 없음)" };
}

/** Codex CLI 상태 명령과 OpenClaw 자체 인증 저장소를 각각 검사한다. */
async function checkCodexAuth(runtime: string): Promise<RuntimeAuthResult> {
  const base: RuntimeAuthResult = { runtime, loggedIn: false, detail: "", fixHint: CODEX_FIX_HINT };
  // openclaw 미설치를 다른 런타임 설치 안내로 오인하지 않도록 자체 CLI를 확인한다.
  if (runtime === "openclaw") {
    // 점검이 실행부와 다른 설치를 보지 않도록 resolveOpenclawBin의 선택값을 후보 맨 앞에 둔다.
    if (!binaryExists("openclaw", ...openclawCliCandidates())) {
      return { ...base, loggedIn: false, detail: "openclaw CLI 미설치(바이너리 없음)", fixHint: `openclaw CLI가 설치되지 않았습니다. 이 서버 컴퓨터에서 \`npm install -g openclaw@latest\` 로 설치하고 \`openclaw onboard --install-daemon\` 으로 인증/게이트웨이 준비 후 다시 활성화하세요. ${RUNTIME_SETUP_DOC}#openclaw` };
    }
    // openclaw enable/disable(setOpenclaw)·activate 스크립트는 openclaw.json 편집에 python3 를 쓴다 → 미설치면 토글이 조용히 실패. 사전 차단.
    if (!binaryExists("python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3")) {
      return { ...base, loggedIn: false, detail: "python3 미설치(openclaw 런타임은 python3 필요)", fixHint: `openclaw/hermes 런타임은 python3 가 필요합니다. 이 서버 컴퓨터에 python3 설치 후 다시 활성화하세요. ${RUNTIME_SETUP_DOC}` };
    }
    // openclaw는 자체 인증을 쓰므로 다른 런타임의 인증 파일로 로그인 여부를 판정하지 않는다.
    const loggedIn = openclawAuthExists();
    return {
      ...base,
      loggedIn,
      detail: loggedIn
        ? "openclaw 인증 확인됨(전역 openclaw.json auth.profiles 또는 per-agent auth-profiles.json)"
        : "openclaw 미인증(전역 openclaw.json auth.profiles가 비어 있고 per-agent auth-profiles.json도 없음)",
      fixHint: loggedIn ? "" : OPENCLAW_FIX_HINT,
    };
  }
  if (!binaryExists("codex", process.env.CODEX_BIN ?? CODEX_BIN, "/opt/homebrew/bin/codex", "/usr/local/bin/codex", `${HOME}/.local/bin/codex`)) {
    // 고정 설치 경로만 보면 Intel·Linux·사용자 경로를 놓치므로 PATH와 플랫폼별 표준 후보를 함께 검사한다.
    return { ...base, loggedIn: false, detail: "codex CLI 미설치(바이너리 없음 — brew install codex 필요)", fixHint: CODEX_MISSING_HINT };
  }
  const bin = resolveCodexBin();
  return bin ? checkCodexCliStatus(bin) : { ...base, detail: "codex CLI 실행파일 없음", fixHint: CODEX_MISSING_HINT };
}

// 인증 사전점검을 정의한 런타임 화이트리스트.
// ⚠️ 신규 런타임(codi류 codex 파생 등)을 추가할 때는 반드시 여기에 등록하고,
//    위 check*Auth 처럼 해당 런타임의 인증 체크 분기를 정의하라.
//    화이트리스트 밖 런타임은 무점검 통과(fail-open)되며 audit/warn 경고만 남는다.
const CODEX_FAMILY = new Set(["codex", "openclaw"]);
const KNOWN_RUNTIMES = new Set(["claude_channel", "hermes_agent", ...CODEX_FAMILY]);

/**
 * 런타임 인증 사전점검. credential 값은 절대 노출하지 않고 존재·status만 본다.
 * 화이트리스트(claude_channel/codex/openclaw/hermes_agent)에 따라 분기한다.
 * 화이트리스트 밖 runtime 은 차단하지 않도록 loggedIn=true 로 통과시키되(false-block 방지),
 * latent 위험(신규 codex 파생이 무점검 통과)을 추적하도록 audit/warn 경고 1줄을 남긴다.
 */
export async function checkRuntimeAuth(runtime: string): Promise<RuntimeAuthResult> {
  if (runtime === "claude_channel") return checkClaudeAuth();
  if (runtime === "hermes_agent") return checkHermesAuth();
  if (CODEX_FAMILY.has(runtime)) return checkCodexAuth(runtime);
  // 화이트리스트 밖 런타임 — 차단하지 않되 무점검 통과를 audit/경고로 남긴다.
  if (!KNOWN_RUNTIMES.has(runtime)) {
    console.warn(`[runtimeAuth] 미정의 런타임 '${runtime}' 인증 사전점검 없이 통과(fail-open). 화이트리스트에 추가하고 인증체크를 정의하라.`);
    appendAuditFile("runtimeAuth", "preflight_unchecked_passthrough", runtime, { reason: "runtime_not_in_whitelist" });
  }
  return { runtime, loggedIn: true, detail: `${runtime}: 인증 사전점검 대상 아님(통과)`, fixHint: "" };
}

/** 설치·실행 의존성·인증을 checkRuntimeAuth와 같은 소스에서 판정한다. */
export async function checkRuntimeReadiness(runtime: string): Promise<RuntimeReadiness> {
  return authResultToReadiness(await checkRuntimeAuth(runtime));
}

/** 주입된 preflight 결과도 동일 계약으로 변환하기 위한 테스트/라우트용 helper. */
export function runtimeReadinessFromAuth(result: RuntimeAuthResult): RuntimeReadiness {
  return authResultToReadiness(result);
}
