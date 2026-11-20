// The job lock of helpers/tmux-session-helper.ts (no tmux needed).
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'session-helper-test-'))
// Keep the helper's own state (log, language) away from the real one.
process.env.TELEGRAM_STATE_DIR = dir
const { acquireLock, releaseLock } = await import('../helpers/tmux-session-helper.ts')

let n = 0
const lockFile = () => join(dir, `lock-${n++}.lock`)

/** A pid that no longer runs. */
async function deadPid(): Promise<number> {
  const proc = Bun.spawn(['true'])
  await proc.exited
  return proc.pid
}

/** A process other than this one that keeps running until killed. */
function otherProcess() {
  return Bun.spawn(['sleep', '30'])
}

describe('session helper lock', () => {
  test('is taken once and holds the pid of its job', () => {
    const file = lockFile()
    expect(acquireLock(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(String(process.pid))
    expect(acquireLock(file)).toBe(false)
    releaseLock(file)
    expect(existsSync(file)).toBe(false)
  })

  test('a lock held by a running job is never stale, however old', async () => {
    const other = otherProcess()
    try {
      const file = lockFile()
      writeFileSync(file, String(other.pid))
      const old = (Date.now() - 60 * 60_000) / 1000
      utimesSync(file, old, old)
      expect(acquireLock(file)).toBe(false)
      // Not ours, so it is not released either.
      releaseLock(file)
      expect(readFileSync(file, 'utf8')).toBe(String(other.pid))
    } finally {
      other.kill()
      await other.exited
    }
  })

  test('a lock left by a job that died is taken over at once', async () => {
    const file = lockFile()
    writeFileSync(file, String(await deadPid()))
    expect(acquireLock(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(String(process.pid))
  })

  test('a lock without a pid is being taken, unless it is old', () => {
    const file = lockFile()
    writeFileSync(file, '')
    expect(acquireLock(file)).toBe(false)
    const old = (Date.now() - 2 * 60_000) / 1000
    utimesSync(file, old, old)
    expect(acquireLock(file)).toBe(true)
  })
})
