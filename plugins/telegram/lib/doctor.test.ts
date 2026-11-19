import { describe, expect, test } from 'bun:test'
import { defaultAccess } from './access'
import {
  ago,
  checkAccess,
  checkActivityHook,
  checkDisk,
  checkFileMode,
  checkLog,
  checkScheduled,
  formatReport,
  summarizeLog,
} from './doctor'

describe('checkAccess', () => {
  test('a locked-down setup is all ok', () => {
    const a = { ...defaultAccess(), dmPolicy: 'allowlist' as const, allowFrom: ['1'], groups: { '-100': { requireMention: true, allowFrom: ['1'] } } }
    expect(checkAccess(a, { '-100': 'Team' }).map(c => c.level)).toEqual(['ok', 'ok'])
  })
  test('flags open groups, pairing mode and waiting codes', () => {
    const a = {
      ...defaultAccess(),
      allowFrom: ['1'],
      pending: { abc123: { senderId: '9', chatId: '9', createdAt: 0, expiresAt: 1, replies: 1 } },
      groups: { '-100': { requireMention: false, allowFrom: [] }, '-200': { requireMention: true, allowFrom: [] } },
    }
    const texts = checkAccess(a, { '-100': 'Jack & Claude' }).filter(c => c.level === 'warn').map(c => c.text)
    expect(texts).toHaveLength(4)
    expect(texts.join('\n')).toContain('"Jack & Claude": every member can talk to Claude, without even mentioning')
    expect(texts.join('\n')).toContain('-200: every member can talk to Claude by mentioning')
  })
})

describe('checkFileMode', () => {
  test('owner-only is fine, group or world readable is not', () => {
    expect(checkFileMode('.env', 0o100600).level).toBe('ok')
    expect(checkFileMode('.env', 0o100644)).toEqual({ level: 'fail', text: '.env is readable by others (mode 644); run chmod 600' })
    expect(checkFileMode('.env', undefined).level).toBe('warn')
  })
})

describe('logs', () => {
  const log = [
    '2026-11-18T01:00:00.000Z ERROR telegram channel: old',
    '2026-11-19T01:00:00.000Z INFO  telegram channel: fine',
    '2026-11-19T02:00:00.000Z WARN  telegram channel: status edit failed: 429',
    '2026-11-19T03:00:00.000Z ERROR telegram channel: send failed',
  ].join('\n')
  test('counts recent warnings and errors only', () => {
    const s = summarizeLog(log, Date.parse('2026-11-18T12:00:00Z'))
    expect(s).toEqual({ warnings: 1, errors: 1, lastProblem: '2026-11-19T03:00:00.000Z ERROR telegram channel: send failed' })
    expect(checkLog('Server log', s).level).toBe('fail')
  })
  test('a quiet log is ok', () => {
    expect(checkLog('Server log', { warnings: 0, errors: 0 }).level).toBe('ok')
    expect(checkLog('Server log', { warnings: 2, errors: 0 }).level).toBe('warn')
  })
})

describe('other checks', () => {
  const now = 10_000_000
  test('activity hook', () => {
    expect(checkActivityHook(undefined, now).level).toBe('warn')
    expect(checkActivityHook(now - 30_000, now).text).toBe('Activity hook reported 30 s ago')
  })
  test('scheduled messages', () => {
    expect(checkScheduled([], now).level).toBe('ok')
    expect(checkScheduled([now + 3_600_000], now).text).toBe('1 scheduled message, next in 60 min')
    expect(checkScheduled([now - 5 * 60_000], now).level).toBe('fail')
  })
  test('disk', () => {
    expect(checkDisk(512 * 1024 ** 2).level).toBe('warn')
    expect(checkDisk(40 * 1024 ** 3).level).toBe('ok')
  })
  test('ago', () => {
    expect(ago(5000)).toBe('5 s')
    expect(ago(30 * 60_000)).toBe('30 min')
    expect(ago(3 * 3_600_000)).toBe('3 h')
    expect(ago(3 * 86_400_000)).toBe('3 d')
  })
})

describe('formatReport', () => {
  test('verdict, then what needs attention, passing checks folded', () => {
    const text = formatReport(['Plugin 1.0'], [
      { level: 'ok', text: 'fine' },
      { level: 'warn', text: 'hmm' },
    ])
    expect(text).toBe(
      '**🩺 Doctor: ⚠️ 1 warning**\n\n- Plugin 1.0\n\n#### Needs attention\n\n- ⚠️ hmm\n\n' +
        '<details><summary>✅ 1 check OK</summary>\n\n- ✅ fine\n\n</details>',
    )
    expect(formatReport([], [{ level: 'ok', text: 'fine' }])).toBe('**🩺 Doctor: ✅ All good**\n\n- ✅ fine')
  })
})
