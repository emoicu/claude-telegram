#!/usr/bin/env bun
/**
 * StopFailure hook: tell the Telegram chat when a turn ends on an API error
 * (rate or usage limit, overload, expired login, billing...).
 *
 * Without it the remote user only saw the bot go quiet. Claude Code ignores
 * this hook's output, so it can only notify. The same error in the same
 * session is reported at most once every ten minutes.
 *
 * Runs for every session that has the plugin enabled, so it first checks
 * that its Claude Code process loaded the plugin as a channel (same rule as
 * server.ts). TELEGRAM_NOTIFY=off disables it.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type FailureInput, failureMessage, takeAlertSlot } from '../lib/failure'
import { SLOT, STATE_DIR, botCall, isChannelSession, readHookInput, readToken, t, targets } from './lib'

const SENT_FILE = join(STATE_DIR, 'failure-alerts.json')

function loadSent(): Record<string, number> {
  try {
    const v = JSON.parse(readFileSync(SENT_FILE, 'utf8'))
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

function saveSent(sent: Record<string, number>): void {
  try {
    const tmp = `${SENT_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify(sent), { mode: 0o600 })
    renameSync(tmp, SENT_FILE)
  } catch {
    // Worst case the next failure is reported again.
  }
}

async function main(): Promise<void> {
  if (process.env.TELEGRAM_NOTIFY === 'off') return
  const input = (await readHookInput<FailureInput & { hook_event_name?: string }>()) ?? {}
  if (input.hook_event_name && input.hook_event_name !== 'StopFailure') return
  if (!isChannelSession()) return

  const sent = loadSent()
  if (!takeAlertSlot(sent, `${SLOT}:${input.error ?? 'unknown'}`, Date.now())) return
  saveSent(sent)

  const token = readToken()
  const chats = targets()
  if (!token || !chats.length) return
  const text = failureMessage(input, t)
  await Promise.all(chats.map(t => botCall(token, 'sendMessage', { ...t, text })))
}

await main()
