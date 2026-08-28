/**
 * codex runtime — per-member 텔레그램 브리지 런처 (M4).
 *
 * codex 두뇌(버스 어댑터)는 in-process지만, 멤버 *자기 봇*으로 직접 텔레그램 I/O(👀+작업중+답)하려면
 * bridge.ts(runBridge)를 per-member 프로세스로 띄워야 한다. claude의 텔레그램 봇 LaunchAgent 패턴을 미러.
 *
 * 보안: 토큰은 파일로만(0600), wrapper가 파일→env(CODEX_BOT_TOKEN)로 주입 — plist·stdout·로그에 평문 안 둔다.
 * 라이브 launchctl 조작은 호출자(agentControl/activation)가 execOn() 게이트 뒤에서만 실행.
 */
import { writeFileSync, mkdirSync, chmodSync, existsSync, rmSync, lstatSync, readlinkSync, symlinkSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO_ROOT, MEMBERS_ROOT } from "../../lib/personaTemplates";
import { getCaptureGroupId } from "../../lib/captureConfig";
import { renderSeededCodexConfig } from "./configSeed";
import { Database } from "bun:sqlite";

const HOME = process.env.HOME ?? "";

/** owner_chat_id 세팅(team.db) 읽기 — 대시보드에서 팀장이 직접 설정한 값. 게이트 시드의 1순위 소스. */
function readOwnerChatIdSetting(): string | null {
  const dbPath = process.env.TEAM_DB_PATH ?? `${REPO_ROOT}/team.db`;
  if (!existsSync(dbPath)) return null;
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare("SELECT value FROM setting WHERE key = 'owner_chat_id'").get() as { value?: string } | undefined;
      const v = row?.value?.trim();
      return v && v !== "" ? v : null;
    } finally {
      db.close();
    }
  } catch {
    return null; // db 없거나 setting 테이블 없으면 조용히 skip → 다음 소스로
  }
}

/** 오너 DM chat_id 도출 우선순위: ①owner_chat_id 세팅(대시보드 입력) ②기존 claude 멤버 access.json allowFrom[0](claude 페어링 자동) ③GD_CHAT_ID env. */
export function resolveOwnerDmId(): string | null {
  const fromSetting = readOwnerChatIdSetting();
  if (fromSetting) return fromSetting;
  const chDir = `${HOME}/.claude/channels`;
  if (existsSync(chDir)) {
    for (const d of readdirSync(chDir)) {
      if (!d.startsWith("telegram-")) continue;
      const aj = `${chDir}/${d}/access.json`;
      if (!existsSync(aj)) continue;
      try {
        const a = JSON.parse(readFileSync(aj, "utf-8"));
        if (Array.isArray(a.allowFrom) && a.allowFrom.length) return String(a.allowFrom[0]);
      } catch { /* skip bad file */ }
    }
  }
  return process.env.GD_CHAT_ID?.trim() || null;
}

/** 발신자 게이트 시드값: 오너 DM chat_id + 팀그룹 id(comma-sep). 브리지 CODEX_ALLOW_FROM 에 주입. 둘 다 없으면 빈 문자열(→ fail-closed). */
export function resolveCodexAllowFrom(): string {
  return [resolveOwnerDmId(), getCaptureGroupId()].filter(Boolean).join(",");
}

/**
 * owner_chat_id 설정이 비어 있고 도출 가능(claude access.json allowFrom / GD_CHAT_ID env)하면 team.db 에 persist.
 * 대시보드 도움말("claude 첫 팀원 영입 시 자동 채워집니다")과 실제 동작을 일치시키고, hermes activate 등이
 * 안정적인 설정값을 읽게 한다(도출은 시점 의존적). 이미 값이 있으면 건드리지 않는다.
 * @returns persist 됐거나 이미 있던 owner_chat_id (없으면 null).
 */
export function persistOwnerChatIdIfEmpty(db: Database): string | null {
  try {
    const existing = (db.query("SELECT value FROM setting WHERE key = 'owner_chat_id'").get() as { value?: string } | null)?.value?.trim();
    if (existing) return existing; // 이미 설정됨 — 자동저장이 사용자 입력을 덮지 않는다.
    const derived = resolveOwnerDmId(); // 설정이 비었으므로 access.json/env 에서 도출
    if (!derived) return null;
    db.query(
      "INSERT INTO setting (key, value, updated_at) VALUES ('owner_chat_id', ?, datetime('now')) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
    ).run(derived);
    return derived;
  } catch {
    return null; // best-effort — 실패해도 부팅/영입 막지 않음
  }
}

