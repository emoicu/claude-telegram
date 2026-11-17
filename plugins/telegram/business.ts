/**
 * Telegram Business support: customers who message a connected account get a
 * reply drafted by Claude, and the owner approves each draft before it goes
 * out under that account's name.
 *
 * Router mode only. The pieces:
 *   - router.ts polls the business_* updates and calls the functions below.
 *   - An account that connects the bot (Telegram Settings → Telegram
 *     Business → Chatbots, with Secretary Mode on in @BotFather) must be on
 *     the business allowlist. Accounts listed in access.json allowFrom are
 *     allowed automatically; any other account triggers a prompt in the
 *     owner's DM with ✅ Allow / ❌ Deny buttons. Only allowFrom users can
 *     press them, and the router handles them itself, never Claude.
 *   - Customer messages from allowed accounts go to one forum topic
 *     ("💼 Customers") whose session runs with built-in tools turned off
 *     (TELEGRAM_BUSINESS_TOOLS, default none): customer text is untrusted.
 *   - That session drafts with the business_draft tool (server.ts). The
 *     draft is posted in the topic with ✅ Send / ❌ Discard buttons, again
 *     handled by the router, so a draft can be sent even after the session
 *     stopped.
 *
 * State: <state dir>/business.json (accounts, connections, known customer
 * chats, the topic) and business-drafts.json.
 */
import { readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

export const BUSINESS_UPDATES = ['business_connection', 'business_message', 'edited_business_message']

export type Account = { name: string; status: 'allowed' | 'denied' | 'pending' }
export type Connection = { userId: string; enabled: boolean; canReply: boolean }
export type CustomerChat = { conn: string; name: string; lastAt: number }
export type Store = {
  accounts: Record<string, Account>
  connections: Record<string, Connection>
  chats: Record<string, CustomerChat>
  topic?: { chat: string; thread: number }
}
export type Draft = {
  conn: string
  chat: string
  text: string
  replyTo?: number
  created: number
  state: 'pending' | 'sent' | 'discarded'
}

const DRAFT_KEEP_MS = 7 * 24 * 3600_000
const CHAT_KEEP_MS = 30 * 24 * 3600_000

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(path: string, value: unknown): void {
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

export function storePath(stateDir: string): string {
  return join(stateDir, 'business.json')
}

export function loadStore(stateDir: string): Store {
  const s = readJson<Partial<Store>>(storePath(stateDir), {})
  return { accounts: s.accounts ?? {}, connections: s.connections ?? {}, chats: s.chats ?? {}, topic: s.topic }
}

export function saveStore(stateDir: string, s: Store): void {
  const cutoff = Date.now() - CHAT_KEEP_MS
  for (const [id, c] of Object.entries(s.chats)) if (c.lastAt < cutoff) delete s.chats[id]
  writeJson(storePath(stateDir), s)
}

const draftsPath = (stateDir: string) => join(stateDir, 'business-drafts.json')

export function loadDrafts(stateDir: string): Record<string, Draft> {
  return readJson<Record<string, Draft>>(draftsPath(stateDir), {})
}

export function saveDrafts(stateDir: string, d: Record<string, Draft>): void {
  const cutoff = Date.now() - DRAFT_KEEP_MS
  for (const [id, x] of Object.entries(d)) if (x.created < cutoff) delete d[id]
  writeJson(draftsPath(stateDir), d)
}

/** Is this connection usable: enabled, and its account allowed? */
export function allowedConnection(s: Store, conn: string): Connection | undefined {
  const c = s.connections[conn]
  if (!c || !c.enabled) return undefined
  return s.accounts[c.userId]?.status === 'allowed' ? c : undefined
}

export function personName(u: { first_name?: string; last_name?: string; username?: string; id?: number } | undefined): string {
  if (!u) return 'unknown'
  const full = [u.first_name, u.last_name].filter(Boolean).join(' ')
  return full || (u.username ? `@${u.username}` : String(u.id ?? 'unknown'))
}

/** Short text for a message of any kind. */
export function describeMessage(m: any): string {
  const body = m.text ?? m.caption ?? ''
  const kinds = ['photo', 'video', 'voice', 'audio', 'document', 'sticker', 'video_note', 'location', 'contact']
  const kind = kinds.find(k => k in m)
  const label = kind === 'sticker' ? `(sticker ${m.sticker?.emoji ?? ''})`.replace(' )', ')') : kind ? `(${kind.replace('_', ' ')})` : ''
  return [label, body].filter(Boolean).join(' ') || '(empty message)'
}

// ---- router side ------------------------------------------------------------

export type RouterHooks = {
  stateDir: string
  api: (method: string, body?: Record<string, unknown>) => Promise<any>
  log: (msg: string) => void
  owners: () => string[]
  /** A forum group to open the customers' topic in, if any. */
  forumChat: () => string | undefined
  /** Hand an update to the session of this topic, starting it if needed. */
  route: (chat: string, thread: number, title: string, update: unknown) => Promise<void>
  /** Does this topic still exist as a slot? */
  topicExists: (thread: number) => boolean
}

const TOPIC_TITLE = process.env.TELEGRAM_BUSINESS_TOPIC ?? '💼 Customers'

async function tellOwners(h: RouterHooks, text: string, extra: Record<string, unknown> = {}): Promise<void> {
  for (const chat_id of h.owners()) {
    await h.api('sendMessage', { chat_id, text, ...extra }).catch(err => h.log(`business: notify ${chat_id} failed: ${err}`))
  }
}

async function askOwners(h: RouterHooks, s: Store, userId: string, name: string): Promise<void> {
  s.accounts[userId] = { name, status: 'pending' }
  await tellOwners(
    h,
    `🔌 ${name} (id ${userId}) connected this bot to their Telegram Business account.\n\n` +
      'Allow it? Allowed accounts get their customer messages drafted here. Until then their messages are ignored.',
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Allow', callback_data: `biz:allow:${userId}` },
          { text: '❌ Deny', callback_data: `biz:deny:${userId}` },
        ]],
      },
    },
  )
}

