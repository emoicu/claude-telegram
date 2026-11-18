import { describe, expect, test } from 'bun:test'
import {
  type Access,
  decideInbound,
  defaultAccess,
  type InboundInfo,
  isAllowedChat,
  isMentionedIn,
  isSendablePath,
  MAX_PENDING,
  PAIRING_TTL_MS,
  parseAccess,
  pruneExpired,
} from './access'

const NOW = 1_800_000_000_000
const dm = (senderId: string): InboundInfo => ({ senderId, chatId: senderId, chatType: 'private', mentioned: () => false })
const group = (chatId: string, senderId: string, mentioned = false): InboundInfo => ({
  senderId,
  chatId,
  chatType: 'supergroup',
  mentioned: () => mentioned,
})
const codes = (...list: string[]) => {
  let i = 0
  return () => list[i++] ?? `code${i}`
}

describe('parseAccess', () => {
  test('fills defaults for missing fields', () => {
    const a = parseAccess('{"allowFrom":["1"]}')
    expect(a.dmPolicy).toBe('pairing')
    expect(a.allowFrom).toEqual(['1'])
    expect(a.groups).toEqual({})
    expect(a.pending).toEqual({})
  })
  test('throws on invalid JSON so the caller can move the file aside', () => {
    expect(() => parseAccess('{oops')).toThrow()
  })
})

describe('pruneExpired', () => {
  test('removes only expired codes', () => {
    const a = defaultAccess()
    a.pending.old = { senderId: '1', chatId: '1', createdAt: 0, expiresAt: NOW - 1, replies: 1 }
    a.pending.new = { senderId: '2', chatId: '2', createdAt: 0, expiresAt: NOW + 1, replies: 1 }
    expect(pruneExpired(a, NOW)).toBe(true)
    expect(Object.keys(a.pending)).toEqual(['new'])
    expect(pruneExpired(a, NOW)).toBe(false)
  })
})

describe('decideInbound: direct messages', () => {
  test('delivers from allowlisted users', () => {
    const a = { ...defaultAccess(), allowFrom: ['42'] }
    const d = decideInbound(a, dm('42'), NOW)
    expect(d.result.action).toBe('deliver')
    expect(d.changed).toBe(false)
  })
  test('drops everything when disabled, even allowlisted users', () => {
    const a: Access = { ...defaultAccess(), dmPolicy: 'disabled', allowFrom: ['42'] }
    expect(decideInbound(a, dm('42'), NOW).result.action).toBe('drop')
  })
  test('drops strangers in allowlist mode without creating a code', () => {
    const a: Access = { ...defaultAccess(), dmPolicy: 'allowlist' }
    const d = decideInbound(a, dm('7'), NOW)
    expect(d.result.action).toBe('drop')
    expect(a.pending).toEqual({})
  })
  test('drops messages without a sender', () => {
    expect(decideInbound(defaultAccess(), { chatType: 'private', mentioned: () => false }, NOW).result.action).toBe('drop')
  })
  test('pairing: a new sender gets a fresh code valid for an hour', () => {
    const a = defaultAccess()
    const d = decideInbound(a, dm('7'), NOW, codes('abc123'))
    expect(d.result).toEqual({ action: 'pair', code: 'abc123', isResend: false })
    expect(d.changed).toBe(true)
    expect(a.pending.abc123).toEqual({ senderId: '7', chatId: '7', createdAt: NOW, expiresAt: NOW + PAIRING_TTL_MS, replies: 1 })
  })
  test('pairing: the code is re-sent once, then the sender is ignored', () => {
    const a = defaultAccess()
    decideInbound(a, dm('7'), NOW, codes('abc123'))
    expect(decideInbound(a, dm('7'), NOW).result).toEqual({ action: 'pair', code: 'abc123', isResend: true })
    const third = decideInbound(a, dm('7'), NOW)
    expect(third.result.action).toBe('drop')
    expect(third.changed).toBe(false)
  })
  test('pairing: at most MAX_PENDING outstanding codes', () => {
    const a = defaultAccess()
    for (let i = 0; i < MAX_PENDING; i++) decideInbound(a, dm(`u${i}`), NOW, codes(`c${i}`))
    const d = decideInbound(a, dm('extra'), NOW, codes('cx'))
    expect(d.result.action).toBe('drop')
    expect(Object.keys(a.pending)).toHaveLength(MAX_PENDING)
  })
  test('pairing: an expired code is pruned and a new one issued', () => {
    const a = defaultAccess()
    decideInbound(a, dm('7'), NOW, codes('old'))
    const later = NOW + PAIRING_TTL_MS + 1
    const d = decideInbound(a, dm('7'), later, codes('new'))
    expect(d.result).toEqual({ action: 'pair', code: 'new', isResend: false })
    expect(Object.keys(a.pending)).toEqual(['new'])
  })
})

