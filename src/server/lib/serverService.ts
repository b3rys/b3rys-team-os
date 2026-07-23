// b3os 서버(팀 버스/대시보드) LaunchAgent 등록 — ★전적으로 선택(opt-in)★.
//   기본은 등록하지 않는다. 등록 없이도 b3os는 완전히 동작한다(`bun run start`).
//   등록하면 얻는 것: 재부팅 자동복구 · 터미널/앱을 닫아도 서버 생존 · 맥앱의 [서버 재시작] 버튼 활성화.
//
//   왜 필요했나: 멤버 봇(runtimes/{claude,codex}/launcher.ts)은 이미 LaunchAgent로 등록되는데,
//   정작 그들을 관리하는 서버만 등록 수단이 없었다(비대칭). uninstall.sh는 이미 서버 plist 제거를
//   약속하고 있었지만 등록하는 쪽이 없었다. 이 모듈이 그 구멍을 메운다. GD 2026-07-12.
//
//   설계 규칙:
//   - 라벨은 teamosLaunchdPrefix()(= com.$USER, TEAMOS_LAUNCHD_PREFIX 로 override) — 특정 조직/사용자 하드코딩 금지.
//   - bun 경로는 process.execPath(현재 실행 중인 bun) — /opt/homebrew 하드코딩 금지.
//   - 루트는 REPO_ROOT — 클론 위치에 무관.
//   - 포트/바인드/베이스패스는 현재 프로세스 env를 승계(등록 시점의 설정 그대로 재현).
//   - macOS 전용. 그 외 플랫폼에서는 supported=false 로 알려주고 아무것도 하지 않는다(Windows 미지원).
import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { teamosLaunchdPrefix } from "./agentControl";
import { REPO_ROOT } from "./personaTemplates";

const HOME = process.env.HOME ?? "";

export interface ServerServicePaths {
  label: string;
  plist: string;
}

/** LaunchAgent 라벨. 멤버 봇과 동일한 generic prefix 규칙을 따른다(com.$USER.team-collab). */
export function serverServiceLabel(): string {
  return `${teamosLaunchdPrefix()}.team-collab`;
}

export function serverServicePaths(): ServerServicePaths {
  const label = serverServiceLabel();
  return { label, plist: `${HOME}/Library/LaunchAgents/${label}.plist` };
}

/** macOS(launchd) 에서만 지원. 그 외에서는 등록/해제를 시도하지 않는다. */
export function isSupportedPlatform(): boolean {
  return process.platform === "darwin";
}

function guiDomain(): string {
  return `gui/${process.getuid?.() ?? ""}`;
}

/** launchd 가 서버에 넘길 env — ★최소한만★.
 *
 *  ★TEAM_HTTP_PORT / TEAM_BIND / BASE_PATH 같은 설정값은 절대 여기에 굽지 않는다.★
 *  b3os 의 설정 원천은 `.env` 이고(bun 이 cwd 에서 자동 로드, WorkingDirectory=REPO_ROOT),
 *  plist 에 명시한 env 는 .env 보다 우선하므로 값을 구워넣으면
 *  (a) 사용자가 .env 에 적은 포트를 무시하고 (b) 나중에 .env 를 고쳐도 반영되지 않는다(값 고정).
 *  → 설정은 .env 가 계속 쥐고 있게 두고, 여기서는 launchd 가 안 주는 것만 채운다.
 *
 *  USER 는 launchd 최소 환경에서 비어 있을 수 있다. 그러면 teamosLaunchdPrefix() 가
 *  com.local 로 떨어져 멤버 봇 라벨과 어긋난다 → 설치 시점에 확정한 prefix 를 박아 결정론적으로 만든다. */
