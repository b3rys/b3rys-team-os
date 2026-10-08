import { describe, expect, test } from 'bun:test'
import { ATTACHMENT_UNSUPPORTED, assertNoFiles, isDmAllowed, mentionsBot, parseApiBase, permissionTargets } from './b3chat.ts'

describe('isDmAllowed — b3chat DM 허용은 chat.id 로 정한다', () => {
  test('private 방 id 가 allowFrom 에 있으면 허용', () => {
    expect(isDmAllowed(['10'], 'private', '10')).toBe(true)
  })
  test('보낸 사람 id 만 allowFrom 에 있고 방 id 는 없으면 거절 (텔레그램식 sender 판단이 아님)', () => {
    // b3chat: 사람 id 1 이 방 20 에서 보냄. allowFrom 에 1 이 있어도 방 20 은 허용 아님.
    expect(isDmAllowed(['1'], 'private', '20')).toBe(false)
  })
  test('그룹은 방 id 가 allowFrom 에 있어도 DM 경로로 허용하지 않는다', () => {
    expect(isDmAllowed(['10'], 'group', '10')).toBe(false)
    expect(isDmAllowed(['10'], 'supergroup', '10')).toBe(false)
    expect(isDmAllowed(['10'], undefined, '10')).toBe(false)
  })
  test('빈 allowFrom 은 전부 거절', () => {
    expect(isDmAllowed([], 'private', '10')).toBe(false)
  })
})

describe('plain-text group mentions without Telegram entities', () => {
  test('matches an exact username with punctuation and case folding', () => {
    for (const text of ['@cleobot hello', 'hello @CLEOBOT!', '(@cleobot)']) expect(mentionsBot(text, 'cleobot')).toBe(true)
  })
  test('rejects another bot, longer username and email-like text', () => {
    for (const text of ['@other hello', '@cleobot_other', '@cleobot2', 'mail@cleobot', 'cleobot']) expect(mentionsBot(text, 'cleobot')).toBe(false)
    expect(mentionsBot('@', '')).toBe(false)
    expect(mentionsBot('@aXb', 'a.b')).toBe(false)
    expect(mentionsBot('@a.b', 'a.b')).toBe(true)
  })
})

describe('parseApiBase — 토큰이 실려 나가는 주소 검사', () => {
  test.each([
    ['http://127.0.0.1:8741', 'http://127.0.0.1:8741'],
    ['http://127.0.0.1:8741/', 'http://127.0.0.1:8741'],
    ['http://localhost:8741', 'http://localhost:8741'],
    ['https://chat.example.com', 'https://chat.example.com'],
    ['https://chat.example.com/b3chat/', 'https://chat.example.com/b3chat'],
  ])('허용 %s', (raw, want) => {
    expect(parseApiBase(raw)).toBe(want)
  })
  test.each([
    [undefined],
    [''],
    ['not a url'],
    ['http://example.com'],
    ['http://192.168.0.10:8741'],
    ['http://127.0.0.1.evil.com'],
    ['http://localhost.evil.com'],
    ['ftp://127.0.0.1'],
    ['file:///tmp/x'],
    ['https://user:pw@chat.example.com'],
    ['https://chat.example.com/?x=1'],
  ])('거절 %s', raw => {
    expect(() => parseApiBase(raw as string | undefined)).toThrow()
  })
})

describe('첨부·권한 요청', () => {
  test('files 가 있으면 보내기 전에 오류', () => {
    expect(() => assertNoFiles(['/tmp/a.png'])).toThrow(ATTACHMENT_UNSUPPORTED)
    expect(() => assertNoFiles([])).not.toThrow()
  })
  test('권한 요청은 ownerChat 한 곳에만', () => {
    expect(permissionTargets({ ownerChat: '10' })).toEqual(['10'])
    expect(permissionTargets({})).toEqual([])
  })
})
