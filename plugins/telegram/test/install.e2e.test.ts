// scripts/install.sh in a throwaway HOME, with a stub `claude` that records
// its arguments and the fake Bot API answering getMe.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { FakeTelegram } from './harness'

const SCRIPT = join(import.meta.dir, '..', '..', '..', 'scripts', 'install.sh')
const TOKEN = `123456789:${'A'.repeat(35)}`

let tg: FakeTelegram
let home: string

beforeEach(() => {
  tg = new FakeTelegram()
  home = mkdtempSync(join(tmpdir(), 'tg-install-'))
  const bin = join(home, 'stub-bin')
  mkdirSync(bin)
  // `claude plugin list` answers from a file so a test can pretend a plugin is installed.
  writeFileSync(
    join(bin, 'claude'),
    `#!/usr/bin/env bash
echo "$*" >> "$HOME/claude-calls.log"
case "$*" in
  --version) echo "9.9.9 (Claude Code)" ;;
  "plugin list") cat "$HOME/plugin-list.txt" 2>/dev/null ;;
  "plugin marketplace list") cat "$HOME/marketplace-list.txt" 2>/dev/null ;;
esac
`,
  )
  chmodSync(join(bin, 'claude'), 0o755)
})

afterEach(() => {
  tg.stop()
  rmSync(home, { recursive: true, force: true })
})

async function install(env: Record<string, string> = {}) {
  const proc = Bun.spawn(['bash', SCRIPT], {
    env: {
      HOME: home,
      PATH: `${join(home, 'stub-bin')}:${dirname(process.execPath)}:/usr/bin:/bin`,
      TELEGRAM_API_ROOT: tg.url,
      ...env,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  const calls = existsSync(join(home, 'claude-calls.log')) ? readFileSync(join(home, 'claude-calls.log'), 'utf8').trim().split('\n') : []
  return { out: out + err, code, calls }
}

const envFile = () => join(home, '.claude', 'channels', 'telegram', '.env')

describe('install.sh', () => {
  test('fresh install: plugin, checked token, launcher', async () => {
    const r = await install({ TELEGRAM_BOT_TOKEN: TOKEN })
    expect(r.code).toBe(0)
    expect(r.calls).toContain('plugin marketplace add emoicu/claude-telegram')
    expect(r.calls).toContain('plugin install telegram@emoicu-plugins')
    expect(tg.sent('getMe')).toHaveLength(1)
    expect(r.out).toContain('Token works: @test_bot')
    expect(readFileSync(envFile(), 'utf8')).toBe(`TELEGRAM_BOT_TOKEN=${TOKEN}\n`)
    expect(statSync(envFile()).mode & 0o777).toBe(0o600)
    const launcher = join(home, '.local', 'bin', 'claude-telegram')
    expect(readFileSync(launcher, 'utf8')).toContain('--dangerously-load-development-channels plugin:telegram@emoicu-plugins')
    expect(r.out).not.toContain(TOKEN)
  })

  test('re-run: updates instead of installing, keeps other settings, disables the official plugin', async () => {
    writeFileSync(join(home, 'marketplace-list.txt'), '  ❯ emoicu-plugins\n')
    writeFileSync(
      join(home, 'plugin-list.txt'),
      '  ❯ telegram@claude-plugins-official\n    Version: 0.0.7\n    Scope: user\n    Status: ✔ enabled\n  ❯ telegram@emoicu-plugins\n    Version: 1.0.0\n    Scope: user\n    Status: ✔ enabled\n',
    )
    mkdirSync(dirname(envFile()), { recursive: true })
    const oldToken = '111:old'
    writeFileSync(envFile(), `TELEGRAM_BOT_TOKEN=${oldToken}\nTELEGRAM_STATUS=off\n`, { mode: 0o644 })
    const r = await install({ TELEGRAM_BOT_TOKEN: TOKEN })
    expect(r.code).toBe(0)
    expect(r.calls).toContain('plugin marketplace update emoicu-plugins')
    expect(r.calls).toContain('plugin update telegram@emoicu-plugins')
    expect(r.calls).not.toContain('plugin install telegram@emoicu-plugins')
    expect(r.calls).toContain('plugin disable telegram@claude-plugins-official')
    expect(readFileSync(envFile(), 'utf8')).toBe(`TELEGRAM_STATUS=off\nTELEGRAM_BOT_TOKEN=${TOKEN}\n`)
    expect(statSync(envFile()).mode & 0o777).toBe(0o600)
  })

  test('keeps a saved token when none is given', async () => {
    mkdirSync(dirname(envFile()), { recursive: true })
    writeFileSync(envFile(), `TELEGRAM_BOT_TOKEN=${TOKEN}\n`, { mode: 0o600 })
    const r = await install()
    expect(r.code).toBe(0)
    expect(r.out).toContain('Already saved')
    expect(tg.sent('getMe')).toHaveLength(0)
  })

  test('refuses a malformed or rejected token and saves nothing', async () => {
    let r = await install({ TELEGRAM_BOT_TOKEN: 'not-a-token' })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('does not look like a bot token')
    tg.failNext('getMe', { error_code: 401, description: 'Unauthorized' })
    r = await install({ TELEGRAM_BOT_TOKEN: TOKEN })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('Telegram rejected the token')
    expect(existsSync(envFile())).toBe(false)
  })

  test('without Claude Code it stops before touching anything', async () => {
    rmSync(join(home, 'stub-bin', 'claude'))
    const r = await install({ TELEGRAM_BOT_TOKEN: TOKEN })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('Claude Code not found')
    expect(existsSync(join(home, '.claude'))).toBe(false)
  })
})
