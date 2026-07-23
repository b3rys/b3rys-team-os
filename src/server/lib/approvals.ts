// 승인 큐 — GD 승인이 필요한 권한 액션을 모아 PIN 승인으로 실행(터미널 0). (2026-06-10 GD)
//
// 보안 모델:
//  - 액션은 **미리 정의된 안전 셋(ACTIONS)만**. 임의 명령 enqueue/실행 불가.
//  - 승인에는 **6자리 admin PIN**(해시 저장, rate-limit)이 필요 → 채널 인젝션이 PIN을 모르면 승인 불가.
//  - **실행(executeApproval)은 1단계에서 OFF**. APPROVAL_EXECUTION_ENABLED=1 일 때만 켜짐(2단계).
//    실행 = 신뢰 경계가 "터미널 직접"→"PIN 인증 서버 실행"으로 이동하는 부분이라 명시 opt-in.
//
// blast radius: 이 파일 + routes/approvals.ts + telegramCapture /menu. message/agent 테이블 무관.

import type { Database } from "bun:sqlite";
import { appendAuditFile } from "./auditFile";
import { MANUALS_DIR } from "./paths";

// ---------------------------------------------------------------------------
// 액션 레지스트리 — 미리 정의된 안전 셋. (Stage 2에서 script/buildEnv 로 실행)
// ---------------------------------------------------------------------------

export interface ApprovalAction {
  key: string;
  label: string;
  description: string;
  danger: "low" | "medium" | "high";
  /** 실행 명령(화이트리스트). cmd 배열 그대로 spawn. env 는 params 에서 생성(화이트리스트 키만). */
  run?: { cmd: string[]; env?: (params: Record<string, string>) => Record<string, string> };
  /** 필요한 파라미터 힌트(검증·UI용). */
  paramHints?: string[];
  /** true 면 전역 실행 OFF 여도 승인 탭 시 즉시 실행(액션별 opt-in). merge_to_main 등 저위험만.
   *  ⚠ deploy_public 같은 고위험은 false 유지 — 탭=승인만, 실행은 별도. (least privilege) */
  autoExec?: boolean;
}

