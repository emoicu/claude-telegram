import { describe, expect, test } from 'bun:test'
import { ALERT_COOLDOWN_MS, failureMessage, takeAlertSlot } from './failure'

describe('failureMessage', () => {
  test('explains a rate limit and shows the error text', () => {
    const text = failureMessage({
      error: 'rate_limit',
      error_details: '429 Too Many Requests',
      last_assistant_message: 'API Error: Rate limit reached',
    })
    expect(text).toBe(
      [
        '⚠️ Usage or rate limit reached',
        '“API Error: Rate limit reached”',
        'Details: 429 Too Many Requests',
        '',
        'Claude cannot answer until the limit resets. Send /usage to see when.',
      ].join('\n'),
    )
  })
  test('skips details already contained in the error text', () => {
    const text = failureMessage({ error: 'server_error', error_details: '529', last_assistant_message: 'API Error: 529 overloaded' })
    expect(text).not.toContain('Details:')
  })
  test('falls back for unknown or missing error types', () => {
    expect(failureMessage({ error: 'something_new' })).toStartWith('⚠️ The turn stopped on an error')
    expect(failureMessage({})).toStartWith('⚠️ The turn stopped on an error')
  })
  test('keeps long error text short and on one line', () => {
    const text = failureMessage({ error: 'invalid_request', last_assistant_message: `bad\n${'x'.repeat(1000)}` })
    const quoted = text.split('\n')[1]!
    expect(quoted.length).toBeLessThan(320)
    expect(quoted).toEndWith('…”')
  })
})

describe('takeAlertSlot', () => {
  test('one alert per key within the cooldown', () => {
    const sent: Record<string, number> = {}
    expect(takeAlertSlot(sent, 'main:rate_limit', 0)).toBe(true)
    expect(takeAlertSlot(sent, 'main:rate_limit', 1000)).toBe(false)
    expect(takeAlertSlot(sent, 'main:server_error', 1000)).toBe(true)
    expect(takeAlertSlot(sent, 't31:rate_limit', 1000)).toBe(true)
  })
  test('alerts again after the cooldown and forgets old entries', () => {
    const sent: Record<string, number> = { 'main:rate_limit': 0, 'old:x': 0 }
    expect(takeAlertSlot(sent, 'main:rate_limit', ALERT_COOLDOWN_MS)).toBe(true)
    expect(Object.keys(sent)).toEqual(['main:rate_limit'])
  })
})
