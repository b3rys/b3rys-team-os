/**
 * 통합 테스트: 가짜 b3chat 봇 API(Bun.serve, 127.0.0.1 임의 포트)를 띄우고, server.ts 를
 * MCP stdio 서버로 실행해 JSON-RPC 로 몰아 본다. 실제 b3chat·텔레그램·Claude 세션은 쓰지 않는다.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Subprocess } from 'bun'
import { ATTACHMENT_UNSUPPORTED } from './b3chat.ts'

const HERE = import.meta.dir
const HAS_DEPS = existsSync(join(HERE, 'node_modules', 'grammy'))
if (!HAS_DEPS) console.warn(`[b3chat-channel] node_modules 없음 — 이 폴더에서 bun install 후 다시 실행 (통합 테스트 건너뜀)`)

const TOKEN = '111:fake-test-token'
const BOT = { id: 111, is_bot: true, first_name: 'claude', username: 'claudemember' }

type Call = { method: string; body: Record<string, any> }
const calls: Call[] = []
const updates: any[] = []
let nextUpdateId = 1
let nextMsgId = 900

function ok(result: unknown) {
  return Response.json({ ok: true, result })
}

let fake: ReturnType<typeof Bun.serve>
let proc: Subprocess<'pipe', 'pipe', 'pipe'>
let stateDir: string
const lines: any[] = []
let stderrBuf = ''
let rpcId = 0

function pushUpdate(message: Record<string, any>) {
  updates.push({ update_id: nextUpdateId++, message: { date: Math.floor(Date.now() / 1000), ...message } })
}

async function waitFor<T>(fn: () => T | undefined, what: string, ms = 8000): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v !== undefined && v !== false) return v as T
    await Bun.sleep(25)
  }
  throw new Error(`timeout waiting for ${what}\n--- stderr ---\n${stderrBuf}`)
}

function send(obj: Record<string, unknown>) {
  proc.stdin.write(JSON.stringify(obj) + '\n')
  proc.stdin.flush()
}

async function rpc(method: string, params: Record<string, unknown>) {
  const id = ++rpcId
  send({ jsonrpc: '2.0', id, method, params })
  return waitFor(() => lines.find(l => l.id === id), `rpc ${method}`)
}

const channelNotes = () => lines.filter(l => l.method === 'notifications/claude/channel')

describe.skipIf(!HAS_DEPS)('b3chat 채널 플러그인 — 가짜 b3chat 서버 통합', () => {
  beforeAll(async () => {
    fake = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname
        const prefix = `/bot${TOKEN}/`
        if (!path.startsWith(prefix)) return Response.json({ ok: false, error_code: 401, description: 'Unauthorized' }, { status: 401 })
        const method = path.slice(prefix.length)
        let body: Record<string, any> = {}
        const text = await req.text()
        if (text) {
          try { body = JSON.parse(text) } catch { body = Object.fromEntries(new URLSearchParams(text)) }
        }
        calls.push({ method, body })
        switch (method) {
          case 'getMe':
            return ok(BOT)
          case 'getUpdates': {
            const offset = Number(body.offset ?? 0)
            const end = Date.now() + Math.min(Number(body.timeout ?? 0), 1) * 1000
            for (;;) {
              while (updates.length && updates[0].update_id < offset) updates.shift()
              if (updates.length || Date.now() >= end) return ok(updates.splice(0, updates.length))
              await Bun.sleep(20)
            }
          }
          case 'sendMessage':
            return ok({ message_id: ++nextMsgId, date: 0, chat: { id: Number(body.chat_id), type: 'private' }, from: BOT, text: body.text })
          case 'editMessageText':
            return ok({ message_id: Number(body.message_id), date: 0, chat: { id: Number(body.chat_id), type: 'private' }, from: BOT, text: body.text })
          case 'setMessageReaction':
          case 'sendChatAction':
          case 'deleteWebhook':
          case 'setMyCommands':
            return ok(true)
          default:
            return Response.json({ ok: false, error_code: 404, description: 'Not Found: method not supported' }, { status: 404 })
        }
      },
    })

    stateDir = mkdtempSync(join(tmpdir(), 'b3chat-channel-test-'))
    writeFileSync(join(stateDir, '.env'), `B3CHAT_BOT_TOKEN=${TOKEN}\nB3CHAT_API_BASE=http://127.0.0.1:${fake.port}\n`, { mode: 0o600 })
    writeFileSync(join(stateDir, 'access.json'), JSON.stringify({
      dmPolicy: 'allowlist',
      allowFrom: ['10', '11'],
      ownerChat: '10',
      groups: { '40': { requireMention: true, allowFrom: ['1'] } },
    }))

    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith('B3CHAT_') && !k.startsWith('TELEGRAM_')) env[k] = v
    }
    env.B3CHAT_STATE_DIR = stateDir
    // apiRoot 가 빠지면 api.telegram.org 로 나간다 — 그 길은 막힌 프록시로 보내 밖으로 안 나가게 한다.
    env.HTTPS_PROXY = 'http://127.0.0.1:9'
    env.https_proxy = 'http://127.0.0.1:9'
    env.NO_PROXY = '127.0.0.1,localhost'
    env.no_proxy = '127.0.0.1,localhost'

    // 플러그인 .mcp.json 의 b3chat 항목 그대로 실행한다(${CLAUDE_PLUGIN_ROOT} = 이 폴더) — 플러그인 배선까지 같이 잰다.
    const entry = JSON.parse(readFileSync(join(HERE, '.mcp.json'), 'utf8')).mcpServers.b3chat
    const args = (entry.args as string[]).map(a => a.replaceAll('${CLAUDE_PLUGIN_ROOT}', HERE))
    proc = Bun.spawn([entry.command, ...args], { cwd: tmpdir(), env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    ;(async () => {
      const dec = new TextDecoder()
      let buf = ''
      for await (const chunk of proc.stdout) {
        buf += dec.decode(chunk)
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (line) try { lines.push(JSON.parse(line)) } catch { /* not JSON */ }
        }
      }
    })()
    ;(async () => {
      const dec = new TextDecoder()
      for await (const chunk of proc.stderr) stderrBuf += dec.decode(chunk)
    })()
  })

  afterAll(async () => {
    try { proc?.stdin.end() } catch {}
    const exited = await Promise.race([proc?.exited, Bun.sleep(4000).then(() => 'timeout')])
    if (exited === 'timeout') proc.kill('SIGKILL') // 이 테스트가 띄운 자기 핸들만
    fake?.stop(true)
    if (stateDir) rmSync(stateDir, { recursive: true, force: true })
  })

  test('initialize: 서버 이름 b3chat, 채널 capability 그대로', async () => {
    const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(r.result.serverInfo.name).toBe('b3chat')
    expect(r.result.capabilities.experimental).toEqual({ 'claude/channel': {}, 'claude/channel/permission': {} })
    expect(r.result.instructions).toContain('source="b3chat"')
    expect(r.result.instructions).not.toContain('/telegram:access')
    expect(r.result.instructions).toContain('yes <code>')
  }, 15000)

  test('tools/list: 네 도구', async () => {
    const r = await rpc('tools/list', {})
    expect(r.result.tools.map((t: any) => t.name).sort()).toEqual(['download_attachment', 'edit_message', 'react', 'reply'])
  })

  test('reply → 가짜 서버에 sendMessage(chat_id·reply_parameters)', async () => {
    const before = calls.length
    const r = await rpc('tools/call', { name: 'reply', arguments: { chat_id: '10', text: '안녕하세요', reply_to: '501' } })
    expect(r.result.isError).toBeUndefined()
    const sm = calls.slice(before).filter(c => c.method === 'sendMessage')
    expect(sm.length).toBe(1)
    expect(String(sm[0].body.chat_id)).toBe('10')
    expect(sm[0].body.text).toBe('안녕하세요')
    expect(sm[0].body.reply_parameters).toEqual({ message_id: 501 })
    expect(r.result.content[0].text).toBe(`sent (id: ${nextMsgId})`)
  })

  test('react·edit_message → setMessageReaction·editMessageText', async () => {
    const before = calls.length
    const a = await rpc('tools/call', { name: 'react', arguments: { chat_id: '10', message_id: '501', emoji: '👍' } })
    const b = await rpc('tools/call', { name: 'edit_message', arguments: { chat_id: '10', message_id: '901', text: '고침' } })
    expect(a.result.isError).toBeUndefined()
    expect(b.result.isError).toBeUndefined()
    const got = calls.slice(before)
    const re = got.find(c => c.method === 'setMessageReaction')!
    expect(String(re.body.chat_id)).toBe('10')
    expect(re.body.message_id).toBe(501)
    expect(re.body.reaction).toEqual([{ type: 'emoji', emoji: '👍' }])
    const ed = got.find(c => c.method === 'editMessageText')!
    expect(String(ed.body.chat_id)).toBe('10')
    expect(ed.body.message_id).toBe(901)
    expect(ed.body.text).toBe('고침')
  })

  test('첨부: reply files·download_attachment 는 오류, 아무것도 안 보냄', async () => {
    const before = calls.length
    const a = await rpc('tools/call', { name: 'reply', arguments: { chat_id: '10', text: 'x', files: ['/etc/hosts'] } })
    const b = await rpc('tools/call', { name: 'download_attachment', arguments: { file_id: 'abc' } })
    expect(a.result.isError).toBe(true)
    expect(a.result.content[0].text).toContain(ATTACHMENT_UNSUPPORTED)
    expect(b.result.isError).toBe(true)
    expect(b.result.content[0].text).toContain(ATTACHMENT_UNSUPPORTED)
    expect(calls.slice(before).filter(c => c.method !== 'getUpdates')).toEqual([])
  })

  test('허용 밖 방으로 reply 는 거절', async () => {
    const before = calls.length
    const r = await rpc('tools/call', { name: 'reply', arguments: { chat_id: '99', text: 'x' } })
    expect(r.result.isError).toBe(true)
    expect(calls.slice(before).filter(c => c.method === 'sendMessage')).toEqual([])
  })

  test('받기: 허용 방만 notifications/claude/channel, 허용 밖·보낸사람만 허용·그룹은 없음', async () => {
    await waitFor(() => calls.some(c => c.method === 'getUpdates'), 'polling start')
    const n0 = channelNotes().length
    const gd = { id: 1, is_bot: false, first_name: 'GD', username: 'gd' }
    // 거절돼야 하는 셋 — 뒤의 허용 메시지(sentinel)가 오면 셋이 처리된 뒤다(grammy 는 차례대로 처리).
    pushUpdate({ message_id: 601, chat: { id: 30, type: 'private' }, from: gd, text: '허용 밖 방' })
    pushUpdate({ message_id: 602, chat: { id: 20, type: 'private' }, from: { id: 10, is_bot: false, first_name: 'X', username: 'x' }, text: '보낸 사람 id 만 allowFrom' })
    pushUpdate({ message_id: 603, chat: { id: 10, type: 'group', title: 'g' }, from: gd, text: '그룹 @claudemember' })
    pushUpdate({ message_id: 604, chat: { id: 10, type: 'private' }, from: gd, text: '안녕' })
    const note = await waitFor(() => channelNotes()[n0], 'channel notification')
    expect(channelNotes().length).toBe(n0 + 1)
    expect(note.params.content).toBe('안녕')
    expect(note.params.meta).toMatchObject({ chat_id: '10', message_id: '604', user: 'gd', user_id: '1' })
    expect(note.params.meta.image_path).toBeUndefined()
    await Bun.sleep(300)
    expect(channelNotes().length).toBe(n0 + 1)
  }, 15000)

  test('positive-ID group: exact plain-text mention is delivered without Telegram entities', async () => {
    const n0 = channelNotes().length
    const from = { id: 1, is_bot: false, first_name: 'GD', username: 'gd' }
    pushUpdate({ message_id: 701, chat: { id: 40, type: 'group' }, from, text: '@claudemember_other not ours' })
    pushUpdate({ message_id: 702, chat: { id: 40, type: 'group' }, from, text: 'no mention' })
    pushUpdate({ message_id: 703, chat: { id: 40, type: 'group' }, from: { ...from, id: 2 }, text: '@claudemember denied sender' })
    pushUpdate({ message_id: 704, chat: { id: 41, type: 'group' }, from, text: '@claudemember denied room' })
    pushUpdate({ message_id: 705, chat: { id: 40, type: 'group' }, from, text: '@claudemember group ping' })
    const note = await waitFor(() => channelNotes()[n0], 'group notification')
    expect(note.params.content).toBe('@claudemember group ping')
    expect(note.params.meta).toMatchObject({ chat_id: '40', chat_type: 'group', message_id: '705' })
    await Bun.sleep(300)
    expect(channelNotes().length).toBe(n0 + 1)
    const reply = await rpc('tools/call', { name: 'reply', arguments: { chat_id: '40', text: 'group reply', reply_to: '705' } })
    expect(reply.result.isError).toBeUndefined()
    expect(calls.find(c => c.method === 'sendMessage' && c.body.text === 'group reply')?.body.reply_parameters).toEqual({ message_id: 705 })
  }, 15000)

  test('받은 사진: 글(캡션)만, image_path 없음', async () => {
    const n0 = channelNotes().length
    pushUpdate({ message_id: 605, chat: { id: 10, type: 'private' }, from: { id: 1, is_bot: false, first_name: 'GD' }, caption: '사진 설명', photo: [{ file_id: 'p1', file_unique_id: 'u1', width: 1, height: 1 }] })
    const note = await waitFor(() => channelNotes()[n0], 'photo notification')
    expect(note.params.content).toBe('사진 설명')
    expect(note.params.meta.image_path).toBeUndefined()
    expect(calls.some(c => c.method === 'getFile')).toBe(false)
  }, 15000)

  test('권한 요청은 ownerChat 한 곳에만, 글 답장 "yes <code>" 로 승인', async () => {
    const before = calls.length
    send({ jsonrpc: '2.0', method: 'notifications/claude/channel/permission_request', params: { request_id: 'abcde', tool_name: 'Bash', description: 'ls 실행', input_preview: '{}' } })
    await waitFor(() => calls.slice(before).find(c => c.method === 'sendMessage'), 'permission sendMessage')
    await Bun.sleep(200)
    const sm = calls.slice(before).filter(c => c.method === 'sendMessage')
    expect(sm.length).toBe(1)
    expect(String(sm[0].body.chat_id)).toBe('10')
    expect(sm[0].body.text).toContain('yes abcde')

    pushUpdate({ message_id: 606, chat: { id: 10, type: 'private' }, from: { id: 1, is_bot: false, first_name: 'GD' }, text: 'yes abcde' })
    const perm = await waitFor(() => lines.find(l => l.method === 'notifications/claude/channel/permission'), 'permission reply')
    expect(perm.params).toEqual({ request_id: 'abcde', behavior: 'allow' })
  }, 15000)
})
