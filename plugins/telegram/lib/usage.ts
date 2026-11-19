// /usage: read Claude Code's usage panel from the terminal screen and turn
// it into a chat message with bars and reset times in the reader's own
// time zone. Pure functions; helpers/tmux-session-helper.ts does the I/O.

import { mdSpaced } from './format.ts'
import { type T, tEn } from './i18n.ts'

export type UsageItem = { title: string; pct?: number; reset?: string }

/** The panel's items, or undefined when the screen does not show it. */
export function parseUsagePanel(screen: string): { items: UsageItem[]; lines: string[] } | undefined {
  const lines: string[] = []
  let grab = false
  for (const raw of screen.split('\n')) {
    const s = raw.trim()
    if (s.startsWith('Current session')) grab = true
    if (s.startsWith('What') && s.includes('contributing')) break
    if (!grab) continue
    const clean = s.replace(/[▀-▟■-◿]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
    if (clean) lines.push(clean)
  }
  if (!lines.length) return undefined
  const items: UsageItem[] = []
  for (const s of lines) {
    const last = items[items.length - 1]
    const pct = /(\d+)% used/.exec(s)
    if (s.startsWith('Current ')) items.push({ title: s })
    else if (last && pct) last.pct = Number(pct[1])
    else if (last && s.startsWith('Resets')) last.reset = s.slice('Resets'.length).trim()
  }
  return { items, lines }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/**
 * "10:40am (UTC)", "6pm (UTC)", "Nov 22, 6pm (UTC)" to Unix seconds: the
 * next such moment after `now`. Only UTC is understood; anything else is
 * shown as Claude Code printed it.
 */
export function parseReset(reset: string, now: number): number | undefined {
  const m = /^(?:([A-Za-z]{3})\w*\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(UTC\)$/i.exec(reset.trim())
  if (!m) return undefined
  let hour = Number(m[3]) % 12
  if (m[5]!.toLowerCase() === 'pm') hour += 12
  const minute = Number(m[4] ?? 0)
  const d = new Date(now)
  if (m[1]) {
    const month = MONTHS.indexOf(m[1].toLowerCase())
    if (month < 0) return undefined
    let at = Date.UTC(d.getUTCFullYear(), month, Number(m[2]), hour, minute)
    // A date in January seen in December belongs to next year.
    if (at < now - 86_400_000) at = Date.UTC(d.getUTCFullYear() + 1, month, Number(m[2]), hour, minute)
    return Math.floor(at / 1000)
  }
  let at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute)
  if (at <= now) at += 86_400_000
  return Math.floor(at / 1000)
}

export function usageBar(pct: number, cells = 10): string {
  const full = Math.round((Math.min(100, Math.max(0, pct)) / 100) * cells)
  return '█'.repeat(full) + '░'.repeat(cells - full)
}

const level = (pct: number) => (pct >= 80 ? '🔴' : pct >= 50 ? '🟡' : '🟢')

function title(raw: string, t: T): string {
  if (raw === 'Current session') return t('usageSession')
  if (/^Current week \(all models\)$/i.test(raw)) return t('usageWeekAll')
  const m = /^Current week \((.+)\)$/.exec(raw)
  if (m) return t('usageWeekModel', { model: m[1] })
  return raw
}

/**
 * Rich Markdown with {{time:…}} tokens (expanded by the sender), one block
 * per item. Falls back to the panel's own lines when nothing was recognized.
 */
export function formatUsage(panel: { items: UsageItem[]; lines: string[] }, now: number, t: T = tEn): string {
  const out = [`### ${t('helperUsageTitle')}`]
  if (!panel.items.length) return [...out, '', ...panel.lines].join('\n')
  for (const it of panel.items) {
    out.push('')
    if (it.pct == null) {
      out.push(`**${title(it.title, t)}** · ${t('helperUsageNoPct')}`)
    } else {
      out.push(`**${title(it.title, t)}** ${level(it.pct)} ${it.pct}%\n\`${usageBar(it.pct)}\``)
    }
    if (it.reset) {
      const at = parseReset(it.reset, now)
      const near = at != null && at * 1000 - now < 20 * 3_600_000
      out.push(
        at != null
          ? t('usageResetsAt', { when: `{{time:${at}|${near ? 't' : 'wdt'}}}`, rel: `{{time:${at}|r}}` })
          : t('usageResetsRaw', { when: it.reset }),
      )
    }
  }
  return mdSpaced(out)
}
