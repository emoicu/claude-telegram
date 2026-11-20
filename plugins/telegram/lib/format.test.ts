import { describe, expect, test } from 'bun:test'
import {
  chunk, clip, describeTool, displayWidth, escapeTightHashes, expandTimes, fmtDuration, fmtElapsed, fmtTokens, mdSpaced, narrowTables, parseTime, plainMarkdown, renderChecklist,
  renderDraft, renderStatus, safeName,
} from './format.ts'
import { isNewer } from './version.ts'

describe('chunk', () => {
  test('short text is one part', () => {
    expect(chunk('hello', 10, 'length')).toEqual(['hello'])
  })
  test('length mode cuts hard', () => {
    expect(chunk('abcdefghij', 4, 'length')).toEqual(['abcd', 'efgh', 'ij'])
  })
  test('newline mode prefers paragraph breaks', () => {
    const text = `${'a'.repeat(30)}\n\n${'b'.repeat(30)}`
    expect(chunk(text, 40, 'newline')).toEqual(['a'.repeat(30), 'b'.repeat(30)])
  })
  test('no part is longer than the limit', () => {
    const text = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ')
    for (const part of chunk(text, 50, 'newline')) expect(part.length).toBeLessThanOrEqual(50)
  })
})

describe('clip and safeName', () => {
  test('clip collapses whitespace and adds an ellipsis', () => {
    expect(clip('a  b\nc', 10)).toBe('a b c')
    expect(clip('abcdefghij', 5)).toBe('abcd…')
  })
  test('safeName strips characters that could fake meta tags', () => {
    expect(safeName('a<b>[c];\nd')).toBe('a_b__c___d')
    expect(safeName(undefined)).toBeUndefined()
  })
})

describe('parseTime', () => {
  test('unix seconds, ISO and relative values', () => {
    expect(parseTime('1794880000')).toBe(1794880000)
    expect(parseTime('2026-11-17T00:00:00Z')).toBe(Date.parse('2026-11-17T00:00:00Z') / 1000)
    const now = Math.floor(Date.now() / 1000)
    expect(Math.abs(parseTime('now+30m')! - (now + 1800))).toBeLessThanOrEqual(1)
    expect(Math.abs(parseTime('now-2h')! - (now - 7200))).toBeLessThanOrEqual(1)
  })
  test('garbage is undefined', () => {
    expect(parseTime('tomorrow-ish')).toBeUndefined()
  })
})

describe('expandTimes', () => {
  const unix = 1700000000 // 2023-11-14 22:13:20 UTC, far from now: date and time
  test('plain text gets a UTC label', () => {
    expect(expandTimes(`at {{time:${unix}}}`, 'text')).toBe('at 2023-11-14 22:13 UTC')
  })
  test('rich gets a date_time link with the default format', () => {
    expect(expandTimes(`{{time:${unix}}}`, 'rich')).toBe(`![2023-11-14 22:13 UTC](tg://time?unix=${unix}&format=dt)`)
  })
  test('an explicit format is kept, a bad one replaced', () => {
    expect(expandTimes(`{{time:${unix}|wDT}}`, 'rich')).toContain('format=wDT')
    expect(expandTimes(`{{time:${unix}|xyz}}`, 'rich')).toContain('format=dt')
  })
  test('markdownv2 escapes the label and survives escaped braces', () => {
    const out = expandTimes(`\\{\\{time:${unix}\\}\\}`, 'markdownv2')
    expect(out).toBe(`![2023\\-11\\-14 22:13 UTC](tg://time?unix=${unix}&format=dt)`)
  })
  test('a time near now shows just the time', () => {
    expect(expandTimes('{{time:now}}', 'rich')).toMatch(/^!\[\d\d:\d\d UTC\]\(tg:\/\/time\?unix=\d+&format=t\)$/)
  })
  test('unparseable tokens stay as they are', () => {
    expect(expandTimes('{{time:soon}}', 'rich')).toBe('{{time:soon}}')
  })
})

describe('renderChecklist', () => {
  const steps = [
    { text: 'one', state: 'done' as const },
    { text: 'two', state: 'doing' as const },
    { text: 'three', state: 'todo' as const },
  ]
  test('rich task list with a running footer', () => {
    const out = renderChecklist('Deploy', steps, 1794880000, true)
    expect(out).toStartWith('**📋 Deploy**')
    expect(out).toContain('- [x] one')
    expect(out).toContain('- [ ] **two** ⏳')
    expect(out).toContain('- [ ] three')
    expect(out).toContain('⏳ 1/3 · started {{time:1794880000|t}}')
  })
  test('plain marks and a finished footer', () => {
    const done = steps.map(s => ({ ...s, state: 'done' as const }))
    const out = renderChecklist(undefined, done, 1794880000, false)
    expect(out).toStartWith('📋 Progress')
    expect(out).toContain('✅ one')
    expect(out).toContain('✅ 3/3 done')
  })
  test('a failed step shows a warning', () => {
    const out = renderChecklist('x', [{ text: 'a', state: 'failed' }], 0, true)
    expect(out).toContain('- [ ] a ❌')
    expect(out).toContain('⚠️ 0/1')
  })
})

