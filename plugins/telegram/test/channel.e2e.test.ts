import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

/** A message the bot sent, rich or plain, and what it says. */
const said = (c: { method: string; body: any }, re: RegExp) =>
  (c.method === 'sendMessage' || c.method === 'sendRichMessage') && re.test(c.body.text ?? c.body.rich_message?.markdown ?? '')
const textOf = (c: { body: any }): string => c.body.text ?? c.body.rich_message?.markdown ?? ''

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
    const msg = await tg.waitFor(c => said(c, /Paired/), 'confirmation', 8000)
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

  const react = (messageId: number, from: string[], to: string[]) =>
    tg.push({
      message_reaction: {
        chat: { id: OWNER, type: 'private' },
        message_id: messageId,
        user: { id: OWNER, is_bot: false, first_name: 'Owner' },
        date: 0,
        old_reaction: from.map(emoji => ({ type: 'emoji', emoji })),
        new_reaction: to.map(emoji => ({ type: 'emoji', emoji })),
      },
    })
  const replyId = async (text: string) => {
    await ch.tool('reply', { chat_id: String(OWNER), text })
    return (await tg.waitFor(c => c.method === 'sendMessage' && c.body.text === text, 'reply')).result.message_id as number
  }
  const shortcutsSeen = () => ch.notifications.filter(n => n.method === 'notifications/claude/channel' && /on your message/.test(n.params?.content))

  test('a ❤ removed during the hold never reaches Claude', async () => {
    await boot(allowlist, { TELEGRAM_REACTION_HOLD_SEC: '0.5' })
    const id = await replyId('Use tabs from now on?')
    react(id, [], ['❤'])
    await Bun.sleep(150)
    react(id, ['❤'], [])
    await Bun.sleep(800)
    expect(shortcutsSeen()).toHaveLength(0)
  })

  test('a ❤ reaches Claude after the hold, and removing it later asks for an undo', async () => {
    await boot(allowlist, { TELEGRAM_REACTION_HOLD_SEC: '0.3' })
    const id = await replyId('Use spaces from now on?')
    react(id, [], ['❤'])
    await Bun.sleep(100)
    expect(shortcutsSeen()).toHaveLength(0)
    const first = await ch.waitNotification('notifications/claude/channel', p => /Reaction ❤ on your message/.test(p.content))
    expect(first.content).toContain('Remember this')
    react(id, ['❤'], [])
    const undo = await ch.waitNotification('notifications/claude/channel', p => /withdrawn/.test(p.content))
    expect(undo.content).toContain('Undo what you did')
    expect(undo.content).toContain('Use spaces from now on?')
  })

  test('removing a reaction that is not held does nothing', async () => {
    await boot(allowlist, { TELEGRAM_REACTION_HOLD_SEC: '0.3' })
    const id = await replyId('Next step?')
    react(id, [], ['👍'])
    await ch.waitNotification('notifications/claude/channel', p => /👍/.test(p.content))
    react(id, ['👍'], [])
    await Bun.sleep(400)
    expect(shortcutsSeen()).toHaveLength(1)
  })

  test('removing it after the undo window does nothing', async () => {
    await boot(allowlist, { TELEGRAM_REACTION_HOLD_SEC: '0', TELEGRAM_REACTION_UNDO_MIN: '0.001' })
    const id = await replyId('Rewrite the parser?')
    react(id, [], ['🔥'])
    await ch.waitNotification('notifications/claude/channel', p => /🔥/.test(p.content))
    await Bun.sleep(200)
    react(id, ['🔥'], [])
    await Bun.sleep(400)
    expect(shortcutsSeen()).toHaveLength(1)
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

describe('retries', () => {
  test('a rate-limited reply is sent once Telegram allows it', async () => {
    await boot(allowlist)
    tg.failNext('sendMessage', { error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } })
    const started = Date.now()
    expect(await ch.tool('reply', { chat_id: String(OWNER), text: 'after the wait' })).toMatch(/sent/)
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000)
    expect(tg.sent('sendMessage').filter(c => c.body.text === 'after the wait')).toHaveLength(2)
  }, 15_000)

  test('a server error is retried, a bad request is not', async () => {
    await boot(allowlist)
    tg.failNext('sendMessage', { error_code: 502, description: 'Bad Gateway' })
    expect(await ch.tool('reply', { chat_id: String(OWNER), text: 'second try' })).toMatch(/sent/)
    tg.failNext('sendMessage', { error_code: 400, description: 'Bad Request: chat not found' })
    await expect(ch.tool('reply', { chat_id: String(OWNER), text: 'no retry' })).rejects.toThrow(/chat not found/)
    expect(tg.sent('sendMessage').filter(c => c.body.text === 'no retry')).toHaveLength(1)
  }, 15_000)
})

