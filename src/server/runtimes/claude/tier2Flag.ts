// Tier2 아웃바운드 롤아웃 게이트 — ★live와 shadow 분리★(Bill 하네스 HIGH#2).
//   live   = persona 마커모드(‹‹‹b3os-send›››) + 훅 live 전송 (Phase1)
//   shadow = persona normal(reply 도구 유지) + 훅 dryRun 로그만 (Phase0, 라이브 무영향)
// 파일(공백/콤마 구분) ∪ env. mtime 캐시라 파일 한 줄로 멤버 on/off(재시작 불요).
// wakeDispatcher의 busWakeExtraFile/busDispatchAllowlist 패턴 미러.
import { existsSync, readFileSync, statSync } from "node:fs";
import { REPO_ROOT } from "../../lib/personaTemplates";

const OUTBOUND_PATH = `${REPO_ROOT}/var/tier2-outbound-agents.txt`; // Phase1 live
const SHADOW_PATH = `${REPO_ROOT}/var/tier2-shadow-agents.txt`; // Phase0 shadow
const cache = new Map<string, { mtime: number; set: Set<string> }>();

function fileSet(path: string): Set<string> {
  try {
    if (!existsSync(path)) return new Set();
    const mtime = statSync(path).mtimeMs;
    const c = cache.get(path);
    if (c && c.mtime === mtime) return c.set;
    const set = new Set(readFileSync(path, "utf-8").split(/[\s,]+/).filter(Boolean));
    cache.set(path, { mtime, set });
    return set;
  } catch {
    return new Set();
  }
}

function envSet(name: string): string[] {
  return (process.env[name] ?? "").split(/[\s,]+/).filter(Boolean);
}

/**
 * live 전환 멤버 — persona가 마커모드(SECTION_CLAUDE_COMMS_TIER2)로 재생성되고 훅이 실전송(Phase1).
 * var/tier2-outbound-agents.txt ∪ env TIER2_OUTBOUND_AGENTS. 미포함=기존 reply 도구.
 */
export function isTier2Outbound(id: string): boolean {
  if (envSet("TIER2_OUTBOUND_AGENTS").includes(id)) return true;
  return fileSet(OUTBOUND_PATH).has(id);
}

/**
 * ★Phase0 shadow 멤버★ — persona는 normal(reply 도구 그대로) 유지하고 tg-outbound 훅만 dryRun으로 설치해
 * '무엇을 보낼지' 로그만 찍음(실전송 X = 라이브 무영향). live와 별개 파일이라 겹치지 않는다.
 * var/tier2-shadow-agents.txt ∪ env TIER2_SHADOW_AGENTS.
 */
export function isTier2Shadow(id: string): boolean {
  if (envSet("TIER2_SHADOW_AGENTS").includes(id)) return true;
  return fileSet(SHADOW_PATH).has(id);
}
