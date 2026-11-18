#!/usr/bin/env bun
/**
 * tmux session helper for the Telegram channel plugin.
 *
 * Claude Code's /clear, /usage, /model and /effort only exist inside its
 * interactive terminal. When Claude runs inside tmux, this helper performs
 * them on the user's behalf: it waits until the session is idle, types the
 * command into the session's tmux pane, reads the result from the screen and
 * reports it to the Telegram chat.
 *
 * The plugin runs it when TELEGRAM_COMMAND_HELPER=builtin and passes context
 * through the environment:
 *   TELEGRAM_HELPER_CLAUDE_PID  pid of the Claude Code process to drive
 *   TELEGRAM_HELPER_CHAT_ID     chat to report to
 *   TELEGRAM_BOT_TOKEN          bot token
 *   TELEGRAM_STATE_DIR          plugin state dir (log and lock file)
 *
 * Usage: tmux-session-helper.ts new | usage | model [name] | effort [level]
 *
 * The first invocation returns immediately and re-runs itself detached, so
 * the plugin never waits on a busy session. Jobs are serialised with a lock.
 */
import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, openSync, closeSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(CLAUDE_DIR, 'channels', 'telegram')
const LOG = join(STATE_DIR, 'session-helper.log')
const LOCK = join(STATE_DIR, `session-helper-${process.env.TELEGRAM_HELPER_CLAUDE_PID ?? 'x'}.lock`)
const PID = process.env.TELEGRAM_HELPER_CLAUDE_PID ?? ''
const CHAT = process.env.TELEGRAM_HELPER_CHAT_ID ?? ''
const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? ''
const THREAD = Number(process.env.TELEGRAM_TOPIC_THREAD) || undefined

const MODELS = ['default', 'fable', 'opus', 'sonnet', 'haiku']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'auto']
const SAFE_ARG = /^[A-Za-z0-9._:-]{1,40}$/

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function log(msg: string): void {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {}
}

async function tg(method: string, body: Record<string, unknown>): Promise<void> {
  if (!TOKEN || !CHAT) return
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT,
        // Topic sessions report into their own topic.
        ...(THREAD && CHAT === process.env.TELEGRAM_TOPIC_CHAT ? { message_thread_id: THREAD } : {}),
        ...body,
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) log(`${method} failed: HTTP ${res.status}`)
  } catch (err) {
    log(`${method} failed: ${err instanceof Error ? err.name : 'error'}`)
  }
}

const send = (text: string, reply_markup?: unknown) =>
  tg('sendMessage', reply_markup ? { text, reply_markup } : { text })

// ---- Claude session and tmux --------------------------------------------

function session(): { status?: string; tmux?: string } | undefined {
  try {
    return JSON.parse(readFileSync(join(CLAUDE_DIR, 'sessions', `${PID}.json`), 'utf8'))
  } catch {
    return undefined
  }
}

/** "claude:@0.%0" → "%0" (tmux pane ids are valid targets on their own). */
function paneTarget(): string | undefined {
  const t = session()?.tmux
  if (!t) return undefined
  const pane = /%\d+/.exec(t)
  return pane ? pane[0] : t
}