describe('/doctor', () => {
  test('reports the setup and flags an open group', async () => {
    await boot({ ...allowlist, groups: { '-100123': { requireMention: false, allowFrom: [] } } })
    tg.dm(OWNER, '/doctor', { entities: [{ type: 'bot_command', offset: 0, length: 7 }] })
    const msg = await tg.waitFor(c => said(c, /Doctor/), 'doctor report')
    expect(msg.method).toBe('sendRichMessage')
    expect(textOf(msg)).toContain('Bot @test_bot')
    expect(textOf(msg)).toContain('**Needs attention**\n\n\u2800\n\n- ⚠️ Group -100123: every member can talk to Claude, without even mentioning the bot')
    expect(textOf(msg)).toContain('- ✅ .env (bot token) is private')
  })

  test('strangers get nothing', async () => {
    await boot(allowlist)
    tg.dm(STRANGER, '/doctor', { entities: [{ type: 'bot_command', offset: 0, length: 7 }] })
    tg.dm(OWNER, 'marker')
    await ch.waitNotification('notifications/claude/channel', p => p.content === 'marker')
    expect(tg.sent(/^send/).some(c => said(c, /Doctor/))).toBe(false)
  })
})

describe('/language', () => {
  const command = (user: number, text: string) => tg.dm(user, text, { entities: [{ type: 'bot_command', offset: 0, length: text.length }] })

  test('switches what the bot shows to Chinese', async () => {
    await boot(allowlist)
    command(OWNER, '/language')
    const picker = await tg.waitFor(c => said(c, /Pick the language/), 'language picker')
    expect(picker.method).toBe('sendMessage')
    const buttons = picker.body.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data)
    expect(buttons).toEqual(['lang:en', 'lang:zh'])

    tg.press(OWNER, 'lang:zh', picker.result.message_id, textOf(picker))
    await tg.waitFor(c => c.method === 'editMessageText' && /语言：中文/.test(textOf(c)), 'confirmation in Chinese')
    expect(readFileSync(join(ch.stateDir, 'language'), 'utf8')).toBe('zh\n')
    const menu = await tg.waitFor(
      c => c.method === 'setMyCommands' && JSON.stringify(c.body.commands).includes('检查一切是否正常'),
      'Chinese command menu',
    )
    expect(menu.body.commands.map((c: any) => c.command)).toContain('language')

    command(OWNER, '/status')
    await tg.waitFor(c => said(c, /已配对/), 'status in Chinese')

    ch.notify('notifications/claude/channel/permission_request', {
      request_id: 'fghij',
      tool_name: 'Bash',
      description: 'List files',
      input_preview: '{"command":"ls"}',
    })
    const prompt = await tg.waitFor(c => c.method === 'sendMessage' && /权限请求：Bash/.test(c.body.text ?? ''), 'permission prompt in Chinese')
    expect(prompt.body.reply_markup.inline_keyboard.flat().map((b: any) => b.text)).toContain('✅ 允许')
  }, 15_000)

  test('strangers cannot switch it', async () => {
    await boot(allowlist)
    tg.press(STRANGER, 'lang:zh', 1)
    const answer = await tg.waitFor(c => c.method === 'answerCallbackQuery', 'refusal')
    expect(answer.body.text).toBe('Not authorized.')
    expect(existsSync(join(ch.stateDir, 'language'))).toBe(false)
  })
})

describe('command answers', () => {
  const command = (user: number, text: string) => tg.dm(user, text, { entities: [{ type: 'bot_command', offset: 0, length: text.length }] })

  test('are rich messages, and plain text when Telegram rejects rich ones', async () => {
    await boot(allowlist)
    command(OWNER, '/start')
    const rich = await tg.waitFor(c => said(c, /Pairing/), '/start')
    expect(rich.method).toBe('sendRichMessage')
    expect(textOf(rich)).toContain('**🔗 Pairing**')

    tg.failNext('sendRichMessage', { error_code: 400, description: 'Bad Request: rich messages are not supported' })
    command(OWNER, '/start')
    const plain = await tg.waitFor(c => c.method === 'sendMessage' && /Pairing/.test(textOf(c)), 'plain /start')
    expect(textOf(plain)).not.toMatch(/\*\*|###|`/)

    // Short answers are plain text to begin with.
    command(OWNER, '/status')
    const status = await tg.waitFor(c => said(c, /Paired as/), '/status')
    expect(status.method).toBe('sendMessage')
  })

  test('long answers are spaced out', async () => {
    await boot(allowlist)
    command(OWNER, '/doctor')
    const msg = await tg.waitFor(c => said(c, /Doctor/), '/doctor')
    expect(textOf(msg)).toMatch(/- ✅ [^\n]+\n\n- ✅ /)
  })
})

describe('command menu', () => {
  const menu = () => tg.waitFor(c => c.method === 'setMyCommands', 'command menu')

  test('lists /sessions under the router, which answers it', async () => {
    await boot(allowlist, { TELEGRAM_ROUTER_SOCKET: join(tmpdir(), `no-router-${process.pid}.sock`) })
    const commands = (await menu()).body.commands.map((c: any) => c.command)
    expect(commands).toContain('sessions')
    expect(commands).toContain('doctor')
  })

  test('leaves /sessions out without the router', async () => {
    await boot(allowlist)
    expect((await menu()).body.commands.map((c: any) => c.command)).not.toContain('sessions')
  })
})
