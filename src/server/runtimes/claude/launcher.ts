// claude_channel 봇 셋업 — 토큰(.env) 배치 + LaunchAgent plist 생성/정리(영입 활성화용).
//   codex launcher(runtimes/codex/launcher.ts)와 동일 패턴. 토큰 값은 파일로만(로그/응답 노출 없음).
//   claude 봇 = start-telegram-channel.sh <id> (tmux claude-<id>) — .env의 TELEGRAM_BOT_TOKEN 읽고, WORKDIR=~/Development/<id>.
// 영입이 codex만 배선돼 claude 봇이 안 떴던 갭 보완(setClaude가 plist를 요구하는데 생성기가 없었음).
import { writeFileSync, mkdirSync, chmodSync, existsSync, rmSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { claudeTelegramLaunchdLabel } from "../../lib/agentControl";
import { MEMBERS_ROOT, REPO_ROOT } from "../../lib/personaTemplates";
import { getCaptureGroupId } from "../../lib/captureConfig";

const HOME = process.env.HOME ?? "";
// ★vendored 시작 스크립트 — repo 내(src/, 공개 export 포함)에서 REPO_ROOT로 해석. 기존 ~/.claude/skills 개인스킬 의존 제거(퍼블릭 fresh 클론서 봇 안 뜨던 #1 blocker).
const START_SCRIPT = `${REPO_ROOT}/src/server/runtimes/claude/start-telegram-channel.sh`;
/** 정본 런처 경로 — plist drift 검사(인수테스트)가 이 값과 대조한다.
 *  ★사본이 여러 벌 굴러다니면 "한 곳만 고치고 까먹는" 사고가 난다★ (2026-07-25 실측: 모델 하드코딩 fix 때
 *  claude 멤버 plist 가 ~/.claude/skills 사본·구 team-collab 사본·정본 3곳으로 갈려 있었다). */
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

/** 토큰을 claude 채널 .env(TELEGRAM_BOT_TOKEN)에 0600 저장. 값 노출 없음.
 * ★atomic(temp+rename): truncate-in-place로 쓰면 poller가 하필 그 순간 읽을 때 빈 파일→토큰로드 실패→poller 즉사(하네스 근본원인). rename은 원자적이라 빈 창이 없음. */
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
    // ★WORKDIR 고정 — 없으면 start-telegram-channel.sh가 ~/Development/<id> fallback → 퍼블릭 모드(MEMBERS_ROOT=$B3RYS_HOME/members)서 봇이 자기 persona/CLAUDE.md/TEAM-OS 못 읽고 $HOME cwd로 뜸(정체성 없음). 하네스 HIGH
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
 * 1:1 텔레그램 DM 턴을 reply 없이 끝내려 하면 차단·재프롬프트(Claude send-drift 안전망).
 *  워크스페이스 스코프라 user 전역 ~/.claude·오너 Claude Code엔 영향 0. 기존 settings.json 있으면 Stop 배열에 병합(중복 방지).
 *  best-effort — 설치 실패해도 활성화는 막지 않는다. */
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
    settings.hooks = hooks;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  } catch { /* best-effort */ }
}

