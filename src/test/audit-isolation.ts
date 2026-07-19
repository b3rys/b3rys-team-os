// ★전 테스트 audit 파일 로그 격리 (팀 하드레슨: bun test가 라이브 logs/ 안 건드림)★
// 모든 테스트 파일 로드 전(preload) B3OS_AUDIT_LOG_DIR을 temp로 세팅 → appendAuditFile(call-time
// resolveLogDir)이 실 logs/audit-<date>.log 대신 임시 디렉토리에 쓴다. auditFile.ts의 env override 활용.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.B3OS_AUDIT_LOG_DIR) {
  process.env.B3OS_AUDIT_LOG_DIR = mkdtempSync(join(tmpdir(), "b3os-test-audit-"));
}
