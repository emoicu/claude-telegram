import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Subprocess, spawn } from 'bun'
import { type Call, FakeTelegram } from './harness'

// The router end to end: a fake Bot API, a private tmux server, and
// test/fake-claude.ts standing in for Claude Code in the session windows.

const OWNER = 1111
const STRANGER = 2222
const HAS_TMUX = !!Bun.which('tmux')

let tg: FakeTelegram
let dir: string
let claudeDir: string
let router: Subprocess | undefined
const SESSION = 'e2e'
// Forum groups the owner may use (see allowGroups).
const GROUP = -1001234567890
const GROUP2 = -1009876543210

function env(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    // No LANG on purpose: the router must read tmux output without a UTF-8 locale.
    HOME: dir,
    TMUX_TMPDIR: dir,
    CLAUDE_CONFIG_DIR: claudeDir,
    TELEGRAM_STATE_DIR: dir,
    TELEGRAM_API_ROOT: tg.url,
    TELEGRAM_ROUTER_TMUX: SESSION,
    TELEGRAM_ROUTER_CLAUDE: `${join(import.meta.dir, 'fake-claude.ts')} plugin:telegram@emoicu-plugins`,
    TELEGRAM_ROUTER_MAIN_CWD: dir,
  }
}

const tmux = (...args: string[]) => Bun.spawnSync(['tmux', ...args], { env: env() })

function spawnRouter(extra: Record<string, string> = {}): void {
  router = spawn(['bun', join(import.meta.dir, '..', 'router.ts')], {
    env: { ...env(), ...extra },
    stdout: 'ignore',
    stderr: Bun.file(join(dir, 'router.err')),
  })
}

/** Stop the router and start it again (running sessions are adopted). */
async function restartRouter(extra: Record<string, string> = {}, before?: () => void): Promise<void> {
  router?.kill()
  await router?.exited
  before?.()
  spawnRouter(extra)
  await Bun.sleep(1500)
}

/** Let the owner use the forum groups GROUP and GROUP2. */
function allowGroups(): void {
  writeFileSync(
    join(dir, 'access.json'),
    JSON.stringify({
      dmPolicy: 'allowlist',
      allowFrom: [String(OWNER)],
      groups: { [GROUP]: { allowFrom: [String(OWNER)] }, [GROUP2]: { allowFrom: [String(OWNER)] } },
      pending: {},
    }),
  )
}

let nextTopicMessage = 100
/** A message in topic `thread` of forum group `chat`. */
function topicMessage(chat: number, thread: number, user: number, text: string): void {
  tg.push({
    message: {
      message_id: nextTopicMessage++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chat, type: 'supergroup', title: 'G', is_forum: true },
      from: { id: user, is_bot: false, first_name: `U${user}` },
      is_topic_message: true,
      message_thread_id: thread,
      text,
    },
  })
}

/** What one fake Claude process received, as parsed lines. */
function receivedBy(pid: number): any[] {
  try {
    return readFileSync(join(claudeDir, `received-${pid}.log`), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l))
  } catch {
    return []
  }
}

const slotsFile = () => join(dir, 'router', 'slots.json')
const savedSlots = (): { name: string; chat?: string; thread?: number }[] => JSON.parse(readFileSync(slotsFile(), 'utf8'))
const terms = () => (existsSync(join(claudeDir, 'terms.log')) ? readFileSync(join(claudeDir, 'terms.log'), 'utf8').trim().split('\n').filter(Boolean) : [])

/** pid and arguments of every fake Claude started so far. */
function starts(): { pid: number; args: string }[] {
  try {
    return readFileSync(join(claudeDir, 'starts.log'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(l => ({ pid: Number(l.split(' ')[0]), args: l.slice(l.indexOf(' ') + 1) }))
  } catch {
    return []
  }
}

async function until<T>(what: string, f: () => T | undefined | false, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = f()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(50)
  }
}

const setStatus = (s: string) => writeFileSync(join(claudeDir, 'fake-status'), s)
const textOf = (c: Call): string => c.body.text ?? ''
const said = (re: RegExp) => (c: Call) => (c.method === 'sendMessage' || c.method === 'editMessageText') && re.test(textOf(c))

beforeEach(async () => {
  if (!HAS_TMUX) return
  tg = new FakeTelegram()
  dir = mkdtempSync(join(tmpdir(), 'tg-router-e2e-'))
  claudeDir = join(dir, 'claude-config')
  mkdirSync(claudeDir)
  writeFileSync(join(dir, '.env'), `TELEGRAM_BOT_TOKEN=123456:${'x'.repeat(35)}\n`, { mode: 0o600 })
  writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [String(OWNER)], groups: {}, pending: {} }))
  tmux('new-session', '-d', '-s', SESSION, 'sleep 600')
  spawnRouter()
  // The router starts main right away; wait until it has said hello.
  await until('main to start', () => starts().length === 1)
  await Bun.sleep(500)
}, 20_000)

