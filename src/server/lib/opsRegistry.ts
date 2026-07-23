// opsRegistry — 잡/기능을 한 레지스트리로 모아 *조건부 on/off* 관리(P1, GD 2026-06-28 설계: Bill+Codex+Steve).
//
// 설계 핵심(Codex 리뷰):
//   - 각 항목 = 공통 envelope(메타) + desired_enabled(사용자 토글) + conditions(선언형 predicate).
//   - predicate는 함수명 저장 X → type+params 로 저장(UI·audit 가 설명 가능).
//   - 4상태 분리: eligible(조건 충족) / desired(사용자 토글) / effective(실제 활성) / reason_codes(왜).
//   - agent capability registry 와는 *분리*(여긴 ops 기능/잡). predicate engine 만 공유, team 조건은 agent registry read-only 참조.
//   - 스케줄러는 effective_enabled=true 인 job 만 돌린다(P1 후속 단계).
//   - ★자동 enable ≠ 실행 허가: 조건 충족=켜질 자격. 위험기능(외부전송/배포/삭제) 첫 실행은 별도 approval(여기 밖).
import type { Database } from "bun:sqlite";

// ── 조건 predicate (선언형, type+params) ───────────────────────────
export type Predicate =
  | { platform: { in: string[] } }                 // 현재 OS 가 목록에 있나 (예 ["macos"])
  | { team: { capability: string; min: number } }  // 그 capability 보유 멤버 ≥ min
  | { members: { min: number } }                   // 멤버 수 ≥ min
  | { config_present: { keys: string[] } }          // 주어진 config 키가 모두 채워졌나
  | { agent_exists: { id: string } }               // 특정 agent 가 존재(영입)했나
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate };

export interface OpsEntry {
  id: string;
  type: "job" | "feature";
  title: string;
  scope: "public" | "internal";   // 퍼블릭 패키지에 실릴지(GD: 설정도 live↔public 분리)
  default_desired: boolean;        // 사용자 미설정 시 기본 desired (GD: 안전·유익은 기본 ON)
  conditions: Predicate;           // 켤 자격 조건(all/any/not 조합)
  risky?: boolean;                 // 외부전송/배포/삭제 — 첫 실행 approval 별도 필요(표시용)
  note?: string;
}

// 평가 컨텍스트 — 런타임이 실제 상태를 주입(team 조건은 agent registry read-only).
export interface OpsContext {
  platform: string;                                  // "macos" | "linux" | ...
  agents: Array<{ id: string; capabilities?: string[] | null; enabled?: boolean }>;
  configPresent: (key: string) => boolean;           // config 키 채워짐 여부(토큰 set 등)
}

// ── predicate 평가 → eligible + reason_codes ───────────────────────
export function evaluatePredicate(p: Predicate, ctx: OpsContext): { ok: boolean; reasons: string[] } {
  if ("platform" in p) {
    const ok = p.platform.in.includes(ctx.platform);
    return { ok, reasons: ok ? [] : [`platform_unsupported:${ctx.platform}∉${p.platform.in.join("/")}`] };
  }
  if ("team" in p) {
    const n = ctx.agents.filter((a) => a.enabled !== false && Array.isArray(a.capabilities) && a.capabilities.includes(p.team.capability)).length;
    const ok = n >= p.team.min;
    return { ok, reasons: ok ? [] : [`need_capability:${p.team.capability}≥${p.team.min}(have ${n})`] };
  }
  if ("members" in p) {
    const n = ctx.agents.filter((a) => a.enabled !== false).length;
    const ok = n >= p.members.min;
    return { ok, reasons: ok ? [] : [`need_members:≥${p.members.min}(have ${n})`] };
  }
  if ("config_present" in p) {
    const missing = p.config_present.keys.filter((k) => !ctx.configPresent(k));
    return { ok: missing.length === 0, reasons: missing.length ? [`config_missing:${missing.join(",")}`] : [] };
  }
  if ("agent_exists" in p) {
    const ok = ctx.agents.some((a) => a.id === p.agent_exists.id && a.enabled !== false);
    return { ok, reasons: ok ? [] : [`agent_missing:${p.agent_exists.id}`] };
  }
  if ("all" in p) {
    const rs = p.all.map((q) => evaluatePredicate(q, ctx));
    return { ok: rs.every((r) => r.ok), reasons: rs.flatMap((r) => r.reasons) };
  }
  if ("any" in p) {
    const rs = p.any.map((q) => evaluatePredicate(q, ctx));
    const ok = rs.some((r) => r.ok);
    return { ok, reasons: ok ? [] : rs.flatMap((r) => r.reasons) };
  }
  // not
  const r = evaluatePredicate(p.not, ctx);
  return { ok: !r.ok, reasons: r.ok ? ["not_condition_failed"] : [] };
}

