import { describe, expect, test } from 'bun:test'
import { envDuration, Holds } from './holds'

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('Holds', () => {
  test('delivers after the hold', async () => {
    const h = new Holds(30, 60_000)
    let sent = 0
    h.hold('k', () => ++sent > 0)
    expect(h.isPending('k')).toBe(true)
    expect(sent).toBe(0)
    await wait(60)
    expect(sent).toBe(1)
    expect(h.isPending('k')).toBe(false)
  })

  test('removing the reaction during the hold drops it', async () => {
    const h = new Holds(30, 60_000)
    let sent = 0
    h.hold('k', () => ++sent > 0)
    expect(h.withdraw('k')).toBe('cancelled')
    await wait(60)
    expect(sent).toBe(0)
    expect(h.withdraw('k')).toBe('ignore')
  })

  test('removing it within the undo window asks for an undo, once', () => {
    let now = 1000
    const h = new Holds(0, 30 * 60_000, () => now)
    h.hold('k', () => true)
    now += 29 * 60_000
    expect(h.withdraw('k')).toBe('undo')
    expect(h.withdraw('k')).toBe('ignore')
  })

  test('after the undo window nothing happens', () => {
    let now = 1000
    const h = new Holds(0, 30 * 60_000, () => now)
    h.markDelivered('k')
    now += 31 * 60_000
    expect(h.withdraw('k')).toBe('ignore')
  })

  test('a failed delivery cannot be undone', () => {
    const h = new Holds(0, 60_000)
    h.hold('k', () => false)
    expect(h.withdraw('k')).toBe('ignore')
  })

  test('undo window 0 turns undo off', () => {
    const h = new Holds(0, 0)
    h.hold('k', () => true)
    expect(h.withdraw('k')).toBe('ignore')
  })

  test('reacting again restarts the hold', async () => {
    const h = new Holds(40, 60_000)
    let sent = 0
    h.hold('k', () => ++sent > 0)
    await wait(20)
    h.hold('k', () => ++sent > 0)
    await wait(30)
    expect(sent).toBe(0)
    await wait(30)
    expect(sent).toBe(1)
  })
})

describe('envDuration', () => {
  test('reads numbers, falls back on blank or invalid', () => {
    expect(envDuration('5', 1000, 10)).toBe(5000)
    expect(envDuration('0.5', 1000, 10)).toBe(500)
    expect(envDuration('0', 1000, 10)).toBe(0)
    expect(envDuration(undefined, 1000, 10)).toBe(10_000)
    expect(envDuration('', 1000, 10)).toBe(10_000)
    expect(envDuration('-1', 1000, 10)).toBe(10_000)
    expect(envDuration('soon', 60_000, 30)).toBe(1_800_000)
  })
})