afterEach(async () => {
  if (!HAS_TMUX) return
  router?.kill()
  await router?.exited
  tmux('kill-server')
  tg.stop()
  rmSync(dir, { recursive: true, force: true })
}, 10_000)

describe.skipIf(!HAS_TMUX)('/restart', () => {
  test('an idle session restarts right away and resumes its conversation', async () => {
    const first = starts()[0]!
    const sid = JSON.parse(readFileSync(join(claudeDir, 'sessions', `${first.pid}.json`), 'utf8')).sessionId
    tg.dm(OWNER, '/restart')
    await tg.waitFor(said(/Restarting this session/), 'restarting notice')
    const second = await until('a second start', () => starts()[1])
    expect(second.args).toContain(`--resume ${sid}`)
    const done = await tg.waitFor(said(/Restarted, same conversation resumed · plugin 9\.9\.9/), 'restarted notice', 15_000)
    expect(done.method).toBe('editMessageText')
  }, 30_000)

  test('a busy session asks first; "When done" waits for the reply to finish', async () => {
    setStatus('busy')
    await Bun.sleep(3500) // one router tick reads the status
    tg.dm(OWNER, '/restart')
    const ask = await tg.waitFor(said(/still replying/), 'question')
    const buttons = ask.body.reply_markup.inline_keyboard[0].map((b: { callback_data: string }) => b.callback_data)
    expect(buttons).toEqual(['restart:wait:main', 'restart:now:main'])
    tg.press(OWNER, 'restart:wait:main', ask.result.message_id)
    await tg.waitFor(said(/Restarting once Claude finishes/), 'waiting notice')
    await Bun.sleep(4000)
    expect(starts().length).toBe(1) // still busy: not restarted
    setStatus('idle')
    await until('a second start', () => starts()[1])
    await tg.waitFor(said(/Restarted, same conversation/), 'restarted notice', 15_000)
  }, 40_000)

  test('"Now" restarts a busy session at once, even one that ignores SIGTERM', async () => {
    setStatus('busy')
    writeFileSync(join(claudeDir, 'fake-ignore-term'), '')
    await Bun.sleep(3500)
    tg.dm(OWNER, '/restart')
    const ask = await tg.waitFor(said(/still replying/), 'question')
    tg.press(OWNER, 'restart:now:main', ask.result.message_id)
    await tg.waitFor(said(/Restarting this session/), 'restarting notice')
    rmSync(join(claudeDir, 'fake-ignore-term'))
    setStatus('idle')
    await until('a second start', () => starts()[1], 25_000)
    await tg.waitFor(said(/Restarted, same conversation/), 'restarted notice', 15_000)
  }, 45_000)

  test('a restarted session that keeps failing is not started again forever', async () => {
    writeFileSync(join(claudeDir, 'fake-crash'), '')
    tg.dm(OWNER, '/restart')
    await tg.waitFor(said(/Restarting this session/), 'restarting notice')
    await tg.waitFor(said(/keeps (crashing|exiting)|crash/i), 'crash-loop notice', 30_000)
    const n = starts().length
    await Bun.sleep(7000)
    expect(starts().length).toBe(n)
  }, 50_000)

  test('a question nobody answered does not block a new /restart', async () => {
    setStatus('busy')
    await Bun.sleep(3500)
    tg.dm(OWNER, '/restart')
    await tg.waitFor(said(/still replying/), 'question')
    setStatus('idle')
    await Bun.sleep(3500)
    tg.dm(OWNER, '/restart')
    await tg.waitFor(said(/Restarting this session/), 'restarting notice')
    await until('a second start', () => starts()[1])
  }, 30_000)

  test('editing an old message to /restart does not restart', async () => {
    tg.push({
      edited_message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        edit_date: Math.floor(Date.now() / 1000),
        chat: { id: OWNER, type: 'private' },
        from: { id: OWNER, is_bot: false, first_name: 'O' },
        text: '/restart',
      },
    })
    await Bun.sleep(4000)
    expect(starts().length).toBe(1)
    expect(tg.sent(/^send|^edit/).some(c => /Restarting/.test(String(c.body.text ?? '')))).toBe(false)
  }, 20_000)

  test('strangers cannot restart anything', async () => {
    tg.dm(STRANGER, '/restart')
    tg.press(STRANGER, 'restart:now:main', 1)
    await Bun.sleep(4000)
    expect(starts().length).toBe(1)
    expect(tg.sent(/^send|^edit/).some(c => String(c.body.chat_id) === String(STRANGER))).toBe(false)
  }, 20_000)
})