// launchd 라벨 prefix (agentControl.teamosLaunchdPrefix와 동일 규약 — 순환참조 피하려 인라인).
function launchdPrefix(): string {
  const override = process.env.TEAMOS_LAUNCHD_PREFIX?.trim();
  if (override) return override.replace(/\.$/, "");
  return `com.${process.env.USER?.trim() || "local"}`;
}

export function codexBridgeLaunchdLabel(id: string): string {
  return `${launchdPrefix()}.codex-bridge-${id}`;
}

export interface CodexBridgePaths {
  label: string;
  plist: string; // ~/Library/LaunchAgents/<label>.plist
  wrapper: string; // 런처 셸(토큰 source→env→bun bridge.ts)
  tokenFile: string; // 0600 봇토큰
  workdir: string; // 멤버 워크스페이스(AGENTS.md 페르소나)
  codexHome: string; // 정체성 격리(CODEX_HOME)
  log: string;
  pidFile: string; // 첫 getUpdates 성공 후 bridge.ts가 쓰는 ready marker
  allowFrom: string; // 발신자 게이트 시드(comma-sep chat_id) → wrapper 가 CODEX_ALLOW_FROM 으로 export
}

export function codexBridgePaths(id: string): CodexBridgePaths {
  const label = codexBridgeLaunchdLabel(id);
  return {
    label,
    plist: `${HOME}/Library/LaunchAgents/${label}.plist`,
    wrapper: `${REPO_ROOT}/var/codex-bridge/${id}-launch.sh`,
    tokenFile: `${REPO_ROOT}/var/secrets/${id}.bot-token`,
    workdir: `${MEMBERS_ROOT}/${id}`,
    codexHome: `${HOME}/.codex-agents/${id}`,
    log: `${REPO_ROOT}/var/codex-bridge/${id}.log`,
    pidFile: `${REPO_ROOT}/var/codex-bridge/${id}.pid`,
    allowFrom: resolveCodexAllowFrom(),
  };
}

/** 런처 셸 본문(순수 — 테스트 가능). 토큰은 파일에서 env로(stdout 노출 X). */
export function renderLaunchWrapper(p: CodexBridgePaths): string {
  return [
    "#!/bin/bash",
    `# codex bridge launcher — ${p.label}. 토큰은 파일→env(평문 노출 금지).`,
    "set -e",
    `TOKEN_FILE="${p.tokenFile}"`,
    `[ -f "$TOKEN_FILE" ] || { echo "[codex-bridge] no token file: $TOKEN_FILE" >&2; exit 1; }`,
    `export CODEX_BOT_TOKEN="$(cat "$TOKEN_FILE")"`,
    `export CODEX_WORKDIR="${p.workdir}"`,
    `export CODEX_HOME="${p.codexHome}"`,
    `export CODEX_ALLOW_FROM="${p.allowFrom}"`,
    `export CODEX_AGENT_ID="${p.label.replace(/^.*\.codex-bridge-/, "")}"`,
    `export CODEX_BRIDGE_PID_FILE="${p.pidFile}"`,
    `export B3OS_REPO_ROOT="${REPO_ROOT}"`,
    `export TEAM_BASE_URL="${process.env.TEAM_BASE_URL ?? "http://127.0.0.1:7878/team"}"`,
    `export CODEX_SCHEDULE_TOOL_ENABLED="${process.env.CODEX_SCHEDULE_TOOL_ENABLED ?? "false"}"`,
    // launchd 는 최소 PATH 로 wrapper 를 띄운다(plist 에 EnvironmentVariables 없음) → bun 설치경로를 명시해야 respawn-loop 안 남.
    // claude launcher(claude/launcher.ts) 와 동일 세트: ~/.bun/bin(공식 인스톨러) · ~/.local/bin · /opt/homebrew/bin(Apple Silicon) · /usr/local/bin(Intel homebrew).
    `export PATH="${HOME}/.bun/bin:${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"`,
    `exec bun "${REPO_ROOT}/src/server/runtimes/codex/bridge.ts"`,
    "",
  ].join("\n");
}

/** LaunchAgent plist(순수). KeepAlive로 죽으면 재기동. 토큰은 plist에 없음(wrapper가 파일서 읽음). */
export function renderBridgePlist(p: CodexBridgePaths): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `  <key>Label</key><string>${p.label}</string>`,
    "  <key>ProgramArguments</key>",
    `  <array><string>/bin/bash</string><string>${p.wrapper}</string></array>`,
    // ★작업 디렉토리를 명시한다★ — 없으면 launchd 가 cwd `/` 로 띄운다.
    //   그러면 cwd 기준 상대경로가 전부 루트로 풀린다(실측: 사진 저장이 `/team-media` 로 가서
    //   `EROFS: read-only file system` 로 1:1 사진 첨부가 전부 실패했다).
    //   ★서버 plist 는 이미 이 키가 있어서 멀쩡했다★ — 브리지만 빠져 있었다. 같은 모양으로 맞춘다.
    `  <key>WorkingDirectory</key><string>${REPO_ROOT}</string>`,
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><true/>",
    `  <key>StandardOutPath</key><string>${p.log}</string>`,
    `  <key>StandardErrorPath</key><string>${p.log}</string>`,
    "</dict></plist>",
    "",
  ].join("\n");
}