/** telegram-progress 훅 설치 — 멤버 워크스페이스 `.claude/settings.json`(프로젝트 스코프)에 "작업 중 ⏳" 진행표시.
 *  PreToolUse(pre)=매 툴마다 진행 한 줄 append · Stop(stop)=턴 끝 진행 삭제 · PreCompact(compact)=압축 알림.
 *  봇 컨텍스트(어느 채팅에 쏠지)는 세션 env TELEGRAM_STATE_DIR(텔레그램 채널이 세팅)에서 읽으므로 별도
 *  래퍼/봇-스코프 case 불필요 — 워크스페이스 스코프라 오너·타 봇 무영향(글로벌 telegram-progress.sh 래퍼를
 *  ★공개 사용자·신규 멤버까지★ 대체). claude 런타임 전용. 멱등(evt별 reconcile). best-effort.
 *  `roots` 는 ★테스트 이음매★ — 안 주면 실제 경로를 쓴다(실 FS 격리: seedGroupIntoClaudeMembers 와 같은 방식). */
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
    // ★"있으면 건너뛴다" 가 아니라 "달라졌으면 맞춘다".★ 예전 구현은 telegram-progress.py 가
    //   settings.json 에 이미 있으면 통째로 skip 했다. 그래서 커맨드가 바뀌어도(예: env 추가)
    //   ★기존 멤버는 옛 커맨드를 그대로 들고 있었다★ — 훅 파일만 새것이고 배선은 옛것이 된다.
    //   실제로 그 상태에서 owner-skip 이 그룹 ID 를 못 구해 fail-open 으로 돌았다.
    const reconcile = (evt: string, matcher: string, mode: string) => {
      const arr = Array.isArray(hooks[evt]) ? (hooks[evt] as unknown[]) : [];
      // ★B3OS_ROOT 를 실어 보낸다★ — 훅은 저장소 밖(멤버 워크스페이스)에서 돌기 때문에
      //   자기 위치로는 b3os `.env`(TEAM_GROUP_ID)를 못 찾는다. 실 chat_id 는 소스에 안 박는다.
      // ★OWNER_GATE_SELF 도 싣는다★ — `react` 모드가 owner 판정을 하므로 자기 id 가 필요하다.
      //   훅은 TELEGRAM_STATE_DIR 로도 유추하지만, ★유추가 틀리면 남의 이름으로 판정한다★
      //   (owner-gate 에서 겪은 것). 런처는 id 를 아니까 추측하게 두지 않는다.
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
    // ★react 는 멤버 스코프에 있어야 한다.★ 지금까지 이 기계 전역 래퍼에만 걸려 있었고,
    //   그 래퍼는 ★봇 목록이 손으로 박혀 있어 새 팀원이 빠졌다★(명부엔 있는데 목록엔 없음).
    //   react 가 "이번 턴이 어느 방인가" 를 적어두므로, 빠진 팀원은 진행표시가 ★엉뚱한 방★ 에 찍힌다.
    //   공개 설치에는 그 래퍼 자체가 없어서 ★전부 같은 상태★ 였다. 명부를 읽는 이 경로로 옮긴다.
    reconcile("UserPromptSubmit", "", "react");
    settings.hooks = hooks;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  } catch { /* best-effort */ }
}

/** 이미 깔려 있는 telegram-progress 훅만 최신으로 맞춘다(새로 깔지는 않는다).
 *
 *  ★설치와 수리를 가른다.★ 부팅 백필(`installProgressHook`)은 `PUBLIC_BUILD` 게이트 뒤에 있어
 *  라이브에서는 안 돈다 — 실멤버 배선 보호가 이유다. 그런데 그 때문에 ★이미 깔린 배선이
 *  낡아도 아무도 안 고쳤다.★ 훅 파일은 활성화 때만 갱신되고, 커맨드는 위 reconcile 이전엔
 *  아예 안 갱신됐다. 그 결과가 이번 fail-open 이다.
 *  → 여기서는 ★배선이 이미 있는 멤버만★ 대상으로 파일·커맨드를 저장소 기준으로 되맞춘다.
 *    안 깔린 멤버에게 새로 깔지 않으므로 라이브 보호 의도는 그대로다. 멱등이다.
 */
export function repairProgressHook(id: string, roots?: { membersRoot?: string; repoRoot?: string }): void {
  assertId(id);
  const settingsPath = `${roots?.membersRoot ?? MEMBERS_ROOT}/${id}/.claude/settings.json`;
  try {
    if (!existsSync(settingsPath)) return;
    if (!readFileSync(settingsPath, "utf-8").includes("telegram-progress.py")) return; // 안 깔린 멤버는 건드리지 않는다
  } catch { return; }
  installProgressHook(id, roots);
}

