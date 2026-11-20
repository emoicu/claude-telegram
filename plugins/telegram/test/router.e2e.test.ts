import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  router = spawn(['bun', join(import.meta.dir, '..', 'router.ts')], { env: env(), stdout: 'ignore', stderr: Bun.file(join(dir, 'router.err')) })
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