/**
 * per-agent 최소 config. 호스트 `~/.codex/config.toml` 의 trust/MCP/plugin 을 상속하지 않기 위한
 * ★빈 껍데기★ 다. **실행 정책(샌드박스·승인)은 여기 쓰지 않는다.**
 *
 * ★실행 정책은 이 파일이 아니라 thread/start 인자로 간다★ — appServerRunner 가 턴마다
 * approvalPolicy·sandbox 를 codex 프로토콜로 명시한다. 여기에 다시 쓰면 두 곳이 갈린다.
 * 우리 코드가 두 번째로 판정하지도 않는다. ★지금 실행 정책은 "never" 라 codex 가 묻지 않는다★
 * (appServerRunner.ts) — 옮길 물음이 없다. "on-request" 로 되돌리면 그 물음을 채널로 옮긴다.
 *
 * 뺀 것: `sandbox_mode` · `approval_policy` · `network_access` · `writable_roots`.
 *
 * ■ 왜 이게 문제였나 — ★12명 중 dex 만 잠겨 있었다★ (실측 2026-08-14)
 *   같은 세 경로 쓰기를 네 런타임에 시켰다.
 *     hermes · openclaw · claude  → /tmp · 타 프로젝트 · 홈 ★전부 성공★, 승인창 없음
 *     dex                        → 타 프로젝트·홈 ★거절★
 *   그리고 openclaw 의 codex-home 에는 위 네 항목이 ★0건★ 인데 dex 것에만 ★4건★ 있었다.
 *   codex 의 한계가 아니라 ★이 함수가 만든 차이★ 였다.
 *
 * ■ ★주의 — 여기서 뺐다고 열리는 게 아니다★
 *   빈 CODEX_HOME 으로 실측하면 codex 0.147.0 기본은 ★read-only + on-request 로 잠긴다.★
 *   실제 실행 모드는 `appServerRunner` 가 ★codex 정식 프로토콜(thread/start·turn/start)로 명시★ 한다.
 *   openclaw 도 같은 방식이다(설정 파일이 아니라 프로토콜로 넘긴다).
 *
 * 경계가 다시 필요해지면 ★codex 설정·프로토콜로★ 넣는다. 우리 판정층을 다시 만들지 않는다.
 */
export function renderMinimalCodexConfig(_p: Pick<CodexBridgePaths, "workdir">): string {
  // ★제품 결정(2026-08-18): 호스트 설정을 상속한다.★ 상세는 configSeed.ts.
  //   상속하는 것은 ★능력★ 이다 — 플러그인·MCP·모델. 그것이 없으면 새 팀원이 기존 팀원보다
  //   좁아서 같은 과제를 맡길 수 없다.
  //   ★정책·신뢰·정체성은 상속하지 않는다★ — 실행 모드는 프로토콜 한 곳에서, 신뢰는 그 팀원의
  //   작업 폴더만, 호스트 CODEX_HOME 을 가리키는 줄은 격리를 깨므로 걷어낸다.
  return renderSeededCodexConfig(readHostCodexConfig(), { workdir: _p.workdir, hostCodexHome: `${HOME}/.codex` });
}

/** 호스트 ~/.codex/config.toml 을 읽는다. 없으면 null(상속할 것이 없다). */
export function readHostCodexConfig(): string | null {
  const hostCfg = `${HOME}/.codex/config.toml`;
  if (!existsSync(hostCfg)) return null;
  try {
    return readFileSync(hostCfg, "utf-8");
  } catch {
    return null; // 읽기 실패는 시딩을 막지 않는다 — 상속을 못 해도 팀원은 떠야 한다
  }
}