export const ACTIONS: Record<string, ApprovalAction> = {
  activate_openclaw: {
    key: "activate_openclaw",
    label: "openclaw 런타임 팀원 활성화",
    description:
      "새 openclaw 에이전트 생성 + 텔레그램 봇·auth·게이트웨이 연결. ⚠ 게이트웨이 재시작 = 다른 openclaw 에이전트 1~2분 중단.",
    danger: "high",
    run: {
      cmd: ["bash", `${MANUALS_DIR}/openclaw/activate-openclaw-agent.sh`],
      env: (p) => ({
        AGENT_ID: p.agent_id ?? "",
        DISPLAY: p.display ?? "",
        ...(p.ws ? { WS: p.ws } : {}),
        ...(p.model ? { MODEL: p.model } : {}),
      }),
    },
    paramHints: ["agent_id", "display", "ws?", "model?"],
  },
  restart_openclaw_gateway: {
    key: "restart_openclaw_gateway",
    label: "openclaw 게이트웨이 재시작",
    description: "openclaw 게이트웨이 재시작. ⚠ 모든 openclaw 에이전트 1~2분 중단.",
    danger: "high",
    run: { cmd: ["openclaw", "gateway", "restart"] },
    paramHints: [],
  },
  deploy_public: {
    key: "deploy_public",
    label: "공개 릴리스 배포",
    description:
      "HEAD export → 누출 검증 → 통과 시 공개 repo(main) push. ⚠ 공개 배포이므로 승인 큐와 실행 게이트를 반드시 지난다.",
    danger: "high",
    run: {
      cmd: [
        "bash",
        "-lc",
        "cd \"${TEAM_COLLAB_DIR:-$HOME/Development/b3rys-team-os}\" && bash scripts/deploy-public.sh",
      ],
    },
    paramHints: [],
  },
  permission_gate: {
    key: "permission_gate",
    label: "런타임 권한 요청",
    description:
      "Codex/OpenClaw/Hermes 런타임의 ask-tier 권한 요청. Telegram /approve 에서 allow-once/always/deny 로 처리한다.",
    danger: "high",
    paramHints: ["permission_request_id", "scope_key", "runtime", "agent_id?", "action", "target"],
  },
  // 파이프라인 검증용 안전 액션(실제 변경 없음). /approve 탭→실행→결과 흐름 테스트에 씀.
  noop_echo: {
    key: "noop_echo",
    label: "테스트(안전·무해): echo",
    description: "실행 파이프라인 검증용. 아무 시스템 변경 없이 echo 만. 언제든 안전.",
    danger: "low",
    run: { cmd: ["bash", "-c", "echo 'executed-ok ('\"$NOTE\"')'"], env: (p) => ({ NOTE: p.note ?? "ping" }) },
    paramHints: ["note?"],
  },
  // merge-gate: 승인된 브랜치를 main 에 머지. merge_gate_enabled=true 일 때만 enqueue/노출된다(merge-to-main.sh).
  //   실행기 = merge-to-main.sh (승인 레코드를 토큰으로 --no-ff 머지 + Approved-by 트레일러). 승인=탭 인증.
  merge_to_main: {
    key: "merge_to_main",
    label: "main 머지 승인",
    description:
      "승인된 브랜치를 main 에 머지한다(merge-to-main.sh). 탭 승인 = 인증. merge_gate ON repo 에서만 노출/실행. " +
      "현재 승인 모델 = GD 탭 승인(승인자=GD, 작성자=에이전트 → self-approve 원천 불가). " +
      "에이전트(Bill·Codex)도 승인자로 확장 시 self-approve 차단(byUserId≠params.author) 을 별도 구현해야 함(미구현).",
    danger: "high",
    autoExec: true, // 저위험(로컬 main, 롤백 쉬움) — 탭 승인 시 즉시 머지. deploy 등 고위험은 autoExec 없음.
    run: {
      cmd: [
        "bash",
        "-lc",
        "cd \"${TEAM_COLLAB_DIR:-$HOME/Development/b3rys-team-os}\" && bash scripts/merge-to-main.sh \"$MERGE_BRANCH\"",
      ],
      env: (p) => ({ MERGE_BRANCH: p.branch ?? "" }),
    },
    paramHints: ["branch", "author?", "tier?"],
  },
};

export function listActions(): ApprovalAction[] {
  return Object.values(ACTIONS);
}

// ---------------------------------------------------------------------------
// 승인 큐 CRUD
// ---------------------------------------------------------------------------

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "executing"
  | "done"
  | "failed"
  | "rejected"
  | "expired"
  | "deferred"; // 승인 시스템 v2(GD 2026-07-08): 10분 미승인 자동 보류

export interface ApprovalRow {
  id: string;
  action_key: string;
  params_json: string;
  title: string;
  status: ApprovalStatus;
  requested_by: string;
  created_at: string;
  decided_at: string | null;
  result: string | null;
}

let _seq = 0;
function genId(): string {
  // crypto.randomUUID 없이도 충돌 적게: 시퀀스 + 길이로. (Date.now 미사용 — 워커 환경 제약 무관)
  _seq = (_seq + 1) % 0xffffff;
  const rnd = Math.floor((performance.now() * 1000) % 0xffffff);
  return `apr_${(_seq ^ rnd).toString(16).padStart(6, "0")}${rnd.toString(16).padStart(6, "0")}`;
}

