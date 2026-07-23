// ★전 테스트 audit 파일 로그 격리 (팀 하드레슨: bun test가 라이브 logs/ 안 건드림)★
// 모든 테스트 파일 로드 전(preload) B3OS_AUDIT_LOG_DIR을 temp로 세팅 → appendAuditFile(call-time
// resolveLogDir)이 실 logs/audit-<date>.log 대신 임시 디렉토리에 쓴다. auditFile.ts의 env override 활용.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.B3OS_AUDIT_LOG_DIR) {
  process.env.B3OS_AUDIT_LOG_DIR = mkdtempSync(join(tmpdir(), "b3os-test-audit-"));
}

// 테스트는 ★라이브 모드★(B3OS_LIVE=1 → PUBLIC_BUILD=false)로 돈다 = 전 기능(codex 영입·런타임 swap·
// 롤백 등 라이브 전용)을 검증한다. 공개 모드(PUBLIC_BUILD=true) 동작은 해당 테스트가 인자를 명시적으로
// 넘겨(allowedRuntimes(true) 등) 따로 검증한다. (public=source 런타임 토글 — docs/BUILD_MODES.md)
if (!process.env.B3OS_LIVE) process.env.B3OS_LIVE = "1";
