// Access control: who may reach Claude through the bot. Pure functions over
// the access.json structure; reading and writing the file stays in server.ts.

import { sep } from 'node:path'

export type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  // delivery/UX config — optional, defaults live in the reply handler
  /** Emoji to react with on receipt. Empty string disables. Telegram only accepts its fixed whitelist. */
  ackReaction?: string
  /** Which chunks get Telegram's reply reference when reply_to is passed. Default: 'first'. 'off' = never thread. */
  replyToMode?: 'off' | 'first' | 'all'
  /** Max chars per outbound message before splitting. Default: 4096 (Telegram's hard cap). */
  textChunkLimit?: number
  /** Split on paragraph boundaries instead of hard char count. */
  chunkMode?: 'length' | 'newline'
}

export type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

/** Pairing codes expire after an hour. */
export const PAIRING_TTL_MS = 60 * 60 * 1000
/** At most this many pairing codes are outstanding; further attempts are dropped. */
export const MAX_PENDING = 3
/** A sender gets the code at most this many times (initial + one reminder). */
export const MAX_PAIRING_REPLIES = 2

export function defaultAccess(): Access {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    pending: {},
  }
}

/** Parse access.json text, filling in defaults. Throws on invalid JSON. */
export function parseAccess(raw: string): Access {
  const parsed = JSON.parse(raw) as Partial<Access>
  return {
    dmPolicy: parsed.dmPolicy ?? 'pairing',
    allowFrom: parsed.allowFrom ?? [],
    groups: parsed.groups ?? {},
    pending: parsed.pending ?? {},
    mentionPatterns: parsed.mentionPatterns,
    ackReaction: parsed.ackReaction,
    replyToMode: parsed.replyToMode,
    textChunkLimit: parsed.textChunkLimit,
    chunkMode: parsed.chunkMode,
  }
}

/** Drop expired pairing codes. Returns true when something was removed. */
export function pruneExpired(a: Access, now: number = Date.now()): boolean {
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

/** Outbound gate: may the bot post to this chat? DMs: chat id == user id. */
export function isAllowedChat(access: Access, chatId: string): boolean {
  return access.allowFrom.includes(chatId) || chatId in access.groups
}

export type InboundInfo = {
  senderId?: string
  chatId?: string
  chatType?: string
  /** Evaluated only when a group requires a mention. */
  mentioned: (patterns?: string[]) => boolean
}

export type GateDecision = {
  result: GateResult
  /** access was modified (codes pruned, a code added or its reply count bumped) and should be saved. */
  changed: boolean
  /** A group that is not allowlisted messaged the bot. */
  unlistedGroup?: string
}

/**
 * Inbound gate: deliver, drop, or answer with a pairing code. Mutates `access`
 * (pruning and pairing state); `changed` says whether it needs saving.
 */
export function decideInbound(
  access: Access,
  msg: InboundInfo,
  now: number = Date.now(),
  newCode: () => string = () => Math.random().toString(16).slice(2, 8),
): GateDecision {
  let changed = pruneExpired(access, now)
  const done = (result: GateResult, extra: Partial<GateDecision> = {}): GateDecision => ({ result, changed, ...extra })

  if (access.dmPolicy === 'disabled') return done({ action: 'drop' })
  if (!msg.senderId) return done({ action: 'drop' })
  const senderId = msg.senderId

  if (msg.chatType === 'private') {
    if (access.allowFrom.includes(senderId)) return done({ action: 'deliver', access })
    if (access.dmPolicy === 'allowlist') return done({ action: 'drop' })

    // Pairing mode: an existing code for this sender is re-sent once, then silence.
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= MAX_PAIRING_REPLIES) return done({ action: 'drop' })
        p.replies = (p.replies ?? 1) + 1
        changed = true
        return done({ action: 'pair', code, isResend: true })
      }
    }
    if (Object.keys(access.pending).length >= MAX_PENDING) return done({ action: 'drop' })

    const code = newCode()
    access.pending[code] = {
      senderId,
      chatId: msg.chatId ?? senderId,
      createdAt: now,
      expiresAt: now + PAIRING_TTL_MS,
      replies: 1,
    }
    changed = true
    return done({ action: 'pair', code, isResend: false })
  }

  if (msg.chatType === 'group' || msg.chatType === 'supergroup') {
    const groupId = msg.chatId ?? ''
    const policy = access.groups[groupId]
    if (!policy) return done({ action: 'drop' }, { unlistedGroup: groupId })
    const groupAllowFrom = policy.allowFrom ?? []
    const requireMention = policy.requireMention ?? true
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) return done({ action: 'drop' })
    if (requireMention && !msg.mentioned(access.mentionPatterns)) return done({ action: 'drop' })
    return done({ action: 'deliver', access })
  }

  return done({ action: 'drop' })
}

export type MentionInfo = {
  text: string
  entities: { type: string; offset: number; length: number; user?: { is_bot?: boolean; username?: string } }[]
  /** Username of the author of the message being replied to, if any. */
  replyToUsername?: string
}

/** Was the bot mentioned: @username, a text mention, a reply to it, or a configured pattern. */
export function isMentionedIn(m: MentionInfo, botUsername: string, extraPatterns?: string[]): boolean {
  for (const e of m.entities) {
    if (e.type === 'mention') {
      const mentioned = m.text.slice(e.offset, e.offset + e.length)
      if (mentioned.toLowerCase() === `@${botUsername}`.toLowerCase()) return true
    }
    if (e.type === 'text_mention' && e.user?.is_bot && e.user.username === botUsername) return true
  }
  // A reply to one of our messages counts as an implicit mention.
  if (m.replyToUsername === botUsername) return true
  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(m.text)) return true
    } catch {
      // Invalid user-supplied regex — skip it.
    }
  }
  return false
}

/**
 * The reply tool may send any file except the channel's own state (token,
 * access list...). Files Claude downloaded into the inbox are fine.
 * Both paths must already be resolved with realpath.
 */
export function isSendablePath(real: string, stateReal: string): boolean {
  const inbox = `${stateReal}${sep}inbox`
  return !(real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep))
}