/** owner-gate 훅 설치 — 멤버 워크스페이스 `.claude/settings.json` 의 `UserPromptSubmit`.
 *
 *  ★왜 필요한가★ — 답장은 ★암묵적 멘션★ 이라, `@A` 라고 써도 ★답장 대상 봇 B 가 그 글을 받는다.★
 *  게이트가 없으면 B 세션이 자기 것이 아닌 일을 시작한다. 이 훅이 라우터에 owner 를 물어
 *  내가 아니면 그 prompt 를 막는다(판단에 맡기지 않는다).
 *  이 게이트는 지금까지 ★이 기계 전역에만 손으로 걸려 있었다★ — 공개 설치·새 팀에는 아예 없었다.
 *
 *  ★커맨드에 `B3OS_ROOT` 를 싣는다★ — 훅이 저장소 밖에서 돌기 때문에 그게 없으면 단톡방 id 를
 *  못 구해 ★게이트가 통째로 무력화된다★(#230 과 같은 함정). 실 chat_id 는 소스에 안 넣는다.
 *  `OWNER_GATE_SELF` 는 안 싣는다 — 훅이 `TELEGRAM_STATE_DIR` 에서 per-bot 으로 얻는다.
 *  best-effort. `roots` 는 테스트 이음매. */
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
    // ★있으면 skip 이 아니라 다르면 교체★ — 커맨드가 바뀌어도 기존 멤버가 옛것을 들고 있으면 안 된다.
    // ★OWNER_GATE_SELF 를 반드시 싣는다★ — 없으면 훅이 자기 id 를 못 구하고,
    //   그때 남의 id 로 폴백하면 ★게이트가 꺼지는 게 아니라 반대로 돈다★(lui 교차검증).
    //   런처는 id 를 이미 안다. 추측하게 두지 않는다.
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

/** owner-gate 를 ★없으면 새로 깐다.★ 부팅 때 돈다.
 *
 *  ★`repairProgressHook`·`repairReplyGuardHook` 과 일부러 다르다.★ 그 둘은 "이미 배선된 멤버만"
 *  손본다 — 안 깔린 멤버에게 새로 깔지 않는 게 실멤버 보호다. ★owner-gate 는 목적이 반대다★:
 *  ★없는 곳에 넣는 것★ 이 이 훅의 존재 이유다(공개 설치·기존 팀에 게이트가 아예 없었다).
 *  "이미 있는 멤버만" 으로 두면 ★아무도 없으니 전원 건너뛰어 효과가 0★ 이 된다(실측으로 확인).
 *
 *  ★그래서 이름이 repair 가 아니라 ensure 다.★ 다음 사람이 세 함수를 같은 것으로 읽지 않게.
 *  멱등이다 — `installOwnerGateHook` 이 있으면 교체, 없으면 추가한다.
 */
export function ensureOwnerGateHook(id: string, roots?: { membersRoot?: string; repoRoot?: string }): void {
  assertId(id);
  installOwnerGateHook(id, roots);
}

/** 이미 깔려 있는 reply-guard 훅의 ★파일만★ 최신으로 맞춘다(새로 깔지는 않는다).
 *
 *  ★배선(settings.json)은 안 바뀌고 파일만 낡는다★ — 커맨드가 `python3 "<경로>"` 뿐이라
 *  저장소에서 훅을 고쳐도 활성화를 다시 하지 않으면 멤버 폴더의 사본이 옛날 것으로 남는다.
 *  실제로 그래서 ★단톡방 글을 1:1 로 오인해 막는 판★ 이 팀원 5명에게 그대로 남아 있었다.
 *  `repairProgressHook` 과 같은 원칙: ★배선이 이미 있는 멤버만★ 대상(라이브 보호 유지), 멱등.
 */
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

// ★tg-reply-recovery 훅은 제거됨.★ 훅이 팀원 '대신' 텔레그램에 보내는 [A] 패턴이었다 —
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
    // 설치 시 실수로 dryRun 안 넘겨도 실전송이 아니라 로그만 → GD 답 오발송/유실 위험 차단.
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

/** tg-reply-recovery Stop 훅 제거 — 훅 자체가 삭제됐다. 이 함수는 이미 설치된 멤버에서
 *  등록을 걷어내는 self-heal 용으로만 남는다(활성화·퇴사 때 호출). 잔재가 다 걷히면 같이 지운다. */
export function uninstallRecoveryHook(id: string): void { uninstallStopHookByFile(id, "tg-reply-recovery.py"); }

/** tmux 봇 세션 종료(claude-<id>). off/퇴사 시 고아 tmux 방지(하네스 #4) — launchctl bootout은 detached tmux를 안 죽인다. */
export function killClaudeTmux(id: string): void {
  assertId(id);
  try { spawnSync("tmux", ["kill-session", "-t", `claude-${id}`], { stdio: "ignore" }); } catch { /* best-effort */ }
}

