// Scheduled messages: Claude queues a message for later and the process that
// polls Telegram (router.ts in router mode, server.ts otherwise) sends it on
// time. Sessions come and go (topic sessions stop when idle), so delivery
// must not depend on the session that scheduled it, and it costs no Claude
// usage.
//
// Each message is its own file under <state>/scheduled/, so the session that
// adds one and the process that sends it never rewrite each other's data.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expandTimes, parseTime } from './format.ts'

export type Repeat = 'daily' | 'weekly'

export type Scheduled = {
  id: string
  chat_id: string
  /** Forum topic to post in. */
  thread?: number
  /** GitHub-flavored Markdown, sent as a rich message (plain text if that fails). */
  text: string
  /**
   * Next scheduled slot, ms since the epoch. Repeating messages count their
   * next run from it, so it never moves because of a retry.
   */
  at: number
  /** While deliveries of this slot keep failing: when to try again. */
  retry?: number
  repeat?: Repeat
  created: number
  /** Failed delivery attempts in a row. */
  failures?: number
}

export const MAX_TEXT = 4000
export const MAX_PER_CHAT = 50
export const MAX_AHEAD_MS = 366 * 86400_000
/**
 * A delivery that keeps failing is given up after this many tries: a one-off
 * message is dropped, a repeating one skips to its next run.
 */
export const MAX_FAILURES = 5
const RETRY_MS = 60_000
const PERIOD_MS: Record<Repeat, number> = { daily: 86400_000, weekly: 7 * 86400_000 }

/**
 * Parse when to send: ISO-8601 with a zone, Unix seconds, or now+30m style.
 * Returns ms since the epoch, or an error message.
 */
export function parseWhen(value: string, now: number): number | string {
  const sec = parseTime(value)
  if (sec == null) return `cannot read the time "${value}": use ISO-8601 with a zone (2026-11-20T08:00:00+08:00), Unix seconds or now+30m`
  const at = sec * 1000
  if (at < now - 60_000) return `${new Date(at).toISOString()} is in the past`
  if (at > now + MAX_AHEAD_MS) return 'at most a year ahead'
  return Math.max(at, now)
}

/** When a message is due: its retry time while failing, otherwise its slot. */
export const dueAt = (s: Scheduled): number => Math.max(s.at, s.retry ?? s.at)

/** The next run of a repeating message after `now`, or undefined for one-off messages. */
export function nextRun(s: Scheduled, now: number): number | undefined {
  if (!s.repeat) return undefined
  const period = PERIOD_MS[s.repeat]
  const missed = Math.max(1, Math.ceil((now - s.at) / period))
  return s.at + missed * period
}

export function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

// ---- store ------------------------------------------------------------------

export const scheduleDir = (stateDir: string): string => join(stateDir, 'scheduled')

const fileOf = (dir: string, id: string): string => join(dir, `${id}.json`)
const safeId = (id: string): boolean => /^[a-z0-9]{4,20}$/.test(id)

export function saveScheduled(dir: string, s: Scheduled): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `.${s.id}.${process.pid}.tmp`)
  writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 })
  renameSync(tmp, fileOf(dir, s.id))
}

