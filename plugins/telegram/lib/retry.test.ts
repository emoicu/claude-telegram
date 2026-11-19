import { describe, expect, test } from 'bun:test'
import { MAX_ATTEMPTS, retryDelayMs } from './retry'

describe('retryDelayMs', () => {
  test('waits out a 429 as Telegram asks', () => {
    expect(retryDelayMs('sendMessage', 0, { status: 429, retryAfter: 3 })).toBe(3250)
  })
  test('gives up on long flood waits', () => {
    expect(retryDelayMs('sendMessage', 0, { status: 429, retryAfter: 300 })).toBeUndefined()
  })
  test('backs off on server errors', () => {
    expect(retryDelayMs('sendMessage', 0, { status: 502 })).toBe(1000)
    expect(retryDelayMs('sendMessage', 2, { status: 500 })).toBe(4000)
  })
  test('network errors: only calls that are safe to repeat', () => {
    expect(retryDelayMs('editMessageText', 0, { network: true })).toBe(1000)
    expect(retryDelayMs('setMessageReaction', 0, { network: true })).toBe(1000)
    expect(retryDelayMs('sendMessage', 0, { network: true })).toBeUndefined()
  })
  test('client errors are final', () => {
    expect(retryDelayMs('sendMessage', 0, { status: 400 })).toBeUndefined()
    expect(retryDelayMs('sendMessage', 0, { status: 403 })).toBeUndefined()
  })
  test('stops after the last attempt and never touches getUpdates', () => {
    expect(retryDelayMs('sendMessage', MAX_ATTEMPTS - 1, { status: 502 })).toBeUndefined()
    expect(retryDelayMs('getUpdates', 0, { status: 502 })).toBeUndefined()
  })
})
