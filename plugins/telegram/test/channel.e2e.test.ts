import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Channel, FakeTelegram } from './harness'

const OWNER = 1111
const STRANGER = 2222

let tg: FakeTelegram
let ch: Channel

async function boot(access: Record<string, unknown>, env: Record<string, string> = {}): Promise<void> {
  ch = new Channel(tg, { access, env })
  await ch.start(tg)
}

beforeEach(() => {
  tg = new FakeTelegram()
})
afterEach(async () => {
  await ch?.stop()
  tg.stop()
})

const allowlist = { dmPolicy: 'allowlist', allowFrom: [String(OWNER)], groups: {}, pending: {} }

describe('inbound messages', () => {
  test('a message from an allowlisted user reaches Claude with its metadata', async () => {
    await boot(allowlist)
    const id = tg.dm(OWNER, 'hello there')
    const n = await ch.waitNotification('notifications/claude/channel')
    expect(n.content).toBe('hello there')
    expect(n.meta.chat_id).toBe(String(OWNER))
    expect(n.meta.message_id).toBe(String(id))
  })

  test('strangers are dropped silently in allowlist mode', async () => {
    await boot(allowlist)
    tg.dm(STRANGER, 'let me in')
    tg.dm(OWNER, 'marker')
    await ch.waitNotification('notifications/claude/channel', p => p.content === 'marker')
    expect(ch.notifications.some(n => n.params?.content === 'let me in')).toBe(false)
    expect(tg.sent(/^send/).some(c => String(c.body.chat_id) === String(STRANGER))).toBe(false)
  })

  test('pairing mode answers a stranger with a code and saves it', async () => {
    await boot({ ...allowlist, dmPolicy: 'pairing' })
    tg.dm(STRANGER, 'hi')
    const reply = await tg.waitFor(c => /^send/.test(c.method) && String(c.body.chat_id) === String(STRANGER), 'pairing reply')
    const code = /\b([a-f0-9]{6})\b/.exec(JSON.stringify(reply.body))?.[1]
    expect(code).toBeDefined()
    const access = JSON.parse(readFileSync(join(ch.stateDir, 'access.json'), 'utf8'))
    expect(access.pending[code!].senderId).toBe(String(STRANGER))
    expect(ch.notifications.some(n => n.method === 'notifications/claude/channel')).toBe(false)
  })
})

describe('pairing confirmation', () => {
  test('an approval dropped by /telegram:access is confirmed to the user and cleaned up', async () => {
    await boot(allowlist)
    mkdirSync(join(ch.stateDir, 'approved'), { recursive: true })
    const file = join(ch.stateDir, 'approved', String(STRANGER))
    writeFileSync(file, '')
    const msg = await tg.waitFor(c => c.method === 'sendMessage' && /Paired/.test(c.body.text), 'confirmation', 8000)
    expect(String(msg.body.chat_id)).toBe(String(STRANGER))
    for (let i = 0; i < 50 && existsSync(file); i++) await Bun.sleep(20)
    expect(existsSync(file)).toBe(false)
  }, 15_000)
})

describe('tools', () => {
  test('reply sends text to an allowlisted chat', async () => {
    await boot(allowlist)
    const text = await ch.tool('reply', { chat_id: String(OWNER), text: 'pong' })
    expect(text).toMatch(/sent/)
    const call = await tg.waitFor(c => c.method === 'sendMessage' && c.body.text === 'pong', 'sendMessage pong')
    expect(String(call.body.chat_id)).toBe(String(OWNER))
  })

  test('reply in rich format sends a rich message', async () => {
    await boot(allowlist)
    await ch.tool('reply', { chat_id: String(OWNER), text: '## Title\n\n- [x] done', format: 'rich' })
    const call = await tg.waitFor(c => c.method === 'sendRichMessage', 'sendRichMessage')
    expect(call.body.rich_message.markdown).toContain('## Title')
  })

  test('reply refuses chats that are not allowlisted', async () => {
    await boot(allowlist)
    await expect(ch.tool('reply', { chat_id: String(STRANGER), text: 'leak' })).rejects.toThrow(/not allowlisted/)
    expect(tg.sent(/^send/).some(c => c.body.text === 'leak')).toBe(false)
  })

  test('reply refuses to send the channel state as a file', async () => {
    await boot(allowlist)
    await expect(ch.tool('reply', { chat_id: String(OWNER), text: 'x', files: [join(ch.stateDir, '.env')] })).rejects.toThrow()
    expect(tg.sent('sendDocument')).toHaveLength(0)
  })

  test('schedule queues a message, scheduled lists and cancels it', async () => {
    await boot(allowlist)
    const out = await ch.tool('schedule', { chat_id: String(OWNER), text: 'drink water', at: 'now+1h' })
    const id = /id: (\w+)/.exec(out)![1]!
    expect(existsSync(join(ch.stateDir, 'scheduled', `${id}.json`))).toBe(true)
    expect(await ch.tool('scheduled', { chat_id: String(OWNER), action: 'list' })).toContain('drink water')
    expect(await ch.tool('scheduled', { chat_id: String(OWNER), action: 'cancel', id })).toBe(`cancelled ${id}`)
    expect(await ch.tool('scheduled', { chat_id: String(OWNER), action: 'list' })).toBe('nothing scheduled')
  })
})

