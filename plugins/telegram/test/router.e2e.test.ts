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
    LANG: 'C.UTF-8', // without it tmux escapes the tabs in its -F output
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

  test('strangers cannot restart anything', async () => {
    tg.dm(STRANGER, '/restart')
    tg.press(STRANGER, 'restart:now:main', 1)
    await Bun.sleep(4000)
    expect(starts().length).toBe(1)
    expect(tg.sent(/^send|^edit/).some(c => String(c.body.chat_id) === String(STRANGER))).toBe(false)
  }, 20_000)
})
