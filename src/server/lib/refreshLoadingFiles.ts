// 부팅 백필은 PUBLIC_BUILD 게이트 안에 있어 라이브 로딩파일 갱신을 보장하지 않는다. 이미 있는 로딩파일만 되맞추고 사용자 소유 SOUL.md는 건드리지 않는다.
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
    // 없으면 만들지 않는다 — 이 함수는 '되맞추기' 이지 '설치' 가 아니다.
    if (!existsSync(loadingFile)) {
      out.absent.push(m.id);
      continue;
    }
    try {
      const r = write(m);
      // skip-if-unchanged 라 내용이 같으면 written 이 비어 있다 — 그때는 갱신했다고 말하지 않는다.
      if (r.written.length > 0) out.updated.push(m.id);
    } catch (e) {
      // 실패를 삼키지 않는다 — 조용한 실패는 성공과 구별되지 않는다. 사유를 결과에 담아 부르는 쪽이 로그로 남긴다.
      out.skipped.push({ id: m.id, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
