// Reading Claude Code transcripts (one JSON object per line) for the live
// work status: which tools ran, what Claude last wrote.

import { describeTool } from './format.ts'

/** The part of the live status that transcript scanning updates. */
export type StepState = {
  /** Ignore entries older than this ISO timestamp (the start of the turn). */
  sinceIso: string
  /** tool_use ids already counted. */
  seen: Set<string>
  steps: number
  /** One-line description of the latest tool call. */
  current?: string
  /** Latest text Claude wrote between steps. */
  note?: string
}

/**
 * Update `state` from the tail of a transcript. The first line is skipped
 * because a tail read may cut it in half; malformed lines are ignored.
 */
export function scanTranscriptTail(tail: string, state: StepState): void {
  const lines = tail.split('\n')
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line || !(line.includes('"tool_use"') || line.includes('"type":"text"'))) continue
    let entry: { type?: unknown; timestamp?: unknown; message?: { content?: unknown } }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry?.type !== 'assistant' || typeof entry.timestamp !== 'string') continue
    if (entry.timestamp < state.sinceIso) continue
    const content = Array.isArray(entry.message?.content) ? entry.message.content : []
    for (const c of content as { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown }[]) {
      if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
        state.note = c.text
        continue
      }
      if (c?.type !== 'tool_use' || typeof c.id !== 'string' || state.seen.has(c.id)) continue
      state.seen.add(c.id)
      state.steps++
      state.current = describeTool(String(c.name ?? ''), (c.input ?? {}) as Record<string, unknown>)
    }
  }
}
