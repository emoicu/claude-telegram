import { describe, expect, test } from 'bun:test'
import { channelMarker, inStartupWindow } from './delivery'

describe('channelMarker', () => {
  test('matches the <channel> tag as Claude Code stores it in the transcript', () => {
    const content = '<channel source="plugin:telegram:telegram" chat_id="-1004320395314" message_id="188" user="u" ts="2026-11-20T06:09:53.000Z">\nhi\n</channel>'
    const line = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content })
    expect(line.includes(channelMarker('-1004320395314', 188))).toBe(true)
    expect(line.includes(channelMarker('-1004320395314', 18))).toBe(false)
    expect(line.includes(channelMarker('-100432039531', '188'))).toBe(false)
  })
})

describe('inStartupWindow', () => {
  test('only the first minutes after start', () => {
    expect(inStartupWindow(1000, 1000 + 90_000, 90_000)).toBe(true)
    expect(inStartupWindow(1000, 1000 + 90_001, 90_000)).toBe(false)
  })
})
