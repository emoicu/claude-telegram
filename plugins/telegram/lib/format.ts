/**
 * Pure helpers of server.ts: text splitting and cleaning, local-time
 * tokens, checklist and status rendering. No I/O, so they can be tested
 * on their own (see format.test.ts).
 */

import { type T, tEn } from './i18n.ts'

/** What renderStatus/renderDraft need from a running turn. */
export type StatusInfo = { start: number; steps: number; current?: string; note?: string }

export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      // Prefer the last double-newline (paragraph), then single newline,
      // then space. Fall back to hard cut.
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

export const TIME_TOKEN = /\\?\{\\?\{time:([^{}\n]{1,60}?)\\?\}\\?\}/g
export const TIME_FORMAT = /^(r|w?[dD]?[tT]?)$/

export function parseTime(value: string): number | undefined {
  const v = value.trim()
  const rel = /^now(?:([+-])(\d+)([smhd]))?$/.exec(v)
  if (rel) {
    const unit = { s: 1, m: 60, h: 3600, d: 86400 }[rel[3] as 's' | 'm' | 'h' | 'd'] ?? 0
    const delta = rel[1] ? Number(rel[2]) * unit * (rel[1] === '-' ? -1 : 1) : 0
    return Math.floor(Date.now() / 1000) + delta
  }
  if (/^\d{9,11}$/.test(v)) return Number(v)
  const ms = Date.parse(v)
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000)
}

export function expandTimes(text: string, mode: 'text' | 'markdownv2' | 'rich'): string {
  return text.replace(TIME_TOKEN, (whole, inner: string) => {
    const [rawValue, rawFormat] = inner.replace(/\\/g, '').split('|')
    const unix = parseTime(rawValue ?? '')
    if (unix == null) return whole
    const near = Math.abs(unix - Date.now() / 1000) < 20 * 3600
    const format = rawFormat != null && TIME_FORMAT.test(rawFormat.trim()) ? rawFormat.trim() : near ? 't' : 'dt'
    const iso = new Date(unix * 1000).toISOString()
    const label = `${near ? '' : `${iso.slice(0, 10)} `}${iso.slice(11, 16)} UTC`
    if (mode === 'text') return label
    const shown = mode === 'markdownv2' ? label.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, m => `\\${m}`) : label
    return `![${shown}](tg://time?unix=${unix}${format ? `&format=${format}` : ''})`
  })
}

/**
 * Telegram's rich Markdown makes a heading of `#` followed directly by text
 * ("#1 merged") at the start of a line, list item or quote, unlike GitHub,
 * which needs a space after it. Escape that `#` so it stays text. Real
 * headings ("# Title") and fenced code blocks are left alone.
 */
