import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { isAlive, procState } from './proc'

describe('procState', () => {
  test('reads the state after the command name, even with spaces and parentheses', () => {
    expect(procState('1234 (claude) S 1 2 3')).toBe('S')
    expect(procState('1234 (weird) name)) Z 1 2 3')).toBe('Z')
    expect(procState('garbage')).toBeUndefined()
  })
})

describe('isAlive', () => {
  test('a running process is alive, a missing pid is not', () => {
    expect(isAlive(process.pid)).toBe(true)
    expect(isAlive(undefined)).toBe(false)
    expect(isAlive(2 ** 22 + 12345)).toBe(false)
  })

  test('a zombie counts as gone', () => {
    expect(isAlive(process.pid, () => `${process.pid} (claude) Z 1`)).toBe(false)
  })

  test('without /proc the signal check decides', () => {
    expect(
      isAlive(process.pid, () => {
        throw new Error('no /proc')
      }),
    ).toBe(true)
  })

  test.skipIf(!existsSync('/proc/self/stat'))('a real zombie process counts as gone', async () => {
    // sh starts `true` in the background, prints its pid, then becomes sleep,
    // which never collects it: `true` stays a zombie until sleep ends.
    const proc = Bun.spawn(['sh', '-c', 'true & echo $!; exec sleep 3'], { stdout: 'pipe' })
    const reader = proc.stdout.getReader()
    const { value } = await reader.read()
    const pid = Number(new TextDecoder().decode(value).trim())
    await Bun.sleep(300)
    expect(() => process.kill(pid, 0)).not.toThrow() // the old check said "alive"
    expect(isAlive(pid)).toBe(false)
    proc.kill()
  })
})
