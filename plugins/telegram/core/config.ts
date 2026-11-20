// Configuration shared by the channel server's modules: where state lives,
// the .env file, logging, and how this process was started (channel mode,
// router slot, forum topic). Importing it loads .env into process.env.

import { chmodSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { translator } from '../lib/i18n.ts'
import { createLogger, parseLevel } from '../lib/log.ts'

const STATE_DIR = process.env.TELEGRAM_STATE_DIR
  ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'channels', 'telegram')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const APPROVED_DIR = join(STATE_DIR, 'approved')
const ENV_FILE = join(STATE_DIR, '.env')

// Load ~/.claude/channels/telegram/.env into process.env. Real env wins.
// Plugin-spawned servers don't get an env block — this is where the token lives.
let envError: unknown
try {
  // Token is a credential — lock to owner. No-op on Windows (would need ACLs).
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch (err) {
  envError = err
}

// Leveled log to stderr and ~/.claude/channels/telegram/logs/server-<slot>.log.
// TELEGRAM_LOG_LEVEL=debug also shows errors that are expected and ignored.
const log = createLogger('telegram channel', {
  level: parseLevel(process.env.TELEGRAM_LOG_LEVEL),
  file: join(STATE_DIR, 'logs', `server-${process.env.TELEGRAM_SLOT || 'main'}.log`),
})
if (envError) log.debug(`could not read ${ENV_FILE}`, envError)

/** Log an error that the code deliberately carries on after. A missing file is
 *  normal (debug); anything else is worth a warning. */
function ignored(what: string, err: unknown): void {
  const code = (err as { code?: unknown })?.code
  if (code === 'ENOENT' || code === 'ESRCH') log.debug(what, err)
  else log.warn(what, err)
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
const STATIC = process.env.TELEGRAM_ACCESS_MODE === 'static'
const INBOX_DIR = join(STATE_DIR, 'inbox')
const PID_FILE = join(STATE_DIR, 'bot.pid')

// LOCAL PATCH: only poll Telegram when this session actually loaded us as a
// channel. The plugin is enabled user-wide, so every Claude Code session on
// the host (background `claude --bg` sessions, an ad-hoc `claude` over SSH…)
// spawns this server too. Without this check each of them would SIGTERM the
// real channel's poller below and steal the bot token.
//
// Detection walks up the process tree to the owning Claude Code process and
// looks for `--channels` / `--dangerously-load-development-channels` naming
// this plugin. TELEGRAM_CHANNEL_MODE=always|never overrides; if no Claude
// ancestor is found we fall back to polling (upstream behaviour).
function detectChannelMode(): { poll: boolean; reason: string; claudePid?: number } {
  const override = process.env.TELEGRAM_CHANNEL_MODE
  if (override === 'always') {
    // TELEGRAM_CLAUDE_PID names the owning Claude Code process when it cannot be found (tests).
    const pid = Number(process.env.TELEGRAM_CLAUDE_PID) || undefined
    return { poll: true, reason: 'TELEGRAM_CHANNEL_MODE=always', ...(pid ? { claudePid: pid } : {}) }
  }
  if (override === 'never') return { poll: false, reason: 'TELEGRAM_CHANNEL_MODE=never' }
  let pid = process.ppid
  for (let depth = 0; depth < 12 && pid > 1; depth++) {
    let line: string
    try {
      line = execFileSync('ps', ['-o', 'ppid=,args=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch {
      break
    }
    const m = /^(\d+)\s+(.*)$/s.exec(line)
    if (!m) break
    const args = m[2]
    const exe = args.split(/\s+/)[0] ?? ''
    const isClaude = /(^|\/)claude$/.test(exe) || /\/claude\/versions\/[^/\s]+$/.test(exe)
    if (isClaude) {
      const hasFlag = /--(channels|dangerously-load-development-channels)\b/.test(args)
      const namesUs = /\bplugin:telegram@|\bserver:telegram\b/.test(args)
      return hasFlag && namesUs
        ? { poll: true, reason: `channel enabled in claude pid=${pid}`, claudePid: pid }
        : { poll: false, reason: `claude pid=${pid} did not load telegram as a channel`, claudePid: pid }
    }
    pid = parseInt(m[1], 10)
  }
  return { poll: true, reason: 'no Claude Code ancestor found, polling as upstream does' }
}
const channelMode = detectChannelMode()

// LOCAL PATCH: router mode. With TELEGRAM_ROUTER_SOCKET set, router.ts is the
// only process polling Telegram; it starts one Claude Code session per forum
// topic (plus `main` for direct messages) and forwards each session the raw
// updates for its topic over a unix socket. This server then feeds them to
// grammy with bot.handleUpdate() instead of polling, so every handler below
// works unchanged. Sending still goes straight to the Bot API.
//   TELEGRAM_SLOT          name of this session's slot (default "main")
//   TELEGRAM_TOPIC_CHAT    forum group this session is bound to
//   TELEGRAM_TOPIC_THREAD  message_thread_id of its topic
const ROUTER_SOCKET = process.env.TELEGRAM_ROUTER_SOCKET || undefined
const SLOT = process.env.TELEGRAM_SLOT || 'main'
const TOPIC_CHAT = process.env.TELEGRAM_TOPIC_CHAT || undefined
const TOPIC_THREAD = Number(process.env.TELEGRAM_TOPIC_THREAD) || undefined
const routed = channelMode.poll && !!ROUTER_SOCKET

// Bot API base URL: a self-hosted Bot API server, or a fake one in tests.
const API_ROOT = (process.env.TELEGRAM_API_ROOT || 'https://api.telegram.org').replace(/\/+$/, '')

export {
  ACCESS_FILE, API_ROOT, APPROVED_DIR, channelMode, ENV_FILE, ignored, INBOX_DIR, log, PID_FILE, ROUTER_SOCKET, routed, SLOT,
  STATE_DIR, STATIC, TOKEN, TOPIC_CHAT, TOPIC_THREAD,
}

/** Translator for what the bot shows in the chat (lib/i18n.ts, /language). */
export const t = translator(STATE_DIR)
