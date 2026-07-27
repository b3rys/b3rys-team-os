// 중앙 경로 모듈 — 하드코딩된 `/Users/you/...` 절대경로를 HOME 기준으로 이관해
// 공개 빌드가 임의 머신에서 동작하게 한다(포터빌리티, GD 2026-07-02).
//
// 원칙:
//   - process.env 는 여기서 한 번만 읽는다(단일 출처).
//   - REPO_ROOT / MEMBERS_ROOT 는 personaTemplates 와 동일 파생을 재사용(divergence 방지).
//     personaTemplates: REPO_ROOT = TEAM_COLLAB_ROOT ?? resolve(<이 소스 dir>/../../..)
//                       MEMBERS_ROOT = B3RYS_HOME ? $B3RYS_HOME/members : $HOME/Development
//   - GD 머신(HOME=/Users/you)에선 모든 값이 기존 하드코딩과 동일하게 해석된다(무중단).
//
// dependency-light: node:path 와 타입 전용 import 만.

import { join } from "node:path";
import type { AgentRecord } from "../types";
import { REPO_ROOT as PERSONA_REPO_ROOT, MEMBERS_ROOT as PERSONA_MEMBERS_ROOT } from "./personaTemplates";

/** 홈 디렉토리(process.env.HOME). 미설정이면 빈 문자열(기존 규약과 동일). */
export const HOME = process.env.HOME ?? "";

/** 사용자 로컬 바이너리 경로(~/.local/bin) — hermes 프로필 바이너리 위치. */
export const LOCAL_BIN = `${HOME}/.local/bin`;

/** hermes 런타임 홈(~/.hermes) — 프로필 .env / credentials 위치. */
export const HERMES_ROOT = `${HOME}/.hermes`;

/** 공유 Hermes 인증 원본 프로필. 공개 기본값은 중립적인 b3os이며 운영 환경에서 env로 재정의한다.
 *  삭제 가드의 기준이므로 잘못된 값은 기본값으로 조용히 폴백하지 않고 서버 시작 단계에서 fail-closed한다. */
const configuredHermesBaseProfile = process.env.HERMES_BASE_PROFILE?.trim();
if (configuredHermesBaseProfile && !/^[A-Za-z0-9_-]+$/.test(configuredHermesBaseProfile)) {
  throw new Error("HERMES_BASE_PROFILE must be a safe profile slug (letters, numbers, underscore, hyphen)");
}
export const HERMES_BASE_PROFILE = configuredHermesBaseProfile || "b3os";

/** openclaw 런타임 홈(~/.openclaw) — openclaw.env / credentials 위치. */
export const OPENCLAW_ROOT = `${HOME}/.openclaw`;

/** team-os repo 루트. personaTemplates 와 동일 파생(TEAM_COLLAB_ROOT env override 존중). */
export const REPO_ROOT = PERSONA_REPO_ROOT;

/** 멤버 워크스페이스 데이터 루트. personaTemplates 와 동일 파생(B3RYS_HOME env override 존중). */
export const MEMBERS_ROOT = PERSONA_MEMBERS_ROOT;

/** 런타임 활성화 스크립트 디렉토리(런타임별 하위폴더 <rt>/activate-<rt>-agent.sh).
 *  기본 = repo 안 vendored 스크립트(src/server/runtimes). TEAM_MANUALS_DIR 로 override 가능. */
export const MANUALS_DIR = process.env.TEAM_MANUALS_DIR ?? join(REPO_ROOT, "src/server/runtimes");

/** hermes 바이너리 경로 — 프로필명이 있으면 그것을, 없으면 b3rys<id> 규약. (hermes_alias 는 호출측에서 우선 처리) */
export function hermesBinary(agent: Pick<AgentRecord, "id" | "hermes_profile">): string {
  return agent.hermes_profile ? `${LOCAL_BIN}/${agent.hermes_profile}` : `${LOCAL_BIN}/b3rys${agent.id}`;
}

/** Expand a machine-local path stored in agents.json/runtime config. */
export function expandHomePath(path: string): string {
  if (path === "~") return HOME;
  if (path.startsWith("~/")) return `${HOME}${path.slice(1)}`;
  return path;
}

/** Gateway/CLI working directory for a member. Defaults to workspace_path for backward compatibility. */
export function runtimeCwdForAgent(agent: Pick<AgentRecord, "id" | "workspace_path" | "runtime_cwd">): string {
  const configured = agent.runtime_cwd?.trim();
  if (configured) return expandHomePath(configured);
  if (agent.workspace_path) return expandHomePath(agent.workspace_path);
  return `${MEMBERS_ROOT}/${agent.id}`;
}

// ─── 자식 프로세스 PATH 보강 ──────────────────────────────────────────────
// ★launchd 로 뜬 서버의 PATH 는 제한적★ 이라, bare name 으로 도구를 부르는 코드가 그대로 실패한다.
// openclaw 실행파일 자체는 openclawBridge.resolveOpenclawBin() 이 절대경로로 풀지만,
// ★approvals 가 spawn 하는 쉘 스크립트(activate-openclaw-agent.sh) 안의 bare name 은 그걸로 안 풀린다.★
// spawn 하는 쪽에서 PATH 를 씌우면 자식이 실행하는 스크립트 내부까지 한 번에 커버된다.
// agentControl·activation 이 각자 PATH 문자열을 손으로 적고 있어 ★/usr/local/bin 이 빠지는 식으로
// 조용히 어긋나 있었다★ — 목록을 여기 하나로 모은다.
export const RUNTIME_BIN_DIRS = [
  LOCAL_BIN,              // npm -g · hermes 프로필
  `${HOME}/.bun/bin`,     // bun 공식 인스톨러
  "/opt/homebrew/bin",    // Apple Silicon homebrew
  "/usr/local/bin",       // Intel homebrew
];

/** 자식 프로세스용 env — PATH 앞에 RUNTIME_BIN_DIRS 를 붙인다(기존 PATH 는 뒤에 보존). */
export function withRuntimePath(base: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
  out.PATH = [...RUNTIME_BIN_DIRS, base.PATH ?? ""].filter(Boolean).join(":");
  return out;
}

/** 공유 openclaw env 파일 경로. OPENCLAW_ENV env override, 기본 = ~/.openclaw/openclaw.env. */
export function openclawEnvPath(): string {
  return process.env.OPENCLAW_ENV ?? `${OPENCLAW_ROOT}/openclaw.env`;
}