describe('decideInbound: groups', () => {
  const withGroup = (policy: Partial<Access['groups'][string]> = {}): Access => ({
    ...defaultAccess(),
    groups: { '-100': { requireMention: true, allowFrom: [], ...policy } },
  })
  test('unlisted groups are dropped and reported', () => {
    const d = decideInbound(defaultAccess(), group('-200', '1', true), NOW)
    expect(d.result.action).toBe('drop')
    expect(d.unlistedGroup).toBe('-200')
  })
  test('a mention is required by default', () => {
    expect(decideInbound(withGroup(), group('-100', '1', false), NOW).result.action).toBe('drop')
    expect(decideInbound(withGroup(), group('-100', '1', true), NOW).result.action).toBe('deliver')
  })
  test('requireMention false delivers without a mention', () => {
    expect(decideInbound(withGroup({ requireMention: false }), group('-100', '1'), NOW).result.action).toBe('deliver')
  })
  test('a group allowFrom list limits who is heard', () => {
    const a = withGroup({ requireMention: false, allowFrom: ['1'] })
    expect(decideInbound(a, group('-100', '1'), NOW).result.action).toBe('deliver')
    expect(decideInbound(a, group('-100', '2'), NOW).result.action).toBe('drop')
  })
  test('other chat types are dropped', () => {
    expect(decideInbound(defaultAccess(), { senderId: '1', chatType: 'channel', mentioned: () => true }, NOW).result.action).toBe('drop')
  })
})

describe('isAllowedChat', () => {
  test('allows allowlisted users and configured groups only', () => {
    const a: Access = { ...defaultAccess(), allowFrom: ['1'], groups: { '-100': { requireMention: true, allowFrom: [] } } }
    expect(isAllowedChat(a, '1')).toBe(true)
    expect(isAllowedChat(a, '-100')).toBe(true)
    expect(isAllowedChat(a, '2')).toBe(false)
  })
})

describe('isMentionedIn', () => {
  test('matches @username case-insensitively', () => {
    const m = { text: 'hi @MyBot!', entities: [{ type: 'mention', offset: 3, length: 6 }] }
    expect(isMentionedIn(m, 'mybot')).toBe(true)
    expect(isMentionedIn(m, 'otherbot')).toBe(false)
  })
  test('matches a text mention of the bot', () => {
    const m = { text: 'hey', entities: [{ type: 'text_mention', offset: 0, length: 3, user: { is_bot: true, username: 'mybot' } }] }
    expect(isMentionedIn(m, 'mybot')).toBe(true)
  })
  test('a reply to the bot counts as a mention', () => {
    expect(isMentionedIn({ text: 'ok', entities: [], replyToUsername: 'mybot' }, 'mybot')).toBe(true)
  })
  test('configured patterns match, invalid ones are skipped', () => {
    const m = { text: 'Claude, help', entities: [] }
    expect(isMentionedIn(m, 'mybot', ['(', '^claude'])).toBe(true)
    expect(isMentionedIn(m, 'mybot', ['('])).toBe(false)
  })
})

describe('isSendablePath', () => {
  const state = '/home/u/.claude/channels/telegram'
  test('refuses the channel state', () => {
    expect(isSendablePath(`${state}/.env`, state)).toBe(false)
    expect(isSendablePath(`${state}/access.json`, state)).toBe(false)
  })
  test('allows the inbox and anything outside the state directory', () => {
    expect(isSendablePath(`${state}/inbox/photo.jpg`, state)).toBe(true)
    expect(isSendablePath('/home/u/report.pdf', state)).toBe(true)
    expect(isSendablePath(`${state}-other/file`, state)).toBe(true)
  })
})
