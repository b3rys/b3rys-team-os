// ★전 테스트 파일시스템 격리 (preload — 어떤 테스트 모듈보다 먼저 실행된다)★
// 팀 하드레슨: bun test 가 라이브 파일을 건드리면 안 된다.
//
// ★여기(preload)에서 env 를 세팅해야만 하는 이유★: 아래 MEMBERS_ROOT 는 ★import 시점 1회 해석되는 상수★라,
// 테스트 안에서 beforeAll 로 env 를 바꿔도 이미 늦다. preload 는 모든 import 보다 먼저 돌기 때문에
// 여기가 그 상수를 갈아끼울 수 있는 유일한 지점이다. (audit 쪽은 call-time 해석이라 원래도 가능했다.)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// appendAuditFile(call-time resolveLogDir)이 실 logs/audit-<date>.log 대신 임시 디렉토리에 쓴다.
if (!process.env.B3OS_AUDIT_LOG_DIR) {
  process.env.B3OS_AUDIT_LOG_DIR = mkdtempSync(join(tmpdir(), "b3os-test-audit-"));
}

// ★멤버 워크스페이스 격리 (2026-07-27, 맥스튜디오 실 팀원 훼손 인시던트)★
//   증상: 영입 API 를 태우는 테스트가 fixture id 로 `jane`·`lisa`·`clo`·`lui` 같은 ★실 팀원과 겹치는 id★ 를
//   쓰는데, MEMBERS_ROOT 가 ambient 로 해석돼 그 머신의 진짜 팀원 폴더에 CLAUDE.md/AGENTS.md 를 덮어썼다.
//   실측(2026-07-27 맥미니): 격리 없이 수트 1회 → `~/b3os/members/jane/CLAUDE.md` 가 테스트 페르소나로 교체됨.
//   맥스튜디오는 실 팀원이 정확히 그 기본 경로(`~/b3os/members/`)에 살아서 제인이 실제로 훼손됐다.
//   ★"테스트가 실 팀원 id 를 피하게" 고치는 건 답이 아니다★ — 다음 사람이 또 겹치는 id 를 쓴다.
//   루트 자체를 temp 로 옮겨 ★어떤 id 를 쓰든 실 팀원에 닿지 않게★ 한다.
//   (이미 명시된 값은 존중 — 특정 루트를 겨냥한 의도적 실행을 막지 않는다.)
if (!process.env.B3RYS_MEMBERS_ROOT && !process.env.B3RYS_HOME) {
  process.env.B3RYS_MEMBERS_ROOT = mkdtempSync(join(tmpdir(), "b3os-test-members-"));
}

// 테스트는 ★라이브 모드★(B3OS_LIVE=1 → PUBLIC_BUILD=false)로 돈다 = 전 기능(codex 영입·런타임 swap·
// 롤백 등 라이브 전용)을 검증한다. 공개 모드(PUBLIC_BUILD=true) 동작은 해당 테스트가 인자를 명시적으로
// 넘겨(allowedRuntimes(true) 등) 따로 검증한다. (public=source 런타임 토글 — docs/BUILD_MODES.md)
if (!process.env.B3OS_LIVE) process.env.B3OS_LIVE = "1";
