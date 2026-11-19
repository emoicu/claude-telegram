// Turn activity reported by hooks (hooks/activity-telegram.ts): when a turn
// starts, each tool call, failures and the end of the turn. The live status
// uses it next to Claude Code's session file and transcript, which are
// internal formats; hooks are a documented interface, so the status keeps
// working if either side changes. The Stop button also works through it:
// a flag file makes the next tool call end the turn.

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type ActivityKind = 'start' | 'tool' | 'tool_failed' | 'stop'
export type ActivityEvent = { t: number; e: ActivityKind; label?: string }

export type ActivityState = {
  busy: boolean
  /** First event of the current turn. */
  since?: number
  steps: number
  failed: number
  current?: string
  /** Time of the latest event. */
  last?: number
}

/** Without any event for this long a turn counts as over (a crash never says Stop). */
export const ACTIVITY_STALE_MS = 15 * 60_000

export const activityFile = (stateDir: string, slot: string): string => join(stateDir, 'activity', `${slot}.jsonl`)
export const stopFlagFile = (stateDir: string, slot: string): string => join(stateDir, 'activity', `${slot}.stop`)

export function parseActivity(text: string): ActivityEvent[] {
  const out: ActivityEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as ActivityEvent
      if (typeof e.t === 'number' && typeof e.e === 'string') out.push(e)
    } catch {
      // A half-written last line: skip it.
    }
  }
  return out
}

/** State of the latest turn. */
export function summarize(events: ActivityEvent[], now: number, staleMs: number = ACTIVITY_STALE_MS): ActivityState {
  let from = 0
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.e === 'start') {
      from = i
      break
    }
    if (e.e === 'stop') {
      from = i + 1
      break
    }
  }
  const turn = events.slice(from)
  const last = events.length ? events[events.length - 1]!.t : undefined
  const ended = !turn.length || turn[turn.length - 1]!.e === 'stop'
  const busy = !ended && last != null && now - last < staleMs
  const tools = turn.filter(e => e.e === 'tool')
  return {
    busy,
    since: turn[0]?.t,
    steps: tools.length,
    failed: turn.filter(e => e.e === 'tool_failed').length,
    current: tools[tools.length - 1]?.label,
    last,
  }
}

/** Record an event; a turn start also clears the previous turns. */
export function recordEvent(file: string, ev: ActivityEvent): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const line = `${JSON.stringify(ev)}\n`
  if (ev.e === 'start') writeFileSync(file, line, { mode: 0o600 })
  else appendFileSync(file, line, { mode: 0o600 })
}

/** The current state, or undefined when no hook has reported anything. */
export function readActivity(file: string, now: number): ActivityState | undefined {
  try {
    if (now - statSync(file).mtimeMs > ACTIVITY_STALE_MS) return undefined
    return summarize(parseActivity(readFileSync(file, 'utf8')), now)
  } catch {
    return undefined
  }
}

/**
 * Should a tool call stop the turn? Only for a flag set during this turn:
 * after the turn's first event, so a press that came too late for the last
 * turn does not stop the next one.
 */
export function stopRequested(flagMtime: number | undefined, state: ActivityState | undefined): boolean {
  if (flagMtime == null) return false
  return state?.since == null || flagMtime >= state.since - 1000
}
