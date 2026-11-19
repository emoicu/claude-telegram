import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cancelScheduled,
  deliverDue,
  describeScheduled,
  listScheduled,
  MAX_FAILURES,
  nextRun,
  parseWhen,
  type Scheduled,
  saveScheduled,
} from './schedule'

const NOW = Date.parse('2026-11-19T03:00:00Z')
const DAY = 86400_000
const tmp = () => mkdtempSync(join(tmpdir(), 'schedule-test-'))
const msg = (over: Partial<Scheduled> = {}): Scheduled => ({
  id: 'abcd1',
  chat_id: '42',
  text: 'Renew the VPS',
  at: NOW,
  created: NOW - 1000,
  ...over,
})

describe('parseWhen', () => {
  test('reads ISO with a zone, Unix seconds and relative times', () => {
    expect(parseWhen('2026-11-20T08:00:00+08:00', NOW)).toBe(Date.parse('2026-11-20T00:00:00Z'))
    expect(parseWhen(String(NOW / 1000 + 60), NOW)).toBe(NOW + 60_000)
    const rel = parseWhen('now+30m', Date.now())
    expect(typeof rel === 'number' && Math.abs(rel - (Date.now() + 30 * 60_000)) < 2000).toBe(true)
  })
  test('rejects the past, far future and nonsense', () => {
    expect(parseWhen('2026-11-18T00:00:00Z', NOW)).toContain('in the past')
    expect(parseWhen('2028-01-01T00:00:00Z', NOW)).toBe('at most a year ahead')
    expect(parseWhen('tomorrow', NOW)).toContain('cannot read')
  })
  test('a time a few seconds ago means now', () => {
    expect(parseWhen(new Date(NOW - 5000).toISOString(), NOW)).toBe(NOW)
  })
})

describe('nextRun', () => {
  test('one-off messages do not repeat', () => {
    expect(nextRun(msg(), NOW)).toBeUndefined()
  })
  test('daily and weekly keep their time of day and skip missed runs', () => {
    expect(nextRun(msg({ repeat: 'daily' }), NOW)).toBe(NOW + DAY)
    expect(nextRun(msg({ repeat: 'daily' }), NOW + 3.5 * DAY)).toBe(NOW + 4 * DAY)
    expect(nextRun(msg({ repeat: 'weekly' }), NOW)).toBe(NOW + 7 * DAY)
  })
})

describe('store', () => {
  test('save, list in time order, cancel', () => {
    const dir = tmp()
    saveScheduled(dir, msg({ id: 'late1', at: NOW + 2000 }))
    saveScheduled(dir, msg({ id: 'soon1', at: NOW + 1000 }))
    expect(listScheduled(dir).map(s => s.id)).toEqual(['soon1', 'late1'])
    expect(cancelScheduled(dir, 'soon1')).toBe(true)
    expect(cancelScheduled(dir, 'soon1')).toBe(false)
    expect(cancelScheduled(dir, '../escape')).toBe(false)
    expect(listScheduled(dir).map(s => s.id)).toEqual(['late1'])
  })
  test('a missing directory or a broken file reads as nothing', () => {
    expect(listScheduled(join(tmp(), 'nope'))).toEqual([])
    const dir = tmp()
    writeFileSync(join(dir, 'bad1.json'), '{oops')
    expect(listScheduled(dir)).toEqual([])
  })
})

describe('deliverDue', () => {
  const ok = () => {
    const sent: string[] = []
    return { sent, send: async (s: Scheduled) => void sent.push(s.id) }
  }
  test('sends due messages once and removes one-off ones', async () => {
    const dir = tmp()
    saveScheduled(dir, msg({ id: 'due01' }))
    saveScheduled(dir, msg({ id: 'later', at: NOW + 60_000 }))
    const { sent, send } = ok()
    expect(await deliverDue(dir, NOW, send, () => true)).toBe(1)
    expect(await deliverDue(dir, NOW, send, () => true)).toBe(0)
    expect(sent).toEqual(['due01'])
    expect(listScheduled(dir).map(s => s.id)).toEqual(['later'])
    expect(readdirSync(dir).filter(n => n.startsWith('.'))).toEqual([])
  })
  test('repeating messages come back for their next run', async () => {
    const dir = tmp()
    saveScheduled(dir, msg({ repeat: 'daily' }))
    await deliverDue(dir, NOW, ok().send, () => true)
    expect(listScheduled(dir)[0]!.at).toBe(NOW + DAY)
  })
  test('failures are retried, then dropped', async () => {
    const dir = tmp()
    saveScheduled(dir, msg())
    const errors: string[] = []
    const fail = async () => {
      throw new Error('network')
    }
    let t = NOW
    for (let i = 0; i < MAX_FAILURES; i++) {
      await deliverDue(dir, t, fail, () => true, w => errors.push(w))
      t += 61_000
    }
    expect(errors).toHaveLength(MAX_FAILURES)
    expect(listScheduled(dir)).toEqual([])
  })
  test('chats that are no longer allowed get nothing', async () => {
    const dir = tmp()
    saveScheduled(dir, msg())
    const { sent, send } = ok()
    await deliverDue(dir, NOW, send, () => false)
    expect(sent).toEqual([])
    expect(listScheduled(dir)).toEqual([])
  })
  test('a claim left by a crashed sender is recovered after a while', async () => {
    const dir = tmp()
    const due = msg({ at: Date.now() - 1000 })
    saveScheduled(dir, due)
    const claimed = join(dir, '.abcd1.sending')
    writeFileSync(claimed, JSON.stringify(due))
    // Simulate the crash: only the claim is left, and it is old.
    cancelScheduled(dir, 'abcd1')
    const old = (Date.now() - 10 * 60_000) / 1000
    utimesSync(claimed, old, old)
    const { sent, send } = ok()
    await deliverDue(dir, Date.now(), send, () => true)
    expect(sent).toEqual(['abcd1'])
    expect(existsSync(claimed)).toBe(false)
  })
})

describe('describeScheduled', () => {
  test('id, time, repeat and the start of the text', () => {
    expect(describeScheduled(msg({ repeat: 'weekly' }))).toBe('abcd1 · 2026-11-19T03:00:00.000Z · weekly · Renew the VPS')
  })
})