/** Record a connection; ask the owners about an account they have not decided on. */
async function noteConnection(h: RouterHooks, s: Store, bc: any): Promise<void> {
  const userId = String(bc.user.id)
  const name = personName(bc.user)
  const canReply = bc.rights?.can_reply ?? bc.can_reply ?? false
  const was = s.connections[bc.id]
  s.connections[bc.id] = { userId, enabled: !!bc.is_enabled, canReply }
  if (!bc.is_enabled) {
    if (was?.enabled) await tellOwners(h, `🔌 ${name} disconnected this bot from their business account.`)
    return
  }
  const acct = s.accounts[userId]
  if (h.owners().includes(userId) && acct?.status !== 'allowed') {
    s.accounts[userId] = { name, status: 'allowed' }
    await tellOwners(h, `✅ Your business account ${name} is connected. Customer messages will show up in the “${TOPIC_TITLE}” topic with a draft reply for you to approve.` + (canReply ? '' : '\n\n⚠️ The bot may not reply yet: turn on “Reply to messages” in Telegram Business → Chatbots.'))
    return
  }
  if (!acct) await askOwners(h, s, userId, name)
  else if (acct.status === 'allowed' && !was?.enabled) {
    acct.name = name
    await tellOwners(h, `✅ ${name} reconnected this bot.` + (canReply ? '' : ' ⚠️ It has no permission to reply.'))
  }
}

async function customerTopic(h: RouterHooks, s: Store): Promise<{ chat: string; thread: number } | undefined> {
  if (s.topic && h.topicExists(s.topic.thread)) return s.topic
  if (s.topic) {
    // The slot is gone (topic deleted, or never seen by this router). Check
    // the topic itself before opening a second one: reopening answers
    // TOPIC_NOT_MODIFIED for an open topic, TOPIC_ID_INVALID for a deleted
    // one, and reopens a closed one (a customer is waiting, so that is fine).
    try {
      await h.api('reopenForumTopic', { chat_id: s.topic.chat, message_thread_id: s.topic.thread })
      return s.topic
    } catch (err) {
      if (!/TOPIC_ID_INVALID|thread not found/i.test(String(err))) return s.topic
    }
    s.topic = undefined
  }
  const chat = h.forumChat()
  if (!chat) return undefined
  try {
    const t = await h.api('createForumTopic', { chat_id: chat, name: TOPIC_TITLE })
    s.topic = { chat, thread: t.message_thread_id }
    h.log(`business: opened topic ${TOPIC_TITLE} (#${t.message_thread_id}) in ${chat}`)
    return s.topic
  } catch (err) {
    h.log(`business: could not open the customers' topic: ${err}`)
    return undefined
  }
}

let warnedNoTopic = false

