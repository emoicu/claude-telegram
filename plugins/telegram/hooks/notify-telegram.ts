#!/usr/bin/env bun
/**
 * Notification hook: tell the Telegram chat when Claude Code is waiting for
 * someone at the terminal.
 *
 * Some prompts are never relayed to channels, for example Claude Code's
 * built-in safety checks on dangerous commands, which only a person at the
 * terminal may answer. Without this hook the remote user had no idea the
 * session was stuck until the prompt timed out. This only notifies; it never
 * answers a prompt.
 *
 * Runs for every session that has the plugin enabled, so it first checks
 * that its Claude Code process loaded the plugin as a channel (same rule as
 * server.ts). Prompts that server.ts already relayed with Allow/Deny buttons
 * are skipped. TELEGRAM_NOTIFY=off disables it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SLOT, STATE_DIR, botCall, isChannelSession, readHookInput, readToken, targets } from './lib'

const RELAY_GRACE_MS = 10_000 // a relay this recent means the chat already has buttons

type HookInput = {
  hook_event_name?: string
  notification_type?: string
  message?: string
  title?: string
  transcript_path?: string
}

/** Most recent tool call in the transcript, to show what is being asked. */
function lastToolCall(path?: string): string | undefined {
  if (!path) return undefined
  let text: string
  try {
    const buf = readFileSync(path)
    text = buf.subarray(Math.max(0, buf.length - 256 * 1024)).toString('utf8')
  } catch {
    return undefined
  }
  const lines = text.split('\n')
  for (let i = lines.length - 1; i > 0; i--) {
    const line = lines[i]
    if (!line?.includes('"tool_use"')) continue
    try {
      const e = JSON.parse(line)
      const uses = (e.message?.content ?? []).filter((c: any) => c?.type === 'tool_use')
      const u = uses[uses.length - 1]
      if (!u) continue
      const input = u.input ?? {}
      const detail = input.description ?? input.command ?? input.file_path ?? input.url ?? ''
      const one = String(detail).replace(/\s+/g, ' ').trim()
      return `${u.name}${one ? `: ${one.length > 200 ? `${one.slice(0, 199)}…` : one}` : ''}`
    } catch {}
  }
  return undefined
}

async function main(): Promise<void> {
  if (process.env.TELEGRAM_NOTIFY === 'off') return
  const input = (await readHookInput<HookInput>()) ?? {}
  if (input.hook_event_name && input.hook_event_name !== 'Notification') return

  // Only prompts that need a person: permission prompts and MCP elicitation
  // dialogs. Idle reminders and auth notices are ignored.
  const type = input.notification_type
  const message = input.message ?? ''
  const needsPerson = type
    ? type === 'permission_prompt' || type === 'elicitation_dialog'
    : /permission|approv|proceed/i.test(message)
  if (!needsPerson) return
  if (!isChannelSession()) return

  // Give server.ts a moment to relay the prompt itself; if it did, the chat
  // already has Allow/Deny buttons and this would only be noise.
  await new Promise(r => setTimeout(r, 2500))
  try {
    const last = Number(readFileSync(join(STATE_DIR, SLOT === 'main' ? 'last-permission-relay' : `last-permission-relay-${SLOT}`), 'utf8'))
    if (Date.now() - last < RELAY_GRACE_MS) return
  } catch {}

  const token = readToken()
  const chats = targets()
  if (!token || !chats.length) return

  const tool = lastToolCall(input.transcript_path)
  const lines = ['⚠️ Claude is waiting for you at the terminal']
  if (message) lines.push(`“${message}”`)
  if (tool) lines.push(`Last step: ${tool}`)
  lines.push('', 'This prompt can only be answered in the terminal. If nobody answers, Claude Code denies it after a timeout.')
  const text = lines.join('\n')

  await Promise.all(chats.map(t => botCall(token, 'sendMessage', { ...t, text })))
}

await main()