// ── desired (사용자 토글) — setting DB. 미설정이면 default_desired. ──
function desiredKey(id: string): string { return `ops_desired_${id}`; }
export function getDesired(db: Database, entry: OpsEntry): boolean {
  const row = db.prepare("SELECT value FROM setting WHERE key = ?").get(desiredKey(entry.id)) as { value: string } | undefined;
  if (!row) return entry.default_desired;
  return row.value === "true";
}
export function setDesired(db: Database, id: string, on: boolean): void {
  db.prepare("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')")
    .run(desiredKey(id), on ? "true" : "false");
}

// ── effective state (4상태) ────────────────────────────────────────
export interface OpsState {
  id: string; type: "job" | "feature"; title: string; scope: "public" | "internal"; risky: boolean;
  eligible: boolean;       // 조건 충족(켤 자격)
  desired: boolean;        // 사용자 토글
  effective: boolean;      // 실제 활성 = eligible && desired
  reasons: string[];       // 왜 ineligible 인지(eligible=false일 때)
}
export function effectiveState(db: Database, entry: OpsEntry, ctx: OpsContext): OpsState {
  const { ok: eligible, reasons } = evaluatePredicate(entry.conditions, ctx);
  const desired = getDesired(db, entry);
  return {
    id: entry.id, type: entry.type, title: entry.title, scope: entry.scope, risky: !!entry.risky,
    eligible, desired, effective: eligible && desired, reasons: eligible ? [] : reasons,
  };
}

// ── 카탈로그 — 잡/기능 정의 (P1 starter; 스케줄러/실배선은 후속 단계) ──
// GD 스코핑: public = capture/router·onoff·칸반·learning·auto-heal·continuation·read-slash / internal = deploy·digest·approve·b3os야간.
export const OPS_CATALOG: OpsEntry[] = [
  {
    id: "kanban-daily", type: "job", title: "매일 칸반 PM 정리", scope: "public", default_desired: true,
    conditions: { team: { capability: "coordinator", min: 1 } },
    note: "owner(coordinator)를 매일 깨워 칸반 점검·보고.",
  },
  {
    id: "learning-weekly", type: "job", title: "주간 self-learning", scope: "public", default_desired: true,
    conditions: { all: [{ team: { capability: "coordinator", min: 1 } }, { members: { min: 2 } }] },
    note: "팀 ≥2명 + coordinator 있을 때. 혼자면 의미 약함.",
  },
  {
    id: "continuation-guard", type: "job", title: "미완 과제 재확인(continuation guard)", scope: "public", default_desired: true,
    conditions: { team: { capability: "coordinator", min: 1 } },
  },
  {
    id: "auto-heal", type: "feature", title: "봇 살아있음 점검·복구(auto-heal)", scope: "public", default_desired: true,
    conditions: { platform: { in: ["macos"] } },
    note: "현재 launchd(macOS) 기반. linux/cloud 확장 시 platform 조건 완화.",
  },
  {
    id: "onoff", type: "feature", title: "팀원 중지/전체중지(onoff)", scope: "public", default_desired: true,
    conditions: { members: { min: 1 } },
    note: "사용자 필수 제어. reversible.",
  },
  {
    id: "slash-readonly", type: "feature", title: "읽기전용 슬래시(/board·/review·/status)", scope: "public", default_desired: true,
    conditions: { config_present: { keys: ["capture_bot_token"] } },
  },
  {
    id: "b3os-native-nightly", type: "job", title: "b3os_native 야간 스파이크", scope: "internal", default_desired: false,
    conditions: { agent_exists: { id: "demis" } }, note: "우리팀 전용 실험.",
  },
  {
    id: "deploy", type: "feature", title: "퍼블릭 배포(/deploy)", scope: "internal", default_desired: false, risky: true,
    conditions: { config_present: { keys: ["capture_bot_token"] } }, note: "외부 반출 — 첫 실행 approval 별도.",
  },
];

export function listOpsState(db: Database, ctx: OpsContext, opts?: { scope?: "public" | "internal" }): OpsState[] {
  return OPS_CATALOG
    .filter((e) => !opts?.scope || e.scope === opts.scope)
    .map((e) => effectiveState(db, e, ctx));
}