describe('permission relay', () => {
  const request = (request_id: string) =>
    ch.notify('notifications/claude/channel/permission_request', {
      request_id,
      tool_name: 'Bash',
      description: 'List files',
      input_preview: '{"command":"ls"}',
    })

  test('a prompt becomes buttons and a press becomes the verdict', async () => {
    await boot(allowlist)
    request('abcde')
    const prompt = await tg.waitFor(c => c.method === 'sendMessage' && /Permission: Bash/.test(c.body.text), 'permission prompt')
    const buttons = prompt.body.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data)
    expect(buttons).toEqual(['perm:more:abcde', 'perm:allow:abcde', 'perm:deny:abcde', 'perm:always:abcde'])
    tg.press(OWNER, 'perm:deny:abcde', 7000, prompt.body.text)
    const verdict = await ch.waitNotification('notifications/claude/channel/permission')
    expect(verdict).toEqual({ request_id: 'abcde', behavior: 'deny' })
  })

  test('presses from someone not allowlisted are refused', async () => {
    await boot(allowlist)
    request('abcde')
    await tg.waitFor(c => c.method === 'sendMessage' && /Permission/.test(c.body.text), 'permission prompt')
    tg.press(STRANGER, 'perm:allow:abcde', 7000)
    await tg.waitFor(c => c.method === 'answerCallbackQuery' && c.body.text === 'Not authorized.', 'refusal')
    expect(ch.notifications.some(n => n.method === 'notifications/claude/channel/permission')).toBe(false)
  })

  test('a "yes <code>" text reply is a verdict, not a message', async () => {
    await boot(allowlist)
    request('fghij')
    tg.dm(OWNER, 'yes fghij')
    expect(await ch.waitNotification('notifications/claude/channel/permission')).toEqual({ request_id: 'fghij', behavior: 'allow' })
    expect(ch.notifications.some(n => n.method === 'notifications/claude/channel')).toBe(false)
  })
})

describe('reaction shortcuts', () => {
  test('a 👍 on one of our replies becomes an instruction to Claude', async () => {
    await boot(allowlist)
    await ch.tool('reply', { chat_id: String(OWNER), text: 'Shall I go on?' })
    const sent = await tg.waitFor(c => c.method === 'sendMessage' && c.body.text === 'Shall I go on?', 'reply')
    const messageId = sent.result.message_id
    tg.push({
      message_reaction: {
        chat: { id: OWNER, type: 'private' },
        message_id: messageId,
        user: { id: OWNER, is_bot: false, first_name: 'Owner' },
        date: 0,
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '👍' }],
      },
    })
    const n = await ch.waitNotification('notifications/claude/channel')
    expect(n.content).toContain('Shall I go on?')
  })
})

describe('progress', () => {
  test('todo-list style status fields are understood', async () => {
    await boot(allowlist)
    await ch.tool('progress', {
      chat_id: String(OWNER),
      title: 'Task',
      steps: [
        { text: 'one', status: 'completed' },
        { text: 'two', status: 'in_progress' },
        { text: 'three', status: 'pending' },
        { text: 'four', state: 'done' },
      ],
    })
    const call = await tg.waitFor(c => /^send/.test(c.method) && /one/.test(JSON.stringify(c.body)), 'checklist')
    const body = call.body.rich_message?.markdown ?? call.body.text
    expect(body).toMatch(/\[x\] one/)
    expect(body).toMatch(/\[ \] three/)
    expect(body).toMatch(/\[x\] four/)
    expect(body).not.toMatch(/\[x\] two/)
  })
})