describe.skipIf(!HAS_TMUX)('plugin updates', () => {
  test('main restarts for a new plugin and says when it is back', async () => {
    setStatus('idle')
    // A router with short update timings and a main session of its own.
    await restartRouter({ TELEGRAM_ROUTER_UPDATE_CHECK_MS: '500', TELEGRAM_ROUTER_UPDATE_IDLE_MS: '0' }, () =>
      process.kill(starts()[0]!.pid, 'SIGKILL'),
    )
    await until('main to start again', () => starts()[1])
    const plugins = join(claudeDir, 'plugins')
    mkdirSync(plugins, { recursive: true })
    writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ plugins: { 'telegram@emoicu-plugins': [{ version: '9.9.10' }] } }))
    writeFileSync(join(claudeDir, 'fake-plugin'), '9.9.10')
    await tg.waitFor(said(/9\.9\.10 is installed\. Restarting this session/), 'updating notice', 15_000)
    await until('a start for the update', () => starts()[2])
    const back = await tg.waitFor(said(/Restarted, same conversation resumed · plugin 9\.9\.10/), 'back notice', 15_000)
    expect(back.body.disable_notification).toBe(false) // the phone rings
    await Bun.sleep(3000)
    expect(starts().length).toBe(3) // up to date now: not restarted again
  }, 40_000)
})

describe.skipIf(!HAS_TMUX)('carrying on after an interrupted turn', () => {
  const received = () => {
    try {
      return readFileSync(join(claudeDir, 'received.log'), 'utf8')
    } catch {
      return ''
    }
  }
  const resumes = () => received().split('\n').filter(l => l.includes('"resume"'))
  /** Kill the running fake Claude while it is busy, as a crash would. */
  async function killMidTurn(): Promise<void> {
    setStatus('busy')
    await Bun.sleep(3500) // one tick sees it busy
    process.kill(starts().at(-1)!.pid, 'SIGKILL')
    setStatus('idle')
  }

  test('a session killed mid-turn comes back and is asked to carry on', async () => {
    await killMidTurn()
    await tg.waitFor(said(/stopped unexpectedly while Claude was working/), 'interrupted notice')
    await until('a second start', () => starts()[1])
    await tg.waitFor(said(/picking up where it left off/), 'carrying-on notice', 15_000)
    const [line] = resumes()
    const msg = JSON.parse(line!).resume
    expect(msg.chat_id).toBe(String(OWNER))
    expect(msg.text).toContain('Message from the Telegram router, not from the user')
  }, 40_000)

  test('cut off again soon after carrying on: it does not carry on again', async () => {
    await killMidTurn()
    await tg.waitFor(said(/picking up where it left off/), 'carrying-on notice', 20_000)
    await killMidTurn()
    await tg.waitFor(said(/cut off again soon after it carried on/), 'no-carry-on notice', 20_000)
    await until('a third start', () => starts()[2])
    await Bun.sleep(4000)
    expect(resumes().length).toBe(1)
  }, 60_000)

  test('once the carried-on turn is over, a later interruption carries on again', async () => {
    await killMidTurn()
    await tg.waitFor(said(/picking up where it left off/), 'carrying-on notice', 20_000)
    setStatus('busy')
    await Bun.sleep(3500)
    setStatus('idle')
    await Bun.sleep(3500) // the carried-on turn finished
    await killMidTurn()
    await until('a second carry-on', () => resumes().length === 2, 20_000)
  }, 60_000)

  test('a session waiting for the user is not asked to carry on', async () => {
    setStatus('waiting')
    await Bun.sleep(3500)
    process.kill(starts()[0]!.pid, 'SIGKILL')
    setStatus('idle')
    await until('a second start', () => starts()[1])
    await Bun.sleep(4000)
    expect(resumes()).toEqual([])
  }, 30_000)

  test('an idle session that dies is not asked to carry on', async () => {
    process.kill(starts()[0]!.pid, 'SIGKILL')
    await until('a second start', () => starts()[1])
    await Bun.sleep(4000)
    expect(resumes()).toEqual([])
    expect(tg.sent(/^send/).some(c => /stopped unexpectedly/.test(String(c.body.text)))).toBe(false)
  }, 30_000)

  test('a session whose plugin cannot carry on: the user is told to nudge it', async () => {
    writeFileSync(join(claudeDir, 'fake-no-resume'), '')
    await killMidTurn()
    await tg.waitFor(said(/too old to carry on by itself/), 'unsupported notice', 20_000)
    expect(resumes()).toEqual([])
  }, 40_000)
})

