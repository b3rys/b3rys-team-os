/**
 * 이미 있는 팀원 로딩파일(CLAUDE.md / AGENTS.md)을 저장소 기준으로 되맞춘다.
 *
 * ═══ 왜 필요한가 ═══
 * 부팅 시 로딩파일을 다시 만드는 백필이 `index.ts` 에 있는데 그 블록 전체가 `PUBLIC_BUILD` 게이트
 * 뒤에 있다. 라이브는 `PUBLIC_BUILD=false` 라 **통째로 건너뛴다.** 그래서 룰을 고치고 배포·재시작해도
 * **기존 팀원의 로딩파일은 그대로 남는다.**
 *
 * 실측(2026-08-18): 핵심룰에 판별 축을 추가하는 변경을 배포한 뒤, 렌더 결과에는 그 문장이 있는데
 * 한 팀원의 `AGENTS.md` 는 08-12 파일 그대로였다(그 문장 0건). 렌더가 실패한 것이 아니라 **쓰지
 * 않은 것**이다. 정본 룰 파일은 심링크로 닿아서 그동안 이 간극이 드러나지 않았다.
 *
 * ★같은 원인으로 이미 한 번 사고가 났다.★ `index.ts` 의 progress 훅 주석에 그대로 적혀 있다 —
 * "위 백필은 PUBLIC_BUILD 뒤에 있어 라이브에서는 안 돈다. 그래서 이미 깔린 배선이 낡아도 아무도
 * 안 고쳤고, 훅 커맨드가 옛것으로 남아 owner-skip 이 fail-open 으로 돌았다." 그때는 훅만 게이트
 * 밖으로 뺐고 **로딩파일은 아직 안쪽에 있었다.**
 *
 * ═══ 왜 이 방식이 안전한가 ═══
 * 게이트가 지키려던 것은 "실멤버 보호" 다. 그래서 훅 수리와 같은 형태를 쓴다 —
 * ★파일이 이미 있는 팀원만★ 되맞추고 **새로 만들지 않는다.** 없는 팀원은 영입 절차가 만든다.
 *
 * 그리고 이 렌더러는 **`SOUL.md`(persona)를 아예 건드리지 않는다**(`writeMemberPersona` 주석 참조 —
 * 2026-07-17 에 렌더가 persona 를 덮어 12명 중 7명이 어긋난 뒤 분리됐다). 로딩파일은 룰이라 코드
 * 소유이고, persona 는 사람 소유다. `writeMemberPersona` 자체가 skip-if-unchanged 라 내용이 같으면
 * 쓰지도 백업하지도 않는다.
 */
import { existsSync } from "node:fs";
import { personaTargetsForRuntime } from "./personaTemplates";
import { writeMemberPersona, type WriteMemberPersonaInput } from "./writeMemberPersona";

export interface RefreshLoadingFilesResult {
  /** 실제로 다시 쓴 팀원. */
  updated: string[];
  /** 로딩파일이 없어서 건드리지 않은 팀원(새로 만들지 않는다). */
  absent: string[];
  /** 렌더 대상이 아니거나 실패한 팀원 — 사유와 함께 남긴다. */
  skipped: { id: string; reason: string }[];
}

/**
 * @param members 재렌더 후보. `runtime` 이 로딩파일 정책을 정한다.
 * @param write 주입용(시험). 기본값은 실제 렌더러.
 */
export function refreshLoadingFiles(
  members: WriteMemberPersonaInput[],
  write: (m: WriteMemberPersonaInput) => { written: string[] } = writeMemberPersona,
): RefreshLoadingFilesResult {
  const out: RefreshLoadingFilesResult = { updated: [], absent: [], skipped: [] };
  for (const m of members) {
    let loadingFile: string;
    try {
      // b3os_native 는 정책 미확정이라 여기서 예외가 난다 — 사유를 남기고 넘어간다.
      loadingFile = personaTargetsForRuntime(m.runtime, m.workspace_path ?? "", m.persona_file).loadingFile;
    } catch (e) {
      out.skipped.push({ id: m.id, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    // ★없으면 만들지 않는다★ — 이 함수는 '되맞추기' 이지 '설치' 가 아니다.
    if (!existsSync(loadingFile)) {
      out.absent.push(m.id);
      continue;
    }
    try {
      const r = write(m);
      // skip-if-unchanged 라 내용이 같으면 written 이 비어 있다 — 그때는 갱신했다고 말하지 않는다.
      if (r.written.length > 0) out.updated.push(m.id);
    } catch (e) {
      // ★실패를 삼키지 않는다★ — 조용한 실패는 성공과 구별되지 않는다. 사유를 결과에 담아 부르는 쪽이 로그로 남긴다.
      out.skipped.push({ id: m.id, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