export function listScheduled(dir: string): Scheduled[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: Scheduled[] = []
  for (const name of names) {
    if (!/^[a-z0-9]+\.json$/.test(name)) continue
    try {
      const s = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Scheduled
      if (s?.id && s.chat_id && typeof s.at === 'number') out.push(s)
    } catch {
      // Half-written or broken: skip it.
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

/** Remove a scheduled message. Returns false when there was none. */
export function cancelScheduled(dir: string, id: string): boolean {
  if (!safeId(id)) return false
  try {
    rmSync(fileOf(dir, id))
    return true
  } catch {
    return false
  }
}

// ---- delivery ---------------------------------------------------------------

const STALE_CLAIM_MS = 5 * 60_000

/** A claim left behind by a process that died while sending goes back in the queue. */
function recoverStale(dir: string, now: number): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const m = /^\.([a-z0-9]+)\.sending$/.exec(name)
    if (!m) continue
    try {
      if (now - statSync(join(dir, name)).mtimeMs > STALE_CLAIM_MS) renameSync(join(dir, name), fileOf(dir, m[1]!))
    } catch {
      // Gone already.
    }
  }
}

export type Send = (s: Scheduled) => Promise<void>

/**
 * Send every message that is due. A message is claimed by renaming its file
 * first, so two processes never send it twice and a cancel during sending
 * is harmless. Repeating messages are written back with their next time;
 * failures are retried a minute later, up to MAX_FAILURES times, without
 * moving the slot the next run is counted from. After that a one-off
 * message is dropped and a repeating one skips this run.
 * `allowed` is checked at send time, so a chat removed from the allowlist
 * gets nothing more. Returns how many were sent.
 */
export async function deliverDue(
  dir: string,
  now: number,
  send: Send,
  allowed: (chat: string) => boolean,
  onError: (what: string, err: unknown) => void = () => {},
): Promise<number> {
  recoverStale(dir, now)
  let sent = 0
  for (const s of listScheduled(dir)) {
    if (s.at > now) break // sorted by slot, and a retry is never before it
    if (dueAt(s) > now) continue
    const claimed = join(dir, `.${s.id}.sending`)
    try {
      renameSync(fileOf(dir, s.id), claimed)
    } catch {
      continue // cancelled or taken by another process
    }
    let next: Scheduled | undefined
    if (!allowed(s.chat_id)) {
      onError(`scheduled ${s.id}: chat ${s.chat_id} is no longer allowed, dropped`, undefined)
    } else {
      try {
        await send(s)
        sent++
        const at = nextRun(s, now)
        if (at) next = { ...s, at, retry: undefined, failures: 0 }
      } catch (err) {
        const failures = (s.failures ?? 0) + 1
        if (failures < MAX_FAILURES) {
          onError(`scheduled ${s.id}: send failed (${failures}/${MAX_FAILURES}), retrying`, err)
          next = { ...s, retry: now + RETRY_MS, failures }
        } else {
          const at = nextRun(s, now)
          onError(`scheduled ${s.id}: send failed (${failures}/${MAX_FAILURES}), ${at ? 'skipping this run' : 'dropped'}`, err)
          if (at) next = { ...s, at, retry: undefined, failures: 0 }
        }
      }
    }
    try {
      if (next) saveScheduled(dir, next)
      rmSync(claimed, { force: true })
    } catch (err) {
      onError(`scheduled ${s.id}: update failed`, err)
    }
  }
  return sent
}

/** One line per message for the list tool. */
export function describeScheduled(s: Scheduled): string {
  const text = s.text.replace(/\s+/g, ' ')
  return `${s.id} · ${new Date(s.at).toISOString()}${s.repeat ? ` · ${s.repeat}` : ''} · ${text.length > 80 ? `${text.slice(0, 79)}…` : text}`
}

export type Api = (method: string, body: Record<string, unknown>) => Promise<unknown>

/**
 * Whether Telegram answered a call with an error saying it will not do it
 * (a 4xx other than a rate limit), as opposed to a network error or timeout,
 * after which the message may have arrived anyway. Both the router's api()
 * (`code`) and grammY's GrammyError (`error_code`) carry the status.
 */
export function rejectedByTelegram(err: unknown): boolean {
  const e = err as { error_code?: unknown; code?: unknown } | undefined
  const status = typeof e?.error_code === 'number' ? e.error_code : typeof e?.code === 'number' ? e.code : undefined
  return status !== undefined && status >= 400 && status < 500 && status !== 429
}

/**
 * Send as a rich message (Bot API 10.1), falling back to plain text when
 * Telegram rejects it. Any other failure is thrown, so the delivery is
 * retried later rather than possibly sent twice.
 */
export function scheduledSender(api: Api): Send {
  return async s => {
    const base = { chat_id: s.chat_id, ...(s.thread ? { message_thread_id: s.thread } : {}) }
    try {
      await api('sendRichMessage', { ...base, rich_message: { markdown: expandTimes(s.text, 'rich') } })
    } catch (err) {
      if (!rejectedByTelegram(err)) throw err
      await api('sendMessage', { ...base, text: expandTimes(s.text, 'text') })
    }
  }
}
