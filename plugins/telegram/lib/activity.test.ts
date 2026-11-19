import { describe, expect, test } from 'bun:test'
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ACTIVITY_STALE_MS, type ActivityEvent, parseActivity, readActivity, recordEvent, stopRequested, summarize } from './activity'

const ev = (t: number, e: ActivityEvent['e'], label?: string): ActivityEvent => ({ t, e, ...(label ? { label } : {}) })

describe('summarize', () => {
  test('a running turn counts its tools and shows the latest', () => {
    const s = summarize([ev(1, 'start'), ev(2, 'tool', 'Reading a.ts'), ev(3, 'tool_failed'), ev(4, 'tool', 'Running: ls')], 10)
    expect(s).toEqual({ busy: true, since: 1, steps: 2, failed: 1, current: 'Running: ls', last: 4 })
  })
  test('a turn that said Stop is over', () => {
    expect(summarize([ev(1, 'start'), ev(2, 'tool', 'x'), ev(3, 'stop')], 10).busy).toBe(false)
  })
  test('without a start event the turn begins after the last stop', () => {
    const s = summarize([ev(1, 'tool', 'old'), ev(2, 'stop'), ev(5, 'tool', 'new')], 10)
    expect(s).toMatchObject({ busy: true, since: 5, steps: 1, current: 'new' })
  })
  test('a turn silent for too long is over (a crash never says Stop)', () => {
    expect(summarize([ev(0, 'start')], ACTIVITY_STALE_MS + 1).busy).toBe(false)
  })
  test('no events: idle', () => {
    expect(summarize([], 10)).toMatchObject({ busy: false, steps: 0 })
  })
})

describe('parseActivity', () => {
  test('skips broken lines', () => {
    expect(parseActivity('{"t":1,"e":"start"}\n{"t":2,"e":\n\n{"x":1}\n')).toEqual([ev(1, 'start')])
  })
})

describe('recordEvent and readActivity', () => {
  test('a start clears earlier turns', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'activity-')), 'activity', 'main.jsonl')
    const now = Date.now()
    recordEvent(file, ev(now - 3, 'tool', 'old'))
    recordEvent(file, ev(now - 2, 'start'))
    recordEvent(file, ev(now - 1, 'tool', 'new'))
    expect(readActivity(file, now)).toMatchObject({ busy: true, steps: 1, current: 'new' })
  })
  test('a missing or stale file reads as nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'activity-'))
    expect(readActivity(join(dir, 'none.jsonl'), Date.now())).toBeUndefined()
    const file = join(dir, 'old.jsonl')
    writeFileSync(file, '{"t":1,"e":"start"}\n')
    const old = (Date.now() - ACTIVITY_STALE_MS - 60_000) / 1000
    utimesSync(file, old, old)
    expect(readActivity(file, Date.now())).toBeUndefined()
  })
})

describe('stopRequested', () => {
  const turn = summarize([ev(10_000, 'start'), ev(11_000, 'tool', 'x')], 12_000)
  test('a flag set during the turn stops it', () => {
    expect(stopRequested(11_500, turn)).toBe(true)
  })
  test('a flag from before the turn does not', () => {
    expect(stopRequested(5_000, turn)).toBe(false)
  })
  test('no flag, no stop', () => {
    expect(stopRequested(undefined, turn)).toBe(false)
  })
})
