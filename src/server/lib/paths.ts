// 중앙 경로 모듈 — 하드코딩된 `/Users/you/...` 절대경로를 HOME 기준으로 이관해
// 공개 빌드가 임의 머신에서 동작하게 한다(포터빌리티, OWNER 2026-07-02).
//
// 원칙:
//   - process.env 는 여기서 한 번만 읽는다(단일 출처).
//   - REPO_ROOT / MEMBERS_ROOT 는 personaTemplates 와 동일 파생을 재사용(divergence 방지).
//     personaTemplates: REPO_ROOT = TEAM_COLLAB_ROOT ?? resolve(<이 소스 dir>/../../..)
//                       MEMBERS_ROOT = B3RYS_HOME ? $B3RYS_HOME/members : $HOME/Development
//   - OWNER 머신(HOME=/Users/you)에선 모든 값이 기존 하드코딩과 동일하게 해석된다(무중단).
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

/** 공유 openclaw env 파일 경로. OPENCLAW_ENV env override, 기본 = ~/.openclaw/openclaw.env. */
export function openclawEnvPath(): string {
  return process.env.OPENCLAW_ENV ?? `${OPENCLAW_ROOT}/openclaw.env`;
}