describe.skipIf(!HAS_TMUX)('commands for other bots', () => {
  test('/sessions and /restart addressed to another bot are ignored', async () => {
    tg.dm(OWNER, '/sessions@otherbot')
    tg.dm(OWNER, '/restart@otherbot')
    await Bun.sleep(4000)
    expect(tg.sent(/^send|^edit/).filter(c => String(c.body.chat_id) === String(OWNER))).toEqual([])
    expect(starts().length).toBe(1)
    tg.dm(OWNER, '/sessions@test_bot')
    await tg.waitFor(c => c.method === 'sendRichMessage' && String(c.body.chat_id) === String(OWNER), 'sessions report')
  }, 20_000)
})

describe.skipIf(!HAS_TMUX)('topics', () => {
  test('the same topic number in two groups gets two sessions', async () => {
    allowGroups()
    topicMessage(GROUP, 5, OWNER, 'hello from group one')
    await until('the first topic session', () => starts()[1])
    topicMessage(GROUP2, 5, OWNER, 'hello from group two')
    await until('the second topic session', () => starts()[2])
    await Bun.sleep(1000)
    topicMessage(GROUP2, 5, OWNER, 'again from group two')
    await Bun.sleep(3500)
    expect(starts().length).toBe(3)
    const topics = savedSlots().filter(s => s.name !== 'main')
    // The first keeps the name older routers used; the other is told apart by its group.
    expect(topics).toEqual([
      expect.objectContaining({ name: 't5', chat: String(GROUP), thread: 5 }),
      expect.objectContaining({ name: 't5-3210', chat: String(GROUP2), thread: 5 }),
    ])
    const texts = (pid: number) => receivedBy(pid).map(l => l.update?.message?.text)
    expect(texts(starts()[1]!.pid)).toEqual(['hello from group one'])
    expect(texts(starts()[2]!.pid)).toEqual(['hello from group two', 'again from group two'])
  }, 40_000)

  test('a failing start backs off, is announced once, and the chat is told once', async () => {
    allowGroups()
    tmux('kill-server') // every new tmux window now fails
    topicMessage(GROUP, 9, OWNER, 'start please')
    const inTopic = () => tg.sent('sendMessage').filter(c => String(c.body.chat_id) === String(GROUP) && c.body.message_thread_id === 9)
    await tg.waitFor(c => inTopic().includes(c) && /tmux failed/.test(textOf(c)), 'start-failed notice', 30_000)
    await Bun.sleep(7000)
    expect(inTopic().map(textOf)).toEqual([expect.stringMatching(/Starting a new session/), expect.stringMatching(/tmux failed/)])
  }, 50_000)

  test('at capacity, only one idle session is stopped to make room', async () => {
    allowGroups()
    await restartRouter({ TELEGRAM_ROUTER_MAX: '3', TELEGRAM_ROUTER_RESERVE_MB: '0', TELEGRAM_ROUTER_SESSION_MB: '1' })
    topicMessage(GROUP, 1, OWNER, 'one')
    await until('topic 1', () => starts()[1])
    topicMessage(GROUP, 2, OWNER, 'two')
    await until('topic 2', () => starts()[2])
    await Bun.sleep(3500) // a tick reads both as idle
    writeFileSync(join(claudeDir, 'fake-ignore-term'), '') // the victim takes its time to exit
    topicMessage(GROUP, 3, OWNER, 'three')
    await until('a session stopped to make room', () => terms().length === 1)
    topicMessage(GROUP, 3, OWNER, 'three again')
    await Bun.sleep(7000)
    expect(terms()).toEqual([String(starts()[1]!.pid)])
    expect(starts().length).toBe(3)
  }, 50_000)

  test('a poll vote wakes a stopped topic session only for a voter who may use it', async () => {
    allowGroups()
    await restartRouter({}, () => {
      writeFileSync(slotsFile(), JSON.stringify([...savedSlots(), { name: 't7', chat: String(GROUP), thread: 7, cwd: dir, lastActive: Date.now() }]))
      const poll = { chat: String(GROUP), id: 1, question: 'q', options: ['a', 'b'], multiple: false, at: Date.now() }
      writeFileSync(join(dir, 'polls-t7.json'), JSON.stringify({ p1: poll }))
    })
    const vote = (user: number) =>
      tg.push({ poll_answer: { poll_id: 'p1', user: { id: user, is_bot: false, first_name: 'U' }, option_ids: [0] } })
    vote(STRANGER)
    await Bun.sleep(4000)
    expect(starts().length).toBe(1)
    vote(OWNER)
    const topic = await until('topic 7 to start', () => starts()[1])
    const got = await until('the vote to arrive', () => receivedBy(topic.pid).find(l => l.update?.poll_answer))
    expect(got.update.poll_answer.user.id).toBe(OWNER)
  }, 30_000)
})

