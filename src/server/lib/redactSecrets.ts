/** 새 세션에 넘기는 지난 대화·기억 글에서 토큰·키 모양을 가린다(넘긴 글이 새 세션 기록에 다시 적히지 않게). */
export function redactSecrets(s: string): string {
  return s
    .replace(/\bbot\d{6,}:[A-Za-z0-9_-]{20,}/g, "bot<redacted>")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}/g, "<redacted-token>")
    .replace(/\b(sk-(?:ant-)?[A-Za-z0-9_-]{16,})/g, "<redacted-key>")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "<redacted-gh>")
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "<redacted-slack>")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "<redacted-aws>")
    .replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, "<redacted-pem>")
    .replace(/((?:token|secret|password|api[_-]?key)\s*[=:]\s*)\S{8,}/gi, "$1<redacted>");
}

