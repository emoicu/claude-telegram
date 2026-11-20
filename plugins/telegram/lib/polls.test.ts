import { describe, expect, test } from 'bun:test'
import { addPoll, describeAnswer, POLLS_KEEP, type PollRecord, pollFileSlot } from './polls'

const rec = (at: number): PollRecord => ({ chat: '1', id: at, question: 'Which ones?', options: ['A', 'B', 'C'], multiple: true, at })

describe('addPoll', () => {
  test('keeps the newest polls', () => {
    let all: Record<string, PollRecord> = {}
    for (let i = 0; i < POLLS_KEEP + 5; i++) all = addPoll(all, `p${i}`, rec(i))
    expect(Object.keys(all)).toHaveLength(POLLS_KEEP)
    expect(all.p0).toBeUndefined()
    expect(all[`p${POLLS_KEEP + 4}`]).toBeDefined()
  })
})

describe('pollFileSlot', () => {
  test('maps file names to slots', () => {
    expect(pollFileSlot('polls.json')).toBe('main')
    expect(pollFileSlot('polls-t32.json')).toBe('t32')
    expect(pollFileSlot('progress.json')).toBeUndefined()
  })
})

describe('describeAnswer', () => {
  test('lists picked and not picked options', () => {
    const text = describeAnswer(rec(7), [0, 2])
    expect(text).toContain('[Poll answer on your message 7]')
    expect(text).toContain('Picked: "A", "C"')
    expect(text).toContain('Not picked: "B"')
  })
  test('single choice has no "not picked" line', () => {
    expect(describeAnswer({ ...rec(7), multiple: false }, [1])).not.toContain('Not picked')
  })
  test('an empty answer is a withdrawn vote', () => {
    expect(describeAnswer(rec(7), [])).toContain('withdrew their vote')
  })
})
