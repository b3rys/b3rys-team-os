// claude_channel 봇 셋업 — 토큰(.env) 배치 + LaunchAgent plist 생성/정리(영입 활성화용).
//   codex launcher(runtimes/codex/launcher.ts)와 동일 패턴. 토큰 값은 파일로만(로그/응답 노출 없음).
//   claude 봇 = start-telegram-channel.sh <id> (tmux claude-<id>) — .env의 TELEGRAM_BOT_TOKEN 읽고, WORKDIR=~/Development/<id>.
//   OWNER 2026-07-01: 영입이 codex만 배선돼 claude 봇이 안 떴던 갭 보완(setClaude가 plist를 요구하는데 생성기가 없었음).
import { writeFileSync, mkdirSync, chmodSync, existsSync, rmSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { claudeTelegramLaunchdLabel } from "../../lib/agentControl";
import { MEMBERS_ROOT, REPO_ROOT } from "../../lib/personaTemplates";
import { getCaptureGroupId } from "../../lib/captureConfig";

const HOME = process.env.HOME ?? "";
// ★vendored 시작 스크립트 — repo 내(src/, 공개 export 포함)에서 REPO_ROOT로 해석. 기존 ~/.claude/skills 개인스킬 의존 제거(퍼블릭 fresh 클론서 봇 안 뜨던 #1 blocker). OWNER 2026-07-02.
const START_SCRIPT = `${REPO_ROOT}/src/server/runtimes/claude/start-telegram-channel.sh`;

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

/** 토큰을 claude 채널 .env(TELEGRAM_BOT_TOKEN)에 0600 저장. 값 노출 없음.
 *  ★atomic(temp+rename): truncate-in-place로 쓰면 poller가 하필 그 순간 읽을 때 빈 파일→토큰로드 실패→poller 즉사(하네스 근본원인). rename은 원자적이라 빈 창이 없음. OWNER 2026-07-01. */
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
    // ★WORKDIR 고정 — 없으면 start-telegram-channel.sh가 ~/Development/<id> fallback → 퍼블릭 모드(MEMBERS_ROOT=$B3RYS_HOME/members)서 봇이 자기 persona/CLAUDE.md/TEAM-OS 못 읽고 $HOME cwd로 뜸(정체성 없음). 하네스 HIGH, OWNER 2026-07-02.
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

/** reply-guard Stop 훅 설치 — 멤버 워크스페이스 `.claude/`(프로젝트 스코프)에 훅 스크립트 + settings.json.
 *  1:1 텔레그램 DM 턴을 reply 없이 끝내려 하면 차단·재프롬프트(Claude send-drift 안전망, OWNER 2026-07-03).
 *  워크스페이스 스코프라 user 전역 ~/.claude·오너 Claude Code엔 영향 0. 기존 settings.json 있으면 Stop 배열에 병합(중복 방지).
 *  best-effort — 설치 실패해도 활성화는 막지 않는다. */
export function installReplyGuardHook(id: string): void {
  assertId(id);
  const dotClaude = `${MEMBERS_ROOT}/${id}/.claude`;
  const hookDst = `${dotClaude}/hooks/reply-guard.py`;
  const settingsPath = `${dotClaude}/settings.json`;
  const src = `${REPO_ROOT}/src/server/runtimes/claude/reply-guard.py`;
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
    settings.hooks = hooks;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  } catch { /* best-effort */ }
}

/** telegram-progress 훅 설치 — 멤버 워크스페이스 `.claude/settings.json`(프로젝트 스코프)에 "작업 중 ⏳" 진행표시.
 *  PreToolUse(pre)=매 툴마다 진행 한 줄 append · Stop(stop)=턴 끝 진행 삭제 · PreCompact(compact)=압축 알림.
 *  봇 컨텍스트(어느 채팅에 쏠지)는 세션 env TELEGRAM_STATE_DIR(텔레그램 채널이 세팅)에서 읽으므로 별도
 *  래퍼/봇-스코프 case 불필요 — 워크스페이스 스코프라 오너·타 봇 무영향(글로벌 telegram-progress.sh 래퍼를
 *  ★공개 사용자·신규 멤버까지★ 대체). claude 런타임 전용. 멱등(evt별 includes 가드). best-effort. */
export function installProgressHook(id: string): void {
  assertId(id);
  const dotClaude = `${MEMBERS_ROOT}/${id}/.claude`;
  const hookDst = `${dotClaude}/hooks/telegram-progress.py`;
  const settingsPath = `${dotClaude}/settings.json`;
  const src = `${REPO_ROOT}/hooks/telegram-progress.py`;
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
    const addOnce = (evt: string, matcher: string, mode: string) => {
      const arr = Array.isArray(hooks[evt]) ? (hooks[evt] as unknown[]) : [];
      if (!JSON.stringify(arr).includes("telegram-progress.py")) {
        const entry: Record<string, unknown> = { hooks: [{ type: "command", command: `python3 "${hookDst}" ${mode}` }] };
        if (matcher) entry.matcher = matcher; // Stop 은 matcher 없음(글로벌 배선과 동형)
        arr.push(entry);
      }
      hooks[evt] = arr;
    };
    addOnce("PreToolUse", "*", "pre");
    addOnce("Stop", "", "stop");
    addOnce("PreCompact", "*", "compact");
    settings.hooks = hooks;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  } catch { /* best-effort */ }
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