function tmux(...args: string[]): string {
  return execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

const capture = (pane: string) => tmux('capture-pane', '-t', pane, '-p')

async function typeCommand(pane: string, text: string): Promise<void> {
  tmux('send-keys', '-t', pane, '-l', text)
  await sleep(1000)
  tmux('send-keys', '-t', pane, 'Enter')
}

/** Idle for 3 consecutive seconds, waiting up to 10 minutes. */
async function waitIdle(): Promise<boolean> {
  let ok = 0
  for (let i = 0; i < 600; i++) {
    if (session()?.status === 'idle') {
      if (++ok >= 3) return true
    } else {
      ok = 0
    }
    await sleep(1000)
  }
  return false
}

// ---- jobs ------------------------------------------------------------------

async function jobNew(pane: string): Promise<void> {
  await typeCommand(pane, '/clear')
  await sleep(3000)
  log('new: typed /clear')
  await send('🆕 Started a new conversation. The previous context was cleared.')
}

function parseUsage(screen: string): string | undefined {
  const lines: string[] = []
  let grab = false
  for (const raw of screen.split('\n')) {
    const s = raw.trim()
    if (s.startsWith('Current session')) grab = true
    if (s.startsWith('What') && s.includes('contributing')) break
    if (!grab) continue
    const clean = s.replace(/[▀-▟■-◿]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
    if (clean) lines.push(clean)
  }
  if (!lines.length) return undefined

  const items: { title: string; pct?: string; reset?: string }[] = []
  for (const s of lines) {
    if (s.startsWith('Current ')) items.push({ title: s })
    else if (items.length && /\d+% used/.test(s)) items[items.length - 1].pct = /(\d+)% used/.exec(s)![1]
    else if (items.length && s.startsWith('Resets')) items[items.length - 1].reset = s.slice('Resets'.length).trim()
  }
  if (!items.length) return ['📊 Claude usage', ...lines].join('\n')
  return [
    '📊 Claude usage',
    ...items.map(it => `${it.title}: ${it.pct ? `${it.pct}% used` : 'percentage not found'}${it.reset ? ` (resets ${it.reset})` : ''}`),
  ].join('\n')
}

async function jobUsage(pane: string): Promise<void> {
  let text: string | undefined
  for (let attempt = 0; attempt < 2 && !text; attempt++) {
    if (attempt > 0 && !(await waitIdle())) break
    // The panel is tall; a small window cuts it off. Enlarge, read, restore.
    let resized = false
    const [w, h] = tmux('display-message', '-p', '-t', pane, '#{window_width} #{window_height}').trim().split(' ').map(Number)
    if ((w ?? 0) < 100 || (h ?? 0) < 45) {
      try {
        tmux('resize-window', '-t', pane, '-x', '140', '-y', '50')
        resized = true
        await sleep(1000)
      } catch {}
    }
    await typeCommand(pane, '/usage')
    await sleep(4000)
    const screen = capture(pane)
    tmux('send-keys', '-t', pane, 'Escape')
    await sleep(1000)
    if (resized) {
      try {
        tmux('set-option', '-w', '-u', '-t', pane, 'window-size')
      } catch {}
    }
    text = parseUsage(screen)
  }
  log(`usage: ${text ? 'read panel' : 'panel not found'}`)
  await send(text ?? '⚠️ Could not read the usage panel. Try again in a moment.')
}

/** Text Claude Code printed below the last `❯ <cmd>` echo, if it is new. */
function slashOutput(screen: string, cmd: string, minEchoes: number): string {
  const lines = screen.split('\n')
  let idx = -1
  let seen = 0
  lines.forEach((ln, i) => {
    if (ln.trim() === `❯ ${cmd}`) {
      idx = i
      seen++
    }
  })
  if (idx < 0 || seen < minEchoes) return ''
  const parts: string[] = []
  for (const ln of lines.slice(idx + 1)) {
    const s = ln.trim()
    if (!s || s.startsWith('❯')) break
    parts.push(s.replace(/^⎿/, '').trim())
  }
  return parts.filter(Boolean).join(' ')
}

function describeSlash(cmd: string, out: string): string {
  let m: RegExpExecArray | null
  if (!out) return `⚠️ Typed ${cmd} but could not read the result. Try again in a moment.`
  m = /Set model to (.+?) and saved as your default/.exec(out)
  if (m) return `✅ Model switched to ${m[1]} (saved as default)`
  m = /Kept model as (.+)/.exec(out)
  if (m) return `ℹ️ Model unchanged: ${m[1]}`
  m = /Model '(.+)' not found/.exec(out)
  if (m) return `⚠️ Unknown model: ${m[1]}\nOptions: ${MODELS.join(', ')}`
  m = /Set effort level to (\w+)/.exec(out)
  if (m) return `✅ Effort set to ${m[1]} (saved as default)`
  if (out.startsWith('Effort level set to auto')) return '✅ Effort set to auto'
  if (out.startsWith('Invalid argument')) return `⚠️ Invalid level. Options: ${EFFORTS.join(', ')}`
  return `ℹ️ ${out}`
}

async function jobSlash(pane: string, cmd: string): Promise<void> {
  const escaped = cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const before = (capture(pane).match(new RegExp(`^❯ ${escaped}\\s*$`, 'gm')) ?? []).length
  await typeCommand(pane, cmd)
  let out = ''
  let confirmed = false
  let screen = ''
  for (let i = 0; i < 8; i++) {
    await sleep(1500)
    screen = capture(pane)
    // Switching model mid-conversation asks "Switch model?" with Yes preselected.
    if (!confirmed && screen.includes('Switch model?')) {
      tmux('send-keys', '-t', pane, 'Enter')
      confirmed = true
      continue
    }
    out = slashOutput(screen, cmd, before + 1)
    if (out) break
  }
  // Older echoes may have scrolled away, which breaks the count; retry once.
  if (!out) out = slashOutput(screen, cmd, 1)
  if (!out) tmux('send-keys', '-t', pane, 'Escape') // close any panel left open
  let msg = describeSlash(cmd, out)
  if (confirmed && msg.startsWith('✅ Model')) msg += '\nThe new model re-reads the conversation, so the next reply may be slower.'
  log(`slash: ${cmd} -> ${msg.split('\n')[0]}`)
  await send(msg, { remove_keyboard: true })
}

// ---- entry -----------------------------------------------------------------

function acquireLock(): boolean {
  try {
    const st = statSync(LOCK)
    if (Date.now() - st.mtimeMs < 15 * 60_000) return false // another job is running
    rmSync(LOCK) // stale lock from a crashed job
  } catch {}
  try {
    const fd = openSync(LOCK, 'wx') // atomic: fails if another job just took it
    writeFileSync(fd, String(process.pid))
    closeSync(fd)
    return true
  } catch {
    return false
  }
}

async function runJob(command: string, arg: string): Promise<void> {
  for (let i = 0; i < 900 && !acquireLock(); i++) await sleep(1000)
  try {
    if (!(await waitIdle())) {
      await send(`⚠️ The session stayed busy, so /${command} was not run. Try again later.`)
      return
    }
    const pane = paneTarget()
    if (!pane) {
      await send(`⚠️ /${command} needs Claude Code running inside tmux.`)
      return
    }
    if (command === 'new') await jobNew(pane)
    else if (command === 'usage') await jobUsage(pane)
    else await jobSlash(pane, `/${command} ${arg}`)
  } catch (err) {
    log(`job ${command} failed: ${err}`)
    await send(`⚠️ /${command} failed: ${err instanceof Error ? err.message.split('\n')[0] : 'unknown error'}`)
  } finally {
    try {
      rmSync(LOCK)
    } catch {}
  }
}

async function main(): Promise<void> {
  const [command = '', arg = '', detached] = process.argv.slice(2)
  if (!PID || !CHAT) {
    console.error('missing TELEGRAM_HELPER_CLAUDE_PID or TELEGRAM_HELPER_CHAT_ID')
    process.exit(2)
  }
  if (!['new', 'usage', 'model', 'effort'].includes(command)) {
    console.error('usage: tmux-session-helper.ts new | usage | model [name] | effort [level]')
    process.exit(2)
  }
  if (arg && !SAFE_ARG.test(arg)) {
    console.error('argument may only contain letters, digits and . _ : -')
    process.exit(2)
  }

  if ((command === 'model' || command === 'effort') && !arg) {
    // The plugin shows the picker itself; a bare call has nothing to apply.
    console.error(`/${command} needs an argument`)
    process.exit(2)
  }

  if (detached !== '--job') {
    const child = spawn(process.execPath, [process.argv[1]!, command, arg, '--job'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    child.unref()
    return
  }
  await runJob(command, arg)
}

void main()
