import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Subprocess, spawn } from 'bun'
import { parseEnv, SUPERVISOR_VERSION, versionOf } from '../service/supervisor'
import { FakeTelegram } from './harness'

// The service's supervisor and launcher end to end: fake plugin versions
// whose router.ts is test/fake-router.ts, a fake Bot API for the notices, and
// a private tmux server.

const OWNER = '1111'
const HAS_TMUX = !!Bun.which('tmux')
const SOURCE = join(import.meta.dir, '..', 'service')
const SESSION = 'sup'

let tg: FakeTelegram
let dir: string
let svc: string
const procs: Subprocess[] = []

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: dir,
    TMUX_TMPDIR: dir,
    CLAUDE_CONFIG_DIR: join(dir, 'claude'),
    TELEGRAM_STATE_DIR: join(dir, 'state'),
    TELEGRAM_API_ROOT: tg.url,
    TELEGRAM_ROUTER_TMUX: SESSION,
    TELEGRAM_SUPERVISOR_QUICK_SECS: '1',
    TELEGRAM_SUPERVISOR_POLL_MS: '100',
    TELEGRAM_SUPERVISOR_PAUSE_MS: '100',
    TELEGRAM_LAUNCHER_PAUSE_SECS: '0',
    ...extra,
  }
}

/** A plugin version directory with the fake router in it. */
function version(name: string, opts: { crash?: boolean; supervisor?: string } = {}): string {
  const root = join(dir, 'plugins', name)
  mkdirSync(join(root, 'service'), { recursive: true })
  copyFileSync(join(import.meta.dir, 'fake-router.ts'), join(root, 'router.ts'))
  if (opts.crash) writeFileSync(join(root, 'crash'), '')
  if (opts.supervisor) writeFileSync(join(root, 'service', 'supervisor.ts'), opts.supervisor)
  return root
}