function serviceEnv(): Record<string, string> {
  return {
    PATH: `${HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME,
    TEAMOS_LAUNCHD_PREFIX: teamosLaunchdPrefix(),
  };
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderServerPlist(): string {
  const { label } = serverServicePaths();
  // ★현재 실행 중인 bun 을 그대로 쓴다 — 경로 하드코딩 금지(사용자마다 bun 위치가 다르다).
  const bun = process.execPath;
  const entry = `${REPO_ROOT}/src/server/index.ts`;
  const env = serviceEnv();
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key><string>${xmlEscape(label)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    <string>${xmlEscape(bun)}</string>`,
    `    <string>run</string>`,
    `    <string>${xmlEscape(entry)}</string>`,
    `  </array>`,
    `  <key>WorkingDirectory</key><string>${xmlEscape(REPO_ROOT)}</string>`,
    `  <key>RunAtLoad</key><true/>`,
    // 서버는 워커(스케줄러·버스 dispatch 등)를 물고 있는 상시 프로세스 → 죽으면 다시 띄운다.
    `  <key>KeepAlive</key><true/>`,
    `  <key>ThrottleInterval</key><integer>10</integer>`,
    `  <key>StandardOutPath</key><string>${xmlEscape(`${REPO_ROOT}/logs/stdout.log`)}</string>`,
    `  <key>StandardErrorPath</key><string>${xmlEscape(`${REPO_ROOT}/logs/stderr.log`)}</string>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    ...Object.entries(env).map(([k, v]) => `    <key>${xmlEscape(k)}</key><string>${xmlEscape(v)}</string>`),
    `  </dict>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

/** plist 파일이 있는가(= 등록됨). */
export function isInstalled(): boolean {
  return existsSync(serverServicePaths().plist);
}

/** launchd 에 실제로 로드돼 있는가. ★없는 라벨에 kickstart 하지 않기 위한 선행 확인.★ */
export function isLoaded(): boolean {
  if (!isSupportedPlatform()) return false;
  const { label } = serverServicePaths();
  const r = spawnSync("launchctl", ["print", `${guiDomain()}/${label}`], { stdio: "ignore" });
  return r.status === 0;
}

export interface ServiceStatus {
  supported: boolean;
  label: string;
  plist: string;
  installed: boolean;
  loaded: boolean;
}

export function status(): ServiceStatus {
  const { label, plist } = serverServicePaths();
  return {
    supported: isSupportedPlatform(),
    label,
    plist,
    installed: isInstalled(),
    loaded: isLoaded(),
  };
}

export interface ServiceResult {
  ok: boolean;
  message: string;
  status: ServiceStatus;
}

/** 등록 + 기동. idempotent — 이미 있으면 plist 를 갱신하고 다시 bootstrap 한다. */
export function install(): ServiceResult {
  if (!isSupportedPlatform()) {
    return { ok: false, message: "launchd 등록은 macOS 에서만 지원됩니다(Windows 미지원).", status: status() };
  }
  const { label, plist } = serverServicePaths();
  mkdirSync(dirname(plist), { recursive: true });
  mkdirSync(`${REPO_ROOT}/logs`, { recursive: true });
  writeFileSync(plist, renderServerPlist(), "utf-8");

  // 이미 로드돼 있으면 먼저 내려야 새 plist 가 반영된다.
  if (isLoaded()) spawnSync("launchctl", ["bootout", `${guiDomain()}/${label}`], { stdio: "ignore" });
  const r = spawnSync("launchctl", ["bootstrap", guiDomain(), plist], { encoding: "utf-8" });
  const st = status();
  if (!st.loaded) {
    return { ok: false, message: `bootstrap 실패: ${(r.stderr || r.stdout || "").trim() || "unknown"}`, status: st };
  }
  return { ok: true, message: `등록 완료 — 재부팅해도 자동으로 뜹니다 (${label})`, status: st };
}

/** 해제 + 정지. plist 도 제거한다(등록 안 한 상태로 되돌림). */
export function uninstall(): ServiceResult {
  if (!isSupportedPlatform()) {
    return { ok: false, message: "launchd 해제는 macOS 에서만 지원됩니다.", status: status() };
  }
  const { label, plist } = serverServicePaths();
  if (isLoaded()) spawnSync("launchctl", ["bootout", `${guiDomain()}/${label}`], { stdio: "ignore" });
  if (existsSync(plist)) rmSync(plist, { force: true });
  return { ok: true, message: `해제 완료 — 이제 서버는 \`bun run start\` 로 직접 띄우면 됩니다 (${label})`, status: status() };
}

/** 재시작(kickstart). ★등록되지 않았으면 시도하지 않는다 — 없는 라벨에 kickstart 금지.★ */
export function restart(): ServiceResult {
  const st = status();
  if (!st.supported) {
    return { ok: false, message: "launchd 재시작은 macOS 에서만 지원됩니다.", status: st };
  }
  if (!st.loaded) {
    return {
      ok: false,
      message: "서버가 launchd 서비스로 등록돼 있지 않습니다. `bun run start` 로 직접 띄우거나, 먼저 등록하세요.",
      status: st,
    };
  }
  const r = spawnSync("launchctl", ["kickstart", "-k", `${guiDomain()}/${st.label}`], { encoding: "utf-8" });
  if (r.status !== 0) {
    return { ok: false, message: `kickstart 실패: ${(r.stderr || r.stdout || "").trim() || "unknown"}`, status: status() };
  }
  return { ok: true, message: `재시작했습니다 (${st.label})`, status: status() };
}
