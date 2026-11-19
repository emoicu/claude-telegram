// Access state: reading and saving access.json, the inbound and command
// gates, the outbound checks, and pairing confirmations. The decisions
// themselves are pure functions in lib/access.ts.

import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Bot, Context } from 'grammy'
import {
  type Access, decideInbound, defaultAccess, type GateResult, isAllowedChat, isSendablePath, parseAccess, pruneExpired,
} from '../lib/access.ts'
import { ACCESS_FILE, APPROVED_DIR, ignored, log, STATE_DIR, STATIC, t, TOPIC_CHAT } from './config.ts'

// reply's files param takes any path. .env is ~60 bytes and ships as a
// document. Claude can already Read+paste file contents, so this isn't a new
// exfil channel for arbitrary paths — but the server's own state is the one
// thing Claude has no reason to ever send.
export function assertSendable(f: string): void {
  let real: string, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch { return } // statSync will fail properly; or STATE_DIR absent → nothing to leak
  if (!isSendablePath(real, stateReal)) throw new Error(`refusing to send channel state: ${f}`)
}

export function readAccessFile(): Access {
  try {
    return parseAccess(readFileSync(ACCESS_FILE, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try {
      renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`)
    } catch (err) {
      log.warn('could not move the corrupt access.json aside', err)
    }
    log.warn('access.json is corrupt, moved aside. Starting fresh.')
    return defaultAccess()
  }
}

// In static mode, access is snapshotted at boot and never re-read or written.
// Pairing requires runtime mutation, so it's downgraded to allowlist with a
// startup warning — handing out codes that never get approved would be worse.
const BOOT_ACCESS: Access | null = STATIC
  ? (() => {
      const a = readAccessFile()
      if (a.dmPolicy === 'pairing') {
        log.warn('static mode — dmPolicy "pairing" downgraded to "allowlist"')
        a.dmPolicy = 'allowlist'
      }
      a.pending = {}
      return a
    })()
  : null

export function loadAccess(): Access {
  return BOOT_ACCESS ?? readAccessFile()
}

// Outbound gate — reply/react/edit can only target chats the inbound gate
// would deliver from. Telegram DM chat_id == user_id, so allowFrom covers DMs.
export function assertAllowedChat(chat_id: string): void {
  if (isAllowedChat(loadAccess(), chat_id)) return
  throw new Error(`chat ${chat_id} is not allowlisted — add via /telegram:access`)
}

export function saveAccess(a: Access): void {
  if (STATIC) return
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = `${ACCESS_FILE}.tmp`
  writeFileSync(tmp, `${JSON.stringify(a, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

// LOCAL PATCH: remember groups that messaged us without being allowlisted, so
// the operator can find the id to pass to `/telegram:access group add`.
function noteUnlistedGroup(id: string, title?: string): void {
  const file = join(STATE_DIR, 'unlisted-groups.json')
  let seen: Record<string, { title?: string; lastSeen: string }> = {}
  try {
    seen = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    ignored(`read ${file}`, err)
  }
  seen[id] = { title, lastSeen: new Date().toISOString() }
  try {
    writeFileSync(file, `${JSON.stringify(seen, null, 2)}\n`, { mode: 0o600 })
  } catch (err) {
    ignored(`write ${file}`, err)
  }
}

/** Inbound gate for a Telegram update; `isMentioned` decides group mentions. */
export function gate(ctx: Context, isMentioned: (ctx: Context, patterns?: string[]) => boolean): GateResult {
  const access = loadAccess()
  const d = decideInbound(
    access,
    {
      senderId: ctx.from ? String(ctx.from.id) : undefined,
      chatId: ctx.chat ? String(ctx.chat.id) : undefined,
      chatType: ctx.chat?.type,
      mentioned: patterns => isMentioned(ctx, patterns),
    },
    Date.now(),
    () => randomBytes(3).toString('hex'), // 6 hex chars
  )
  if (d.changed) saveAccess(access)
  if (d.unlistedGroup) noteUnlistedGroup(d.unlistedGroup, (ctx.chat as { title?: string } | undefined)?.title)
  return d.result
}

// Like gate() but for bot commands: no pairing side effects, just allow/drop.
export function dmCommandGate(ctx: Context): { access: Access; senderId: string } | null {
  // LOCAL PATCH: a topic session also takes commands from its own topic.
  if (ctx.chat?.type !== 'private' && TOPIC_CHAT && String(ctx.chat?.id) === TOPIC_CHAT && ctx.from) {
    const access = loadAccess()
    const policy = access.groups[TOPIC_CHAT]
    if (!policy) return null
    const senderId = String(ctx.from.id)
    const allowed = policy.allowFrom?.length ? policy.allowFrom : access.allowFrom
    return allowed.includes(senderId) ? { access, senderId } : null
  }
  if (ctx.chat?.type !== 'private') return null
  if (!ctx.from) return null
  const senderId = String(ctx.from.id)
  const access = loadAccess()
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access)
  if (access.dmPolicy === 'disabled') return null
  if (access.dmPolicy === 'allowlist' && !access.allowFrom.includes(senderId)) return null
  return { access, senderId }
}

// The /telegram:access skill drops a file at approved/<senderId> when it pairs
// someone. Poll for it, send confirmation, clean up. For Telegram DMs,
// chatId == senderId, so we can send directly without stashing chatId.

function checkApprovals(bot: Bot): void {
  let files: string[]
  try {
    files = readdirSync(APPROVED_DIR)
  } catch {
    return
  }
  if (files.length === 0) return

  for (const senderId of files) {
    const file = join(APPROVED_DIR, senderId)
    void bot.api.sendMessage(senderId, t('pairApproved')).then(
      () => rmSync(file, { force: true }),
      err => {
        log.warn('failed to send approval confirm', err)
        // Remove anyway — don't loop on a broken send.
        rmSync(file, { force: true })
      },
    )
  }
}

/** Confirm new pairings made by the /telegram:access skill. */
export function startApprovalPolling(bot: Bot): void {
  if (!STATIC) setInterval(() => checkApprovals(bot), 5000).unref()
}
