/**
 * Shared helpers for the plugin's hook scripts.
 */
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
export const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(CLAUDE_DIR, 'channels', 'telegram')

/**
 * Hooks run for every session that has the plugin enabled. Act only when our
 * Claude Code ancestor loaded the plugin as a channel (same rule as server.ts).
 */
export function isChannelSession(): boolean {
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

export function readToken(): string | undefined {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN
  try {
    for (const line of readFileSync(join(STATE_DIR, '.env'), 'utf8').split('\n')) {
      const m = /^TELEGRAM_BOT_TOKEN=(.*)$/.exec(line)
      if (m) return m[1]!.trim()
    }
  } catch {}
  return undefined
}

/** Allowlisted DM chats (user ids double as private chat ids). */
export function recipients(): string[] {
  try {
    const access = JSON.parse(readFileSync(join(STATE_DIR, 'access.json'), 'utf8'))
    return Array.isArray(access.allowFrom) ? access.allowFrom.map(String) : []
  } catch {
    return []
  }
}

export async function readHookInput<T>(): Promise<T | undefined> {
  try {
    return JSON.parse(await new Response(Bun.stdin.stream()).text()) as T
  } catch {
    return undefined
  }
}

export async function botCall(token: string, method: string, body: Record<string, unknown>): Promise<any> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return await res.json()
  } catch {
    return undefined
  }
}