export function escapeTightHashes(md: string): string {
  let fence: string | undefined
  return md
    .split('\n')
    .map(line => {
      const f = /^\s*(`{3,}|~{3,})/.exec(line)
      if (f) {
        const ch = f[1]![0]!
        if (!fence) fence = ch
        else if (ch === fence) fence = undefined
        return line
      }
      if (fence) return line
      return line.replace(/^(\s*(?:(?:[-*+]|\d+[.)])\s+|>\s?)*)(#+)(?=[^\s#\\])/, '$1\\$2')
    })
    .join('\n')
}

export type Step = { text: string; state: 'todo' | 'doing' | 'done' | 'failed' | 'skipped' }

export function renderChecklist(title: string | undefined, steps: Step[], started: number, rich: boolean, t: T = tEn): string {
  const done = steps.filter(x => x.state === 'done' || x.state === 'skipped').length
  const failed = steps.some(x => x.state === 'failed')
  const finished = done === steps.length
  const now = Math.floor(Date.now() / 1000)
  const at = (unix: number, f: string) => (rich ? `{{time:${unix}|${f}}}` : `{{time:${unix}}}`)
  const head = rich ? `**📋 ${title ?? t('checklistTitle')}**` : `📋 ${title ?? t('checklistTitle')}`
  const lines = steps.map(x => {
    const t = x.text.replace(/\s+/g, ' ').trim()
    if (rich) {
      switch (x.state) {
        case 'done': return `- [x] ${t}`
        case 'skipped': return `- [x] ~~${t}~~`
        case 'doing': return `- [ ] **${t}** ⏳`
        case 'failed': return `- [ ] ${t} ❌`
        default: return `- [ ] ${t}`
      }
    }
    const mark = { done: '✅', skipped: '➖', doing: '⏳', failed: '❌', todo: '⬜' }[x.state] ?? '⬜'
    return `${mark} ${t}`
  })
  const foot = finished
    ? t('checklistDone', { done, total: steps.length, from: at(started, 't'), to: at(now, 't') })
    : t('checklistRunning', { icon: failed ? '⚠️' : '⏳', done, total: steps.length, from: at(started, 't'), ago: at(now, 'r') })
  return [head, '', ...lines, '', foot].join('\n')
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

export function fmtDuration(ms: number): string {
  const m = Math.floor(ms / 60_000)
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
}

export function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>[\]\r\n;]/g, '_')
}

export function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

export function describeTool(name: string, input: Record<string, unknown>, t: T = tEn): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const base = (p: string) => p.split('/').pop() || p
  if (typeof input.description === 'string' && input.description) return clip(input.description, 80)
  switch (name) {
    case 'Bash': return t('toolBash', { x: clip(str('command'), 60) })
    case 'Read': return t('toolRead', { x: base(str('file_path')) })
    case 'Edit': return t('toolEdit', { x: base(str('file_path')) })
    case 'Write': return t('toolWrite', { x: base(str('file_path')) })
    case 'Grep': return t('toolGrep', { x: clip(str('pattern'), 50) })
    case 'Glob': return t('toolGlob', { x: clip(str('pattern'), 50) })
    case 'WebSearch': return t('toolWebSearch', { x: clip(str('query'), 50) })
    case 'WebFetch': return t('toolWebFetch', { x: clip(str('url'), 60) })
    case 'ToolSearch': return t('toolToolSearch')
  }
  if (name.startsWith('mcp__plugin_telegram_telegram__')) {
    const tool = name.slice('mcp__plugin_telegram_telegram__'.length)
    return tool === 'reply' ? t('toolReply') : t('toolTelegram', { x: tool })
  }
  return name.replace(/^mcp__/, '').replace(/__/g, ' · ')
}

export function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// One line: elapsed time, step count, current step.
export function renderStatus(w: StatusInfo, now: number, t: T = tEn): string {
  const parts = [`⏳ ${fmtElapsed(now - w.start)}`]
  if (w.steps) parts.push(t('statusSteps', { n: w.steps }))
  parts.push(clip(w.current ?? t('statusThinking'), 60))
  return parts.join(' · ')
}

/** Draft body: the status plus what Claude last wrote between steps. */
export function renderDraft(w: StatusInfo, now: number, t: T = tEn): string {
  const lines = [renderStatus(w, now, t)]
  if (w.note) lines.push(`💭 ${clip(w.note, 80)}`)
  return lines.join('\n')
}

/** Rich Markdown as plain text, for when a rich message is rejected. */
export function plainMarkdown(md: string): string {
  return md
    .replace(/^```.*$\n?/gm, '')
    .replace(/^#+ /gm, '')
    .replace(/<\/?(details|summary)>/g, '')
    .replace(/\*\*|`/g, '')
    .replace(/ +$/gm, '')
    .replace(/^\u2800\n*/gm, '')
}

/**
 * Spaced layout for longer rich messages: every item is its own
 * paragraph (a blank line between them). An item may hold several lines,
 * which stay together with hard breaks.
 */
export function mdSpaced(items: string[]): string {
  const out: string[] = []
  for (const x of items) {
    if (x === '') continue
    // A title (a line that is all bold) gets an empty line around it:
    // Telegram drops blank lines, but keeps a paragraph of one blank
    // Braille character.
    const title = /^\*\*[^*\n]+\*\*$/.test(x)
    if (title && out.length) out.push(SPACER)
    out.push(x.replace(/([^\n ])\n(?!\n|- |\d+\. )/g, '$1  \n'))
    if (title) out.push(SPACER)
  }
  return out.join('\n\n')
}

/** U+2800 BRAILLE PATTERN BLANK: shows as nothing but is not whitespace. */
const SPACER = '\u2800'

/**
 * A bulleted list. Spaced by default (a blank line between items, which
 * Telegram shows as a gap); `tight` keeps short items together. An item's
 * own lines stay inside it.
 */
export function mdList(items: string[], tight = false): string {
  return items
    .filter(x => x !== '')
    .map(x => `- ${x.replace(/\n/g, '  \n  ')}`)
    .join(tight ? '\n' : '\n\n')
}
