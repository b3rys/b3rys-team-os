// 테스트 전용 지원 유틸(프로덕션 경로에서 import 하지 않는다).
//
// ★왜 필요한가★ — `rules/TEAM-OS.md` 는 ★런타임 렌더본★ 이라 .gitignore 대상이다
//   (정본 소스 = `rules/TEAM-OS.template.md`, 렌더는 서버 부팅/설정 저장 시 1회).
//   그래서 라이브 폴더에는 있고 ★깨끗한 clone 에는 없다★ → 이 파일을 읽거나 여기로
//   심링크를 거는 테스트가 clone 에서만 100% 깨졌다(환경 의존 = 한쪽만 green).
//   테스트는 "부팅을 한 번 거친 상태"를 전제하므로, 없을 때만 그 부팅 단계를 재현한다.
import { existsSync } from "node:fs";
import { renderTeamOs } from "./teamOsRender";
import { REPO_ROOT } from "./personaTemplates";

/**
 * `rules/TEAM-OS.md`(런타임 렌더본)가 없으면 템플릿에서 렌더해 만든다.
 *
 * ★이미 있으면 손대지 않는다★ — 라이브 폴더에는 owner 이름까지 치환된 렌더본이 있는데
 * 여기서 다시 렌더하면 그 값을 덮어써 ★라이브에 부작용★ 을 낸다. 없을 때만 만든다.
 */
export function ensureRenderedTeamOs(): void {
  if (existsSync(`${REPO_ROOT}/rules/TEAM-OS.md`)) return;
  renderTeamOs(null); // owner 미치환 = 템플릿 그대로. 내용 단언은 owner 와 무관한 문구만 본다.
}
