/**
 * b3chat 전용 판단 함수 — server.ts 가 쓰고, 테스트가 grammy 없이 바로 부른다.
 * 텔레그램과 b3chat 이 다른 곳만 여기 둔다(server.ts 원본 diff 를 작게 유지).
 */

export const ATTACHMENT_UNSUPPORTED = 'b3chat 에서는 아직 첨부 파일을 지원하지 않습니다'

// B3CHAT_API_BASE 는 봇 토큰이 실려 나가는 주소다. https 이거나, 평문 http 는
// 이 기계 안(127.0.0.1 / localhost)만 허용한다. 그 밖은 토큰 유출이라 거절한다.
export function parseApiBase(raw: string | undefined): string {
  if (!raw) throw new Error('B3CHAT_API_BASE required')
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error(`B3CHAT_API_BASE is not a URL: ${raw}`)
  }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local))) {
    throw new Error(`B3CHAT_API_BASE must be https:// or http://127.0.0.1 / http://localhost: ${raw}`)
  }
  if (u.username || u.password || u.search || u.hash) {
    throw new Error(`B3CHAT_API_BASE must not carry credentials, query or fragment: ${raw}`)
  }
  return u.toString().replace(/\/+$/, '')
}

// b3chat 의 private 방 chat.id 는 방 id 이고 보낸 사람 id 와 다르다(텔레그램은 같다).
// 그래서 DM 허용은 chat.id 로 정한다. 그룹은 여기서 허용하지 않는다(access.groups 경로가 따로 본다).
export function isDmAllowed(allowFrom: string[], chatType: string | undefined, chatId: string): boolean {
  return chatType === 'private' && allowFrom.includes(chatId)
}

// b3chat updates carry plain text without Telegram mention entities.
export function mentionsBot(text: string, username: string): boolean {
  if (!username) return false
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9_])@${escaped}(?=$|[^A-Za-z0-9_])`, 'i').test(text)
}

// 권한 요청은 ownerChat 한 방에만 보낸다. 없으면 아무 데도 보내지 않는다.
export function permissionTargets(access: { ownerChat?: string }): string[] {
  return access.ownerChat ? [access.ownerChat] : []
}

// b3chat 에는 getFile·sendPhoto·sendDocument 가 아직 없다 — 보내기 전에 막는다.
export function assertNoFiles(files: string[]): void {
  if (files.length > 0) throw new Error(ATTACHMENT_UNSUPPORTED)
}