describe('status line', () => {
  test('one line: elapsed, steps, current step', () => {
    expect(renderStatus({ start: 0, steps: 3, current: 'Reading x.ts' }, 75_000)).toBe('⏳ 1:15 · 3 steps · Reading x.ts')
    expect(renderStatus({ start: 0, steps: 0 }, 5_000)).toBe('⏳ 0:05 · Thinking…')
  })
  test('draft adds the latest note', () => {
    expect(renderDraft({ start: 0, steps: 1, current: 'x', note: 'checking the logs' }, 1_000)).toBe('⏳ 0:01 · 1 step · x\n💭 checking the logs')
  })
  test('describeTool', () => {
    expect(describeTool('Bash', { command: 'ls -la' })).toBe('Running: ls -la')
    expect(describeTool('Read', { file_path: '/a/b/c.ts' })).toBe('Reading c.ts')
    expect(describeTool('Bash', { command: 'x', description: 'List files' })).toBe('List files')
    expect(describeTool('mcp__plugin_telegram_telegram__reply', {})).toBe('Sending Telegram message')
    expect(describeTool('mcp__srv__do_it', {})).toBe('srv · do_it')
  })
})

describe('numbers', () => {
  test('fmtTokens, fmtDuration, fmtElapsed', () => {
    expect(fmtTokens(950)).toBe('950')
    expect(fmtTokens(12_400)).toBe('12k')
    expect(fmtTokens(1_234_567)).toBe('1.23M')
    expect(fmtDuration(125 * 60_000)).toBe('2h 5m')
    expect(fmtDuration(59_000)).toBe('0m')
    expect(fmtElapsed(61_000)).toBe('1:01')
  })
  test('isNewer', () => {
    expect(isNewer('2.1.330', '2.1.326')).toBe(true)
    expect(isNewer('2.1.326', '2.1.326')).toBe(false)
    expect(isNewer('2.2.0', '2.10.0')).toBe(false)
    expect(isNewer('3.0.0-beta', '2.9.9')).toBe(true)
  })
})

describe('mdSpaced', () => {
  test('puts a blank Braille line around bold titles, which plain text drops', () => {
    const md = mdSpaced(['**Title**', 'one\ntwo', '**Section**', '- a'])
    expect(md).toBe('**Title**\n\n\u2800\n\none  \ntwo\n\n\u2800\n\n**Section**\n\n\u2800\n\n- a')
    expect(plainMarkdown(md)).toBe('Title\n\none\ntwo\n\nSection\n\n- a')
  })
})

describe('escapeTightHashes', () => {
  test('escapes # glued to text at the start of a line, list item or quote', () => {
    expect(escapeTightHashes('- #1 merged\n#2 next\n> #3 quoted\n1. #4 done')).toBe('- \\#1 merged\n\\#2 next\n> \\#3 quoted\n1. \\#4 done')
    expect(escapeTightHashes('##6 x')).toBe('\\##6 x')
  })
  test('leaves real headings, # inside a line, escaped ones and code alone', () => {
    const md = '# Title\n## Sub\n- PR #5\n\\#7 done\n```bash\n#comment\n```\n~~~\n#x\n~~~'
    expect(escapeTightHashes(md)).toBe(md)
  })
})

describe('narrowTables', () => {
  test('keeps a wide table that has no rows', () => {
    const md = `| ${'long header '.repeat(6)}| second |\n| --- | --- |`
    expect(narrowTables(md, 50)).toBe(md)
  })
  const wide = '| Script | What it does | Used |\n| --- | --- | --- |\n| claude-tg.sh | 守护脚本：运行路由器，退出后 5 秒重启它 | ✅ always |\n| tgctl | | no |'
  test('turns a table with long rows into a list', () => {
    expect(narrowTables(wide, 50)).toBe('- **claude-tg.sh**\n  - What it does: 守护脚本：运行路由器，退出后 5 秒重启它\n  - Used: ✅ always\n- **tgctl**\n  - Used: no')
  })
  test('two columns become "first: second"', () => {
    const md = 'Intro\n\n|a|b|\n|:-|-:|\n|`x`|' + 'long text '.repeat(6) + '|\n\nafter'
    expect(narrowTables(md, 40)).toBe('Intro\n\n- **`x`**: ' + 'long text '.repeat(6).trim() + '\n\nafter')
  })
  test('keeps narrow tables, tables in code and everything when maxWidth is 0', () => {
    const small = '| | now | later |\n| --- | --- | --- |\n| router | 10 min | 30 s |'
    expect(narrowTables(small, 50)).toBe(small)
    expect(narrowTables('```\n' + wide + '\n```', 50)).toBe('```\n' + wide + '\n```')
    expect(narrowTables(wide, 0)).toBe(wide)
    expect(narrowTables('a | b\nnot a table', 1)).toBe('a | b\nnot a table')
  })
  test('a CJK header or first cell takes a full-width colon', () => {
    expect(narrowTables('| | 现在 |\n|---|---|\n| 路由器 | ' + '最长十分钟'.repeat(5) + ' |', 20)).toBe('- **路由器**：' + '最长十分钟'.repeat(5))
    expect(narrowTables('| a | 现在 | 改后 |\n|---|---|---|\n| x | ' + '十'.repeat(30) + ' | y |', 20)).toBe('- **x**\n  - 现在：' + '十'.repeat(30) + '\n  - 改后：y')
  })

  test('an escaped pipe stays in its cell; bold first cells are not bolded twice', () => {
    expect(narrowTables('| k | v |\n|---|---|\n| **a\\|b** | ' + 'x'.repeat(30) + ' |', 20)).toBe('- **a\\|b**: ' + 'x'.repeat(30))
  })
  test('displayWidth counts CJK and emoji as two columns and ignores markup', () => {
    expect(displayWidth('ab')).toBe(2)
    expect(displayWidth('路由器')).toBe(6)
    expect(displayWidth('✅')).toBe(2)
    expect(displayWidth('**[x](http://e.com)** `y`')).toBe(3)
  })
})
