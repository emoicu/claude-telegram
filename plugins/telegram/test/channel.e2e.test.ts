import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Channel, FakeTelegram } from './harness'

const OWNER = 1111
const STRANGER = 2222
/** In the group below only, by its own allowFrom. */
const MEMBER = 3333
const GROUP = -100777

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

let routerCount = 0
/** Stands in for router.ts: a socket the server connects to, and that connection. */
function fakeRouter() {
  const path = join(tmpdir(), `tg-e2e-router-${process.pid}-${routerCount++}.sock`)
  let connected!: (sock: { write(data: string | Uint8Array): number }) => void
  const socket = new Promise<{ write(data: string | Uint8Array): number }>(resolve => {
    connected = resolve
  })
  const listener = Bun.listen({ unix: path, socket: { open: sock => connected(sock), data() {} } })
  return { path, socket, stop: () => listener.stop(true) }
}

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

describe('photos', () => {
  const photo = (file_id: string, file_unique_id: string) =>
    tg.dm(OWNER, '', { text: undefined, caption: 'look', photo: [{ file_id, file_unique_id, width: 10, height: 10 }] })

  test('a photo that cannot be downloaded arrives without an image', async () => {
    await boot(allowlist)
    tg.serveFile('ph1', { file_path: 'photos/gone.jpg', file_unique_id: 'U1' })
    photo('ph1', 'U1')
    const n = await ch.waitNotification('notifications/claude/channel', p => p.content === 'look')
    expect(n.meta.image_path).toBeUndefined()
    const inbox = join(ch.stateDir, 'inbox')
    expect(existsSync(inbox) ? readdirSync(inbox) : []).toEqual([])
  })

  test('a photo is saved in the inbox under a safe name', async () => {
    await boot(allowlist)
    tg.serveFile('ph2', { file_path: 'photos/a.jp/g', file_unique_id: '../A b', content: 'JPEGDATA' })
    photo('ph2', '../A b')
    const n = await ch.waitNotification('notifications/claude/channel', p => p.content === 'look')
    expect(dirname(n.meta.image_path)).toBe(join(ch.stateDir, 'inbox'))
    expect(basename(n.meta.image_path)).toMatch(/^\d+-Ab\.jpg$/)
    expect(readFileSync(n.meta.image_path, 'utf8')).toBe('JPEGDATA')
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

  test('servers that do not poll Telegram, and topic sessions, leave it alone', async () => {
    const quiet = new Channel(tg, { access: allowlist, env: { TELEGRAM_CHANNEL_MODE: 'never' } })
    const topic = new Channel(tg, {
      access: allowlist,
      env: {
        TELEGRAM_ROUTER_SOCKET: join(tmpdir(), `no-router-${process.pid}.sock`),
        TELEGRAM_SLOT: 'topic-7',
        TELEGRAM_TOPIC_CHAT: '-100555',
        TELEGRAM_TOPIC_THREAD: '7',
      },
    })
    try {
      await quiet.handshake()
      await topic.start(tg)
      const files = [quiet, topic].map(c => {
        mkdirSync(join(c.stateDir, 'approved'), { recursive: true })
        const file = join(c.stateDir, 'approved', String(STRANGER))
        writeFileSync(file, '')
        return file
      })
      await Bun.sleep(6_500)
      expect(tg.sent().some(c => said(c, /Paired/))).toBe(false)
      for (const file of files) expect(existsSync(file)).toBe(true)
    } finally {
      await quiet.stop()
      await topic.stop()
    }
  }, 20_000)
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

  test('a rich reply keeps "#1" at the start of a list item as text', async () => {
    await boot(allowlist)
    await ch.tool('reply', { chat_id: String(OWNER), text: '**PRs**\n- #1 merged\n# Real heading', format: 'rich' })
    const call = await tg.waitFor(c => c.method === 'sendRichMessage' && /PRs/.test(textOf(c)), 'rich reply')
    expect(textOf(call)).toBe('**PRs**\n- \\#1 merged\n# Real heading')
  })

  test('a rich reply turns a wide table into a list and keeps a narrow one', async () => {
    await boot(allowlist)
    const narrow = '| | now | later |\n| --- | --- | --- |\n| router | 10 min | 30 s |'
    const wide = '| Script | What it does |\n| --- | --- |\n| claude-tg.sh | ' + 'keeps the router running, '.repeat(3) + '|'
    await ch.tool('reply', { chat_id: String(OWNER), text: `**Tables**\n\n${narrow}\n\n${wide}`, format: 'rich' })
    const call = await tg.waitFor(c => c.method === 'sendRichMessage' && /Tables/.test(textOf(c)), 'rich reply')
    expect(textOf(call)).toBe(`**Tables**\n\n${narrow}\n\n- **claude-tg.sh**: ${'keeps the router running, '.repeat(3).trim()}`)
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

  test('reply sends photos and documents as one album each', async () => {
    await boot(allowlist)
    const dir = join(tmpdir(), `tg-album-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const files = ['a.png', 'b.jpg', 'c.txt', 'd.pdf'].map(n => join(dir, n))
    for (const f of files) writeFileSync(f, 'x')
    expect(await ch.tool('reply', { chat_id: String(OWNER), text: 'files', files })).toMatch(/sent/)
    const albums = tg.sent('sendMediaGroup').map(c => JSON.parse(c.body.media).map((m: { type: string }) => m.type))
    expect(albums).toEqual([['photo', 'photo'], ['document', 'document']])
  })

  test('reply with files and no text sends just the files', async () => {
    await boot(allowlist)
    const dir = join(tmpdir(), `tg-files-only-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const f = join(dir, 'report.txt')
    writeFileSync(f, 'x')
    expect(await ch.tool('reply', { chat_id: String(OWNER), text: '', files: [f] })).toMatch(/sent/)
    expect(await ch.tool('reply', { chat_id: String(OWNER), text: ' \n', files: [f], format: 'rich' })).toMatch(/sent/)
    expect(tg.sent('sendDocument')).toHaveLength(2)
    expect(tg.sent(/^send(Message|RichMessage)$/)).toHaveLength(0)
    await expect(ch.tool('reply', { chat_id: String(OWNER), text: '' })).rejects.toThrow(/text or files/)
  })

  test('a rich reply that fails part way sends only the rest as plain text', async () => {
    await boot(allowlist)
    const a = 'a'.repeat(20_000)
    const b = 'b'.repeat(20_000)
    tg.failNext('sendRichMessage', null, { error_code: 400, description: 'Bad Request: rich message rejected' })
    expect(await ch.tool('reply', { chat_id: String(OWNER), text: `${a}\n\n${b}`, format: 'rich' })).toMatch(/sent/)
    const rich = tg.sent('sendRichMessage')
    expect(rich).toHaveLength(2)
    expect(textOf(rich[0]!)).toBe(a)
    const plain = tg.sent('sendMessage').map(textOf)
    expect(plain.length).toBeGreaterThan(1)
    expect(plain.join('')).toBe(b)
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

  test('a "yes <code>" from a group member outside allowFrom is only a message', async () => {
    await boot({ ...allowlist, groups: { [String(GROUP)]: { requireMention: false, allowFrom: [String(MEMBER)] } } })
    request('fghij')
    tg.group(GROUP, MEMBER, 'yes fghij')
    const n = await ch.waitNotification('notifications/claude/channel', p => p.content === 'yes fghij')
    expect(n.meta.chat_id).toBe(String(GROUP))
    expect(ch.notifications.some(x => x.method === 'notifications/claude/channel/permission')).toBe(false)
  })
})

describe('questions (AskUserQuestion)', () => {
  test('quick presses delivered at once are all kept, and the answers reach Claude once', async () => {
    const router = fakeRouter()
    try {
      await boot(allowlist, { TELEGRAM_ROUTER_SOCKET: router.path })
      const sock = await router.socket
      const id = 'abcdef01'
      const question = (q: string, options: string[], msg: number) =>
        ({ header: '', question: q, multiSelect: false, options, selected: [], done: false, messages: { [String(OWNER)]: msg }, text: `❓ ${q}` })
      mkdirSync(join(ch.stateDir, 'ask'), { recursive: true })
      const file = join(ch.stateDir, 'ask', `${id}.json`)
      writeFileSync(file, JSON.stringify({ id, created: Date.now(), delivered: false, questions: [question('Color?', ['Red', 'Blue'], 7001), question('Size?', ['S', 'M'], 7002)] }))
      // The router hands updates over as they come; the server runs them side by side.
      const presses = [tg.pressUpdate(OWNER, `ask:${id}:0:1`, 7001), tg.pressUpdate(OWNER, `ask:${id}:1:0`, 7002), tg.pressUpdate(OWNER, `ask:${id}:1:1`, 7002)]
      sock.write(presses.map(update => `${JSON.stringify({ update })}\n`).join(''))
      const n = await ch.waitNotification('notifications/claude/channel', p => /Answers to your questions/.test(p.content))
      expect(n.content).toContain('1. Color?\n   → Blue')
      expect(n.content).toContain('2. Size?\n   → S')
      await Bun.sleep(500)
      expect(ch.notifications.filter(x => /Answers to your questions/.test(x.params?.content ?? ''))).toHaveLength(1)
      const rec = JSON.parse(readFileSync(file, 'utf8'))
      expect(rec.delivered).toBe(true)
      expect(rec.questions.map((q: { selected: number[] }) => q.selected)).toEqual([[1], [0]])
      expect(tg.sent('answerCallbackQuery').map(c => c.body.text).sort()).toEqual(['Already answered.', 'Selected: Blue', 'Selected: S'])
    } finally {
      router.stop()
    }
  })
})

describe('buttons in a group', () => {
  const group = { ...allowlist, groups: { [String(GROUP)]: { requireMention: true, allowFrom: [String(MEMBER)] } } }
  const answers = () => tg.sent('answerCallbackQuery').map(c => c.body.text)
  const pressAndWait = async (user: number, data: string, messageId: number) => {
    const before = answers().length
    tg.press(user, data, messageId, '', GROUP)
    await tg.waitFor(() => answers().length > before, 'answer')
    return answers()[before]
  }

  test('Stop works for the group\'s members and the owner, not for others', async () => {
    await boot(group)
    expect(await pressAndWait(MEMBER, 'stop:run', 1)).toBe('Claude is not working on anything right now.')
    expect(await pressAndWait(OWNER, 'stop:run', 1)).toBe('Claude is not working on anything right now.')
    expect(await pressAndWait(STRANGER, 'stop:run', 1)).toBe('Not authorized.')
  })

  test('a quick button pressed by a member reaches Claude', async () => {
    await boot(group)
    await ch.tool('reply', { chat_id: String(GROUP), text: 'Ready to ship?' })
    const id = (await tg.waitFor(c => c.method === 'sendMessage' && c.body.text === 'Ready to ship?', 'reply')).result.message_id
    expect(await pressAndWait(STRANGER, `qr:${id}:0`, id)).toBe('Not authorized.')
    tg.press(MEMBER, `qr:${id}:0`, id, '', GROUP)
    const n = await ch.waitNotification('notifications/claude/channel', p => /\[Button .* on your message/.test(p.content))
    expect(n.meta.chat_id).toBe(String(GROUP))
    expect(n.meta.user_id).toBe(String(MEMBER))
  })
})

describe('reaction status', () => {
  const OTHER = 4444
  test('a reply settles the 👀 in its own chat and leaves other chats waiting', async () => {
    await boot({ ...allowlist, allowFrom: [String(OWNER), String(OTHER)] }, { TELEGRAM_STATUS: 'on' })
    const reactions = (id: number) => tg.sent('setMessageReaction').filter(c => c.body.message_id === id).map(c => c.body.reaction?.[0]?.emoji)
    const first = tg.dm(OWNER, 'one')
    await ch.waitNotification('notifications/claude/channel', p => p.content === 'one')
    const second = tg.dm(OTHER, 'two')
    await ch.waitNotification('notifications/claude/channel', p => p.content === 'two')
    await ch.tool('reply', { chat_id: String(OWNER), text: 'done with one' })
    await tg.waitFor(c => c.method === 'setMessageReaction' && c.body.message_id === first && c.body.reaction?.[0]?.emoji === '👍', '👍 on the first')
    expect(reactions(second)).toEqual(['👀'])
    await ch.tool('reply', { chat_id: String(OTHER), text: 'done with two' })
    await tg.waitFor(c => c.method === 'setMessageReaction' && c.body.message_id === second && c.body.reaction?.[0]?.emoji === '👍', '👍 on the second')
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

describe('choose (polls)', () => {
  const vote = (pollId: string, user: number, option_ids: number[]) =>
    tg.push({ poll_answer: { poll_id: pollId, user: { id: user, is_bot: false, first_name: `U${user}` }, option_ids } })
  const ask = async () => {
    expect(await ch.tool('choose', { chat_id: String(OWNER), question: 'Which next?', options: ['Retry fix', 'Checklist', 'Status'] })).toMatch(/sent poll/)
    const call = await tg.waitFor(c => c.method === 'sendPoll', 'poll')
    expect(call.body.is_anonymous).toBe(false)
    expect(call.body.allows_multiple_answers).toBe(true)
    return call.result.poll.id as string
  }

  test('a vote reaches Claude with what was picked', async () => {
    await boot(allowlist)
    const pollId = await ask()
    vote(pollId, OWNER, [0, 2])
    const n = await ch.waitNotification('notifications/claude/channel', p => /Poll answer/.test(p.content))
    expect(n.content).toContain('Picked: "Retry fix", "Status"')
    expect(n.content).toContain('Not picked: "Checklist"')
    expect(n.meta.chat_id).toBe(String(OWNER))
  })

  test('a withdrawn vote is reported, a stranger is ignored', async () => {
    await boot(allowlist)
    const pollId = await ask()
    vote(pollId, STRANGER, [1])
    vote(pollId, OWNER, [])
    const n = await ch.waitNotification('notifications/claude/channel', p => /Poll/.test(p.content))
    expect(n.content).toContain('withdrew their vote')
    await Bun.sleep(200)
    expect(ch.notifications.filter(x => /Poll answer/.test(x.params?.content ?? ''))).toHaveLength(0)
  })

  test('rejects too few options', async () => {
    await boot(allowlist)
    await expect(ch.tool('choose', { chat_id: String(OWNER), question: 'Q?', options: ['only'] })).rejects.toThrow(/2 to 12/)
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

describe('delivery check', () => {
  const SID = '11111111-2222-3333-4444-555555555555'
  const PID = '424242'
  /** A Claude session file and transcript the server can find. */
  function fakeSession(): string {
    const dir = join(ch.stateDir, 'claude-config')
    mkdirSync(join(dir, 'sessions'), { recursive: true })
    mkdirSync(join(dir, 'projects', 'p'), { recursive: true })
    writeFileSync(join(dir, 'sessions', `${PID}.json`), JSON.stringify({ sessionId: SID, status: 'idle' }))
    const transcript = join(dir, 'projects', 'p', `${SID}.jsonl`)
    writeFileSync(transcript, '')
    return transcript
  }
  const count = (text: string) => ch.notifications.filter(n => n.method === 'notifications/claude/channel' && n.params?.content === text).length
  const env = { TELEGRAM_CLAUDE_PID: PID, TELEGRAM_DELIVERY_CHECK_MS: '300' }

  test('a message missing from the transcript is handed over once more', async () => {
    await boot(allowlist, env)
    fakeSession()
    tg.dm(OWNER, 'lost one')
    await ch.waitNotification('notifications/claude/channel', p => p.content === 'lost one')
    await Bun.sleep(900)
    expect(count('lost one')).toBe(2)
  })

  test('a message found in the transcript is not handed over again', async () => {
    await boot(allowlist, env)
    const transcript = fakeSession()
    const id = tg.dm(OWNER, 'arrived')
    const n = await ch.waitNotification('notifications/claude/channel', p => p.content === 'arrived')
    // What Claude Code writes when it accepts the message.
    const tag = `<channel source="plugin:telegram:telegram" chat_id="${n.meta.chat_id}" message_id="${id}" user="u">\narrived\n</channel>`
    writeFileSync(transcript, `${JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: tag })}\n`)
    await Bun.sleep(900)
    expect(count('arrived')).toBe(1)
  })

  test('nothing is resent when the transcript cannot be found', async () => {
    await boot(allowlist, env)
    tg.dm(OWNER, 'unknown')
    await ch.waitNotification('notifications/claude/channel', p => p.content === 'unknown')
    await Bun.sleep(900)
    expect(count('unknown')).toBe(1)
  })
})

describe('router messages', () => {
  test('says it can carry on, and hands the router\'s carry-on request to Claude', async () => {
    const path = join(tmpdir(), `fake-router-${process.pid}.sock`)
    let hello: any
    const listener = Bun.listen({
      unix: path,
      socket: {
        data(sock, chunk) {
          hello = JSON.parse(chunk.toString().split('\n')[0]!)
          sock.write(`${JSON.stringify({ resume: { chat_id: String(OWNER), id: 'resume-main-1', text: '[resume-main-1] carry on' } })}\n`)
        },
      },
    })
    try {
      await boot(allowlist, { TELEGRAM_ROUTER_SOCKET: path })
      const n = await ch.waitNotification('notifications/claude/channel', p => p.content === '[resume-main-1] carry on')
      expect(hello.can).toContain('resume')
      expect(n.meta.chat_id).toBe(String(OWNER))
      expect(n.meta.user).toBe('telegram-router')
    } finally {
      listener.stop(true)
    }
  })

  test('a character split between two reads from the socket arrives whole', async () => {
    const router = fakeRouter()
    try {
      await boot(allowlist, { TELEGRAM_ROUTER_SOCKET: router.path })
      const sock = await router.socket
      const update = {
        update_id: 1,
        message: {
          message_id: 42,
          date: Math.floor(Date.now() / 1000),
          chat: { id: OWNER, type: 'private' },
          from: { id: OWNER, is_bot: false, first_name: 'Owner' },
          text: '你好 router',
        },
      }
      const bytes = new TextEncoder().encode(`${JSON.stringify({ update })}\n`)
      const cut = bytes.indexOf(0xe4) + 1 // inside 你
      sock.write(bytes.subarray(0, cut))
      await Bun.sleep(150)
      sock.write(bytes.subarray(cut))
      const n = await ch.waitNotification('notifications/claude/channel', p => /router/.test(p.content))
      expect(n.content).toBe('你好 router')
    } finally {
      router.stop()
    }
  })
})