// ★tg-reply-recovery 훅은 제거됨 (OWNER 2026-07-14).★ 훅이 팀원 '대신' 텔레그램에 보내는 [A] 패턴이었다 —
// 서버가 팀원 턴 본문을 대신 게시하던 것을 걷어낸 것과 같은 이유로 삭제. 팀원이 안 보냈으면 안 보낸 것이고,
// 그 사실을 팀원 본인에게 되돌려 주는 것(reply-guard)까지가 시스템의 몫이다. 대신 말해 주지는 않는다.

/** tg-outbound Stop 훅 설치 — Tier2(2026-07-06): claude 아웃바운드를 서버 소유로. LLM은 답을 마커
 *  (‹‹‹b3os-send›››…‹‹‹b3os-end›››) 평문으로만 쓰고, 이 훅이 추출→tg-send.sh 전송(=malform 원천 0).
 *  installRecoveryHook 미러(워크스페이스 스코프·오너 무영향). dryRun=true(Phase0 shadow)면 TG_OUTBOUND_DRYRUN=1
 *  로 실전송 없이 '무엇을 보낼지' 로그만. TG_OUTBOUND_ENV=멤버 봇 .env. 토큰 없으면 안전 폴백. */
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
    // ★DRYRUN 기본 true (fail-open 방지, Bill 하네스 MED): 명시적 dryRun:false(Phase1 live)만 실전송.
    //   설치 시 실수로 dryRun 안 넘겨도 실전송이 아니라 로그만 → OWNER 답 오발송/유실 위험 차단.
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
function uninstallStopHookByFile(id: string, hookFile: string): void {
  assertId(id);
  const dotClaude = `${MEMBERS_ROOT}/${id}/.claude`;
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
export function uninstallReplyGuardHook(id: string): void { uninstallStopHookByFile(id, "reply-guard.py"); }

/** tg-reply-recovery Stop 훅 제거 — 훅 자체가 삭제됐다(OWNER 2026-07-14). 이 함수는 이미 설치된 멤버에서
 *  등록을 걷어내는 self-heal 용으로만 남는다(활성화·퇴사 때 호출). 잔재가 다 걷히면 같이 지운다. */
export function uninstallRecoveryHook(id: string): void { uninstallStopHookByFile(id, "tg-reply-recovery.py"); }

/** tmux 봇 세션 종료(claude-<id>). off/퇴사 시 고아 tmux 방지(하네스 #4) — launchctl bootout은 detached tmux를 안 죽인다. */
export function killClaudeTmux(id: string): void {
  assertId(id);
  try { spawnSync("tmux", ["kill-session", "-t", `claude-${id}`], { stdio: "ignore" }); } catch { /* best-effort */ }
}

/** 퇴사 정리 — tmux 세션 kill + plist + (removeToken 시) 채널 상태 dir 전체 + ~/.claude.json projects 항목.
 *  ★재영입 clean: 채널 dir(.env·access.json·inbox 등)·trust 항목이 남으면 재영입 시 stale 설정 잔재(OWNER 2026-07-01 4런타임 잔재 감사). launchctl bootout은 호출자가 먼저. */
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

/** 신규 workspace trust 프롬프트 hang 방지(하네스 #2): ~/.claude.json projects 항목 사전 시드(trust/onboarding 완료). */
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

/** OWNER DM 페어링 자동 시드(하네스 #1): 기존 claude 멤버 access.json 의 allowFrom(인스턴스 오너 DM id)을 새 봇 access.json 에 시드.
 *  도출 불가(첫 claude 멤버)면 skip — 봇은 뜨고 버스/그룹은 도달, OWNER DM은 수동 페어링(DM→code→promote). */
export function seedClaudeAccess(id: string): void {
  assertId(id);
  const p = claudeBridgePaths(id);
  try {
    let ownerId: string | null = null;
    let refGroups: Record<string, unknown> = {}; // ★참조봇의 팀방 groups 정책도 복사 — 안 하면 새 봇 access.groups={}라 팀방 응답 안 됨(server.ts:198 access.groups 체크). OWNER 2026-07-01 지적.
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
    // ackReaction: 봇이 메시지 받으면 👀 리액션(server.ts:950 access.ackReaction 있어야 붙음). 없으면 claude 봇 리액션 안 뜸(codex는 브리지 경로라 별개). OWNER 2026-07-01.
    if (ownerId) {
      // 참조봇 있음: owner DM allowlist + 참조봇 groups 복사.
      writeFileSync(`${p.stateDir}/access.json`, JSON.stringify({ dmPolicy: "allowlist", allowFrom: [ownerId], groups: refGroups, pending: {}, ackReaction: "👀" }, null, 2), "utf-8");
    } else {
      // ★첫 claude 멤버(참조봇 없음): access.json 자체가 없으면 플러그인 assertAllowedChat이 그룹 응답을 거부(받되 답 못함, 하네스 Gap A HIGH). capture group id로 groups seed → 그룹 참여 가능. DM은 수동 페어링(pairing)로 안전 fallback. OWNER 2026-07-02.
      const gid = getCaptureGroupId();
      const groups = gid ? { [gid]: { requireMention: true, allowFrom: [] as string[] } } : {};
      writeFileSync(`${p.stateDir}/access.json`, JSON.stringify({ dmPolicy: "pairing", allowFrom: [], groups, pending: {}, ackReaction: "👀" }, null, 2), "utf-8");
    }
  } catch { /* best-effort */ }
}
