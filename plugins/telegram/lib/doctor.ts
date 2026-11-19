// /doctor: a health check of the channel, answered in the chat. The checks
// are pure functions over facts that server.ts collects.

import type { Access } from './access.ts'

export type Check = { level: 'ok' | 'warn' | 'fail'; text: string }

const ok = (text: string): Check => ({ level: 'ok', text })
const warn = (text: string): Check => ({ level: 'warn', text })
const fail = (text: string): Check => ({ level: 'fail', text })

/** Who can reach Claude, and anything that lets more people in than likely meant. */
export function checkAccess(a: Access, groupTitles: Record<string, string | undefined> = {}): Check[] {
  const out: Check[] = []
  const users = a.allowFrom.length
  if (a.dmPolicy === 'disabled') out.push(warn('Direct messages are disabled (dmPolicy "disabled")'))
  else out.push(ok(`Direct messages: ${a.dmPolicy}, ${users} allowed user${users === 1 ? '' : 's'}`))
  if (a.dmPolicy === 'pairing') out.push(warn('Pairing is on: anyone who finds the bot can ask for a code. Use allowlist mode once everyone is paired'))
  const pending = Object.keys(a.pending).length
  if (pending) out.push(warn(`${pending} pairing code${pending === 1 ? '' : 's'} waiting for approval`))
  for (const [id, g] of Object.entries(a.groups)) {
    const name = groupTitles[id] ? `"${groupTitles[id]}"` : id
    const who = g.allowFrom?.length ? `${g.allowFrom.length} allowed member${g.allowFrom.length === 1 ? '' : 's'}` : 'every member'
    if (!g.allowFrom?.length && g.requireMention === false) {
      out.push(warn(`Group ${name}: every member can talk to Claude, without even mentioning the bot`))
    } else if (!g.allowFrom?.length) {
      out.push(warn(`Group ${name}: every member can talk to Claude by mentioning the bot`))
    } else {
      out.push(ok(`Group ${name}: ${who}${g.requireMention === false ? '' : ', mention required'}`))
    }
  }
  return out
}

/** Secrets and the access list should be readable by their owner only. */
export function checkFileMode(name: string, mode: number | undefined): Check {
  if (mode == null) return warn(`${name} not found`)
  const perm = mode & 0o777
  return perm & 0o077 ? fail(`${name} is readable by others (mode ${perm.toString(8)}); run chmod 600`) : ok(`${name} is private`)
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

export function checkLog(name: string, s: LogSummary | undefined): Check {
  if (!s) return ok(`${name}: no log yet`)
  if (!s.warnings && !s.errors) return ok(`${name}: no warnings or errors in the last 24 h`)
  const counts = `${s.errors} error${s.errors === 1 ? '' : 's'}, ${s.warnings} warning${s.warnings === 1 ? '' : 's'} in the last 24 h`
  const last = s.lastProblem ? `\n    last: ${s.lastProblem.length > 160 ? `${s.lastProblem.slice(0, 159)}…` : s.lastProblem}` : ''
  return (s.errors ? fail : warn)(`${name}: ${counts}${last}`)
}

/** The activity hook reports every turn; silence after a turn means it is not loaded. */
export function checkActivityHook(lastEventMs: number | undefined, now: number): Check {
  if (lastEventMs == null) return warn('Activity hook has not reported yet (it loads when the session restarts)')
  return ok(`Activity hook reported ${ago(now - lastEventMs)} ago`)
}

/** Overdue scheduled messages mean delivery is stuck. */
export function checkScheduled(dueTimes: number[], now: number): Check {
  if (!dueTimes.length) return ok('No scheduled messages')
  const late = dueTimes.filter(t => now - t > 2 * 60_000).length
  if (late) return fail(`${late} scheduled message${late === 1 ? ' is' : 's are'} overdue: is the router (or the polling server) running?`)
  return ok(`${dueTimes.length} scheduled message${dueTimes.length === 1 ? '' : 's'}, next in ${ago(Math.min(...dueTimes) - now)}`)
}

export function checkDisk(freeBytes: number | undefined): Check {
  if (freeBytes == null) return ok('Disk space: unknown')
  const gb = freeBytes / 1024 ** 3
  return gb < 1 ? warn(`Only ${gb.toFixed(1)} GB free on the state disk`) : ok(`${gb.toFixed(0)} GB free on the state disk`)
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return `${s} s`
  if (s < 5400) return `${Math.round(s / 60)} min`
  if (s < 172_800) return `${Math.round(s / 3600)} h`
  return `${Math.round(s / 86_400)} d`
}

const ICON = { ok: '✅', warn: '⚠️', fail: '❌' } as const

/** The chat message: a one-line verdict, then every check. */
export function formatReport(header: string[], checks: Check[]): string {
  const fails = checks.filter(c => c.level === 'fail').length
  const warns = checks.filter(c => c.level === 'warn').length
  const verdict = fails
    ? `❌ ${fails} problem${fails === 1 ? '' : 's'}${warns ? `, ${warns} warning${warns === 1 ? '' : 's'}` : ''}`
    : warns
      ? `⚠️ ${warns} warning${warns === 1 ? '' : 's'}`
      : '✅ All good'
  return [`🩺 Doctor: ${verdict}`, '', ...header, '', ...checks.map(c => `${ICON[c.level]} ${c.text}`)].join('\n')
}
