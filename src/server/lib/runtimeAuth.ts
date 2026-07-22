// 런타임 인증 preflight (OWNER 2026-06-29): 영입 활성화 전에 claude/codex 로그인 상태를 사전점검한다.
//   = provision(토큰 저장) 후 bundle(활성화) 사이에서 "이 런타임이 oauth 로그인돼 있나"만 본다.
//   미로그인이면 활성화를 막아, tmux headless 프롬프트 갇힘(claude)·exit 1 실패(codex)를 사전에 차단.
//
// 보안: credential 값은 절대 읽지/출력/로그하지 않는다. 파일은 키 존재 여부만, codex는 status 문자열만 본다.
//   토큰/oauth 값을 detail/응답에 절대 넣지 않는다.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { appendAuditFile } from "./auditFile";
import { HOME, OPENCLAW_ROOT } from "./paths";

// codex 풀패스(iTerm alias 깨짐 회피) — reference_codex_binary_path.
const CODEX_BIN = "/opt/homebrew/bin/codex";

/** openclaw 자체 auth store 존재 확인 — 전역 openclaw.json auth.profiles 또는
 *  ~/.openclaw/agents/<agent>/agent/auth-profiles.json 중 하나라도 있으면 인증된 것.
 *  ~/.codex/auth.json(OWNER 머신 심링크)에 의존하면 공개 openclaw 사용자를 오차단하므로 별도 판정.
 *  값은 절대 읽지 않고 파일 존재만 확인. (하네스 fix, OWNER 2026-07-02) */
