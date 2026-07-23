// persona 쓰기 단일 canonical 경로 (GD 아키텍처 지시, Bill 핸드오프 2026-07-05).
//
// 문제: persona 쓰기 통로가 여러 개(recruit buildPersona / save buildPersonaFromCustom / swap activate)라
//   제각각 → Lui 스왑에서 옛 한글 persona 유지 + 사용자 custom 덮어쓰기 반복.
// 해결: recruit·swap·save·핵심룰재적용 전부 이 함수 하나만 통과한다.
//   - custom block(agents.json `purpose`) = verbatim 보존(i18n·strip·inject 안 함).
//   - 룰/템플릿 섹션만 현재(영문) 최신으로 재생성.
//   - !existsSync 게이트 없음 → 항상 멱등 재생성(옛 persona 잔존 = Lui 버그 직접 원인 제거).
//   - backup-first: 덮기 전 기존 파일 `.bak` (GD 데이터 무조건 백업 원칙).
//   - 런타임→파일 매핑은 personaTargetsForRuntime 단일 소스(Codex runtimeEssentials 와 공유).

import { existsSync, readFileSync, copyFileSync, mkdirSync, writeFileSync, symlinkSync, lstatSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { LIVE_TEAM_OS_PATH } from "./teamOsRender";
import {
  buildPersona,
  buildAgentsMd,
  personaTargetsForRuntime,
  memberPaths,
  assertNotLiveMemberFsUnderTest,
  applyCollectMode,
} from "./personaTemplates";
import { isTier2Outbound } from "../runtimes/claude/tier2Flag";

export interface WriteMemberPersonaInput {
  id: string;
  display_name: string;
  role: string;
  runtime: string;
  signature?: string;
  bot_username?: string;
  /** 워크스페이스 경로(레지스트리값). 없으면 memberPaths 로 도출. */
  workspace_path?: string;
  /** 레지스트리 persona_file(있으면 identity/loading 경로 fallback). */
  persona_file?: string;
  owner_name?: string;
  team_name?: string;
  /**
   * 서버의 team-collect 오케스트레이션이 켜져 있는가 (setting `team_collect_enabled`).
   * 이 값이 렌더되는 ★수집 규칙 자체★를 고른다 — OFF 면 "서버가 번들로 깨워준다"가 아니라
   * "네가 직접 모아서 1회 보고한다"로 룰이 바뀐다. 생략 시 ON(기존 동작 보존).
   */
  team_collect_enabled?: boolean;
}

export interface WriteMemberPersonaResult {
  written: string[];
  backedUp: string[];
}

/**
 * ★워크스페이스에 TEAM-OS.md 심링크를 보장한다★ (GD 2026-07-13 — "team-os 심링크는 영입때도 체크")
 *
 * ═══ 왜 (루이가 잡았다) ═══
 *   실측: 팀원 11명 중 ★6명(steve·hermes·codex·ames·devon·dex)에게 TEAM-OS.md 가 아예 없었다.★
 *   원인: 심링크를 거는 코드가 ★런타임 스왑 경로(activation STEP4)에만★ 있었다 →
 *         ★스왑을 겪은 5명만★ 갖게 됐고, 그냥 영입된 사람은 정본을 못 읽었다.
 *   → ★팀 룰 정본을 절반이 못 보고 있었다.★ "룰이 시켰는데 안 한다" 가 아니라 ★볼 수 없게 해놓고 시켰다★ —
 *     오늘 하루 종일 나온 그 패턴이 여기서도 똑같았다.
 *
 * persona 를 쓰는 ★단 하나의 통로★ 가 이 함수이므로, 여기 걸면 ★영입·스왑·저장·재렌더 전부★ 커버된다.
 * (사람이 기억해야 하는 절차로 두지 않는다.)
 */
function ensureTeamOsLink(workspace: string): void {
  const link = join(workspace, "TEAM-OS.md");
  let st: ReturnType<typeof lstatSync> | null = null;
  try { st = lstatSync(link); } catch { st = null; }
  if (st) {
    // ★일반 파일이면 건드리지 않는다★ — 사람이 쓴 것일 수 있다 (백업 먼저 원칙).
    if (!st.isSymbolicLink()) return;
    if (existsSync(link)) return;                 // 살아있는 심링크 → 그대로
    try { unlinkSync(link); } catch { return; }   // ★깨진 심링크만★ 교체
  }
  try {
    mkdirSync(workspace, { recursive: true });
    symlinkSync(LIVE_TEAM_OS_PATH, link);
  } catch { /* best-effort — 심링크 실패가 영입 자체를 막지는 않는다 */ }
}

/**
 * 멤버 persona 파일을 canonical 규칙으로 (재)생성한다. 단일 writer — 다른 어떤 곳에서도 persona 파일을
 * 직접 쓰지 않는다. custom block 은 절대 변형하지 않고, 룰/템플릿 섹션만 최신으로 덮는다.
 */
/**
 * ★persona 값을 저장하는 유일한 지점 — SOUL.md 에만 쓴다.★ (GD 2026-07-17)
 *
 *   "persona 값은 그냥 soul.md 에만 저장해. 대시보드 나머지 필드는 agents.json이 원본이면 되고" — GD
 *
 * agents.json 의 purpose 필드는 제거됐다. 두 곳에 두면 반드시 어긋나고(2026-07-17: 12명 중 7명),
 * 어긋나면 렌더가 옛값으로 사용자 글을 덮는다. ★소스를 하나로 두면 그 문제가 아예 생기지 않는다.★
 *
 * 렌더러(writeMemberPersona)는 이 파일을 건드리지 않는다. 저장은 persona 를 가진 쪽(대시보드 저장·영입)만 한다.
 * backup-first: 덮기 전 1세대 .bak.
 */
export function savePersonaFile(personaFile: string, content: string): void {
  if (existsSync(personaFile)) copyFileSync(personaFile, `${personaFile}.bak`);
  else mkdirSync(dirname(personaFile), { recursive: true });
  writeFileSync(personaFile, content.endsWith("\n") ? content : `${content}\n`, "utf-8");
}

/**
 * ★로딩파일(CLAUDE.md/AGENTS.md)을 렌더한다 — 쓰지는 않는다.★
 *
 * writeMemberPersona(쓰기)와 verify-rules-live(검증)가 ★같은 함수★ 를 쓰게 하려고 뽑았다.
 * 검증기가 렌더 입력을 손으로 재현하면 반드시 어긋난다(2026-07-17 실측: workspace 폴백·team_name·
 * tier2 플래그를 빠뜨려 ★12명 전원 오탐★). ★검증기가 writer 와 다르면 검증기를 못 믿는다.★
 */
export function renderLoadingFile(m: WriteMemberPersonaInput): { path: string; content: string } {
  const workspace = m.workspace_path ?? memberPaths(m.id, m.runtime).workspace_path;
  const targets = personaTargetsForRuntime(m.runtime, workspace, m.persona_file);
  const input = {
    id: m.id,
    display_name: m.display_name,
    role: m.role,
    runtime: m.runtime,
    signature: m.signature,
    bot_username: m.bot_username,
    owner_name: m.owner_name,
    team_name: m.team_name,
    tier2_outbound: isTier2Outbound(m.id),
  } as Parameters<typeof buildPersona>[0];
  const rendered = m.runtime === "claude_channel" ? buildPersona(input) : buildAgentsMd(input);
  return { path: targets.loadingFile, content: applyCollectMode(rendered, m.runtime) };
}

export function writeMemberPersona(m: WriteMemberPersonaInput): WriteMemberPersonaResult {
  const workspace = m.workspace_path ?? memberPaths(m.id, m.runtime).workspace_path;
  assertNotLiveMemberFsUnderTest(workspace, `writeMemberPersona(${m.id})`); // FIX2(GD 2026-07-08): 테스트가 라이브 persona 덮어쓰기 못 하게 차단
  const targets = personaTargetsForRuntime(m.runtime, workspace, m.persona_file);

  const written: string[] = [];
  const backedUp: string[] = [];

  const put = (file: string, content: string): void => {
    // skip-if-unchanged: 렌더 결과가 기존 파일과 동일하면 write·bak 생략 (GD 2026-07-19 — 룰 변화 없으면 매 부팅 재작성하지 마라).
    // ★내용 비교★라 안전 — 같을 때만 스킵하므로 옛 persona 잔존(Lui 버그: existsSync 게이트로 인한 것)은 재발하지 않는다.
    if (existsSync(file)) {
      if (readFileSync(file, "utf-8") === content) return; // 동일 → 재작성·백업 생략
      // backup-first: 덮기 전 기존 파일 1세대 백업.
      copyFileSync(file, `${file}.bak`);
      backedUp.push(file);
    } else {
      mkdirSync(dirname(file), { recursive: true });
    }
    writeFileSync(file, content, "utf-8");
    written.push(file);
  };

  // ★렌더는 renderLoadingFile 한 곳에서만★ — 검증기(verify-rules-live)도 같은 함수를 쓴다.
  put(targets.loadingFile, renderLoadingFile(m).content);

  // ★SOUL.md 는 여기서 아예 안 건드린다 — 이 함수는 '룰 렌더러' 다.★ (GD 2026-07-17)
  //
  // ═══ 왜 ═══
  //   persona 값이 사는 곳은 ★SOUL.md 단 하나★ 다(purpose 필드는 제거됨). 저장은 persona 를 가진 쪽
  //   (대시보드 저장·영입)이 savePersonaFile() 로 ★직접★ 한다. 렌더러가 낄 자리가 아니다.
  //   ★"어디에 붙이냐" 와 "어디에 저장하냐" 는 분리된 트랜잭션이다★ (GD).
  //
  // ═══ 이 줄이 있었을 때 무슨 일이 났나 (2026-07-17 실측) ═══
  //   옛 코드는 렌더마다 SOUL 을 purpose 로 덮었다. 12명 중 7명이 어긋났고:
  //     · GD 가 손질한 5명(steve·hermes·ames·codex·demis) → ★렌더 한 번에 손질이 되돌아갈 위치★
  //     · lui·forin → purpose 가 비어 찍힌 24자 껍데기가 굳어 페르소나가 실제로 없었다
  //   ★렌더는 플래그 토글로도 돈다(line 124).★ 스위치 하나에 사용자가 쓴 글이 사라지면 안 된다.
  //
  //   로딩파일(CLAUDE.md/AGENTS.md)만 렌더한다 — 그건 룰이라 코드 소유다.
  //   로딩파일은 SOUL 을 ★참조만★ 한다(claude=@SOUL.md inline / openclaw·hermes=경로 참조).
  //   SOUL 이 없어도 안전하다: @SOUL.md 는 대상이 없으면 조용히 증발하고 본문은 정상 로드된다.

  ensureTeamOsLink(workspace);   // ★영입 때부터 팀 룰 정본을 읽을 수 있게★ (GD 2026-07-13)

  return { written, backedUp };
}
