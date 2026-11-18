import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger, errText, formatLine, parseLevel, redact } from './log'

const at = new Date('2026-11-18T10:00:00.000Z')

function capture(level?: Parameters<typeof parseLevel>[1], file?: string, maxBytes?: number) {
  const lines: string[] = []
  const log = createLogger('telegram', { level, file, maxBytes, write: l => lines.push(l), now: () => at })
  return { log, lines }
}

describe('parseLevel', () => {
  test('accepts known names in any case', () => {
    expect(parseLevel('DEBUG')).toBe('debug')
    expect(parseLevel(' warn ')).toBe('warn')
  })
  test('falls back on unknown or missing values', () => {
    expect(parseLevel(undefined)).toBe('info')
    expect(parseLevel('verbose', 'error')).toBe('error')
  })
})

describe('errText', () => {
  test('includes the error code when there is one', () => {
    const err = Object.assign(new Error('no such file'), { code: 'ENOENT' })
    expect(errText(err)).toBe('no such file (ENOENT)')
  })
  test('keeps the name of special error types', () => {
    expect(errText(new TypeError('bad'))).toBe('TypeError: bad')
  })
  test('handles non-errors', () => {
    expect(errText('plain')).toBe('plain')
  })
})

describe('redact', () => {
  test('hides bot tokens', () => {
    const token = `123456789:${'A'.repeat(35)}`
    expect(redact(`url /bot${token}/getMe`)).toBe('url /bot<redacted-token>/getMe')
  })
  test('leaves ordinary numbers alone', () => {
    expect(redact('chat 1234567890 message 42')).toBe('chat 1234567890 message 42')
  })
})

describe('formatLine', () => {
  test('has time, padded level, prefix, message and error', () => {
    expect(formatLine(at, 'telegram', 'warn', 'save failed', new Error('disk full'))).toBe(
      '2026-11-18T10:00:00.000Z WARN  telegram: save failed: disk full',
    )
  })
  test('keeps each entry on one line', () => {
    expect(formatLine(at, 'p', 'info', 'a\nb')).toBe('2026-11-18T10:00:00.000Z INFO  p: a\\nb')
  })
})

describe('createLogger', () => {
  test('drops lines below the level', () => {
    const { log, lines } = capture('warn')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(lines.map(l => l.split(' ')[1])).toEqual(['WARN', 'ERROR'])
  })
  test('defaults to info', () => {
    const { log, lines } = capture()
    log.debug('hidden')
    log.info('shown')
    expect(lines).toHaveLength(1)
    expect(log.level).toBe('info')
  })
  test('child loggers extend the prefix', () => {
    const { log, lines } = capture()
    log.child('router').info('up')
    expect(lines[0]).toContain(' telegram/router: up')
  })
  test('appends to a file and rotates it when too big', () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-test-'))
    const file = join(dir, 'sub', 'telegram.log')
    const { log } = capture('info', file, 100)
    log.info('first')
    expect(readFileSync(file, 'utf8')).toContain('first')
    writeFileSync(file, 'x'.repeat(200))
    log.info('second')
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('x'.repeat(200))
    expect(readFileSync(file, 'utf8')).toContain('second')
  })
  test('never throws when the file cannot be written', () => {
    const { log, lines } = capture('info', '/proc/definitely/not/writable.log')
    expect(() => log.error('still fine')).not.toThrow()
    expect(lines).toHaveLength(1)
  })
})