// auto-reconnect 구현은 ★pollerHealth.ts★ 로 옮겼다 — 재시작 경로(agentControl)도 같은 복구를 써야 하는데
// launcher 는 agentControl 을 import 하고 있어서 반대 방향 import 가 순환이 된다. 여기서는 재-export 만 한다.
export { reconnectClaudeTelegram } from "./pollerHealth";


/** 퇴사 정리 — tmux 세션 kill + plist + (removeToken 시) 채널 상태 dir 전체 + ~/.claude.json projects 항목.
 * ★재영입 clean: 채널 dir(.env·access.json·inbox 등)·trust 항목이 남으면 재영입 시 stale 설정 잔재. launchctl bootout은 호출자가 먼저. */
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

/** GD DM 페어링 자동 시드(하네스 #1): 기존 claude 멤버 access.json 의 allowFrom(인스턴스 오너 DM id)을 새 봇 access.json 에 시드.
 *  재활성화 대상에 이미 승인된 allowFrom 이 있으면 파일 전체를 보존한다. 도출 불가(첫 claude 멤버)면
 * pairing 기본값을 시드해 봇/그룹은 즉시 도달하고 GD DM은 수동 페어링(DM→code→promote)한다. */
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
    let refGroups: Record<string, unknown> = {}; // ★참조봇의 팀방 groups 정책도 복사 — 안 하면 새 봇 access.groups={}라 팀방 응답 안 됨(server.ts:198 access.groups 체크). GD 2026-07-01 지적.
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
      // ★첫 claude 멤버(참조봇 없음): access.json 자체가 없으면 플러그인 assertAllowedChat이 그룹 응답을 거부(받되 답 못함, 하네스 Gap A HIGH). capture group id로 groups seed → 그룹 참여 가능. DM은 수동 페어링(pairing)로 안전 fallback.
      const gid = getCaptureGroupId();
      const groups = gid ? { [gid]: { requireMention: true, allowFrom: [] as string[] } } : {};
      writeFileSync(targetAccess, JSON.stringify({ dmPolicy: "pairing", allowFrom: [], groups, pending: {}, ackReaction: "👀" }, null, 2), "utf-8");
    }
  } catch { /* best-effort */ }
}

/** 팀방(capture group) 설정/변경 시, 이미 활성화된 claude 멤버들의 access.json `groups` 에 그 그룹을
 *  ★비파괴·원자적★ 병합한다(dmPolicy·allowFrom·pending·ackReaction·기존 groups 정책 보존). seedClaudeAccess 는
 *  access.json 을 통째로 재작성해 페어링 상태를 날리므로 이 용도엔 못 쓴다.
 *
 *  왜 필요: 팀방 셋업을 팀원 영입 '이후'에 하는 게 claude-only 팀의 일반 순서인데, 그러면 각 멤버 activate 시점엔
 *  capture group id 가 아직 없어 access.json 이 groups={} 로 남는다. 팀방을 나중에 붙여도(=setCaptureGroupId)
 *  기존 멤버 access.json 은 갱신되지 않아 ① 그룹 원본 메시지 네이티브 리액션(setMessageReaction)이 플러그인
 *  assertAllowedChat 게이트에 막히고(👀 안 붙음) ② 그룹 인바운드가 drop 된다. 그래서 setCaptureGroupId 호출지점
 *  (대시보드 PATCH /system-op · detect-group)에서 이 헬퍼로 기존 멤버에 그룹을 시드한다.
 *
 *  ★설계(Bill 하네스검증 #9 — 반증 반영):
 *   - 대상은 ~/.claude/channels/telegram-* 전체가 아니라 memberIds(호출부가 레지스트리에서 산출한 활성 claude
 *     멤버 id)만 — 테스트/퇴사 봇 access.json 에 팀방 접근을 과다부여하지 않는다(최소권한).
 *   - 원자쓰기(tmp+rename): 대상 봇은 살아서 access.json 을 매 메시지 fresh-read 하고, 플러그인은 torn-read 를
 *     '손상'으로 보고 파일을 치워 pairing 으로 리셋한다. 반쯤 쓴 파일이 읽히지 않게 tmp 에 쓰고 원자 교체.
 *   - per-member try/catch: 한 멤버 access.json 손상/부재가 나머지를 막지 않는다. best-effort.
 *   - 이미 그룹이 있으면 기존 정책(requireMention/allowFrom) 보존(skip). gid 빈값이면 no-op. */
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
