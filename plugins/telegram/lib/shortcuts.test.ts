import { describe, expect, test } from 'bun:test'
import { bare, DEFAULT_HELD, DEFAULT_REACTIONS, mergeShortcuts, PAUSE_REACTION, QUICK_FIRST } from './shortcuts'

describe('mergeShortcuts', () => {
  test('returns the defaults with labels when there is no custom file', () => {
    const map = mergeShortcuts()
    expect(map.size).toBe(Object.keys(DEFAULT_REACTIONS).length)
    expect(map.get('👍')).toEqual({ meaning: DEFAULT_REACTIONS['👍'], label: 'Go on', hold: false })
  })
  test('a string replaces the meaning and keeps the label', () => {
    expect(mergeShortcuts({ '👍': 'Ship it' }).get('👍')).toEqual({ meaning: 'Ship it', label: 'Go on', hold: false })
  })
  test('an object can set meaning and label, or add a new emoji', () => {
    const map = mergeShortcuts({ '🤔': { label: 'Simpler' }, '🚀': { meaning: 'Deploy now', label: 'Deploy' } })
    expect(map.get('🤔')).toEqual({ meaning: DEFAULT_REACTIONS['🤔'], label: 'Simpler', hold: false })
    expect(map.get('🚀')).toEqual({ meaning: 'Deploy now', label: 'Deploy', hold: false })
  })
  test('❤ and 🔥 are held by default; hold can be set or cleared', () => {
    const map = mergeShortcuts({ '❤': { hold: false }, '🔥': 'Ship it', '🚀': { meaning: 'Deploy now', hold: true } })
    expect(mergeShortcuts().get('❤')?.hold).toBe(true)
    expect(map.get('❤')?.hold).toBe(false)
    expect(map.get('🔥')).toEqual({ meaning: 'Ship it', label: 'Do it', hold: true })
    expect(map.get('🚀')?.hold).toBe(true)
  })
  test('null removes a shortcut, and entries without a meaning are dropped', () => {
    const map = mergeShortcuts({ '🎉': null, '🆕': { label: 'No meaning' } })
    expect(map.has('🎉')).toBe(false)
    expect(map.has('🆕')).toBe(false)
  })
  test('ignores a file that is not an object', () => {
    expect(mergeShortcuts(['👍']).size).toBe(Object.keys(DEFAULT_REACTIONS).length)
    expect(mergeShortcuts('oops').size).toBe(Object.keys(DEFAULT_REACTIONS).length)
  })
})

describe('constants', () => {
  test('quick buttons, pause and held ones are real shortcuts', () => {
    for (const e of [...QUICK_FIRST, PAUSE_REACTION, ...DEFAULT_HELD]) expect(DEFAULT_REACTIONS[e]).toBeTruthy()
  })
  test('bare strips the emoji variation selector', () => {
    expect(bare('❤️')).toBe('❤')
  })
})
