// Claude 봇 활성화용 토큰 파일과 LaunchAgent를 준비한다. 토큰은 파일에만 저장하며 로그·응답에 노출하지 않는다.
import { writeFileSync, mkdirSync, chmodSync, existsSync, rmSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { claudeTelegramLaunchdLabel } from "../../lib/agentControl";
import { MEMBERS_ROOT, REPO_ROOT } from "../../lib/personaTemplates";
import { getCaptureGroupId } from "../../lib/captureConfig";

const HOME = process.env.HOME ?? "";
// 시작 스크립트는 저장소의 REPO_ROOT에서 찾아 개인 스킬 설치 없이 새 클론에서도 활성화할 수 있게 한다.
const START_SCRIPT = `${REPO_ROOT}/src/server/runtimes/claude/start-telegram-channel.sh`;
/** 런처 경로를 정본 하나로 유지해 활성화와 plist drift 검사가 서로 다른 사본을 참조하지 않게 한다. */
export const CLAUDE_START_SCRIPT = START_SCRIPT;

export interface ClaudeBridgePaths {
  id: string;
  label: string;
  plist: string;
  stateDir: string; // ~/.claude/channels/telegram-<id>
  envFile: string; // stateDir/.env
  botPid: string; // stateDir/bot.pid
}

/** id 형식 가드(경로/rm 안전). 비허용이면 throw. */
function assertId(id: string): void {
  if (!/^[a-z0-9_-]+$/i.test(id)) throw new Error(`invalid claude member id: ${id}`);
}

export function claudeBridgePaths(id: string): ClaudeBridgePaths {
  assertId(id);
  const label = claudeTelegramLaunchdLabel(id);
  const stateDir = `${HOME}/.claude/channels/telegram-${id}`;
  return {
    id,
    label,
    plist: `${HOME}/Library/LaunchAgents/${label}.plist`,
    stateDir,
    envFile: `${stateDir}/.env`,
    botPid: `${stateDir}/bot.pid`,
  };
}

/** 토큰은 0600 파일에 tmp+rename으로 원자 저장한다. 직접 잘라 쓰면 poller가 빈 파일을 읽어 종료할 수 있다. */
export function placeClaudeToken(id: string, token: string): string {
  const p = claudeBridgePaths(id);
  mkdirSync(p.stateDir, { recursive: true });
  const tmp = `${p.envFile}.tmp`;
  writeFileSync(tmp, `TELEGRAM_BOT_TOKEN=${token.trim()}\n`, { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* best-effort */ }
  renameSync(tmp, p.envFile); // 원자적 교체 — 부분/빈 파일 창 없음
  return p.envFile;
}

function renderClaudePlist(p: ClaudeBridgePaths): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key><string>${p.label}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    <string>${START_SCRIPT}</string>`,
    `    <string>${p.id}</string>`,
    `  </array>`,
    `  <key>RunAtLoad</key><true/>`,
    `  <key>KeepAlive</key><false/>`,
    `  <key>StandardOutPath</key><string>/tmp/${p.label}.out.log</string>`,
    `  <key>StandardErrorPath</key><string>/tmp/${p.label}.err.log</string>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    `    <key>PATH</key><string>${HOME}/.bun/bin:${HOME}/.local/bin:${HOME}/.claude/local:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>`,
    `    <key>HOME</key><string>${HOME}</string>`,
    // WORKDIR를 명시해야 공개 설치의 멤버 루트에서도 자기 persona·규칙을 읽으며, 개발 폴더 기본값으로 잘못 시작하지 않는다.
    `    <key>WORKDIR</key><string>${MEMBERS_ROOT}/${p.id}</string>`,
    ...(process.env.B3RYS_HOME ? [`    <key>B3RYS_HOME</key><string>${process.env.B3RYS_HOME}</string>`] : []),
    `  </dict>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

/** LaunchAgent plist 생성(setClaude bootstrap 대상). idempotent — 파일 쓰기만, launchctl은 setAgentEnabled가. */
export function writeClaudeBridgeFiles(id: string): ClaudeBridgePaths {
  const p = claudeBridgePaths(id);
  mkdirSync(dirname(p.plist), { recursive: true });
  mkdirSync(p.stateDir, { recursive: true });
  writeFileSync(p.plist, renderClaudePlist(p), "utf-8");
  return p;
}

/** 1:1 DM 미답변을 막는 Stop 훅은 멤버 작업폴더에만 설치해 사용자 전역 설정을 건드리지 않는다. 기존 Stop 배열과 중복 없이 병합하며 실패는 활성화를 막지 않는다. */
/** reply-guard 보냄 표식을 거는 도구 — 텔레그램 reply·edit_message. */
export const REPLY_GUARD_MARK_MATCHER = "mcp__plugin_telegram_telegram__reply|mcp__plugin_telegram_telegram__edit_message";

export function installReplyGuardHook(id: string, roots?: { membersRoot?: string; repoRoot?: string }): void {
  assertId(id);
  const membersRoot = roots?.membersRoot ?? MEMBERS_ROOT;
  const repoRoot = roots?.repoRoot ?? REPO_ROOT;
  const dotClaude = `${membersRoot}/${id}/.claude`;
  const hookDst = `${dotClaude}/hooks/reply-guard.py`;
  const settingsPath = `${dotClaude}/settings.json`;
  const src = `${repoRoot}/src/server/runtimes/claude/reply-guard.py`;
  try {
    if (!existsSync(src)) return; // 소스 없으면 skip
    mkdirSync(`${dotClaude}/hooks`, { recursive: true });
    writeFileSync(hookDst, readFileSync(src, "utf-8"));
    try { chmodSync(hookDst, 0o755); } catch { /* best-effort */ }
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try { const p = JSON.parse(readFileSync(settingsPath, "utf-8")); if (p && typeof p === "object") settings = p; } catch { /* keep {} */ }
    }
    const hooks = (settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}) as Record<string, unknown>;
    const stop = Array.isArray(hooks.Stop) ? (hooks.Stop as unknown[]) : [];
    if (!JSON.stringify(stop).includes("reply-guard.py")) {
      stop.push({ hooks: [{ type: "command", command: `python3 "${hookDst}"` }] });
    }
    hooks.Stop = stop;
    // 보냄 표식(PostToolUse) — transcript 기록 지연과 무관하게 "이번 턴 보냈다" 를 Stop 판정에 넘긴다.
    const post = Array.isArray(hooks.PostToolUse) ? (hooks.PostToolUse as unknown[]) : [];
    if (!JSON.stringify(post).includes("reply-guard.py")) {
      post.push({ matcher: REPLY_GUARD_MARK_MATCHER, hooks: [{ type: "command", command: `python3 "${hookDst}" --mark` }] });
    }
    hooks.PostToolUse = post;
    settings.hooks = hooks;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  } catch { /* best-effort */ }
}

/** 진행 훅은 멤버별 settings.json에 설치해 다른 봇·사용자에게 영향을 주지 않는다. 채팅은 TELEGRAM_STATE_DIR에서 읽으며 이벤트별로 멱등 조정한다.
 * 설치는 best-effort이며 roots 주입으로 시험의 파일 접근을 격리한다. */
export function installProgressHook(id: string, roots?: { membersRoot?: string; repoRoot?: string }): void {
  assertId(id);
  const membersRoot = roots?.membersRoot ?? MEMBERS_ROOT;
  const repoRoot = roots?.repoRoot ?? REPO_ROOT;
  const dotClaude = `${membersRoot}/${id}/.claude`;
  const hookDst = `${dotClaude}/hooks/telegram-progress.py`;
  const settingsPath = `${dotClaude}/settings.json`;
  const src = `${repoRoot}/hooks/telegram-progress.py`;
  try {
    if (!existsSync(src)) return; // 소스 없으면 skip
    mkdirSync(`${dotClaude}/hooks`, { recursive: true });
    writeFileSync(hookDst, readFileSync(src, "utf-8"));
    try { chmodSync(hookDst, 0o755); } catch { /* best-effort */ }
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try { const p = JSON.parse(readFileSync(settingsPath, "utf-8")); if (p && typeof p === "object") settings = p; } catch { /* keep {} */ }
    }
    const hooks = (settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}) as Record<string, unknown>;
    // 파일만 갱신하고 커맨드를 남기면 필요한 env가 빠져 owner-skip이 무력화되므로 기존 배선도 현재 값과 대조해 교체한다.
    const reconcile = (evt: string, matcher: string, mode: string) => {
      const arr = Array.isArray(hooks[evt]) ? (hooks[evt] as unknown[]) : [];
      // 훅은 저장소 밖에서 실행되므로 B3OS_ROOT로 설정 경로를, OWNER_GATE_SELF로 자기 신원을 명시한다. 그룹 ID나 다른 팀원 신원을 추측하지 않는다.
      const command = `B3OS_ROOT="${repoRoot}" OWNER_GATE_SELF="${id}" python3 "${hookDst}" ${mode}`;
      const entry: Record<string, unknown> = { hooks: [{ type: "command", command }] };
      if (matcher) entry.matcher = matcher; // Stop 은 matcher 없음(글로벌 배선과 동형)
      const idx = arr.findIndex((e) => JSON.stringify(e).includes("telegram-progress.py"));
      if (idx < 0) arr.push(entry);
      else if (JSON.stringify(arr[idx]) !== JSON.stringify(entry)) arr[idx] = entry;
      hooks[evt] = arr;
    };
    reconcile("PreToolUse", "*", "pre");
    reconcile("Stop", "", "stop");
    reconcile("PreCompact", "*", "compact");
    // react 훅을 명부에서 얻은 멤버별로 설치해야 새 팀원도 올바른 방 컨텍스트를 기록하고 진행표시를 다른 방에 보내지 않는다.
    reconcile("UserPromptSubmit", "", "react");
    settings.hooks = hooks;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  } catch { /* best-effort */ }
}

/** 이미 진행 훅이 설치된 멤버만 파일·커맨드를 정본과 맞춘다. 미설치 멤버에는 새로 설치하지 않아 운영 중 배선의 보호 경계를 유지한다. */
export function repairProgressHook(id: string, roots?: { membersRoot?: string; repoRoot?: string }): void {
  assertId(id);
  const settingsPath = `${roots?.membersRoot ?? MEMBERS_ROOT}/${id}/.claude/settings.json`;
  try {
    if (!existsSync(settingsPath)) return;
    if (!readFileSync(settingsPath, "utf-8").includes("telegram-progress.py")) return; // 안 깔린 멤버는 건드리지 않는다
  } catch { return; }
  installProgressHook(id, roots);
}

/** 답장 대상 봇이 다른 멘션의 메시지를 받아도 작업을 시작하지 않도록 라우터의 담당자 판정을 훅으로 강제한다.
 * 저장소 밖에서 설정을 찾도록 B3OS_ROOT를 전달하며, 설치 실패는 활성화를 막지 않고 roots 주입으로 시험을 격리한다. */
export function installOwnerGateHook(id: string, roots?: { membersRoot?: string; repoRoot?: string }): void {
  assertId(id);
  const membersRoot = roots?.membersRoot ?? MEMBERS_ROOT;
  const repoRoot = roots?.repoRoot ?? REPO_ROOT;
  const dotClaude = `${membersRoot}/${id}/.claude`;
  const hookDst = `${dotClaude}/hooks/telegram-owner-gate.py`;
  const settingsPath = `${dotClaude}/settings.json`;
  const src = `${repoRoot}/hooks/telegram-owner-gate.py`;
  try {
    if (!existsSync(src)) return; // 소스 없으면 skip
    mkdirSync(`${dotClaude}/hooks`, { recursive: true });
    writeFileSync(hookDst, readFileSync(src, "utf-8"));
    try { chmodSync(hookDst, 0o755); } catch { /* best-effort */ }
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try { const p = JSON.parse(readFileSync(settingsPath, "utf-8")); if (p && typeof p === "object") settings = p; } catch { /* keep {} */ }
    }
    const hooks = (settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}) as Record<string, unknown>;
    const arr = Array.isArray(hooks.UserPromptSubmit) ? (hooks.UserPromptSubmit as unknown[]) : [];
    // 기존 커맨드도 현재 값으로 맞추며 OWNER_GATE_SELF를 반드시 전달한다. 자기 신원을 다른 팀원으로 추측하면 게이트가 반대로 판정할 수 있다.
    const command = `B3OS_ROOT="${repoRoot}" OWNER_GATE_SELF="${id}" python3 "${hookDst}"`;
    const entry = { hooks: [{ type: "command", command }] };
    const idx = arr.findIndex((e) => JSON.stringify(e).includes("telegram-owner-gate.py"));
    if (idx < 0) arr.push(entry);
    else if (JSON.stringify(arr[idx]) !== JSON.stringify(entry)) arr[idx] = entry;
    hooks.UserPromptSubmit = arr;
    settings.hooks = hooks;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  } catch { /* best-effort */ }
}

/** owner-gate는 미설치 멤버에도 추가해야 담당자가 아닌 봇의 작업 시작을 막을 수 있다.
 * 기존 설치만 수리하는 progress·reply-guard와 의도적으로 다르며, 설치된 경우에는 멱등 교체한다. */
export function ensureOwnerGateHook(id: string, roots?: { membersRoot?: string; repoRoot?: string }): void {
  assertId(id);
  installOwnerGateHook(id, roots);
}

/** 설치된 reply-guard만 파일을 갱신하며 새 배선은 추가하지 않아 운영 중 멤버를 보호한다. 활성화를 반복하지 않아도 훅 사본을 정본과 맞춘다. */
export function repairReplyGuardHook(id: string, roots?: { membersRoot?: string; repoRoot?: string }): void {
  assertId(id);
  const settingsPath = `${roots?.membersRoot ?? MEMBERS_ROOT}/${id}/.claude/settings.json`;
  try {
    if (!existsSync(settingsPath)) return;
    if (!readFileSync(settingsPath, "utf-8").includes("reply-guard.py")) return; // 안 깔린 멤버는 건드리지 않는다
  } catch { return; }
  installReplyGuardHook(id, roots);
}

/** telegram-progress 훅 제거 — settings.json 의 PreToolUse/Stop/PreCompact 에서 progress 항목 제거 + 훅 파일 삭제. best-effort. */
export function uninstallProgressHook(id: string): void {
  assertId(id);
  const dotClaude = `${MEMBERS_ROOT}/${id}/.claude`;
  const settingsPath = `${dotClaude}/settings.json`;
  const hookDst = `${dotClaude}/hooks/telegram-progress.py`;
  try {
    if (existsSync(settingsPath)) {
      const p = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const hooks = (p?.hooks && typeof p.hooks === "object" ? p.hooks : {}) as Record<string, unknown>;
      for (const evt of ["PreToolUse", "Stop", "PreCompact"]) {
        if (Array.isArray(hooks[evt])) {
          hooks[evt] = (hooks[evt] as unknown[]).filter((e) => !JSON.stringify(e).includes("telegram-progress.py"));
          if ((hooks[evt] as unknown[]).length === 0) delete hooks[evt];
        }
      }
      p.hooks = hooks;
      writeFileSync(settingsPath, JSON.stringify(p, null, 2) + "\n");
    }
  } catch { /* best-effort */ }
  try { rmSync(hookDst, { force: true }); } catch { /* best-effort */ }
}

// tg-reply-recovery 훅은 제거됨. 훅이 팀원 '대신' 텔레그램에 보내는 [A] 패턴이었다 —
// 서버가 팀원 턴 본문을 대신 게시하던 것을 걷어낸 것과 같은 이유로 삭제. 팀원이 안 보냈으면 안 보낸 것이고,
// 그 사실을 팀원 본인에게 되돌려 주는 것(reply-guard)까지가 시스템의 몫이다. 대신 말해 주지는 않는다.

/** Tier2는 답 마커를 훅에서 추출·전송하는 별도 경로다. 멤버 작업폴더에만 설치하며 토큰이 없으면 안전하게 폴백한다.
 * 기본 dryRun은 실전송 없이 로그만 남기고, 명시적으로 live를 선택한 경우에만 전송한다. */
export function installOutboundHook(id: string, opts: { dryRun?: boolean } = {}): void {
  assertId(id);
  const dotClaude = `${MEMBERS_ROOT}/${id}/.claude`;
  const hookDst = `${dotClaude}/hooks/tg-outbound.py`;
  const settingsPath = `${dotClaude}/settings.json`;
  const src = `${REPO_ROOT}/src/server/runtimes/claude/tg-outbound.py`;
  const tokenEnv = `${homedir()}/.claude/channels/telegram-${id}/.env`;
  try {
    if (!existsSync(src)) return; // 소스 없으면 skip
    mkdirSync(`${dotClaude}/hooks`, { recursive: true });
    writeFileSync(hookDst, readFileSync(src, "utf-8"));
    try { chmodSync(hookDst, 0o755); } catch { /* best-effort */ }
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try { const p = JSON.parse(readFileSync(settingsPath, "utf-8")); if (p && typeof p === "object") settings = p; } catch { /* keep {} */ }
    }
    const hooks = (settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}) as Record<string, unknown>;
    const stop = Array.isArray(hooks.Stop) ? (hooks.Stop as unknown[]) : [];
    // dryRun 기본값은 true다. 설치 인자 누락으로 실제 답이 발송되거나 유실되지 않도록 명시적인 false만 실전송을 허용한다.
    const dry = opts.dryRun === false ? "" : "TG_OUTBOUND_DRYRUN=1 ";
    if (!JSON.stringify(stop).includes("tg-outbound.py")) {
      stop.push({ hooks: [{ type: "command", command: `${dry}TG_OUTBOUND_ENV="${tokenEnv}" python3 "${hookDst}"` }] });
    }
    hooks.Stop = stop;
    settings.hooks = hooks;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  } catch { /* best-effort */ }
}

/** tg-outbound 훅 제거 (revertTier2/롤백용) — settings.json Stop에서 tg-outbound 항목 제거 + 훅 파일 삭제. best-effort. */
export function uninstallOutboundHook(id: string): void {
  assertId(id);
  const dotClaude = `${MEMBERS_ROOT}/${id}/.claude`;
  const settingsPath = `${dotClaude}/settings.json`;
  const hookDst = `${dotClaude}/hooks/tg-outbound.py`;
  try {
    if (existsSync(settingsPath)) {
      const p = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
      const hooks = (p.hooks && typeof p.hooks === "object" ? p.hooks : {}) as Record<string, unknown>;
      const stop = Array.isArray(hooks.Stop) ? (hooks.Stop as unknown[]) : [];
      hooks.Stop = stop.filter((h) => !JSON.stringify(h).includes("tg-outbound.py"));
      p.hooks = hooks;
      writeFileSync(settingsPath, JSON.stringify(p, null, 2) + "\n");
    }
    if (existsSync(hookDst)) rmSync(hookDst);
  } catch { /* best-effort */ }
}

/** Stop 훅에서 특정 파일 훅 제거(+파일 삭제). uninstallOutboundHook 로직 일반화(Tier2 live 승격 시 reply-guard/recovery 제거). */
function uninstallStopHookByFile(id: string, hookFile: string, membersRoot: string = MEMBERS_ROOT): void {
  assertId(id);
  const dotClaude = `${membersRoot}/${id}/.claude`;
  const settingsPath = `${dotClaude}/settings.json`;
  const hookDst = `${dotClaude}/hooks/${hookFile}`;
  try {
    if (existsSync(settingsPath)) {
      const p = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
      const hooks = (p.hooks && typeof p.hooks === "object" ? p.hooks : {}) as Record<string, unknown>;
      const stop = Array.isArray(hooks.Stop) ? (hooks.Stop as unknown[]) : [];
      hooks.Stop = stop.filter((h) => !JSON.stringify(h).includes(hookFile));
      p.hooks = hooks;
      writeFileSync(settingsPath, JSON.stringify(p, null, 2) + "\n");
    }
    if (existsSync(hookDst)) rmSync(hookDst);
  } catch { /* best-effort */ }
}

/** reply-guard Stop 훅 제거 — Tier2 live(마커모드)에선 reply 도구를 안 써 매턴 block 방지. */
export function uninstallReplyGuardHook(id: string, roots?: { membersRoot?: string }): void {
  assertId(id);
  const membersRoot = roots?.membersRoot ?? MEMBERS_ROOT;
  // PostToolUse 표식 배선도 걷는다 — 파일만 지우면 reply 때마다 없는 파일을 부르는 훅 오류가 난다.
  try {
    const settingsPath = `${membersRoot}/${id}/.claude/settings.json`;
    if (existsSync(settingsPath)) {
      const p = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
      const hooks = (p.hooks && typeof p.hooks === "object" ? p.hooks : {}) as Record<string, unknown>;
      if (Array.isArray(hooks.PostToolUse)) {
        hooks.PostToolUse = (hooks.PostToolUse as unknown[]).filter((h) => !JSON.stringify(h).includes("reply-guard.py"));
        p.hooks = hooks;
        writeFileSync(settingsPath, JSON.stringify(p, null, 2) + "\n");
      }
    }
  } catch { /* best-effort */ }
  uninstallStopHookByFile(id, "reply-guard.py", membersRoot);
}

/** tg-reply-recovery Stop 훅 제거 — 훅 자체가 삭제됐다. 이 함수는 이미 설치된 멤버에서
 *  등록을 걷어내는 self-heal 용으로만 남는다(활성화·퇴사 때 호출). 잔재가 다 걷히면 같이 지운다. */
export function uninstallRecoveryHook(id: string): void { uninstallStopHookByFile(id, "tg-reply-recovery.py"); }

/** launchctl bootout은 분리된 tmux를 종료하지 않으므로 off·퇴사 때 봇 세션도 직접 종료한다. */
export function killClaudeTmux(id: string): void {
  assertId(id);
  try { spawnSync("tmux", ["kill-session", "-t", `claude-${id}`], { stdio: "ignore" }); } catch { /* best-effort */ }
}

// auto-reconnect 구현은 pollerHealth.ts 로 옮겼다 — 재시작 경로(agentControl)도 같은 복구를 써야 하는데
// launcher 는 agentControl 을 import 하고 있어서 반대 방향 import 가 순환이 된다. 여기서는 재-export 만 한다.
export { reconnectClaudeTelegram } from "./pollerHealth";


/** 퇴사 정리 — tmux 세션 kill + plist + (removeToken 시) 채널 상태 dir 전체 + ~/.claude.json projects 항목.
 * 재영입 clean: 채널 dir(.env·access.json·inbox 등)·trust 항목이 남으면 재영입 시 stale 설정 잔재. launchctl bootout은 호출자가 먼저. */
export function removeClaudeBridgeFiles(id: string, opts: { removeToken?: boolean } = {}): void {
  const p = claudeBridgePaths(id);
  killClaudeTmux(id); // detached tmux 봇 종료(고아 방지)
  try { if (existsSync(p.plist)) rmSync(p.plist); } catch { /* best-effort */ }
  if (opts.removeToken) {
    // 채널 상태 dir 전체 제거(.env·access.json·inbox·progress·turnch) — 재영입 시 stale access.json/토큰 잔재 방지.
    try { if (existsSync(p.stateDir)) rmSync(p.stateDir, { recursive: true }); } catch { /* best-effort */ }
    // ~/.claude.json projects 항목 제거(seedClaudeTrust가 넣은 것).
    try {
      const cj = `${HOME}/.claude.json`; const ws = `${MEMBERS_ROOT}/${id}`;
      if (existsSync(cj)) { const data = JSON.parse(readFileSync(cj, "utf-8")); if (data.projects && data.projects[ws]) { delete data.projects[ws]; writeFileSync(cj, JSON.stringify(data, null, 2), "utf-8"); } }
    } catch { /* best-effort */ }
  }
}

/** 신규 작업폴더의 trust 프롬프트가 무인 기동을 멈추지 않도록 ~/.claude.json에 신뢰·온보딩 완료 상태를 시드한다. */
export function seedClaudeTrust(id: string): void {
  assertId(id);
  const ws = `${MEMBERS_ROOT}/${id}`;
  const cj = `${HOME}/.claude.json`;
  try {
    const data = existsSync(cj) ? JSON.parse(readFileSync(cj, "utf-8")) : {};
    data.projects = data.projects ?? {};
    data.projects[ws] = { ...(data.projects[ws] ?? {}), hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
    writeFileSync(cj, JSON.stringify(data, null, 2), "utf-8");
  } catch { /* best-effort */ }
}

/** 기존 멤버의 오너 DM 허용값을 새 봇에 시드하되 이미 승인된 대상 파일은 보존한다.
 * 참조 봇이 없는 첫 멤버는 pairing 기본값으로 그룹을 열고 DM은 수동 승인으로 제한한다. */
export function seedClaudeAccess(id: string): void {
  assertId(id);
  const p = claudeBridgePaths(id);
  try {
    const targetAccess = `${p.stateDir}/access.json`;
    if (existsSync(targetAccess)) {
      try {
        const current = JSON.parse(readFileSync(targetAccess, "utf-8"));
        const approved = Array.isArray(current.allowFrom)
          && current.allowFrom.some((senderId: unknown) => /^\d+$/.test(String(senderId).trim()));
        if (approved) return; // 재활성화로 기존 승인·그룹·pending 정책을 초기값에 덮어쓰지 않는다.
      } catch { /* 손상 파일은 아래 정상 시드로 복구 */ }
    }
    let ownerId: string | null = null;
    let refGroups: Record<string, unknown> = {}; // 참조 봇의 그룹 정책도 복사해야 새 봇이 팀방 응답 게이트를 통과한다.
    const chDir = `${HOME}/.claude/channels`;
    if (existsSync(chDir)) {
      for (const d of readdirSync(chDir)) {
        if (d === `telegram-${id}` || !d.startsWith("telegram-")) continue;
        const aj = `${chDir}/${d}/access.json`;
        if (!existsSync(aj)) continue;
        try {
          const a = JSON.parse(readFileSync(aj, "utf-8"));
          if (Array.isArray(a.allowFrom) && a.allowFrom.length) {
            ownerId = String(a.allowFrom[0]);
            if (a.groups && typeof a.groups === "object") refGroups = a.groups; // 팀방+DM그룹 정책 시드
            break;
          }
        } catch { /* skip bad file */ }
      }
    }
    mkdirSync(p.stateDir, { recursive: true });
    // ackReaction: 봇이 메시지 받으면 👀 리액션(server.ts:950 access.ackReaction 있어야 붙음). 없으면 claude 봇 리액션 안 뜸(codex는 브리지 경로라 별개).
    if (ownerId) {
      // 참조봇 있음: owner DM allowlist + 참조봇 groups 복사.
      writeFileSync(targetAccess, JSON.stringify({ dmPolicy: "allowlist", allowFrom: [ownerId], groups: refGroups, pending: {}, ackReaction: "👀" }, null, 2), "utf-8");
    } else {
      // 첫 멤버도 그룹 응답이 가능하도록 capture 그룹을 시드한다. 오너 DM은 수동 pairing으로 제한한다.
      const gid = getCaptureGroupId();
      const groups = gid ? { [gid]: { requireMention: true, allowFrom: [] as string[] } } : {};
      writeFileSync(targetAccess, JSON.stringify({ dmPolicy: "pairing", allowFrom: [], groups, pending: {}, ackReaction: "👀" }, null, 2), "utf-8");
    }
  } catch { /* best-effort */ }
}

/** 활성 Claude 멤버 ID만 대상으로 새 그룹을 비파괴·원자 병합한다. 전체 재시드는 DM 페어링 상태를 잃게 하므로 사용하지 않는다.
 * 기존 그룹 정책은 보존하고 빈 ID는 건너뛰며, 멤버별 실패를 격리한다. tmp+rename으로 실행 중 봇의 반쪽 읽기를 막는다. */
export function seedGroupIntoClaudeMembers(gid: string, memberIds: string[], channelsDir: string = `${HOME}/.claude/channels`): void {
  const g = (gid ?? "").trim();
  if (!g || !Array.isArray(memberIds)) return;
  for (const id of memberIds) {
    try {
      if (typeof id !== "string" || !/^[a-z][a-z0-9_-]{1,31}$/.test(id)) continue; // 방어: id 형식(경로조작 차단)
      const aj = `${channelsDir}/telegram-${id}/access.json`;
      if (!existsSync(aj)) continue;
      const a = JSON.parse(readFileSync(aj, "utf-8"));
      const groups: Record<string, unknown> = (a.groups && typeof a.groups === "object" && !Array.isArray(a.groups)) ? a.groups : {};
      if (groups[g]) continue; // 이미 있으면 기존 정책 보존 — 덮어쓰지 않음
      groups[g] = { requireMention: true, allowFrom: [] as string[] };
      a.groups = groups;
      const tmp = `${aj}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(a, null, 2) + "\n", { mode: 0o600 });
      renameSync(tmp, aj); // 원자 교체 — 실행 중 봇이 반쯤 쓴 파일을 읽어 '손상'→pairing 리셋하는 것 방지
    } catch { /* skip bad/missing file — 한 멤버 실패가 나머지를 막지 않음 */ }
  }
}