/** Handle a business_* update. Returns false if it is not one. */
export async function handleBusinessUpdate(u: any, h: RouterHooks): Promise<boolean> {
  const bc = u.business_connection
  const msg = u.business_message ?? u.edited_business_message
  if (!bc && !msg) return false
  const s = loadStore(h.stateDir)
  try {
    if (bc) {
      await noteConnection(h, s, bc)
      return true
    }
    const connId: string = msg.business_connection_id
    if (!s.connections[connId]) {
      // Connected before this router listened for business updates.
      try {
        await noteConnection(h, s, await h.api('getBusinessConnection', { business_connection_id: connId }))
      } catch (err) {
        h.log(`business: unknown connection ${connId}: ${err}`)
        return true
      }
    }
    const conn = allowedConnection(s, connId)
    if (!conn) return true
    // The account owner writing in their own chat (from the phone).
    if (String(msg.from?.id) === conn.userId) return true
    const chatId = String(msg.chat.id)
    const name = personName(msg.from ?? msg.chat)
    s.chats[chatId] = { conn: connId, name, lastAt: Date.now() }
    const topic = await customerTopic(h, s)
    if (!topic) {
      if (!warnedNoTopic) {
        warnedNoTopic = true
        await tellOwners(h, '⚠️ A customer wrote to your business account, but there is no forum group to put the customers’ topic in. Add the bot to a group with topics (as admin, allowed to manage topics).')
      }
      return true
    }
    const account = s.accounts[conn.userId]?.name ?? 'your account'
    const edited = u.edited_business_message ? ' (edited)' : ''
    await h
      .api('sendMessage', {
        chat_id: topic.chat,
        message_thread_id: topic.thread,
        text: `💬 ${name} → ${account}${edited}\n\n${describeMessage(msg)}`.slice(0, 4096),
        disable_notification: false,
      })
      .catch(err => h.log(`business: copy to topic failed: ${err}`))
    await h.route(topic.chat, topic.thread, TOPIC_TITLE, u)
    return true
  } finally {
    saveStore(h.stateDir, s)
  }
}

/** Handle a biz:* button. Returns false if the callback is not one of ours. */
export async function handleBusinessCallback(cq: any, h: RouterHooks): Promise<boolean> {
  const m = /^biz:(allow|deny|send|drop):([\w-]{1,40})$/.exec(cq.data ?? '')
  if (!m) return false
  const answer = (text?: string) => h.api('answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text } : {}) }).catch(() => {})
  if (!h.owners().includes(String(cq.from?.id))) {
    await answer('Not authorized.')
    return true
  }
  const [, action, id] = m as unknown as [string, string, string]
  const where = cq.message ? { chat_id: cq.message.chat.id, message_id: cq.message.message_id } : undefined
  const settle = async (suffix: string) => {
    if (!where) return
    const old: string = cq.message.text ?? ''
    await h.api('editMessageText', { ...where, text: `${old}\n\n${suffix}`.slice(0, 4096) }).catch(() => {})
  }

  if (action === 'allow' || action === 'deny') {
    const s = loadStore(h.stateDir)
    const acct = s.accounts[id] ?? { name: id, status: 'pending' as const }
    acct.status = action === 'allow' ? 'allowed' : 'denied'
    s.accounts[id] = acct
    saveStore(h.stateDir, s)
    h.log(`business: account ${acct.name} (${id}) ${acct.status}`)
    await answer(action === 'allow' ? 'Allowed' : 'Denied')
    await settle(action === 'allow' ? '✅ Allowed. New customer messages will be drafted.' : '❌ Denied. Its messages are ignored.')
    return true
  }

  const drafts = loadDrafts(h.stateDir)
  const d = drafts[id]
  if (!d || d.state !== 'pending') {
    await answer(d ? `Already ${d.state}.` : 'This draft has expired.')
    if (where) await h.api('editMessageReplyMarkup', { ...where, reply_markup: { inline_keyboard: [] } }).catch(() => {})
    return true
  }
  if (action === 'drop') {
    d.state = 'discarded'
    saveDrafts(h.stateDir, drafts)
    await answer('Discarded')
    await settle('❌ Not sent')
    return true
  }
  const s = loadStore(h.stateDir)
  if (!allowedConnection(s, d.conn)) {
    await answer('That account is no longer connected or allowed.')
    return true
  }
  try {
    await h.api('sendMessage', {
      business_connection_id: d.conn,
      chat_id: d.chat,
      text: d.text,
      ...(d.replyTo ? { reply_parameters: { message_id: d.replyTo, allow_sending_without_reply: true } } : {}),
    })
  } catch (err) {
    const why = String(err).replace(/^Error: sendMessage: /, '')
    h.log(`business: sending draft ${id} failed: ${why}`)
    await answer('Sending failed')
    await settle(`⚠️ Not sent: ${why}`)
    return true
  }
  d.state = 'sent'
  saveDrafts(h.stateDir, drafts)
  await answer('Sent')
  await settle('✅ Sent')
  return true
}
