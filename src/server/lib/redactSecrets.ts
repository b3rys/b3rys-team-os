// 비밀값을 담는 이름: token·secret·password·passwd·api_key·access_key·private_key·credential 을 포함하는 key(따옴표 있어도 됨)
const SECRET_KEY = `["']?\\b[a-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential)[a-z0-9_-]*["']?`;

/** 새 세션에 넘기는 지난 대화·기억 글에서 토큰·키 모양을 가린다(넘긴 글이 새 세션 기록에 다시 적히지 않게). */
export function redactSecrets(s: string): string {
  return s
    // Standard HTTP credentials can occur inside an otherwise ordinary file body.
    .replace(/(\b(?:proxy-)?authorization["']?[ \t]*:[ \t]*["']?(?:bearer|basic)[ \t]+)[A-Za-z0-9._~+\/-]+=*/gi, "$1<redacted>")
    .replace(/\bbot\d{6,}:[A-Za-z0-9_-]{20,}/g, "bot<redacted>")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}/g, "<redacted-token>")
    .replace(/\b(sk-(?:ant-)?[A-Za-z0-9_-]{16,})/g, "<redacted-key>")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "<redacted-gh>")
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "<redacted-slack>")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "<redacted-aws>")
    .replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, "<redacted-pem>")
    // 비밀 이름 뒤의 값: 따옴표 값은 닫는 따옴표까지 통째로(\" 같은 이스케이프 포함, 공백·쉼표가 있어도).
    //   닫는 따옴표가 없으면 그 줄 끝(또는 글 끝)까지. 따옴표 없는 값은 공백·쉼표·괄호 앞까지('<' 로 시작해도).
    //   이미 가린 표시(<redacted…>)만 그대로 둔다. 길이와 상관없이 가린다.
    .replace(new RegExp(`(${SECRET_KEY}\\s*[=:]\\s*)"(?:[^"\\\\\\n]|\\\\.)*"?`, "gi"), '$1"<redacted>"')
    .replace(new RegExp(`(${SECRET_KEY}\\s*[=:]\\s*)'(?:[^'\\\\\\n]|\\\\.)*'?`, "gi"), "$1'<redacted>'")
    .replace(new RegExp(`(${SECRET_KEY}\\s*[=:]\\s*)(?!["']|<redacted[a-z-]*>(?=[\\s,;}\\])]|$))[^"'\\s,;}\\])]+`, "gi"), "$1<redacted>");
}


export function redactApprovalText(text: string): string {
  return redactSecrets(text)
    .replace(/(--[\w-]*(?:token|secret|password|passwd|api-key|access-key|private-key|authorization|bearer|credential)[\w-]*\s+)(?:"(?:[^"\\]|\\.)*(?:"|$)|'[^']*(?:'|$)|[^\s]+)/gi, "$1<redacted>")
    .replace(/((?:--user|-u)\s+)(?:"[^"\n]*(?:"|$)|'[^'\n]*(?:'|$)|[^\s]+)/g, "$1<redacted>")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1<redacted>@");
}

/** Walk JSON values before encoding so escaped command quotes cannot hide secret flags. */
export function redactStoredValue(value: unknown): any {
  if (typeof value === "string") {
    if (/^\s*[\[{]/.test(value)) { try { return JSON.stringify(redactStoredValue(JSON.parse(value))); } catch { /* ordinary text */ } }
    return redactApprovalText(value);
  }
  if (Array.isArray(value)) return value.map(redactStoredValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
    [key, /token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential/i.test(key) ? "<redacted>" : redactStoredValue(entry)]));
  return value;
}
