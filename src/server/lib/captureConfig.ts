// captureConfig — 기본 협업 floor 설정(capture 봇 토큰·라우터·그룹)을 UI-settable 하게.
// (P0, OWNER 2026-06-28) 목적: 신규 유저가 터미널·.env 편집 없이 대시보드로 기본 협업을 켤 수 있게.
//
// 저장 위치(보안):
//   - capture 봇 토큰 = var/secrets/capture.bot-token (0600 파일, approvals.setPin 패턴). ★절대 DB·audit·로그에 값으로 두지 않는다 — 경로 참조만.
//   - router_enabled / capture_group_id = setting DB(비밀 아님).
//   - env(CAPTURE_BOT_TOKEN/ROUTER_ENABLED/CAPTURE_GROUP_ID)는 bootstrap/fallback — store가 비면 env 사용(라이브 무중단).
//
// router_enabled 는 *라이브 읽기*용(worker/router 가 매번 isRouterEnabled(db) 호출 → UI 토글 즉시 반영, 재시작 불요).
import type { Database } from "bun:sqlite";
import { chmodSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// 테스트 격리용 env override(라이브 var/secrets 오염 방지) — 미설정 시 라이브 경로. 함수로 둬서 매 호출 시 평가(테스트가 env로 주입).
function tokenPath(): string {
  return process.env.CAPTURE_TOKEN_FILE ?? `${process.cwd()}/var/secrets/capture.bot-token`;
}

// ── capture 봇 토큰 (0600 파일, write-only — getter는 내부용, UI엔 hasCaptureToken 만) ──
export function hasCaptureToken(): boolean {
  try {
    if (existsSync(tokenPath()) && readFileSync(tokenPath(), "utf-8").trim()) return true;
  } catch {
    /* 파일 접근 실패 → env fallback */
  }
  return !!process.env.CAPTURE_BOT_TOKEN?.trim();
}

export function getCaptureToken(): string | null {
  try {
    if (existsSync(tokenPath())) {
      const t = readFileSync(tokenPath(), "utf-8").trim();
      if (t) return t;
    }
  } catch {
    /* 파일 없음/접근 실패 → env fallback */
  }
  return process.env.CAPTURE_BOT_TOKEN?.trim() || null;
}

export function setCaptureToken(token: string): void {
  mkdirSync(dirname(tokenPath()), { recursive: true, mode: 0o700 }); // 하네스 L1: 시크릿 디렉토리 0700
  writeFileSync(tokenPath(), token.trim(), { mode: 0o600 });
  try {
    chmodSync(tokenPath(), 0o600); // 기존 파일 권한 보정(umask 영향 방지)
  } catch {
    /* best-effort */
  }
}

// ── 비밀 아닌 config (setting DB, env fallback) ──
function getSetting(db: Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM setting WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setSetting(db: Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
  ).run(key, value);
}

// (getOwnerName 제거 2026-07-01: OWNER 단순화로 주입문·라우터가 owner_name 치환 대신 generic '팀장'/'the team lead'
//  locale pick 사용 → 호출처 0. owner_name 실제 이름은 셋업 정체선언(핵심룰 {{OWNER}})에서만 렌더.)

/**
 * 팀 메시지/UI 로케일 — 한국어 기본, setting 'locale'='en' 일 때만 영어. (OWNER 2026-06-30)
 * 라이브 읽기(owner_name 패턴 동일) — 토글 즉시 반영, 재시작 불요. owner_name 치환과 직교.
 */
export function getLocale(db: Database): import("./i18n").Locale {
  return getSetting(db, "locale") === "en" ? "en" : "ko";
}

/** 라이브 읽기 — worker/router 가 매 메시지마다 호출(UI 토글 즉시 반영). store 우선, 없으면 env, 둘 다 없으면 기본 ON. */
export function isRouterEnabled(db: Database): boolean {
  const v = getSetting(db, "router_enabled");
  if (v !== null) return v === "true";
  // 기본 ON (OWNER 2026-07-21): 신규 사용자가 토글을 켜야 팀이 응답하던 초반 마찰 제거.
  // 명시적으로 끈 경우(setting="false" 또는 ROUTER_ENABLED=false)와 비상 킬스위치는 그대로 동작.
  return process.env.ROUTER_ENABLED !== "false";
}

export function setRouterEnabled(db: Database, on: boolean): void {
  setSetting(db, "router_enabled", on ? "true" : "false");
}

// group_id — 비밀 아니지만 *모듈 로드 시점*(워커 const)에서 읽혀야 해 파일 기반(그 시점엔 db 없음). file→env fallback.
// (Codex 팀원리뷰: DB저장+env읽기 불일치 → UI로 바꿔도 미적용 "설정됐다 보이는데 안 됨" 버그. 파일로 통일=재시작 시 적용+GET 일치.)
function groupPath(): string {
  return process.env.CAPTURE_GROUP_FILE ?? `${process.cwd()}/var/capture-group-id.txt`;
}

export function getCaptureGroupId(): string | null {
  try {
    if (existsSync(groupPath())) {
      const g = readFileSync(groupPath(), "utf-8").trim();
      if (g) return g;
    }
  } catch {
    /* 파일 없음/접근 실패 → env fallback */
  }
  return process.env.CAPTURE_GROUP_ID?.trim() || null;
}

export function setCaptureGroupId(id: string): void {
  mkdirSync(dirname(groupPath()), { recursive: true });
  writeFileSync(groupPath(), id.trim());
}

/** UI/GET 용 마스킹 상태 — ★토큰 값은 절대 포함하지 않는다. router 는 라이브(db), group/token 은 파일. */
export function captureConfigStatus(db: Database): {
  has_capture_token: boolean;
  capture_group_id: string | null;
  router_enabled: boolean;
} {
  return {
    has_capture_token: hasCaptureToken(),
    capture_group_id: getCaptureGroupId(),
    router_enabled: isRouterEnabled(db),
  };
}
