import { describe, expect, test } from 'bun:test'
import { translate } from './i18n'
import { plainMarkdown } from './format'
import { formatUsage, parseReset, parseUsagePanel, usageBar } from './usage'

const SCREEN = `
  Settings   Status   Config   Usage

  Current session
  █████████                                          17% used
  Resets 10:40am (UTC)

  Current week (all models)
  ████████████████████████████                       56% used
  Resets Nov 22, 6pm (UTC)

  What's contributing to your limits usage?
`
// 2026-11-19 07:17 UTC
const NOW = Date.UTC(2026, 10, 19, 7, 17)

describe('parseUsagePanel', () => {
  test('reads titles, percentages and reset times', () => {
    expect(parseUsagePanel(SCREEN)?.items).toEqual([
      { title: 'Current session', pct: 17, reset: '10:40am (UTC)' },
      { title: 'Current week (all models)', pct: 56, reset: 'Nov 22, 6pm (UTC)' },
    ])
  })
  test('no panel on screen', () => {
    expect(parseUsagePanel('❯ /usage\n  loading…')).toBeUndefined()
  })
})

describe('parseReset', () => {
  test('a time today or tomorrow', () => {
    expect(parseReset('10:40am (UTC)', NOW)).toBe(Date.UTC(2026, 10, 19, 10, 40) / 1000)
    expect(parseReset('6am (UTC)', NOW)).toBe(Date.UTC(2026, 10, 20, 6, 0) / 1000)
    expect(parseReset('12pm (UTC)', NOW)).toBe(Date.UTC(2026, 10, 19, 12, 0) / 1000)
  })
  test('a date, rolling over the year', () => {
    expect(parseReset('Nov 22, 6pm (UTC)', NOW)).toBe(Date.UTC(2026, 10, 22, 18, 0) / 1000)
    expect(parseReset('Jan 2, 9:30am (UTC)', Date.UTC(2026, 11, 30))).toBe(Date.UTC(2027, 0, 2, 9, 30) / 1000)
  })
  test('other time zones are left alone', () => {
    expect(parseReset('10:40am (Asia/Shanghai)', NOW)).toBeUndefined()
  })
})

describe('formatUsage', () => {
  test('bars, levels and local reset times', () => {
    const text = formatUsage(parseUsagePanel(SCREEN)!, NOW, (k, v) => translate('zh', k, v))
    const at1 = Date.UTC(2026, 10, 19, 10, 40) / 1000
    const at2 = Date.UTC(2026, 10, 22, 18, 0) / 1000
    expect(text).toBe(
      [
        '### 📊 Claude 用量',
        '',
        '- **当前会话（5 小时额度）** 🟢 17%  ',
        '  `██░░░░░░░░`  ',
        `  ⏱ {{time:${at1}|t}} 重置 · {{time:${at1}|r}}`,
        '',
        '- **本周（全部模型）** 🟡 56%  ',
        '  `██████░░░░`  ',
        `  ⏱ {{time:${at2}|wdt}} 重置 · {{time:${at2}|r}}`,
      ].join('\n'),
    )
    expect(plainMarkdown(text)).not.toMatch(/\*\*|`|###/)
  })
  test('bar', () => {
    expect(usageBar(0)).toBe('░░░░░░░░░░')
    expect(usageBar(95)).toBe('██████████')
  })
})