/** 권한 액션을 승인 큐에 적재(pending). action_key 는 ACTIONS 에 있어야 함. */
export function enqueueApproval(
  db: Database,
  input: { action_key: string; params?: Record<string, string>; title?: string; requested_by?: string },
): ApprovalRow {
  const action = ACTIONS[input.action_key];
  if (!action) throw new Error(`unknown action_key: ${input.action_key}`);
  const id = genId();
  const params = input.params ?? {};
  const title = input.title ?? action.label;
  db.prepare(
    `INSERT INTO approval_request(id, action_key, params_json, title, status, requested_by)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  ).run(id, action.key, JSON.stringify(params), title, input.requested_by ?? "system");
  appendAuditFile("approvals", "enqueue", id, { action_key: action.key, title });
  return getApproval(db, id)!;
}

export function getApproval(db: Database, id: string): ApprovalRow | undefined {
  return db.prepare("SELECT * FROM approval_request WHERE id = ?").get(id) as ApprovalRow | undefined;
}

export function listApprovals(db: Database, status?: ApprovalStatus): ApprovalRow[] {
  const rows = status
    ? db.prepare("SELECT * FROM approval_request WHERE status = ? ORDER BY created_at DESC LIMIT 50").all(status)
    : db.prepare("SELECT * FROM approval_request ORDER BY created_at DESC LIMIT 50").all();
  return rows as ApprovalRow[];
}

export function setApprovalStatus(
  db: Database,
  id: string,
  status: ApprovalStatus,
  result?: string,
): void {
  db.prepare(
    `UPDATE approval_request
       SET status = ?, decided_at = datetime('now'), result = COALESCE(?, result)
     WHERE id = ?`,
  ).run(status, result ?? null, id);
}

// 승인 시스템 v2 tier 인가(GD 2026-07-08). normal(문구·코드) 승인자 풀 = author 아닌 풀 1인.
// core(위험·보안·삭제·배포)는 GD(lead) 탭만. GD 는 상위권한이라 normal 도 승인 가능(단 self-approve 금지).
// 에이전트 승인은 CLI/버스 경로(텔레그램 탭 아님). 소문자 id 비교.
// ★풀은 하드코딩 아니라 설정(setting)으로 언제든 변경(GD 2026-07-08, 데이터구조>분기 원칙).
export const DEFAULT_NORMAL_TIER_APPROVERS = ["bill", "steve", "codex", "hermes"] as const;
export const MERGE_APPROVERS_SETTING_KEY = "merge_approvers_normal";
export type ApprovalTier = "normal" | "core";

/** 설정에서 normal tier 승인자 풀 조회(콤마/공백 구분, 소문자). 미설정=기본 4인. GD 가 대시보드/설정에서 변경. */
export function getNormalApprovers(db: Database): string[] {
  const row = db.prepare("SELECT value FROM setting WHERE key = ?").get(MERGE_APPROVERS_SETTING_KEY) as
    | { value: string }
    | undefined;
  const raw = row?.value?.trim();
  if (!raw) return DEFAULT_NORMAL_TIER_APPROVERS.map((s) => s);
  const pool = raw.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  return pool.length ? pool : DEFAULT_NORMAL_TIER_APPROVERS.map((s) => s); // 빈 설정=기본(락아웃 방지)
}

/**
 * 이 승인 시도가 tier 규칙상 인가되는가? 순수 함수(부작용 없음) — 상위 인가(allowlist·탭 위조불가)는
 * 호출부가 이미 확인했다고 가정하고, 여기선 tier↔승인자 자격 + self-approve 금지만 판정.
 * 풀은 주입받는다(getNormalApprovers 결과) — 순수·테스트가능·config-driven.
 * Bill 제약①(author≠approver, 모든 tier) ⑧(core=lead-only) 준수.
 */
export function canApproveTier(opts: {
  tier: ApprovalTier;
  approver: string; // 승인 시도자 id (agent 소문자 id, 또는 lead)
  author: string; // 요청 작성자 (requested_by)
  isLead: boolean; // approver 가 GD(lead)로 이미 인증됐나 (core / 상위권한)
  normalApprovers: string[]; // getNormalApprovers(db) 주입 (config-driven 풀)
}): { ok: boolean; reason?: string } {
  const approver = (opts.approver ?? "").trim().toLowerCase();
  const author = (opts.author ?? "").trim().toLowerCase();
  // ① self-approve 금지 — 모든 tier. (lead 가 자기 요청을 승인하는 경우도 차단; 실무상 GD 는 요청자가 아님)
  if (approver && author && approver === author) {
    return { ok: false, reason: "self-approve 금지(author≠approver)" };
  }
  if (opts.isLead) return { ok: true }; // GD 는 normal·core 둘 다 승인 가능(상위권한)
  if (opts.tier === "core") return { ok: false, reason: "core tier 는 팀장(GD) 승인만" };
  // normal: 풀 자격(설정 주입)
  if (opts.normalApprovers.map((s) => s.toLowerCase()).includes(approver)) return { ok: true };
  return { ok: false, reason: "normal tier 승인자 아님(설정된 풀에 없음)" };
}

/**
 * 승인 시스템 v2(GD 2026-07-08): maxAgeMinutes(기본 10분) 이상 pending 인 승인을 '보류(deferred)' 로
 * 전이하고 대상 행을 반환한다(호출부가 신청자에게 알림). ★행 id 로 개별 전이 — 'WHERE status=pending'
 * 일괄 UPDATE 금지(Bill 제약⑨: bulk 는 남의 pending 오염). 순수 db 로직이라 sender 비의존 → 테스트 용이.
 */
export function deferStaleApprovals(db: Database, maxAgeMinutes = 10): ApprovalRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM approval_request
         WHERE status = 'pending' AND created_at <= datetime('now', ?)
         ORDER BY created_at ASC`,
    )
    .all(`-${maxAgeMinutes} minutes`) as ApprovalRow[];
  for (const r of rows) {
    setApprovalStatus(db, r.id, "deferred"); // id 특정
    appendAuditFile("approvals", "deferred", r.id, { requested_by: r.requested_by, age_min: maxAgeMinutes });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// PIN — 6자리 admin PIN. 해시 저장(Bun.password=argon2id), rate-limit.
// ---------------------------------------------------------------------------

// 테스트 격리용 env override(라이브 admin-pin 의존 차단) — 미설정 시 라이브 경로. 함수로 매 호출 평가.
function pinPath(): string {
  return process.env.ADMIN_PIN_FILE ?? `${process.cwd()}/var/secrets/admin-pin.hash`;
}
const PIN_RE = /^\d{6}$/;

// rate-limit: in-memory 시도 카운터(프로세스 단위). 5회 실패 → 15분 잠금.
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;
let _attempts = 0;
let _lockedUntil = 0;

// PIN per-session — 검증 1회 후 짧은 TTL 토큰으로 재요구 없이(GD UX). in-memory(프로세스).
const PIN_SESSIONS = new Map<string, number>(); // token → expiryMs
const PIN_SESSION_TTL = 30 * 60 * 1000; // 30분
/** PIN 검증 성공 시 세션 토큰 발급(이후 민감작업은 pin 대신 이 토큰으로). */
export async function verifyPinIssueSession(pin: string, nowMs = Date.now()): Promise<{ ok: boolean; token?: string; error?: string }> {
  const v = await verifyPin(pin, nowMs);
  if (!v.ok) return { ok: false, error: v.error };
  const { randomUUID } = await import("node:crypto");
  const token = `pins_${randomUUID()}`;
  PIN_SESSIONS.set(token, nowMs + PIN_SESSION_TTL);
  return { ok: true, token };
}
/** 세션 토큰 유효성(만료 자동정리). */
export function isPinSessionValid(token: string | undefined, nowMs = Date.now()): boolean {
  if (!token) return false;
  const exp = PIN_SESSIONS.get(token);
  if (!exp) return false;
  if (nowMs > exp) { PIN_SESSIONS.delete(token); return false; }
  return true;
}

export function isPinSet(): boolean {
  try {
    return Bun.file(pinPath()).size > 0;
  } catch {
    return false;
  }
}

/** admin PIN 설정/변경. 6자리 숫자만. 해시로 0600 저장(평문 미보관). */
export async function setPin(pin: string): Promise<{ ok: boolean; error?: string }> {
  if (!PIN_RE.test(pin)) return { ok: false, error: "PIN은 6자리 숫자" };
  const hash = await Bun.password.hash(pin, "argon2id");
  // 하네스/Codex 리뷰: temp+rename 원자적 교체 — isPinSet()가 size 0 보는 창 제거(TOCTOU 가드).
  const { chmodSync, renameSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(pinPath()), { recursive: true, mode: 0o700 });
  const tmp = `${pinPath()}.${process.pid}.tmp`;
  await Bun.write(tmp, hash);
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* best-effort */
  }
  renameSync(tmp, pinPath());
  _attempts = 0;
  _lockedUntil = 0;
  appendAuditFile("approvals", "pin_set", "admin", {});
  return { ok: true };
}

export function pinLockState(nowMs = Date.now()): { locked: boolean; until: number } {
  return { locked: nowMs < _lockedUntil, until: _lockedUntil };
}

/** PIN 검증. rate-limit 적용. 값/해시는 절대 로그/리턴에 노출 안 함. */
export async function verifyPin(pin: string, nowMs = Date.now()): Promise<{ ok: boolean; error?: string }> {
  if (nowMs < _lockedUntil) {
    return { ok: false, error: "PIN 시도 잠금 중(15분). 잠시 후 다시." };
  }
  if (!isPinSet()) return { ok: false, error: "admin PIN 미설정" };
  if (!PIN_RE.test(pin)) {
    registerFail(nowMs);
    return { ok: false, error: "PIN 형식 오류" };
  }
  const hash = await Bun.file(pinPath()).text();
  const match = await Bun.password.verify(pin, hash);
  if (!match) {
    registerFail(nowMs);
    appendAuditFile("approvals", "pin_fail", "admin", { attempts: _attempts });
    return { ok: false, error: "PIN 불일치" };
  }
  _attempts = 0;
  return { ok: true };
}

function registerFail(nowMs: number): void {
  _attempts += 1;
  if (_attempts >= MAX_ATTEMPTS) {
    _lockedUntil = nowMs + LOCK_MS;
    _attempts = 0;
    appendAuditFile("approvals", "pin_locked", "admin", { lock_ms: LOCK_MS });
  }
}

// ---------------------------------------------------------------------------
// 승인 + 실행
// ---------------------------------------------------------------------------

/** 실행 활성화 여부. Stage 1=OFF(승인만, 실행 안 함). Stage 2에서 env 로 opt-in. */
export function isExecutionEnabled(): boolean {
  return process.env.APPROVAL_EXECUTION_ENABLED === "1";
}

/**
 * PIN 검증 후 승인(대시보드/API 경로). 실행 ON이면 executeApproval.
 */
export async function approveAndMaybeExecute(
  db: Database,
  id: string,
  pin: string,
): Promise<{ ok: boolean; status: ApprovalStatus; error?: string; executed: boolean; output?: string }> {
  const row = getApproval(db, id);
  if (!row) return { ok: false, status: "rejected", error: "승인 항목 없음", executed: false };
  if (row.status !== "pending") {
    return { ok: false, status: row.status, error: `이미 처리됨(${row.status})`, executed: false };
  }
  const v = await verifyPin(pin);
  if (!v.ok) return { ok: false, status: "pending", error: v.error, executed: false };
  return finalizeApproval(db, id, "pin");
}

/**
 * 신뢰된 탭 승인(텔레그램 인라인 버튼). 인증 = 호출부에서 확인한 GD 텔레그램 id(=tapper).
 * PIN 없이 실행 — GD의 검증된 탭 자체가 인가(채널 텍스트보다 강함: callback_query 는 위조 불가). 2026-06-10 GD.
 */
export async function approveByTrustedTap(
  db: Database,
  id: string,
  byUserId: string,
): Promise<{ ok: boolean; status: ApprovalStatus; error?: string; executed: boolean; output?: string }> {
  const row = getApproval(db, id);
  if (!row) return { ok: false, status: "rejected", error: "승인 항목 없음", executed: false };
  if (row.status !== "pending") {
    return { ok: false, status: row.status, error: `이미 처리됨(${row.status})`, executed: false };
  }
  appendAuditFile("approvals", "tap_approved", id, { action_key: row.action_key, by: byUserId });
  return finalizeApproval(db, id, `tap:${byUserId}`);
}

/** 승인 확정 + (실행 ON 시) 실행. 공통 경로. */
async function finalizeApproval(
  db: Database,
  id: string,
  by: string,
): Promise<{ ok: boolean; status: ApprovalStatus; error?: string; executed: boolean; output?: string }> {
  // ★실제 승인자(by)를 result 에 보존★ — merge commit 트레일러/감사 기록이 요청자가 아닌 진짜 승인자를
  //   가리키게. (Codex 리뷰 2026-07-08: 미보존 시 wrapper 가 requested_by 로 fallback → "Approved-by: 요청자" 거짓기록)
  const prevRes = (() => { try { const r = getApproval(db, id)?.result; return r ? JSON.parse(r) as Record<string, unknown> : {}; } catch { return {}; } })();
  setApprovalStatus(db, id, "approved", JSON.stringify({ ...prevRes, approver: by }));
  appendAuditFile("approvals", "approved", id, { by });
  // 실행 조건: 액션별 autoExec(저위험 opt-in, 예: merge_to_main) 또는 전역 실행 ON.
  // → merge 는 탭 승인 시 즉시 실행 / deploy 등 고위험은 전역 ON 아니면 승인만(실행 안 함).
  const act = ACTIONS[getApproval(db, id)?.action_key ?? ""];
  if (!(act?.autoExec || isExecutionEnabled())) {
    return { ok: true, status: "approved", executed: false };
  }
  const ex = await executeApproval(db, id);
  return { ok: ex.ok, status: ex.ok ? "done" : "failed", executed: true, output: ex.output, error: ex.ok ? undefined : ex.output };
}

/**
 * 화이트리스트 액션 실행. action.run.cmd 를 spawn, stdout/stderr 캡처, status executing→done/failed.
 * ⚠ self-mod(게이트웨이 재시작 등) 포함 — APPROVAL_EXECUTION_ENABLED=1 + 승인 통과 후에만 도달.
 */
export async function executeApproval(db: Database, id: string): Promise<{ ok: boolean; output: string }> {
  const row = getApproval(db, id);
  if (!row) return { ok: false, output: "승인 항목 없음" };
  const action = ACTIONS[row.action_key];
  if (!action?.run) {
    setApprovalStatus(db, id, "failed", "no executor");
    return { ok: false, output: "이 액션엔 실행기(executor)가 없음" };
  }
  setApprovalStatus(db, id, "executing");
  const params = (() => { try { return JSON.parse(row.params_json) as Record<string, string>; } catch { return {}; } })();
  const env = { ...process.env, ...(action.run.env ? action.run.env(params) : {}) };
  appendAuditFile("approvals", "execute_start", id, { action_key: action.key });
  try {
    const proc = Bun.spawn(action.run.cmd, { env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    const tail = (out + (err ? "\n[stderr]\n" + err : "")).trim().slice(-1500);
    const ok = code === 0;
    setApprovalStatus(db, id, ok ? "done" : "failed", tail.slice(0, 1000));
    appendAuditFile("approvals", ok ? "execute_done" : "execute_failed", id, { action_key: action.key, code });
    return { ok, output: tail || (ok ? "완료(출력 없음)" : `실패 (exit ${code})`) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setApprovalStatus(db, id, "failed", msg.slice(0, 1000));
    appendAuditFile("approvals", "execute_error", id, { action_key: action.key, error: msg });
    return { ok: false, output: "실행 오류: " + msg };
  }
}
