// TEAM-OS {{OWNER}} 렌더 (Option B 통합, OWNER 2026-06-25) — 전 런타임이 rules/TEAM-OS.md 를 읽으므로
// 그 파일 자체를 '렌더본'으로 만든다. 템플릿({{OWNER}})은 rules/TEAM-OS.template.md 로 분리(편집·export용).
//   - 소스(편집/export): rules/TEAM-OS.template.md  ({{OWNER}} 유지)
//   - 런타임이 읽는 파일: rules/TEAM-OS.md           ({{OWNER}}→owner_name 렌더; owner 비면 템플릿 그대로)
// claude_channel: workspace 심링크(→ rules/TEAM-OS.md) · openclaw/hermes: AGENTS.md 가 rules/TEAM-OS.md 절대경로
// 둘 다 rules/TEAM-OS.md 를 읽으므로 한 곳 렌더로 전 런타임 적용. 심링크 재지정은 표준 타깃(TEAM-OS.md) 보장용.
import { readFileSync, writeFileSync, lstatSync, unlinkSync, symlinkSync, readlinkSync, existsSync } from "node:fs";
import { REPO_ROOT, MEMBERS_ROOT } from "./personaTemplates";

const RULES_DIR = `${REPO_ROOT}/rules`; // 포터블: repo 루트 기준(OWNER 2026-06-27 — 하드코딩 제거)
const TEMPLATE = `${RULES_DIR}/TEAM-OS.template.md`;
const LIVE = `${RULES_DIR}/TEAM-OS.md`; // 런타임이 읽는 렌더본
// claude 에이전트 workspace 심링크가 가리킬 표준 타깃 = 렌더본 절대경로.
// (상대경로는 workspace가 repo의 형제일 때만 유효 → B3RYS_HOME/members 구조에선 깨짐. 절대경로로 포터블화.)
const REL_TARGET = LIVE;

// 템플릿 → 런타임용 rules/TEAM-OS.md 렌더. owner_name 있으면 {{OWNER}} 치환, 없으면 템플릿 그대로.
// 템플릿이 없으면(아직 미분리) 현재 LIVE 를 템플릿으로 간주(부팅 안전).
export function renderTeamOs(ownerName: string | null | undefined): { ok: boolean; owner: string; error?: string } {
  const owner = (ownerName ?? "").trim();
  try {
    const srcPath = existsSync(TEMPLATE) ? TEMPLATE : LIVE;
    let text = readFileSync(srcPath, "utf-8");
    if (owner) text = text.split("{{OWNER}}").join(owner);
    // skip-if-unchanged: 렌더 결과가 기존 LIVE 와 동일하면 재작성 생략 (OWNER 2026-07-19 — 룰 변화 없으면 매 부팅 렌더하지 마라).
    if (existsSync(LIVE) && readFileSync(LIVE, "utf-8") === text) return { ok: true, owner };
    writeFileSync(LIVE, text, "utf-8");
    return { ok: true, owner };
  } catch (e) {
    return { ok: false, owner, error: e instanceof Error ? e.message : String(e) };
  }
}

// claude_channel 에이전트 workspace 의 TEAM-OS.md 심링크가 표준 타깃(rules/TEAM-OS.md)을 가리키게 보장(가역·idempotent).
// 실파일이거나 없으면 건드리지 않음. 이미 표준 타깃이면 skip.
export function repointAgentTeamOs(agentIds: string[]): string[] {
  const repointed: string[] = [];
  for (const id of agentIds) {
    const link = `${MEMBERS_ROOT}/${id}/TEAM-OS.md`;
    let st;
    try { st = lstatSync(link); } catch { continue; }
    if (!st.isSymbolicLink()) continue;
    try { if (readlinkSync(link) === REL_TARGET) continue; } catch { /* ignore */ }
    try {
      unlinkSync(link);
      symlinkSync(REL_TARGET, link);
      repointed.push(id);
    } catch { /* skip */ }
  }
  return repointed;
}

export function renderAndRepoint(ownerName: string | null | undefined, agentIds: string[]): {
  ok: boolean; owner: string; repointed: string[]; error?: string;
} {
  const r = renderTeamOs(ownerName);
  if (!r.ok) return { ok: false, owner: r.owner, repointed: [], error: r.error };
  const repointed = repointAgentTeamOs(agentIds);
  return { ok: true, owner: r.owner, repointed };
}

export const LIVE_TEAM_OS_PATH = LIVE;
export const TEAM_OS_TEMPLATE_PATH = TEMPLATE;