function openclawAuthExists(): boolean {
  try {
    // (신규 레이아웃 · openclaw ~v2026.6.11+) 전역 `~/.openclaw/openclaw.json` 의 `auth.profiles` 에 인증 저장.
    //   `openclaw configure` 로 구독 로그인하면 per-agent auth-profiles.json 이 안 생기고 여기에만 저장돼,
    //   per-agent 만 보던 기존 탐지가 '로그인했는데 미로그인'으로 오차단했다(BUG8 버전드리프트, OWNER 2026-07-03).
    //   값은 안 읽고 profiles 키 존재만 확인. 실측: 이 머신(v2026.6.10)은 두 레이아웃 공존 → additive 로 둘 다 인정(라이브 무영향).
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

/** hermes 자체 auth 존재 확인 — activate-hermes-agent.sh 는 seed 를 ~/.hermes/profiles/<name>/auth.json 에서
 *  뽑는다(글로벌 ~/.hermes/auth.json 이 아님). 그래서 preflight 도 동일하게 판정해야 divergence(프로필만
 *  있는 사용자 오차단 / 글로벌만 보고 통과 후 스크립트 exit 1)를 막는다.
 *  loggedIn = profiles 하위 임의 프로필의 auth.json 하나라도 존재 OR 글로벌 ~/.hermes/auth.json 존재.
 *  값은 절대 읽지 않고 파일 존재만 확인(openclawAuthExists 패턴 재사용). (하네스 fix, OWNER 2026-07-02) */
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
  fixHint: string; // 미로그인 시 OWNER 안내 문구
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

// plain codex = ~/.codex/auth.json 존재로 빠르게 점검. openclaw는 자체 auth store(전역 auth.profiles 또는 per-agent auth-profiles.json)로
// 별도 판정(공개 사용자엔 ~/.codex 심링크가 없음). hermes는 자체 auth라 checkHermesAuth로 분리.
// (구: `codex login status`는 12s 지연/타임아웃 false-negative로 제거)
const CODEX_FIX_HINT = "이 서버가 실행되는 컴퓨터의 터미널에서 `codex login` 으로 ChatGPT 로그인 후 다시 활성화하세요";
// 바이너리 자체가 없을 때(homebrew cleanup/업데이트로 사라짐 등) — '미로그인'과 구분해 명확히 안내(OWNER 2026-07-01).
const CODEX_MISSING_HINT = "codex CLI가 설치되지 않았습니다. 이 서버 컴퓨터 터미널에서 `brew install codex` 로 설치 후 다시 활성화하세요";
// openclaw 는 자체 auth store(전역 auth.profiles 또는 per-agent auth-profiles.json)로 인증한다 — codex login 이 아님.
const RUNTIME_SETUP_DOC = "절차: skills/b3os/references/runtime-setup.md";
const OPENCLAW_FIX_HINT = `openclaw 인증을 완료하세요(전역 auth.profiles 또는 per-agent auth-profiles.json). 이 서버 컴퓨터에서 \`npm install -g openclaw@latest\` → \`openclaw onboard --install-daemon\` → \`openclaw doctor\` 완료 후 다시 활성화하세요. ${RUNTIME_SETUP_DOC}#openclaw`;
const CLAUDE_FIX_HINT = "이 서버가 실행되는 컴퓨터의 터미널에서 `claude` 를 한 번 실행해 oauth 로그인 후 다시 활성화하세요";
const CLAUDE_MISSING_HINT = "Claude Code CLI가 설치되지 않았습니다. 이 서버 컴퓨터에서 `npm install -g @anthropic-ai/claude-code` 로 설치하고 `claude` 를 실행해 로그인한 뒤 다시 활성화하세요";

/** 바이너리 존재 확인 — Bun.which(PATH) ∪ 흔한 경로. launchd 제한 PATH서도 잡히게 고정경로 병행. 미설치 vs 미로그인 구분용(하네스 HIGH, OWNER 2026-07-02). */
function binaryExists(cmd: string, ...paths: string[]): boolean {
  try { if (typeof Bun !== "undefined" && Bun.which(cmd)) return true; } catch { /* Bun.which 실패 무시 */ }
  return paths.some((p) => { try { return existsSync(p); } catch { return false; } });
}

/** 실행할 바이너리 절대경로 해석 — Bun.which(PATH) 우선, 없으면 첫 존재 경로. 없으면 null. */
function resolveBinPath(cmd: string, ...paths: string[]): string | null {
  try { const w = (typeof Bun !== "undefined" && Bun.which) ? Bun.which(cmd) : null; if (w) return w; } catch { /* ignore */ }
  for (const p of paths) { try { if (p && existsSync(p)) return p; } catch { /* ignore */ } }
  return null;
}

/** 바이너리가 '실제로 실행되는지' 검증 — `<bin> --version` 을 돌려 (존재+실행가능+미격리)를 확인.
 *  파일 존재만으론 부족: macOS XProtect 격리·코드서명 인증서 폐기 시 파일은 있어도 실행이 차단돼(SIGKILL/ENOENT),
 *  나중에 불투명한 first-model-call exit_null 만 남긴다(BUG6, OWNER 2026-07-03). 값/출력은 안 봄(stdio ignore). */
function binaryRunnable(bin: string): { ok: boolean; reason: string } {
  try {
    const r = spawnSync(bin, ["--version"], { timeout: 5000, stdio: "ignore" });
    if (r.error) {
      const code = (r.error as NodeJS.ErrnoException).code;
      return { ok: false, reason: code === "ENOENT" ? "실행파일 없음(ENOENT)" : (r.error as Error).message };
    }
    if (r.signal) return { ok: false, reason: `시그널 종료(${r.signal}) — XProtect 격리/인증서 폐기 가능` };
    if (typeof r.status === "number" && r.status !== 0) return { ok: false, reason: `비정상 종료(exit ${r.status})` };
    return { ok: true, reason: "" };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

const CODEX_UNRUNNABLE_HINT = "codex 바이너리가 설치돼 있지만 실행되지 않습니다 — macOS XProtect 격리 또는 OpenAI 코드서명 인증서 폐기 가능성. 이 서버 컴퓨터 터미널에서 `codex --version` 으로 확인하고, 최신 서명본으로 재설치하세요: `brew install codex` (npm 옛 설치가 있으면 먼저 제거).";

/** claude_channel: 바이너리 존재(미설치 구분) → ~/.claude.json 'oauthAccount' 키(로그인 여부). 값은 안 봄. */
function checkClaudeAuth(): RuntimeAuthResult {
  const base: RuntimeAuthResult = { runtime: "claude_channel", loggedIn: false, detail: "", fixHint: CLAUDE_FIX_HINT };
  // ① 바이너리 부재 = 미설치(미로그인과 구분). codex처럼 명확히 안내(하네스: claude는 미설치를 "로그인하세요"로 오안내하던 갭).
  if (!binaryExists("claude", `${HOME}/.claude/local/claude`, "/opt/homebrew/bin/claude", `${HOME}/.bun/bin/claude`, `${HOME}/.local/bin/claude`)) {
    return { ...base, loggedIn: false, detail: "Claude Code CLI 미설치(바이너리 없음)", fixHint: CLAUDE_MISSING_HINT };
  }
  // ①-b 인프라 의존성: claude_channel 은 tmux 세션에 프롬프트를 주입하고(Slack/텔레그램 멘션 전달)
  //     bun 으로 실행된다. tmux 는 macOS 기본 미탑재 → 없으면 주입이 조용히 실패하고 28s poller
  //     타임아웃(오해 유발)으로만 나타난다. 여기서 미리 명확히 안내(하네스 fix, OWNER 2026-07-02).
  if (!binaryExists("tmux", process.env.TMUX_BIN ?? "/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux")) {
    return { ...base, loggedIn: false, detail: "tmux 미설치(claude_channel 주입에 필요)", fixHint: "tmux가 필요합니다: 이 서버 컴퓨터 터미널에서 `brew install tmux`(또는 OS 패키지 매니저)로 설치 후 다시 활성화하세요" };
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
/** hermes_agent: 바이너리 존재(미설치 구분) → 자체 auth(~/.hermes/auth.json). codex와 별개 백엔드라 ~/.codex 프록시 판정 금지(하네스). 값 미열람. OWNER 2026-07-01. */
function checkHermesAuth(): RuntimeAuthResult {
  const base: RuntimeAuthResult = { runtime: "hermes_agent", loggedIn: false, detail: "", fixHint: HERMES_FIX_HINT };
  if (!binaryExists("hermes", `${HOME}/.local/bin/hermes`, "/opt/homebrew/bin/hermes")) {
    return { ...base, loggedIn: false, detail: "hermes CLI 미설치(바이너리 없음)", fixHint: HERMES_MISSING_HINT };
  }
  // activate-hermes-agent.sh 는 프로필 seed 파생/plist 생성/토큰 주입에 python3 를 쓴다(steps 2/3/5) → 미설치면
  // 활성화가 조용히 실패. openclaw 분기와 동일하게 사전 차단(하네스 fix, OWNER 2026-07-02).
  if (!binaryExists("python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3")) {
    return { ...base, loggedIn: false, detail: "python3 미설치(hermes 런타임은 python3 필요)", fixHint: `openclaw/hermes 런타임은 python3 가 필요합니다. 이 서버 컴퓨터에 python3 설치 후 다시 활성화하세요. ${RUNTIME_SETUP_DOC}` };
  }
  // 인증 판정: activate 스크립트가 seed 를 ~/.hermes/profiles/*/auth.json 에서 뽑으므로 동일하게 판정한다
  // (프로필만 있는 사용자 오차단 / 글로벌만 보고 통과 후 exit 1 하는 divergence 제거, 하네스 fix, OWNER 2026-07-02).
  const loggedIn = hermesAuthExists();
  return { ...base, loggedIn, detail: loggedIn ? "hermes 인증 확인됨(~/.hermes/profiles/*/auth.json 또는 ~/.hermes/auth.json)" : "hermes 미인증(~/.hermes/profiles/*/auth.json·~/.hermes/auth.json 없음)" };
}

/** codex/openclaw: ChatGPT oauth 백엔드 공유(~/.codex/auth.json — openclaw는 심링크). 존재만 본다. */
async function checkCodexAuth(runtime: string): Promise<RuntimeAuthResult> {
  const base: RuntimeAuthResult = { runtime, loggedIn: false, detail: "", fixHint: CODEX_FIX_HINT };
  // ① 바이너리 부재 감지 — 런타임별 CLI를 확인(openclaw는 codex가 아니라 openclaw 바이너리. 하네스: openclaw 미설치를 "brew reinstall codex"로 오안내하던 갭). 미설치 vs 미로그인 구분.
  if (runtime === "openclaw") {
    if (!binaryExists("openclaw", "/opt/homebrew/bin/openclaw", `${HOME}/.local/bin/openclaw`)) {
      return { ...base, loggedIn: false, detail: "openclaw CLI 미설치(바이너리 없음)", fixHint: `openclaw CLI가 설치되지 않았습니다. 이 서버 컴퓨터에서 \`npm install -g openclaw@latest\` 로 설치하고 \`openclaw onboard --install-daemon\` 으로 인증/게이트웨이 준비 후 다시 활성화하세요. ${RUNTIME_SETUP_DOC}#openclaw` };
    }
    // openclaw enable/disable(setOpenclaw)·activate 스크립트는 openclaw.json 편집에 python3 를 쓴다 → 미설치면 토글이 조용히 실패. 사전 차단(OWNER 2026-07-02).
    if (!binaryExists("python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3")) {
      return { ...base, loggedIn: false, detail: "python3 미설치(openclaw 런타임은 python3 필요)", fixHint: `openclaw/hermes 런타임은 python3 가 필요합니다. 이 서버 컴퓨터에 python3 설치 후 다시 활성화하세요. ${RUNTIME_SETUP_DOC}` };
    }
    // ② openclaw 로그인 여부 = 전역 openclaw.json auth.profiles 또는 per-agent auth-profiles.json 존재.
    //    ~/.codex/auth.json 은 OWNER 머신 심링크라 공개 openclaw 사용자엔 없음 → 그걸로 판정하면 오차단.
    //    openclaw 는 codex login 을 안 거치고 자체 인증하므로 openclaw 소스로만 판정(하네스 fix, OWNER 2026-07-02).
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
    // 아키텍처/OS 무관 감지(하네스 HIGH, OWNER 2026-07-02): Bun.which(PATH) ∪ Apple-Silicon(/opt/homebrew) ∪ Intel(/usr/local) ∪ ~/.local. 고정경로 하나로 판정하면 Intel/Linux서 정상 codex를 '미설치'로 오판→활성화 차단.
    return { ...base, loggedIn: false, detail: "codex CLI 미설치(바이너리 없음 — brew install codex 필요)", fixHint: CODEX_MISSING_HINT };
  }
  // ①-b 바이너리 실행 검증(BUG6, OWNER 2026-07-03) — 존재하지만 실행 불가(macOS XProtect 격리·OpenAI 인증서 폐기)면
  //   preflight를 통과한 뒤 first-model-call에서 불투명한 exit_null로만 실패해 원인 진단이 안 된다. `codex --version`을
  //   실제 실행해 실행가능·미격리를 확인하고, 실패 시 원인 명확한 fixHint를 준다.
  {
    const cbin = resolveBinPath("codex", process.env.CODEX_BIN ?? CODEX_BIN, "/opt/homebrew/bin/codex", "/usr/local/bin/codex", `${HOME}/.local/bin/codex`);
    const run = cbin ? binaryRunnable(cbin) : { ok: false, reason: "경로 해석 실패" };
    if (!run.ok) {
      return { ...base, loggedIn: false, detail: `codex 바이너리 실행 불가: ${run.reason}`, fixHint: CODEX_UNRUNNABLE_HINT };
    }
  }
  // ② 로그인 여부 = ~/.codex/auth.json 존재(빠른 로컬 체크, 값 미열람). `codex login status`는 온라인검증이라 느리고(측정 12s+)
  //    preflight 타임아웃(8s)에 걸려 false '미로그인' → codex 계열 영입이 preflight서 막히던 근본버그(OWNER 2026-07-01).
  //    plain codex 는 ~/.codex/auth.json 존재 체크가 유효. (openclaw는 위에서 자체 store 로, hermes는 checkHermesAuth로 분리.) 온라인 무응답은 exec 시점에서 처리.
  const authFile = `${HOME}/.codex/auth.json`;
  const loggedIn = existsSync(authFile);
  return { ...base, loggedIn, detail: loggedIn ? "ChatGPT oauth 로그인 확인됨(auth.json)" : "ChatGPT oauth 미로그인(auth.json 없음 — 터미널서 codex login 후 재시도)" };
}

// 인증 사전점검을 정의한 런타임 화이트리스트.
// ⚠️ 신규 런타임(codi류 codex 파생 등)을 추가할 때는 반드시 여기에 등록하고,
//    위 check*Auth 처럼 해당 런타임의 인증 체크 분기를 정의하라.
//    화이트리스트 밖 런타임은 무점검 통과(fail-open)되며 audit/warn 경고만 남는다.
const CODEX_FAMILY = new Set(["codex", "openclaw"]); // checkCodexAuth 로 분기(같은 바이너리군). 단 인증 소스는 다름: plain codex=~/.codex/auth.json, openclaw=전역 auth.profiles 또는 per-agent auth-profiles.json. hermes는 분리(checkHermesAuth).
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
