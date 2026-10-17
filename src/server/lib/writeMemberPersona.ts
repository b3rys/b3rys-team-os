// persona 쓰기 단일 canonical 경로.
//
// 문제: persona 쓰기 통로가 여러 개(recruit buildPersona / save buildPersonaFromCustom / swap activate)라
//   제각각 → Lui 스왑에서 옛 한글 persona 유지 + 사용자 custom 덮어쓰기 반복.
// 해결: recruit·swap·save·핵심룰재적용 전부 이 함수 하나만 통과한다.
//   - custom block(agents.json `purpose`) = verbatim 보존(i18n·strip·inject 안 함).
//   - 룰/템플릿 섹션만 현재(영문) 최신으로 재생성.
//   - !existsSync 게이트 없음 → 항상 멱등 재생성(옛 persona 잔존 = Lui 버그 직접 원인 제거).
// - backup-first: 덮기 전 기존 파일 `.bak`.
//   - 런타임→파일 매핑은 personaTargetsForRuntime 단일 소스(Codex runtimeEssentials 와 공유).

import { existsSync, readFileSync, copyFileSync, mkdirSync, writeFileSync, symlinkSync, lstatSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { LIVE_TEAM_OS_PATH } from "./teamOsRender";
import { ensureSkillsCopy } from "./skillsRender";
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
   * 이 값이 렌더되는 수집 규칙 자체를 고른다 — OFF 면 "서버가 번들로 깨워준다"가 아니라
   * "네가 직접 모아서 1회 보고한다"로 룰이 바뀐다. 생략 시 ON(기존 동작 보존).
   */
  team_collect_enabled?: boolean;
}

export interface WriteMemberPersonaResult {
  written: string[];
  backedUp: string[];
}

// 영입·스왑·저장·재렌더의 공통 경로에서 TEAM-OS 심링크를 보장해야 모든 팀원이 정본에 접근할 수 있다.
function ensureTeamOsLink(workspace: string): void { ensureRulesLink(workspace, "TEAM-OS.md", LIVE_TEAM_OS_PATH); }
function ensureRulesLink(workspace: string, name: string, target: string): void {
  const link = join(workspace, name);
  let st: ReturnType<typeof lstatSync> | null = null;
  try { st = lstatSync(link); } catch { st = null; }
  if (st) {
    // 일반 파일이면 건드리지 않는다 — 사람이 쓴 것일 수 있다 (백업 먼저 원칙).
    if (!st.isSymbolicLink()) return;
    if (existsSync(link)) return;                 // 살아있는 심링크 → 그대로
    try { unlinkSync(link); } catch { return; }   // 깨진 심링크만 교체
  }
  try {
    mkdirSync(workspace, { recursive: true });
    symlinkSync(target, link);
  } catch { /* best-effort — 심링크 실패가 영입 자체를 막지는 않는다 */ }
}

/**
 * 멤버 persona 파일을 canonical 규칙으로 (재)생성한다. 단일 writer — 다른 어떤 곳에서도 persona 파일을
 * 직접 쓰지 않는다. custom block 은 절대 변형하지 않고, 룰/템플릿 섹션만 최신으로 덮는다.
 */
// 사용자가 수정한 페르소나를 렌더가 덮지 않도록 SOUL.md 한 곳에만 저장한다. 쓰기 전 한 세대 백업을 남긴다.
export function savePersonaFile(personaFile: string, content: string): void {
  // 로딩파일뿐 아니라 SOUL 쓰기도 라이브 파일을 바꿀 수 있어 같은 테스트 경로 가드를 적용한다.
  assertNotLiveMemberFsUnderTest(personaFile, "savePersonaFile");
  if (existsSync(personaFile)) copyFileSync(personaFile, `${personaFile}.bak`);
  else mkdirSync(dirname(personaFile), { recursive: true });
  writeFileSync(personaFile, content.endsWith("\n") ? content : `${content}\n`, "utf-8");
}

// writer와 검증기가 같은 렌더 함수를 써야 폴백·플래그·팀 설정을 서로 다르게 재현하지 않는다.
/**
 * SOUL.md 본문을 읽는다 — 없거나 못 읽으면 undefined 다.
 * 지어내지 않는다: 페르소나가 없는데 있는 척하면 다음 사람이 왜 안 먹는지 못 찾는다.
 */
function readSoulText(soulFile: string): string | undefined {
  try {
    const t = readFileSync(soulFile, "utf-8").trim();
    return t.length ? t : undefined;
  } catch {
    return undefined;
  }
}

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
    // codex 는 SOUL.md 를 안 읽는다 — 그 런타임만 본문을 실어 보낸다(위 personaPointer 주석의 실측).
    //   읽어오지 못하면 안 넣는다: 없는 페르소나를 지어내지 않는다.
    soul_text: m.runtime === "codex" ? readSoulText(targets.personaFile) : undefined,
  } as Parameters<typeof buildPersona>[0];
  const rendered = m.runtime === "claude_channel" ? buildPersona(input) : buildAgentsMd(input);
  return { path: targets.loadingFile, content: applyCollectMode(rendered, m.runtime) };
}

export function writeMemberPersona(m: WriteMemberPersonaInput): WriteMemberPersonaResult {
  const workspace = m.workspace_path ?? memberPaths(m.id, m.runtime).workspace_path;
  assertNotLiveMemberFsUnderTest(workspace, `writeMemberPersona(${m.id})`); // 테스트가 라이브 페르소나를 덮어쓰지 못하도록 차단한다.
  const targets = personaTargetsForRuntime(m.runtime, workspace, m.persona_file);

  const written: string[] = [];
  const backedUp: string[] = [];

  const put = (file: string, content: string): void => {
    // skip-if-unchanged: 렌더 결과가 기존 파일과 동일하면 write·bak 생략.
    // 내용 비교라 안전 — 같을 때만 스킵하므로 옛 persona 잔존(Lui 버그: existsSync 게이트로 인한 것)은 재발하지 않는다.
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

  // 렌더는 renderLoadingFile 한 곳에서만 — 검증기(verify-rules-live)도 같은 함수를 쓴다.
  put(targets.loadingFile, renderLoadingFile(m).content);

  // 이 함수는 코드 소유 로딩파일만 렌더한다. 사용자 소유 SOUL.md는 savePersonaFile에서만 저장해야 플래그 변경이 페르소나를 덮지 않는다.

  ensureTeamOsLink(workspace);   // 영입 시에도 정본 규칙에 접근할 수 있어야 한다.
  ensureSkillsCopy(workspace);   // 스킬 목록은 심링크가 아니라 복사본 — 폴더 밖 @import 는 claude 가 안 읽는다

  return { written, backedUp };
}
