// /doctor: a health check of the channel, answered in the chat. The checks
// are pure functions over facts that server.ts collects.

import type { Access } from './access.ts'
import { type T, tEn } from './i18n.ts'

export type Check = { level: 'ok' | 'warn' | 'fail'; text: string }

const ok = (text: string): Check => ({ level: 'ok', text })
const warn = (text: string): Check => ({ level: 'warn', text })
const fail = (text: string): Check => ({ level: 'fail', text })

/** Who can reach Claude, and anything that lets more people in than likely meant. */
export function checkAccess(a: Access, groupTitles: Record<string, string | undefined> = {}, t: T = tEn): Check[] {
  const out: Check[] = []
  const users = a.allowFrom.length
  if (a.dmPolicy === 'disabled') out.push(warn(t('doctorDmDisabled')))
  else out.push(ok(t('doctorDm', { policy: a.dmPolicy, n: users })))
  if (a.dmPolicy === 'pairing') out.push(warn(t('doctorPairing')))
  const pending = Object.keys(a.pending).length
  if (pending) out.push(warn(t('doctorPending', { n: pending })))
  for (const [id, g] of Object.entries(a.groups)) {
    const name = groupTitles[id] ? `"${groupTitles[id]}"` : id
    if (!g.allowFrom?.length && g.requireMention === false) {
      out.push(warn(t('doctorGroupOpen', { name })))
    } else if (!g.allowFrom?.length) {
      out.push(warn(t('doctorGroupMention', { name })))
    } else {
      const mention = g.requireMention === false ? '' : t('doctorGroupMentionRequired')
      out.push(ok(t('doctorGroupOk', { name, n: g.allowFrom.length, mention })))
    }
  }
  return out
}

/** Secrets and the access list should be readable by their owner only. */
export function checkFileMode(name: string, mode: number | undefined, t: T = tEn): Check {
  if (mode == null) return warn(t('doctorFileMissing', { name }))
  const perm = mode & 0o777
  return perm & 0o077 ? fail(t('doctorFileOpen', { name, mode: perm.toString(8) })) : ok(t('doctorFilePrivate', { name }))
}

export type LogSummary = { warnings: number; errors: number; lastProblem?: string }

/** Count warnings and errors in log lines newer than `sinceMs`. */
export function summarizeLog(text: string, sinceMs: number): LogSummary {
  const s: LogSummary = { warnings: 0, errors: 0 }
  for (const line of text.split('\n')) {
    const m = /^(\S+) (WARN|ERROR)\s/.exec(line)
    if (!m) continue
    const t = Date.parse(m[1]!)
    if (Number.isNaN(t) || t < sinceMs) continue
    if (m[2] === 'WARN') s.warnings++
    else s.errors++
    s.lastProblem = line
  }
  return s
}

export function checkLog(name: string, s: LogSummary | undefined, t: T = tEn): Check {
  if (!s) return ok(t('doctorLogNone', { name }))
  if (!s.warnings && !s.errors) return ok(t('doctorLogQuiet', { name }))
  const counts = t('doctorLogCounts', { name, errors: s.errors, warnings: s.warnings })
  const line = s.lastProblem && (s.lastProblem.length > 160 ? `${s.lastProblem.slice(0, 159)}…` : s.lastProblem)
  return (s.errors ? fail : warn)(line ? `${counts}\n    ${t('doctorLogLast', { line })}` : counts)
}

/** The activity hook reports every turn; silence after a turn means it is not loaded. */
export function checkActivityHook(lastEventMs: number | undefined, now: number, t: T = tEn): Check {
  if (lastEventMs == null) return warn(t('doctorHookNone'))
  return ok(t('doctorHookOk', { ago: ago(now - lastEventMs, t) }))
}

/** Overdue scheduled messages mean delivery is stuck. */
export function checkScheduled(dueTimes: number[], now: number, t: T = tEn): Check {
  if (!dueTimes.length) return ok(t('doctorScheduledNone'))
  const late = dueTimes.filter(at => now - at > 2 * 60_000).length
  if (late) return fail(t('doctorScheduledLate', { n: late }))
  return ok(t('doctorScheduledOk', { n: dueTimes.length, in: ago(Math.min(...dueTimes) - now, t) }))
}

export function checkDisk(freeBytes: number | undefined, t: T = tEn): Check {
  if (freeBytes == null) return ok(t('doctorDiskUnknown'))
  const gb = freeBytes / 1024 ** 3
  return gb < 1 ? warn(t('doctorDiskLow', { gb: gb.toFixed(1) })) : ok(t('doctorDiskOk', { gb: gb.toFixed(0) }))
}

export function ago(ms: number, t: T = tEn): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return t('timeS', { n: s })
  if (s < 5400) return t('timeMin', { n: Math.round(s / 60) })
  if (s < 172_800) return t('timeH', { n: Math.round(s / 3600) })
  return t('timeD', { n: Math.round(s / 86_400) })
}

const ICON = { ok: '✅', warn: '⚠️', fail: '❌' } as const

/** The chat message: a one-line verdict, then every check. */
export function formatReport(header: string[], checks: Check[], t: T = tEn): string {
  const fails = checks.filter(c => c.level === 'fail').length
  const warns = checks.filter(c => c.level === 'warn').length
  const verdict = fails
    ? t(warns ? 'doctorFailsWarns' : 'doctorFails', { fails, warns })
    : warns
      ? t('doctorWarns', { warns })
      : t('doctorAllGood')
  return [t('doctorTitle', { verdict }), '', ...header, '', ...checks.map(c => `${ICON[c.level]} ${c.text}`)].join('\n')
}