function install(root: string): void {
  writeFileSync(
    join(dir, 'claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'telegram@emoicu-plugins': [{ scope: 'user', installPath: root }] } }),
  )
}

const runs = () => {
  try {
    return readFileSync(join(dir, 'claude', 'runs.log'), 'utf8').trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const notices = () => tg.sent('sendMessage').map(c => String(c.body.text))

async function until<T>(what: string, f: () => T | undefined | false, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = f()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; runs: ${runs().join(' | ')}; log: ${read(join(svc, 'supervisor.log'))}`)
    await Bun.sleep(50)
  }
}

function run(cmd: string[], extra: Record<string, string> = {}): Subprocess {
  const p = spawn(cmd, { env: env(extra), stdout: 'ignore', stderr: 'ignore' })
  procs.push(p)
  return p
}
const supervisor = (extra: Record<string, string> = {}) => run(['bun', join(svc, 'supervisor.ts')], extra)
const launcher = (extra: Record<string, string> = {}) => run(['bash', join(svc, 'launcher.sh')], extra)

beforeEach(() => {
  if (!HAS_TMUX) return
  tg = new FakeTelegram()
  dir = mkdtempSync(join(tmpdir(), 'tg-sup-'))
  svc = join(dir, 'state', 'service')
  mkdirSync(join(dir, 'claude', 'plugins'), { recursive: true })
  mkdirSync(svc, { recursive: true })
  mkdirSync(join(dir, 'work'))
  writeFileSync(join(dir, 'state', '.env'), `TELEGRAM_BOT_TOKEN=123456:${'x'.repeat(35)}\nTELEGRAM_ROUTER_MAIN_CWD=${join(dir, 'work')}\n`)
  writeFileSync(join(dir, 'state', 'access.json'), JSON.stringify({ allowFrom: [OWNER], groups: {} }))
  copyFileSync(join(SOURCE, 'supervisor.ts'), join(svc, 'supervisor.ts'))
  copyFileSync(join(SOURCE, 'launcher.sh'), join(svc, 'launcher.sh'))
})

afterEach(async () => {
  if (!HAS_TMUX) return
  // The launcher's supervisor and the routers outlive a killed launcher.
  Bun.spawnSync(['pkill', '-f', dir])
  for (const p of procs.splice(0)) p.kill()
  Bun.spawnSync(['tmux', 'kill-server'], { env: env() })
  tg.stop()
  rmSync(dir, { recursive: true, force: true })
}, 10_000)

describe('supervisor helpers', () => {
  test('versionOf reads the version of a copy', () => {
    expect(versionOf(read(join(SOURCE, 'supervisor.ts')))).toBe(SUPERVISOR_VERSION)
    expect(versionOf('nothing here')).toBeUndefined()
  })
  test('parseEnv reads KEY=value lines', () => {
    expect(parseEnv('A=1\n# note\nB=x=y\n\nbad line')).toEqual({ A: '1', B: 'x=y' })
  })
})

describe.skipIf(!HAS_TMUX)('supervisor', () => {
  test('runs the installed router in the working directory and moves to a newer version', async () => {
    const v1 = version('v1')
    install(v1)
    supervisor()
    await until('v1 to run', () => runs().includes(`v1 self=1 cwd=${join(dir, 'work')} tmux=${SESSION}`))
    // It made the tmux session the router opens its windows in.
    expect(Bun.spawnSync(['tmux', 'has-session', '-t', SESSION], { env: env() }).exitCode).toBe(0)
    await Bun.sleep(1200) // longer than QUICK_SECS: v1 counts as good
    install(version('v2'))
    await until('v2 to run', () => runs().some(r => r.startsWith('v2 self=1')))
    expect(read(join(svc, 'router-good'))).toBe(v1)
  }, 20_000)

  test('goes back to the last good version after three quick crashes, tells the user, and moves on to a fix', async () => {
    const v1 = version('v1')
    writeFileSync(join(svc, 'router-good'), v1)
    install(version('v2', { crash: true }))
    supervisor()
    await until('v1 to run as the fallback', () => runs().includes(`v1 self= cwd=${join(dir, 'work')} tmux=${SESSION}`))
    expect(runs().filter(r => r.startsWith('v2')).length).toBe(3)
    await until('the notice', () => notices().some(t => t.includes('v2') && t.includes('v1')))
    install(version('v3'))
    await until('v3 to run', () => runs().some(r => r.startsWith('v3 self=1')))
  }, 30_000)

  test('does not start beside a running router', async () => {
    install(version('v1'))
    const sock = Bun.listen({ unix: join(dir, 'state', 'router.sock'), socket: { data() {} } })
    try {
      expect(await supervisor().exited).toBe(75)
      expect(runs()).toEqual([])
      await until('the notice', () => notices().some(t => t.includes('already running')))
    } finally {
      sock.stop(true)
    }
  })

  test('does not start beside another supervisor', async () => {
    install(version('v1'))
    supervisor()
    await until('v1 to run', () => runs().length === 1)
    expect(await supervisor().exited).toBe(75)
    expect(runs().length).toBe(1)
  })
})

describe.skipIf(!HAS_TMUX)('updating the supervisor', () => {
  const source = () => read(join(SOURCE, 'supervisor.ts'))
  const bumped = (n: number) => source().replace(/SUPERVISOR_VERSION = \d+/, `SUPERVISOR_VERSION = ${n}`)

  test('takes a newer copy once the router has run long enough, and restarts with it', async () => {
    install(version('v1', { supervisor: bumped(SUPERVISOR_VERSION + 1) }))
    launcher({ TELEGRAM_SUPERVISOR_STABLE_SECS: '1' })
    await until('the new supervisor to start', () => read(join(svc, 'supervisor.log')).includes(`supervisor ${SUPERVISOR_VERSION + 1} up`))
    expect(versionOf(read(join(svc, 'supervisor.ts')))).toBe(SUPERVISOR_VERSION + 1)
    expect(versionOf(read(join(svc, 'supervisor.prev.ts')))).toBe(SUPERVISOR_VERSION)
    await until('the router to run again', () => runs().length === 2)
  }, 20_000)

  test('the launcher puts the previous copy back when a new one keeps failing, and it is not taken again', async () => {
    const broken = SUPERVISOR_VERSION + 1
    writeFileSync(join(svc, 'supervisor.prev.ts'), read(join(svc, 'supervisor.ts')))
    writeFileSync(join(svc, 'supervisor.ts'), `export const SUPERVISOR_VERSION = ${broken}\nprocess.exit(1)\n`)
    // The plugin still ships the broken copy.
    install(version('v1', { supervisor: `export const SUPERVISOR_VERSION = ${broken}\nprocess.exit(1)\n` }))
    launcher({ TELEGRAM_SUPERVISOR_STABLE_SECS: '1' })
    await until('the previous copy to run', () => runs().length >= 1)
    expect(versionOf(read(join(svc, 'supervisor.ts')))).toBe(SUPERVISOR_VERSION)
    expect(read(join(svc, 'supervisor.bad')).trim()).toBe(String(broken))
    await until('the notice', () => notices().some(t => t.includes('put back')))
    expect(existsSync(join(svc, 'supervisor.restored'))).toBe(false)
    // Past STABLE_SECS it does not take the broken copy again.
    await Bun.sleep(1500)
    expect(versionOf(read(join(svc, 'supervisor.ts')))).toBe(SUPERVISOR_VERSION)
    expect(runs().length).toBe(1)
  }, 20_000)
})