describe.skipIf(!HAS_TMUX)('delivery', () => {
  test('a message sent while the session is restarting goes to the new process', async () => {
    writeFileSync(join(claudeDir, 'fake-ignore-term'), '') // exits only when killed, 15 s later
    tg.dm(OWNER, '/restart')
    await tg.waitFor(said(/Restarting this session/), 'restarting notice')
    await until('the old process to get SIGTERM', () => terms().length === 1)
    tg.dm(OWNER, 'sent while restarting')
    rmSync(join(claudeDir, 'fake-ignore-term'))
    const second = await until('a second start', () => starts()[1], 25_000)
    const texts = (pid: number) => receivedBy(pid).map(l => l.update?.message?.text)
    await until('the message at the new process', () => texts(second.pid).includes('sent while restarting'))
    expect(texts(starts()[0]!.pid)).not.toContain('sent while restarting')
  }, 45_000)

  test('large updates with multi-byte text arrive whole', async () => {
    const big = `${'é'.repeat(1_000_000)}END`
    tg.dm(OWNER, big)
    const pid = starts()[0]!.pid
    const line = await until('the big update', () => receivedBy(pid).find(l => l.update?.message?.text?.endsWith('END')), 20_000)
    expect(line.update.message.text).toBe(big)
  }, 30_000)

  test('a hello split across reads, inside a character, is understood', async () => {
    writeFileSync(join(claudeDir, 'fake-split-hello'), '')
    tg.dm(OWNER, '/restart')
    await tg.waitFor(said(/Restarted, same conversation resumed · plugin 9\.9\.9-ü/), 'restarted notice', 20_000)
  }, 30_000)

  test('a stranger does not revive a session given up on; the owner does', async () => {
    writeFileSync(join(claudeDir, 'fake-crash'), '')
    tg.dm(OWNER, '/restart')
    await tg.waitFor(said(/keeps (crashing|exiting)|crash/i), 'crash-loop notice', 30_000)
    const n = starts().length
    tg.dm(STRANGER, 'hello')
    await Bun.sleep(5000)
    expect(starts().length).toBe(n)
    tg.dm(OWNER, 'hello')
    await until('a start after the owner wrote', () => starts().length > n)
  }, 50_000)
})
