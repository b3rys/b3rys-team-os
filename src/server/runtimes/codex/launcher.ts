/** 멤버별 봇 I/O는 별도 브리지 프로세스로 실행한다. 토큰은 0600 파일에서 env로 주입하고 plist·로그에 넣지 않는다.
 * 실제 launchctl 조작은 호출자의 execOn 게이트 뒤에서만 실행한다. */
import { writeFileSync, mkdirSync, chmodSync, existsSync, rmSync, lstatSync, readlinkSync, symlinkSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO_ROOT, MEMBERS_ROOT } from "../../lib/personaTemplates";
import { getCaptureGroupId } from "../../lib/captureConfig";
import { DEFAULT_CHANNEL, assertChannelUsable, channelEnvLines, readMemberChannel, type MemberChannel } from "../../lib/memberChannel";
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
  channel: MemberChannel; // 봇이 붙는 메신저(텔레그램 기본·b3chat) — lib/memberChannel.ts
}

/** channel 을 안 주면 기본(텔레그램) — 경로만 필요한 호출(pidFile·tokenFile 등)은 agents.json 을 읽지 않는다. */
export function codexBridgePaths(id: string, channel: MemberChannel = DEFAULT_CHANNEL): CodexBridgePaths {
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
    // 채널에 허용 방 목록이 있으면 그것(b3chat 방 id). 없으면 팀 공통 시드(팀장 DM + 팀 그룹) 그대로.
    allowFrom: channel.allowFrom ? channel.allowFrom.join(",") : resolveCodexAllowFrom(),
    channel,
  };
}

/** wrapper 의 CODEX_BIN 줄 — 값이 비었으면 줄 자체를 만들지 않는다. */
export function codexBinLine(bin: string | undefined): string[] {
  const v = bin?.trim();
  if (!v) return [];
  return [`export CODEX_BIN="${v.replace(/(["\\$`])/g, "\\$1")}"`];
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
    // 서버가 쓰는 codex 실행 파일을 브리지도 쓴다. 값이 있을 때만 넣는다 — 빈 값을 export 하면
    // runner·appServerClient 의 `CODEX_BIN ?? "codex"` 가 빈 문자열을 그대로 써서 spawn("") 으로 즉사한다.
    ...codexBinLine(process.env.CODEX_BIN),
    // 봇 API 주소·채널 종류 — 채널 설정이 있는 팀원만. 없으면 줄이 없어 wrapper 가 지금과 같다.
    ...channelEnvLines(p.channel),
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
    // 작업 디렉토리를 명시한다 — 없으면 launchd 가 cwd `/` 로 띄운다.
    //   그러면 cwd 기준 상대경로가 전부 루트로 풀린다(실측: 사진 저장이 `/team-media` 로 가서
    //   `EROFS: read-only file system` 로 1:1 사진 첨부가 전부 실패했다).
    //   서버 plist 는 이미 이 키가 있어서 멀쩡했다 — 브리지만 빠져 있었다. 같은 모양으로 맞춘다.
    `  <key>WorkingDirectory</key><string>${REPO_ROOT}</string>`,
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><true/>",
    `  <key>StandardOutPath</key><string>${p.log}</string>`,
    `  <key>StandardErrorPath</key><string>${p.log}</string>`,
    "</dict></plist>",
    "",
  ].join("\n");
}

/** config에는 실행 정책을 중복하지 않는다. thread/start·turn/start가 한 곳에서 정하며 생략 시 CLI 0.147.0 기본은 readOnly·on-request로 잠긴다.
 * 현재 never는 사람 승인 경로를 만들지 않는다. 복원하려면 on-request로 바꾸고, 실행 경계가 필요하면 Codex 설정·프로토콜을 사용하며 별도 판정층을 재도입하지 않는다. */
export function renderMinimalCodexConfig(_p: Pick<CodexBridgePaths, "workdir">): string {
  // 기능은 상속해 새 팀원의 플러그인·MCP·모델을 기존 팀원과 맞춘다. 정책은 프로토콜, 신뢰는 자기 작업폴더만 사용하며 호스트 CODEX_HOME 참조는 격리를 깨므로 제거한다.
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

/** CODEX_HOME이 없으면 CLI가 즉시 종료하므로 활성화 때 생성한다. 호스트 기능 설정은 상속하고 팀원별 값으로 덮어쓴다.
 * 기본은 호스트 인증을 공유하되 대상 인증이 이미 있으면 보존한다. 별도 계정은 팀원별 login으로 교체할 수 있다. */
export function ensureCodexHome(p: CodexBridgePaths): void {
  mkdirSync(p.codexHome, { recursive: true });
  const hostHome = `${HOME}/.codex`;
  // config.toml: 없을 때만 시드한다(이미 있는 팀원 설정을 덮지 않는다). 내용은 호스트 상속 + 팀원별 덮어쓰기.
  {
    const dst = join(p.codexHome, "config.toml");
    if (!existsSync(dst)) writeFileSync(dst, renderMinimalCodexConfig(p), "utf-8");
  }
  // ChatGPT refresh 토큰은 단일 사용·회전하므로 인증을 복사하면 호스트 갱신 뒤 사본이 만료된다. 실시간 auth.json 심링크로 같은 갱신본을 사용한다.
  // 독립 계정이 필요하면 심링크 대신 팀원별 실제 login 파일로 교체한다.
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
  const p = codexBridgePaths(id, readMemberChannel(id));
  // 채널 설정이 틀리면 파일을 쓰기 전에 멈춘다 — 옛 wrapper 를 덮어 반쯤 바뀐 상태를 만들지 않는다.
  assertChannelUsable(p.channel, `codex ${id}`);
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
  // removeHome 이면 ready 표시(pid)·창구 파일도 — 남기면 다음 영입의 "기동 확인" 이 옛 표시를 읽는다.
  const runFiles = opts.removeHome ? [p.log, p.pidFile, join(dirname(p.pidFile), `${id}.window.json`)] : [];
  for (const f of [p.plist, p.wrapper, ...(opts.removeToken ? [p.tokenFile] : []), ...runFiles]) {
    try { if (existsSync(f)) rmSync(f); } catch { /* best-effort */ }
  }
  // CODEX_HOME 정리 — id 형식 가드(rm-rf 안전: 빈/슬래시/.. 로 상위경로 삭제 방지).
  if (opts.removeHome && /^[a-z0-9_-]+$/i.test(id)) {
    try { if (existsSync(p.codexHome)) rmSync(p.codexHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
