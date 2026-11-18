import { describe, expect, test } from 'bun:test'
import { type StepState, scanTranscriptTail } from './transcript'

const entry = (timestamp: string, content: unknown[], type = 'assistant') => JSON.stringify({ type, timestamp, message: { content } })
const fresh = (): StepState => ({ sinceIso: '2026-11-18T10:00:00Z', seen: new Set(), steps: 0 })
const tail = (...lines: string[]) => ['{"cut in ha', ...lines].join('\n')

describe('scanTranscriptTail', () => {
  test('counts each tool call once and remembers the latest', () => {
    const s = fresh()
    const t = tail(
      entry('2026-11-18T10:00:01Z', [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } }]),
      entry('2026-11-18T10:00:02Z', [{ type: 'tool_use', id: 'b', name: 'Read', input: { file_path: '/x/y.ts' } }]),
    )
    scanTranscriptTail(t, s)
    scanTranscriptTail(t, s)
    expect(s.steps).toBe(2)
    expect(s.seen.size).toBe(2)
    expect(s.current).toBeTruthy()
  })
  test('keeps the latest non-empty text as the note', () => {
    const s = fresh()
    scanTranscriptTail(tail(entry('2026-11-18T10:00:01Z', [{ type: 'text', text: 'Checking the logs' }, { type: 'text', text: '  ' }])), s)
    expect(s.note).toBe('Checking the logs')
    expect(s.steps).toBe(0)
  })
  test('ignores entries from before the turn and from the user', () => {
    const s = fresh()
    scanTranscriptTail(
      tail(
        entry('2026-11-18T09:59:59Z', [{ type: 'tool_use', id: 'old', name: 'Bash', input: {} }]),
        entry('2026-11-18T10:00:01Z', [{ type: 'tool_use', id: 'u', name: 'Bash', input: {} }], 'user'),
      ),
      s,
    )
    expect(s.steps).toBe(0)
  })
  test('skips the first (possibly cut) line and malformed lines', () => {
    const s = fresh()
    const first = entry('2026-11-18T10:00:01Z', [{ type: 'tool_use', id: 'first', name: 'Bash', input: {} }])
    scanTranscriptTail([first, '{"type":"tool_use" broken', ''].join('\n'), s)
    expect(s.steps).toBe(0)
  })
})