/**
 * CODEX_HOME 디렉토리 보장 + locked-down config + 호스트 codex 인증 seed(타깃에 없을 때만).
 * codex exec 는 CODEX_HOME 이 존재하지 않으면 즉시 exit 1("path does not exist") →
 * 브리지가 응답 생성 실패로 처리(영입 ack 무한대기, Codi 2026-06-29 인시던트).
 * 활성화 시 home 을 만들어 두면 재발 없음.
 * 정체성 모델: 기본은 호스트(~/.codex) ChatGPT 인증만 공유(빠른 활성화·테스트).
 * 설정 모델: ★호스트 config 를 상속하고 팀원별 값만 덮어쓴다★(2026-08-18 제품 결정 — configSeed.ts).
 * 팀원별 독립 정체성이 필요하면 이후 per-agent `codex login` 으로 교체(seed 는 타깃에 없을 때만 하므로 덮어쓰지 않음).
 */
export function ensureCodexHome(p: CodexBridgePaths): void {
  mkdirSync(p.codexHome, { recursive: true });
  const hostHome = `${HOME}/.codex`;
  // config.toml: ★없을 때만★ 시드한다(이미 있는 팀원 설정을 덮지 않는다). 내용은 호스트 상속 + 팀원별 덮어쓰기.
  {
    const dst = join(p.codexHome, "config.toml");
    if (!existsSync(dst)) writeFileSync(dst, renderMinimalCodexConfig(p), "utf-8");
  }
  // auth.json: **라이브 ~/.codex/auth.json 로 심링크**(복사 아님) — openclaw/hermes 와 동일 메커니즘.
  // (하네스+실증: codex ChatGPT 인증은 single-use rotating refresh 토큰. 복사본은 호스트 rotation
  //    뒤 stale→"refresh token already used"(codi 인시던트). openclaw acpx/codex-home/auth.json 은 심링크라
  //    항상 라이브를 읽어 idle 후에도 정상 — 그 패턴을 codi 에도 적용. refresh 도 라이브에 in-place → 사본 race 근절.)
  //   per-agent 독립 로그인이 필요하면(멀티 계정) 이 심링크를 실파일 login 으로 교체(향후, 계정 하나면 불필요).
  {
    const dst = join(p.codexHome, "auth.json");
    const src = join(hostHome, "auth.json");
    if (existsSync(src)) {
      let ok = false;
      try { ok = lstatSync(dst).isSymbolicLink() && readlinkSync(dst) === src; } catch { /* 타깃 없음 */ }
      if (!ok) {
        try { rmSync(dst, { force: true }); } catch { /* 없을 수 있음 */ }
        symlinkSync(src, dst); // 라이브 인증 공유(항상 최신)
      }
    }
  }
}

/** wrapper+plist 파일 생성(파일 쓰기만 — launchctl 로드는 호출자가 게이트 뒤에서). idempotent. */
export function writeCodexBridgeFiles(id: string): CodexBridgePaths {
  const p = codexBridgePaths(id);
  ensureCodexHome(p); // CODEX_HOME 없으면 codex exec 즉사 → 활성화 시 보장
  mkdirSync(dirname(p.wrapper), { recursive: true });
  mkdirSync(dirname(p.plist), { recursive: true });
  writeFileSync(p.wrapper, renderLaunchWrapper(p), "utf-8");
  chmodSync(p.wrapper, 0o755);
  writeFileSync(p.plist, renderBridgePlist(p), "utf-8");
  return p;
}

/** 토큰 0600 저장(stdout 노출 없음). */
export function placeCodexToken(id: string, token: string): string {
  const p = codexBridgePaths(id);
  mkdirSync(dirname(p.tokenFile), { recursive: true });
  writeFileSync(p.tokenFile, token.trim() + "\n", "utf-8");
  chmodSync(p.tokenFile, 0o600);
  return p.tokenFile;
}

/** plist/wrapper/토큰 + (removeHome 시) CODEX_HOME 정리(퇴사). launchctl bootout은 호출자가 먼저.
 *  removeHome=true: ~/.codex-agents/<id> 삭제 → 같은 이름 재영입이 stale 인증 재사용 없이 fresh 재시드.
 * */
export function removeCodexBridgeFiles(id: string, opts: { removeToken?: boolean; removeHome?: boolean } = {}): void {
  const p = codexBridgePaths(id);
  // removeHome(전체 퇴사)면 브릿지 로그도 정리 — 재영입 시 stale 로그 혼선 방지.
  for (const f of [p.plist, p.wrapper, ...(opts.removeToken ? [p.tokenFile] : []), ...(opts.removeHome ? [p.log] : [])]) {
    try { if (existsSync(f)) rmSync(f); } catch { /* best-effort */ }
  }
  // CODEX_HOME 정리 — id 형식 가드(rm-rf 안전: 빈/슬래시/.. 로 상위경로 삭제 방지).
  if (opts.removeHome && /^[a-z0-9_-]+$/i.test(id)) {
    try { if (existsSync(p.codexHome)) rmSync(p.codexHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
