// Permission relay: Claude Code's permission prompts as Telegram buttons
// (Allow / Deny / Always allow / See more) and the answers back as verdicts.
// "Always allow" works with hooks/permission-telegram.ts (see lib/remember.ts).

import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { type Bot, InlineKeyboard } from 'grammy'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Access } from '../lib/access.ts'
import { clip } from '../lib/format.ts'
import { addRemembered, findPending, loadList, type PendingPrompt, pendingFile, promptLabel, type Remembered, rememberedFile, saveList } from '../lib/remember.ts'
import { ignored, log, SLOT, STATE_DIR, TOPIC_CHAT } from './config.ts'

// Stores full permission details for "See more" expansion keyed by request_id.
const pendingPermissions = new Map<string, { tool_name: string; description: string; input_preview: string }>()

// Receive permission_request from CC → format → send to all allowlisted DMs.
// Groups are intentionally excluded — the security thread resolution was
// "single-user mode for official plugins." Anyone in access.allowFrom
// already passed explicit pairing; group members haven't.
export function relayPermissionRequests(mcp: Server, bot: Bot, loadAccess: () => Access): void {
  mcp.setNotificationHandler(
    z.object({
      method: z.literal('notifications/claude/channel/permission_request'),
      params: z.object({
        request_id: z.string(),
        tool_name: z.string(),
        description: z.string(),
        input_preview: z.string(),
      }),
    }),
    async ({ params }) => {
      const { request_id, tool_name, description, input_preview } = params
      pendingPermissions.set(request_id, { tool_name, description, input_preview })
      // Lets hooks/notify-telegram.ts skip prompts we already relayed with buttons.
      try {
        writeFileSync(join(STATE_DIR, SLOT === 'main' ? 'last-permission-relay' : `last-permission-relay-${SLOT}`), String(Date.now()))
      } catch (err) {
        ignored('write last-permission-relay', err)
      }
      const access = loadAccess()
      const text = `🔐 Permission: ${tool_name}`
      const keyboard = new InlineKeyboard()
        .text('See more', `perm:more:${request_id}`)
        .text('✅ Allow', `perm:allow:${request_id}`)
        .text('❌ Deny', `perm:deny:${request_id}`)
        .row()
        .text('🔁 Always allow', `perm:always:${request_id}`)
      // LOCAL PATCH: a topic session asks in its own topic.
      for (const chat_id of TOPIC_CHAT ? [TOPIC_CHAT] : access.allowFrom) {
        void bot.api.sendMessage(chat_id, text, { reply_markup: keyboard }).catch(e => {
          log.warn(`permission_request send to ${chat_id} failed`, e)
        })
      }
    },
  )
}

/**
 * Remember the answer to a relayed prompt; returns what was remembered, or
 * undefined when the hook left no record of it.
 */
function rememberPrompt(details: { tool_name: string; input_preview: string } | undefined): string | undefined {
  if (!details) return undefined
  try {
    const now = Date.now()
    const prompt = findPending(loadList<PendingPrompt>(pendingFile(STATE_DIR, SLOT)), details.tool_name, details.input_preview, now)
    if (!prompt) return undefined
    const file = rememberedFile(STATE_DIR, SLOT)
    saveList(file, addRemembered(loadList<Remembered>(file), prompt, now))
    log.info(`always allow: ${promptLabel(prompt)}`)
    return promptLabel(prompt)
  } catch (err) {
    log.warn('remember permission answer', err)
    return undefined
  }
}

export function handlePermissionButtons(mcp: Server, bot: Bot, loadAccess: () => Access): void {
  // Button presses on permission prompts. Callback data is
  // `perm:allow:<id>`, `perm:deny:<id>`, `perm:always:<id>` or `perm:more:<id>`.
  // Security mirrors the text-reply path: allowFrom must contain the sender.
  bot.on('callback_query:data', async (ctx, next) => {
    const data = ctx.callbackQuery.data
    const m = /^perm:(allow|deny|always|more):([a-km-z]{5})$/.exec(data)
    // LOCAL PATCH: let later handlers (quick buttons, Stop) see other data;
    // a catch-all at the end still answers anything nobody handled.
    if (!m) return next()
    const access = loadAccess()
    const senderId = String(ctx.from.id)
    if (!access.allowFrom.includes(senderId)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
      return
    }
    const [, choice, request_id] = m
    const behavior = choice === 'always' ? 'allow' : choice

    if (behavior === 'more') {
      const details = pendingPermissions.get(request_id)
      if (!details) {
        await ctx.answerCallbackQuery({ text: 'Details no longer available.' }).catch(() => {})
        return
      }
      const { tool_name, description, input_preview } = details
      let prettyInput: string
      try {
        prettyInput = JSON.stringify(JSON.parse(input_preview), null, 2)
      } catch {
        prettyInput = input_preview
      }
      const expanded =
        `🔐 Permission: ${tool_name}\n\n` +
        `tool_name: ${tool_name}\n` +
        `description: ${description}\n` +
        `input_preview:\n${prettyInput}`
      const keyboard = new InlineKeyboard()
        .text('✅ Allow', `perm:allow:${request_id}`)
        .text('❌ Deny', `perm:deny:${request_id}`)
        .row()
        .text('🔁 Always allow', `perm:always:${request_id}`)
      await ctx.editMessageText(expanded, { reply_markup: keyboard }).catch(() => {})
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }

    // "Always allow": mark the prompt the PermissionRequest hook recorded, so
    // the hook allows the same kind of prompt by itself from now on.
    let remembered: string | undefined
    if (choice === 'always') remembered = rememberPrompt(pendingPermissions.get(request_id))
    void mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id, behavior },
    })
    pendingPermissions.delete(request_id)
    const label =
      behavior === 'deny' ? '❌ Denied' :
      choice !== 'always' ? '✅ Allowed' :
      remembered ? `✅ Allowed · won't ask again in this conversation for: ${remembered}` :
      '✅ Allowed (once: nothing to remember for this prompt)'
    await ctx.answerCallbackQuery({ text: clip(label, 190) }).catch(() => {})
    // Replace buttons with the outcome so the same request can't be answered
    // twice and the chat history shows what was chosen.
    const msg = ctx.callbackQuery.message
    if (msg && 'text' in msg && msg.text) {
      await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {})
    }
  })
}
