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
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(CLAUDE_DIR, 'channels', 'telegram')
const RELAY_GRACE_MS = 10_000 // a relay this recent means the chat already has buttons

type HookInput = {
  hook_event_name?: string
  notification_type?: string
  message?: string
  title?: string
  transcript_path?: string
}

/** Same detection as server.ts: is our Claude ancestor running us as a channel? */
function isChannelSession(): boolean {
  const override = process.env.TELEGRAM_CHANNEL_MODE
  if (override === 'always') return true
  if (override === 'never') return false
  let pid = process.ppid
  for (let depth = 0; depth < 12 && pid > 1; depth++) {
    let line: string
    try {
      line = execFileSync('ps', ['-o', 'ppid=,args=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch {
      return false
    }
    const m = /^(\d+)\s+(.*)$/s.exec(line)
    if (!m) return false
    const args = m[2]!
    const exe = args.split(/\s+/)[0] ?? ''
    if (/(^|\/)claude$/.test(exe) || /\/claude\/versions\/[^/\s]+$/.test(exe)) {
      return (
        /--(channels|dangerously-load-development-channels)\b/.test(args) &&
        /\bplugin:telegram@|\bserver:telegram\b/.test(args)
      )
    }
    pid = parseInt(m[1]!, 10)
  }
  return false
}

function readToken(): string | undefined {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN
  try {
    for (const line of readFileSync(join(STATE_DIR, '.env'), 'utf8').split('\n')) {
      const m = /^TELEGRAM_BOT_TOKEN=(.*)$/.exec(line)
      if (m) return m[1]!.trim()
    }
  } catch {}
  return undefined
}

function recipients(): string[] {
  try {
    const access = JSON.parse(readFileSync(join(STATE_DIR, 'access.json'), 'utf8'))
    return Array.isArray(access.allowFrom) ? access.allowFrom.map(String) : []
  } catch {
    return []
  }
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
    if (!line || !line.includes('"tool_use"')) continue
    try {
      const e = JSON.parse(line)
      const uses = (e.message?.content ?? []).filter((c: any) => c?.type === 'tool_use')
      const u = uses[uses.length - 1]
      if (!u) continue
      const input = u.input ?? {}
      const detail = input.description ?? input.command ?? input.file_path ?? input.url ?? ''
      const one = String(detail).replace(/\s+/g, ' ').trim()
      return `${u.name}${one ? `: ${one.length > 200 ? one.slice(0, 199) + '…' : one}` : ''}`
    } catch {}
  }
  return undefined
}

async function main(): Promise<void> {
  if (process.env.TELEGRAM_NOTIFY === 'off') return
  let input: HookInput = {}
  try {
    input = JSON.parse(await new Response(Bun.stdin.stream()).text())
  } catch {}
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
    const last = Number(readFileSync(join(STATE_DIR, 'last-permission-relay'), 'utf8'))
    if (Date.now() - last < RELAY_GRACE_MS) return
  } catch {}

  const token = readToken()
  const chats = recipients()
  if (!token || !chats.length) return

  const tool = lastToolCall(input.transcript_path)
  const lines = ['⚠️ Claude is waiting for you at the terminal']
  if (message) lines.push(`“${message}”`)
  if (tool) lines.push(`Last step: ${tool}`)
  lines.push('', 'This prompt can only be answered in the terminal. If nobody answers, Claude Code denies it after a timeout.')
  const text = lines.join('\n')

  await Promise.all(
    chats.map(chat_id =>
      fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id, text }),
      }).catch(() => undefined),
    ),
  )
}

await main()
