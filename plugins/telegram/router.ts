#!/usr/bin/env bun
/**
 * Multi-session router for the Telegram channel plugin.
 *
 * One bot, many Claude Code sessions: direct messages go to the `main`
 * session, and each topic of a forum group gets a session of its own. The
 * router is the only process polling Telegram (one token allows one poller).
 * It starts sessions on demand in tmux windows, resumes the topic's previous
 * conversation with --resume, stops sessions that sit idle, and caps how many
 * run at once from the host's free memory and CPU load.
 *
 * Sessions run server.ts in router mode (TELEGRAM_ROUTER_SOCKET): it
 * connects back over a unix socket, says which slot it is, and receives the
 * raw Telegram updates for that slot. Sending goes straight to the Bot API.
 *
 * Run inside a tmux session (sessions open as windows of it):
 *   tmux new-session -s claude 'bun router.ts'
 *
 * Environment (all optional):
 *   TELEGRAM_ROUTER_TMUX        tmux session for the windows (default: current, else "claude")
 *   TELEGRAM_ROUTER_CLAUDE      command that starts Claude Code with this plugin as a channel
 *                               (default: claude --dangerously-load-development-channels plugin:telegram@emoicu-plugins)
 *   TELEGRAM_ROUTER_MAIN_CWD    working directory of the main session (default: cwd)
 *   TELEGRAM_ROUTER_PROJECTS    a topic named like a folder in here works in that folder (default: main cwd)
 *   TELEGRAM_ROUTER_IDLE_MIN    stop a topic session idle this long (default 30)
 *   TELEGRAM_ROUTER_MAX         hard cap on running sessions (default: no cap besides resources)
 *   TELEGRAM_ROUTER_RESERVE_MB  memory always left free (default: max(1024, 20% of RAM))
 *   TELEGRAM_ROUTER_SESSION_MB  memory per session until one is measured (default 500)
 *   TELEGRAM_ROUTER_PROMPT_SNAPSHOT  passed as --system-prompt-snapshot (default off, so a resumed
 *                               conversation gets the current plugin instructions; empty: Claude's default)
 *   TELEGRAM_ROUTER_SELF_UPDATE 1: exit once a newer version of this plugin is installed, for a
 *                               supervisor loop that restarts the router from the newest copy
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cpus, homedir, loadavg } from 'node:os'
import { basename, join } from 'node:path'
import type { Socket } from 'bun'
import { createLogger, parseLevel } from './lib/log.ts'
import { mdList, mdSpaced, plainMarkdown } from './lib/format.ts'
import { type Key, translator } from './lib/i18n.ts'
import { retryDelayMs } from './lib/retry.ts'
import { deliverDue, scheduleDir, scheduledSender } from './lib/schedule.ts'
import { pollFileSlot } from './lib/polls.ts'
import { isAlive } from './lib/proc.ts'
import { isNewer } from './lib/version.ts'

// ---- config ---------------------------------------------------------------

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(CLAUDE_DIR, 'channels', 'telegram')
const ROUTER_DIR = join(STATE_DIR, 'router')
/** Translator for what the router posts (/language). */
const t = translator(STATE_DIR)
const SOCKET = join(STATE_DIR, 'router.sock')
const SLOTS_FILE = join(ROUTER_DIR, 'slots.json')
const QUEUE_FILE = join(ROUTER_DIR, 'queue.json')
const LOG_FILE = join(ROUTER_DIR, 'router.log')
const OFFSET_FILE = join(ROUTER_DIR, 'offset')

const CLAUDE_CMD = (
  process.env.TELEGRAM_ROUTER_CLAUDE ??
  'claude --dangerously-load-development-channels plugin:telegram@emoicu-plugins'
).split(/\s+/).filter(Boolean)
// tmux runs the command without a shell, so resolve it against our PATH now.
CLAUDE_CMD[0] = Bun.which(CLAUDE_CMD[0]!) ?? CLAUDE_CMD[0]!
const MAIN_CWD = process.env.TELEGRAM_ROUTER_MAIN_CWD ?? process.cwd()
const PROJECTS = process.env.TELEGRAM_ROUTER_PROJECTS ?? MAIN_CWD
const IDLE_MS = Number(process.env.TELEGRAM_ROUTER_IDLE_MIN ?? 30) * 60_000
const MAX_SESSIONS = Number(process.env.TELEGRAM_ROUTER_MAX ?? 0)
const SESSION_MB_DEFAULT = Number(process.env.TELEGRAM_ROUTER_SESSION_MB ?? 500)
const TICK_MS = 3000
const QUICK_EXIT_MS = 60_000 // a session that dies sooner than this "crashed quickly"
const MAX_QUICK_EXITS = 3 // then stop restarting it and tell the user
const DIALOG_WINDOW_MS = 120_000 // look for the development-channels dialog this long
const START_TIMEOUT_MS = 120_000 // a session that has not connected by then is stuck
const UPDATE_CHECK_MS = 30_000 // how often to look for a newer plugin or Claude Code on disk
const VERSION_RUN_MS = 10 * 60_000 // how often to run `claude --version` when its path does not tell
const UPDATE_IDLE_MS = 5 * 60_000 // restart an outdated session only after this much quiet
// Claude Code records a conversation's system prompt (plugin instructions
// included) once and replays it on --resume; off renders it fresh, so a
// session resumed after a plugin update follows the new instructions.
// Measured: the prompt cache still hits across resumes with it off.
const PROMPT_SNAPSHOT = process.env.TELEGRAM_ROUTER_PROMPT_SNAPSHOT ?? 'off'
const SELF_UPDATE = process.env.TELEGRAM_ROUTER_SELF_UPDATE === '1'
const PLUGIN_ID = /plugin:(\S+)/.exec(CLAUDE_CMD.join(' '))?.[1]

function tmuxSessionName(): string {
  if (process.env.TELEGRAM_ROUTER_TMUX) return process.env.TELEGRAM_ROUTER_TMUX
  if (process.env.TMUX) {
    try {
      return tmux('display-message', '-p', '#{session_name}').trim()
    } catch (err) {
      ignored('read the tmux session name', err)
    }
  }
  return 'claude'
}

function readToken(): string {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN
  for (const line of readFileSync(join(STATE_DIR, '.env'), 'utf8').split('\n')) {
    const m = /^TELEGRAM_BOT_TOKEN=(.*)$/.exec(line)
    if (m) return m[1]!.trim()
  }
  throw new Error(`no TELEGRAM_BOT_TOKEN in ${STATE_DIR}/.env`)
}

const TOKEN = readToken()

// ---- small utilities ------------------------------------------------------

mkdirSync(ROUTER_DIR, { recursive: true, mode: 0o700 })

// Leveled log to stderr and router/router.log (rotated at 1 MiB).
// TELEGRAM_LOG_LEVEL=debug also shows errors that are expected and ignored.
const logger = createLogger('telegram router', { level: parseLevel(process.env.TELEGRAM_LOG_LEVEL), file: LOG_FILE })

function log(msg: string): void {
  logger.info(msg)
}

/** Log an error the router deliberately carries on after: a missing file or a
 *  missing tmux target is normal (debug); anything else is a warning. */
function ignored(what: string, err: unknown): void {
  const code = (err as { code?: unknown })?.code
  const text = String((err as { message?: unknown })?.message ?? err)
  if (code === 'ENOENT' || code === 'ESRCH' || /can't find|no server running|not found/i.test(text)) logger.debug(what, err)
  else logger.warn(what, err)
}

function tmux(...args: string[]): string {
  return execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
// Bot API base URL: a self-hosted Bot API server, or a fake one in tests.
const API_ROOT = (process.env.TELEGRAM_API_ROOT || 'https://api.telegram.org').replace(/\/+$/, '')

async function api(method: string, body: Record<string, unknown> = {}): Promise<any> {
  // A half-dead connection would otherwise hang the poll loop for good:
  // allow a long poll its own timeout plus some slack, anything else 30s.
  const limit = method === 'getUpdates' ? (Number(body.timeout ?? 0) + 20) * 1000 : 30_000
  for (let attempt = 0; ; attempt++) {
    let json: any
    try {
      const res = await fetch(`${API_ROOT}/bot${TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(limit),
      })
      json = await res.json().catch(() => ({ ok: false, error_code: res.status, description: `HTTP ${res.status}` }))
    } catch (err) {
      // Rate limits, server errors and dropped connections are retried
      // (see lib/retry.ts); the poll loop handles getUpdates itself.
      const delay = retryDelayMs(method, attempt, { network: true })
      if (delay == null) throw err
      logger.debug(`${method}: ${err}, retrying in ${delay} ms`)
      await sleep(delay)
      continue
    }
    if (json.ok) return json.result
    const delay = retryDelayMs(method, attempt, { status: json.error_code, retryAfter: json.parameters?.retry_after })
    if (delay == null) throw Object.assign(new Error(`${method}: ${json.description}`), { code: json.error_code })
    logger.warn(`${method}: ${json.error_code} ${json.description}, retrying in ${delay} ms`)
    await sleep(delay)
  }
}

/** Fire-and-forget message to a slot's chat (its topic, or every allowlisted DM for main). */
async function notify(slot: Slot, text: string): Promise<number | undefined> {
  const chats = slot.chat ? [slot.chat] : loadAccess().allowFrom
  let id: number | undefined
  for (const chat_id of chats) {
    try {
      const sent = await api('sendMessage', {
        chat_id,
        text,
        ...(slot.thread ? { message_thread_id: slot.thread } : {}),
        disable_notification: true,
      })
      id ??= sent.message_id
    } catch (err) {
      log(`notify ${slot.name} failed: ${err}`)
    }
  }
  return id
}

type Access = { allowFrom: string[]; groups: Record<string, { allowFrom?: string[] }> }
function loadAccess(): Access {
  try {
    const a = JSON.parse(readFileSync(join(STATE_DIR, 'access.json'), 'utf8'))
    return { allowFrom: (a.allowFrom ?? []).map(String), groups: a.groups ?? {} }
  } catch {
    return { allowFrom: [], groups: {} }
  }
}

/** May this user wake a topic session in this group? Mirrors server.ts gate(). */
function allowedInGroup(chatId: string, userId: string): boolean {
  const access = loadAccess()
  const policy = access.groups[chatId]
  if (!policy) return false
  const list = policy.allowFrom?.length ? policy.allowFrom : access.allowFrom
  return list.includes(userId)
}

// ---- slots ----------------------------------------------------------------

type Slot = {
  name: string // "main" or "t<thread id>"
  chat?: string // forum group id (topic slots)
  thread?: number // message_thread_id (topic slots)
  title?: string
  cwd: string
  sessionId?: string // last Claude session, resumed on the next start
  lastActive: number
  pinned?: boolean // never stopped for being idle (main)
  closed?: boolean // topic closed in Telegram
}

type Runtime = {
  pid?: number
  startedAt: number
  stopping?: boolean
  dialogDone?: boolean
  status?: string
  version?: string // Claude Code version the session runs
  updateTo?: string // stopped to pick up this update (e.g. "Claude Code 2.1.330")
  plugin?: string // plugin version its server.ts runs, from its hello
  rssMB?: number
  quickExits: number
  gaveUp?: boolean
  connected?: boolean // has said hello since it started
  startRetried?: boolean // already restarted once for not connecting
  sock?: Socket<SockData>
  queue: unknown[]
  startNotice?: { chat: string; id: number }
  queuedNotice?: boolean
}

type SockData = { slot?: string; out: string }

const slots = new Map<string, Slot>()
const rt = new Map<string, Runtime>()
let dirty = false

function runtime(name: string): Runtime {
  let r = rt.get(name)
  if (!r) {
    r = { startedAt: 0, quickExits: 0, queue: [] }
    rt.set(name, r)
  }
  return r
}

function loadSlots(): void {
  try {
    for (const s of JSON.parse(readFileSync(SLOTS_FILE, 'utf8')) as Slot[]) slots.set(s.name, s)
  } catch (err) {
    ignored('load slots.json', err)
  }
  if (!slots.has('main')) slots.set('main', { name: 'main', cwd: MAIN_CWD, lastActive: Date.now(), pinned: true })
  const main = slots.get('main')!
  main.pinned = true
  // A planned restart (tg-restart-claude) leaves the session to resume here.
  for (const f of ['resume-once', 'last-session']) {
    const p = join(STATE_DIR, f)
    try {
      const sid = readFileSync(p, 'utf8').trim()
      if (f === 'resume-once') rmSync(p)
      if (sid && !main.sessionId) main.sessionId = sid
      if (sid && f === 'resume-once') main.sessionId = sid
    } catch (err) {
      ignored(`read ${f}`, err)
    }
  }
}

function saveSlots(): void {
  if (!dirty) return
  dirty = false
  const tmp = `${SLOTS_FILE}.tmp`
  writeFileSync(tmp, `${JSON.stringify([...slots.values()], null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, SLOTS_FILE)
}

function topicSlot(chat: string, thread: number, title?: string): Slot {
  const name = `t${thread}`
  let s = slots.get(name)
  if (!s) {
    s = { name, chat, thread, cwd: cwdFor(title), title, lastActive: Date.now() }
    slots.set(name, s)
    dirty = true
    log(`new topic slot ${name}${title ? ` "${title}"` : ''} → ${s.cwd}`)
  } else if (title && s.title !== title) {
    s.title = title
    renameWindow(s)
    dirty = true
  }
  return s
}

/** A topic named like a folder in PROJECTS works in that folder. */
function cwdFor(title?: string): string {
  if (title && /^[\w.-]+$/.test(title) && !title.startsWith('.')) {
    const dir = join(PROJECTS, title)
    try {
      if (statSync(dir).isDirectory()) return dir
    } catch (err) {
      ignored(`check folder ${dir}`, err)
    }
  }
  return PROJECTS
}

const validSession = (sid?: string): sid is string =>
  !!sid && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sid) &&
  (() => {
    try {
      return execFileSync('sh', ['-c', `ls "$1"/projects/*/"$2".jsonl`, 'sh', CLAUDE_DIR, sid], {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).length > 0
    } catch {
      return false
    }
  })()

// ---- processes and resources ----------------------------------------------

// A zombie (exited, not yet collected by tmux) counts as gone, so the session
// is restarted instead of waited for (lib/proc.ts).
const alive = (pid?: number) => isAlive(pid)

function sessionFile(pid: number): { sessionId?: string; status?: string } | undefined {
  try {
    return JSON.parse(readFileSync(join(CLAUDE_DIR, 'sessions', `${pid}.json`), 'utf8'))
  } catch {
    return undefined
  }
}

/** RSS in MB of each pid's whole process tree (Claude plus its MCP servers). */
function treeRss(pids: number[]): Map<number, number> {
  const out = new Map<number, number>()
  let table: string
  try {
    table = execFileSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8' })
  } catch {
    return out
  }
  const kids = new Map<number, number[]>()
  const rss = new Map<number, number>()
  for (const line of table.split('\n')) {
    const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number)
    if (!pid) continue
    rss.set(pid, kb ?? 0)
    if (!kids.has(ppid!)) kids.set(ppid!, [])
    kids.get(ppid!)!.push(pid)
  }
  for (const root of pids) {
    let total = 0
    const stack = [root]
    while (stack.length) {
      const p = stack.pop()!
      total += rss.get(p) ?? 0
      stack.push(...(kids.get(p) ?? []))
    }
    out.set(root, Math.round(total / 1024))
  }
  return out
}

function memInfoMB(): { total: number; available: number } {
  const text = readFileSync('/proc/meminfo', 'utf8')
  const get = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0) / 1024
  return { total: get('MemTotal'), available: get('MemAvailable') }
}

const running = () => [...slots.values()].filter(s => alive(runtime(s.name).pid))

function sessionCostMB(): number {
  const measured = running().map(s => runtime(s.name).rssMB ?? 0).filter(x => x > 0)
  if (!measured.length) return SESSION_MB_DEFAULT
  return Math.max(...measured, measured.reduce((a, b) => a + b, 0) / measured.length)
}

/** Room for one more session, keeping the reserve free and the CPU unsaturated? */
function capacity(): { ok: boolean; why: string; limit: number } {
  const mem = memInfoMB()
  const reserve = Number(process.env.TELEGRAM_ROUTER_RESERVE_MB ?? Math.max(1024, mem.total * 0.2))
  const cost = sessionCostMB()
  const n = running().length
  // Sessions that fit in memory right now, counting the ones already running.
  const limitMem = n + Math.max(0, Math.floor((mem.available - reserve) / cost))
  const limit = MAX_SESSIONS > 0 ? Math.min(MAX_SESSIONS, limitMem) : limitMem
  if (n >= limit) {
    return { ok: false, why: t('routerWhyMemory', { free: Math.round(mem.available), reserve: Math.round(reserve), cost: Math.round(cost) }), limit }
  }
  const load = loadavg()[0]!
  const cores = cpus().length
  if (load > cores * 2) return { ok: false, why: t('routerWhyCpu', { load: load.toFixed(1), cores }), limit }
  return { ok: true, why: '', limit }
}

// ---- starting and stopping sessions ---------------------------------------

const TMUX_SESSION = tmuxSessionName()

/**
 * The tmux window of a slot. Windows are tagged with the user option @slot,
 * so their visible names can carry the topic title (and change with it).
 * Untagged windows named exactly like the slot are from older routers.
 */
function windowOf(name: string): { id: string; pid: number } | undefined {
  try {
    const out = tmux('list-windows', '-t', TMUX_SESSION, '-F', '#{window_id}\t#{@slot}\t#{window_name}\t#{pane_pid}')
    for (const line of out.split('\n')) {
      const [id, tag, wname, pid] = line.split('\t')
      if (id && (tag === name || (!tag && wname === name))) return { id, pid: Number(pid) }
    }
  } catch (err) {
    ignored('list tmux windows', err)
  }
  return undefined
}
const windowPid = (name: string) => windowOf(name)?.pid
const windowTarget = (name: string) => windowOf(name)?.id ?? `${TMUX_SESSION}:${name}`

/** Visible window name: "t11-test" for topics, "main" for the DM session. */
function displayName(slot: Slot): string {
  if (!slot.title) return slot.name
  // tmux targets use ":" and "." as separators; keep names short.
  const title = slot.title.replace(/[\s:.]+/g, '-').replace(/^-+|-+$/g, '')
  return title ? `${slot.name}-${[...title].slice(0, 20).join('')}` : slot.name
}

function renameWindow(slot: Slot): void {
  const w = windowOf(slot.name)
  if (!w) return
  try {
    tmux('rename-window', '-t', w.id, displayName(slot))
    tmux('set-option', '-w', '-t', w.id, '@slot', slot.name)
  } catch (err) {
    ignored('tag tmux window', err)
  }
}

/** Environment for a session: our TELEGRAM_* settings plus its slot binding. */
function sessionEnv(slot: Slot): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue
    if (k.startsWith('TELEGRAM_ROUTER_') || k === 'TELEGRAM_BOT_TOKEN') continue
    if (k.startsWith('TELEGRAM_') || k === 'PATH' || k === 'LANG') env[k] = v
  }
  env.TELEGRAM_ROUTER_SOCKET = SOCKET
  env.TELEGRAM_SLOT = slot.name
  if (slot.chat && slot.thread) {
    env.TELEGRAM_TOPIC_CHAT = slot.chat
    env.TELEGRAM_TOPIC_THREAD = String(slot.thread)
    if (slot.title) env.TELEGRAM_TOPIC_TITLE = slot.title
  }
  return env
}

/**
 * After the plugin's MCP server fails to start once, Claude Code remembers it
 * in mcp-needs-auth-cache.json and later sessions skip it for a while, so a
 * new session would never connect. Forget that before every start.
 */
function clearFailedMark(): void {
  const file = join(CLAUDE_DIR, 'mcp-needs-auth-cache.json')
  try {
    const cache = JSON.parse(readFileSync(file, 'utf8'))
    const keys = Object.keys(cache).filter(k => /^plugin:telegram:/.test(k))
    if (!keys.length) return
    for (const k of keys) delete cache[k]
    writeFileSync(file, JSON.stringify(cache))
    log(`cleared failed-start mark for ${keys.join(', ')}`)
  } catch (err) {
    ignored('clear failed-start mark', err)
  }
}

async function start(slot: Slot): Promise<void> {
  const r = runtime(slot.name)
  if (alive(r.pid)) return
  const stale = windowOf(slot.name)
  if (stale) {
    try {
      tmux('kill-window', '-t', stale.id)
    } catch (err) {
      ignored('kill stale tmux window', err)
    }
  }
  clearFailedMark()
  const resume = validSession(slot.sessionId) ? ['--resume', slot.sessionId!] : []
  if (slot.sessionId && !resume.length) log(`${slot.name}: session ${slot.sessionId} is gone, starting fresh`)
  const args = ['new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${TMUX_SESSION}:`, '-n', displayName(slot), '-c', existsSync(slot.cwd) ? slot.cwd : MAIN_CWD]
  for (const [k, v] of Object.entries(sessionEnv(slot))) args.push('-e', `${k}=${v}`)
  args.push(...CLAUDE_CMD, ...(PROMPT_SNAPSHOT ? ['--system-prompt-snapshot', PROMPT_SNAPSHOT] : []), ...resume)
  try {
    const id = tmux(...args).trim()
    tmux('set-option', '-w', '-t', id, '@slot', slot.name)
  } catch (err) {
    log(`${slot.name}: tmux new-window failed: ${err}`)
    return
  }
  const pid = windowPid(slot.name)
  Object.assign(r, { pid, startedAt: Date.now(), stopping: false, dialogDone: false, status: undefined, queuedNotice: false, connected: false })
  slot.lastActive = Date.now()
  dirty = true
  log(`${slot.name}: started pid ${pid}${resume.length ? ` resuming ${slot.sessionId}` : ' (new session)'} in ${slot.cwd}`)
}

function stop(slot: Slot, why: string): void {
  const r = runtime(slot.name)
  if (!alive(r.pid)) return
  r.stopping = true
  log(`${slot.name}: stopping pid ${r.pid} (${why})`)
  try {
    process.kill(r.pid!, 'SIGTERM')
  } catch (err) {
    ignored(`stop ${slot.name}`, err)
  }
}

/** Press Enter on Claude Code's "Loading development channels" dialog. */
function confirmDialog(slot: Slot, r: Runtime): void {
  if (r.dialogDone || Date.now() - r.startedAt > DIALOG_WINDOW_MS) return
  let screen = ''
  try {
    screen = tmux('capture-pane', '-p', '-t', windowTarget(slot.name))
  } catch {
    return
  }
  if (screen.includes('Loading development channels') && screen.includes('I am using this for local development')) {
    try {
      tmux('send-keys', '-t', windowTarget(slot.name), 'Enter')
      r.dialogDone = true
      log(`${slot.name}: confirmed the development-channels dialog`)
    } catch (err) {
      ignored('confirm the development-channels dialog', err)
    }
  }
}

// ---- delivery -------------------------------------------------------------

function send(sock: Socket<SockData>, obj: unknown): void {
  sock.data.out += `${JSON.stringify(obj)}\n`
  flush(sock)
}

function flush(sock: Socket<SockData>): void {
  if (!sock.data.out) return
  const n = sock.write(sock.data.out)
  sock.data.out = n > 0 ? sock.data.out.slice(n) : sock.data.out
}

/** Updates waiting for a session survive a router restart. */
function saveQueue(): void {
  const all: Record<string, unknown[]> = {}
  for (const [name, r] of rt) if (r.queue.length) all[name] = r.queue
  try {
    if (Object.keys(all).length) {
      writeFileSync(`${QUEUE_FILE}.tmp`, JSON.stringify(all), { mode: 0o600 })
      renameSync(`${QUEUE_FILE}.tmp`, QUEUE_FILE)
    } else rmSync(QUEUE_FILE, { force: true })
  } catch (err) {
    log(`saving queue failed: ${err}`)
  }
}

function loadQueue(): void {
  try {
    const all = JSON.parse(readFileSync(QUEUE_FILE, 'utf8')) as Record<string, unknown[]>
    for (const [name, updates] of Object.entries(all)) {
      if (!slots.has(name) || !Array.isArray(updates)) continue
      runtime(name).queue.push(...updates)
      log(`${name}: ${updates.length} queued update(s) restored`)
    }
  } catch (err) {
    ignored('restore queue.json', err)
  }
}

function deliver(slot: Slot, update: unknown): void {
  const r = runtime(slot.name)
  slot.lastActive = Date.now()
  dirty = true
  if (r.sock) send(r.sock, { update })
  else {
    r.queue.push(update)
    saveQueue()
  }
}

async function onHello(sock: Socket<SockData>, name: string, plugin?: string): Promise<void> {
  const slot = slots.get(name)
  if (!slot) {
    log(`hello from unknown slot ${name}`)
    return
  }
  sock.data.slot = name
  const r = runtime(name)
  r.sock = sock
  // Servers older than this check send no version: treat them as outdated.
  r.plugin = plugin ?? 'older'
  r.dialogDone = true
  log(`${name}: session connected (${r.queue.length} queued)`)
  r.connected = true
  r.startRetried = false
  if (r.queue.length) {
    for (const u of r.queue.splice(0)) send(sock, { update: u })
    saveQueue()
  }
  if (r.startNotice) {
    const { chat, id } = r.startNotice
    r.startNotice = undefined
    void api('deleteMessage', { chat_id: chat, message_id: id }).catch(() => {})
  }
}

Bun.listen<SockData>({
  unix: (() => {
    try {
      rmSync(SOCKET)
    } catch (err) {
      ignored('remove old router socket', err)
    }
    return SOCKET
  })(),
  socket: {
    open(sock) {
      sock.data = { out: '' }
    },
    data(sock, chunk) {
      const text = chunk.toString()
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (typeof msg.hello === 'string') void onHello(sock, msg.hello, typeof msg.plugin === 'string' ? msg.plugin : undefined)
        } catch (err) {
          logger.warn('unreadable line from a session', err)
        }
      }
    },
    drain(sock) {
      flush(sock)
    },
    close(sock) {
      const name = sock.data?.slot
      if (name && runtime(name).sock === sock) runtime(name).sock = undefined
    },
    error() {},
  },
})

// ---- routing --------------------------------------------------------------

/** Messages Claude should see; service messages (topic created…) are not. */
const ACTIONABLE = ['text', 'photo', 'document', 'voice', 'audio', 'video', 'video_note', 'sticker']

/** The slot that sent a poll, from the polls files the sessions keep. */
function pollOwner(pollId: string): Slot | undefined {
  let files: string[] = []
  try {
    files = readdirSync(STATE_DIR)
  } catch {
    return undefined
  }
  for (const f of files) {
    const name = pollFileSlot(f)
    if (!name) continue
    try {
      if (pollId in JSON.parse(readFileSync(join(STATE_DIR, f), 'utf8'))) return slots.get(name)
    } catch {
      // unreadable or half-written: try the others
    }
  }
  return undefined
}

async function handleUpdate(u: any): Promise<void> {
  const msg = u.message ?? u.edited_message
  const cq = u.callback_query
  // Poll votes name no chat: hand them to the session that sent the poll
  // (started if needed); it checks who voted.
  if (u.poll_answer) {
    const owner = pollOwner(String(u.poll_answer.poll_id))
    if (owner) deliver(owner, u)
    return
  }
  // Reactions carry no topic: offer them to every running session of that
  // group; each one ignores reactions on messages it did not send.
  if (u.message_reaction) {
    const rc = u.message_reaction.chat
    if (rc.type === 'private' || !rc.is_forum) deliver(slots.get('main')!, u)
    else for (const s of running()) if (s.chat === String(rc.id) && runtime(s.name).sock) send(runtime(s.name).sock!, { update: u })
    return
  }
  const chat = msg?.chat ?? cq?.message?.chat ?? u.stopped_message_generation?.chat
  if (!chat) return
  const from = String((msg ?? cq)?.from?.id ?? '')

  if (msg?.text && /^\/sessions(@\w+)?\b/.test(msg.text)) {
    if (loadAccess().allowFrom.includes(from)) await reportSessions(String(chat.id), msg.message_thread_id)
    return
  }

  // Direct messages (and plain groups): the main session, always running.
  if (chat.type === 'private' || !chat.is_forum) {
    deliver(slots.get('main')!, u)
    return
  }

  // Forum group: one session per topic.
  const source = msg ?? cq?.message
  const thread: number | undefined = source?.is_topic_message ? source.message_thread_id : undefined
  const chatId = String(chat.id)
  const title: string | undefined =
    msg?.forum_topic_created?.name ?? msg?.forum_topic_edited?.name ?? msg?.reply_to_message?.forum_topic_created?.name
  if (!thread) {
    if (msg && ACTIONABLE.some(k => k in msg) && allowedInGroup(chatId, from)) {
      await api('sendMessage', {
        chat_id: chatId,
        text: t('routerUseTopic'),
      }).catch(() => {})
    }
    return
  }
  if (!allowedInGroup(chatId, from)) return
  const slot = topicSlot(chatId, thread, title)
  if (msg?.forum_topic_closed) {
    slot.closed = true
    dirty = true
    stop(slot, 'topic closed')
    return
  }
  if (msg?.forum_topic_reopened && slot.closed) {
    slot.closed = false
    dirty = true
  }
  const r = runtime(slot.name)
  if (cq && !alive(r.pid)) {
    await api('answerCallbackQuery', { callback_query_id: cq.id, text: t('routerNotRunning') }).catch(() => {})
    return
  }
  if (msg && !ACTIONABLE.some(k => k in msg)) return
  deliver(slot, u)
  if (!alive(r.pid)) await wake(slot)
}

/** Start a slot's session now if there is room, otherwise free some or queue. */
async function wake(slot: Slot): Promise<void> {
  const r = runtime(slot.name)
  if (alive(r.pid) || r.gaveUp) return
  const cap = capacity()
  if (!cap.ok && !slot.pinned) {
    const victim = running()
      .filter(s => !s.pinned && s.name !== slot.name && runtime(s.name).status === 'idle' && !runtime(s.name).queue.length && !runtime(s.name).stopping)
      .sort((a, b) => a.lastActive - b.lastActive)[0]
    if (victim) {
      stop(victim, `making room for ${slot.name}`)
      return // started by the tick once the victim is gone
    }
    if (!r.queuedNotice) {
      r.queuedNotice = true
      const busy = running().filter(s => !s.pinned).map(s => s.title ?? s.name).join(', ')
      await notify(slot, t('routerQueued', { why: cap.why, busy: busy || t('routerNone') }))
    }
    return
  }
  if (slot.chat) {
    const resuming = validSession(slot.sessionId)
    const id = await notify(slot, t(resuming ? 'routerWaking' : 'routerStarting'))
    if (id) r.startNotice = { chat: slot.chat, id }
  }
  await start(slot)
}

// Telegram does not tell bots when a topic is deleted. Probe stopped topic
// slots without changing anything: reopening an open topic (or closing a
// closed one) answers TOPIC_NOT_MODIFIED, a deleted one TOPIC_ID_INVALID.
async function pruneDeletedTopics(): Promise<void> {
  for (const s of [...slots.values()]) {
    if (!s.chat || !s.thread || alive(runtime(s.name).pid)) continue
    const probe = s.closed ? 'closeForumTopic' : 'reopenForumTopic'
    try {
      await api(probe, { chat_id: s.chat, message_thread_id: s.thread })
      // It did change something: our closed flag was stale. Put it back.
      if (probe === 'reopenForumTopic') await api('closeForumTopic', { chat_id: s.chat, message_thread_id: s.thread }).catch(() => {})
      else await api('reopenForumTopic', { chat_id: s.chat, message_thread_id: s.thread }).catch(() => {})
      s.closed = probe === 'reopenForumTopic'
      dirty = true
    } catch (err) {
      if (!/TOPIC_ID_INVALID|thread not found/i.test(String(err))) continue
      log(`${s.name}: topic ${s.title ?? s.thread} was deleted, forgetting it`)
      slots.delete(s.name)
      rt.delete(s.name)
      dirty = true
    }
  }
  saveSlots()
}

const KNOWN_STATES = Object.fromEntries(
  ['starting', 'busy', 'idle', 'waiting', 'crashed', 'queued', 'closed', 'stopped'].map(s => [`routerState.${s}`, true]),
)

async function reportSessions(chatId: string, thread?: number): Promise<void> {
  await pruneDeletedTopics()
  const cap = capacity()
  const rss = treeRss(running().map(s => runtime(s.name).pid!))
  const lines: string[] = []
  const sorted = [...slots.values()].sort((a, b) => b.lastActive - a.lastActive)
  for (const s of sorted) {
    const r = runtime(s.name)
    const on = alive(r.pid)
    const state = on ? (r.status ?? 'starting') : r.gaveUp ? 'crashed' : r.queue.length ? 'queued' : s.closed ? 'closed' : 'stopped'
    const ago = Math.round((Date.now() - s.lastActive) / 60_000)
    const stateKey = `routerState.${state}` as Key
    lines.push(
      t('routerSessionLine', {
        icon: on ? '🟢' : '⚪️',
        name: s.name === 'main' ? t('routerMainDm') : (s.title ?? s.name),
        state: stateKey in KNOWN_STATES ? t(stateKey) : state,
        mem: on ? `, ${rss.get(r.pid!) ?? '?'} MB` : '',
        ago,
      }),
    )
  }
  const mem = memInfoMB()
  const where = thread ? { message_thread_id: thread } : {}
  const markdown = mdSpaced([
    ...t('routerSessions', { running: running().length, limit: cap.limit }).split('\n\n'),
    mdList(lines),
    t('routerMemory', { free: Math.round(mem.available), total: Math.round(mem.total), idle: IDLE_MS / 60_000 }),
  ])
  await api('sendRichMessage', { chat_id: chatId, rich_message: { markdown }, ...where }).catch(() =>
    api('sendMessage', { chat_id: chatId, text: plainMarkdown(markdown), ...where }).catch(() => {}),
  )
}

// ---- supervision loop -----------------------------------------------------

async function tick(): Promise<void> {
  const pids = running().map(s => runtime(s.name).pid!)
  const rss = treeRss(pids)
  for (const slot of slots.values()) {
    const r = runtime(slot.name)
    if (r.pid && alive(r.pid)) {
      r.rssMB = rss.get(r.pid) ?? r.rssMB
      const info = sessionFile(r.pid)
      if (info?.sessionId && info.sessionId !== slot.sessionId) {
        slot.sessionId = info.sessionId
        dirty = true
        if (slot.name === 'main') writeFileSync(join(STATE_DIR, 'last-session'), `${info.sessionId}\n`)
      }
      r.status = info?.status
      r.version = (info as { version?: string } | undefined)?.version ?? r.version
      if (r.status && r.status !== 'idle') slot.lastActive = Date.now()
      confirmDialog(slot, r)
      if (!r.connected && !r.stopping && Date.now() - r.startedAt > START_TIMEOUT_MS) await startTimedOut(slot, r)
      if (!slot.pinned && r.status === 'idle' && !r.queue.length && Date.now() - slot.lastActive > IDLE_MS && !r.stopping) {
        stop(slot, `idle for ${Math.round((Date.now() - slot.lastActive) / 60_000)} min`)
      }
      continue
    }
    if (r.pid) {
      // The session just exited.
      const ran = Date.now() - r.startedAt
      const planned = r.stopping
      r.pid = undefined
      r.sock = undefined
      r.status = undefined
      if (planned) {
        log(`${slot.name}: stopped`)
        r.quickExits = 0
        if (r.updateTo && slot.pinned) {
          void notify(slot, t('routerUpdating', { version: r.updateTo }))
        }
        r.updateTo = undefined
      } else {
        r.quickExits = ran < QUICK_EXIT_MS ? r.quickExits + 1 : 0
        log(`${slot.name}: exited after ${Math.round(ran / 1000)}s (quick exits in a row: ${r.quickExits})`)
        if (r.quickExits >= MAX_QUICK_EXITS) {
          if (slot.sessionId && r.quickExits === MAX_QUICK_EXITS) {
            log(`${slot.name}: giving up on resuming ${slot.sessionId}, next start is a new session`)
            slot.sessionId = undefined
            dirty = true
          } else {
            r.gaveUp = true
            await notify(slot, t('routerCrashLoop'))
          }
        }
      }
    }
    if (r.gaveUp) continue
    // Restart main always, and any slot that has messages waiting.
    if (slot.pinned || r.queue.length) await wake(slot)
  }
  checkForUpdate()
  saveSlots()
}

/** A session that never connected: tell the user what its screen shows, retry once. */
async function startTimedOut(slot: Slot, r: Runtime): Promise<void> {
  let screen = ''
  try {
    screen = tmux('capture-pane', '-p', '-t', windowTarget(slot.name))
      .split('\n').filter(l => l.trim()).slice(-8).join('\n')
  } catch (err) {
    ignored('capture pane after a timed-out start', err)
  }
  const again = !r.startRetried
  log(`${slot.name}: not connected after ${START_TIMEOUT_MS / 1000}s${again ? ', restarting once' : ', giving up'}`)
  await notify(
    slot,
    t('routerNotConnected', { min: START_TIMEOUT_MS / 60_000 }) +
      t(again ? 'routerRetryOnce' : 'routerGaveUp') +
      (screen ? `\n\n${t('routerLastLines')}\n${screen.slice(-800)}` : ''),
  )
  r.connected = true // report once per start
  if (again) {
    r.startRetried = true
    stop(slot, 'start timed out')
    r.stopping = false // treat as an exit to restart, not a planned stop
  } else {
    r.gaveUp = true
    r.startRetried = false
    stop(slot, 'start timed out twice')
  }
}

// ---- Claude Code updates ---------------------------------------------------

/** Version of the Claude Code that new sessions would run. */
let ranVersion: { at: number; version?: string } | undefined

function installedVersion(): string | undefined {
  try {
    // The native installer links `claude` to …/versions/<version>.
    const name = basename(realpathSync(CLAUDE_CMD[0]!))
    if (/^\d+\.\d+\.\d+/.test(name)) return name
  } catch (err) {
    ignored('read Claude Code version from its path', err)
  }
  // Running `claude --version` takes a second or two and blocks the router:
  // do it at most every VERSION_RUN_MS, not at every update check.
  if (ranVersion && Date.now() - ranVersion.at < VERSION_RUN_MS) return ranVersion.version
  ranVersion = { at: Date.now() }
  try {
    const out = execFileSync(CLAUDE_CMD[0]!, ['--version'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] })
    ranVersion.version = /(\d+\.\d+\.\d+)/.exec(out)?.[1]
  } catch (err) {
    ignored('run claude --version', err)
  }
  return ranVersion.version
}


let lastUpdateCheck = Date.now()

/** Version of this plugin that is installed now (what new sessions load). */
function installedPlugin(): string | undefined {
  if (!PLUGIN_ID) return undefined
  try {
    const all = JSON.parse(readFileSync(join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'), 'utf8'))
    return all.plugins?.[PLUGIN_ID]?.[0]?.version
  } catch {
    return undefined
  }
}

/** Version of the plugin copy this router runs from. */
const OWN_PLUGIN = (() => {
  try {
    return JSON.parse(readFileSync(join(import.meta.dir, '.claude-plugin', 'plugin.json'), 'utf8')).version as string
  } catch {
    return undefined
  }
})()

/**
 * Claude Code and this plugin update on disk, but a running session keeps
 * the old code until it restarts. Topic sessions restart often anyway; this
 * restarts any outdated session once it has been quiet for a while. main is
 * brought back right away (resuming its conversation), topics on their next
 * message. With TELEGRAM_ROUTER_SELF_UPDATE=1 the router itself exits for
 * its supervisor to start the new copy; running sessions are adopted.
 */
function checkForUpdate(): void {
  if (Date.now() - lastUpdateCheck < UPDATE_CHECK_MS) return
  lastUpdateCheck = Date.now()
  const latest = installedVersion()
  const plugin = installedPlugin()
  for (const slot of running()) {
    const r = runtime(slot.name)
    if (r.stopping || r.status !== 'idle' || r.queue.length || Date.now() - slot.lastActive < UPDATE_IDLE_MS) continue
    const update =
      latest && r.version && isNewer(latest, r.version) ? `Claude Code ${latest}` :
      plugin && r.plugin && plugin !== r.plugin ? `Telegram plugin ${plugin}` :
      undefined
    if (!update) continue
    r.updateTo = update
    stop(slot, `${update} (was ${update.startsWith('Claude') ? r.version : r.plugin})`)
  }
  if (SELF_UPDATE && plugin && OWN_PLUGIN && plugin !== OWN_PLUGIN) {
    log(`plugin ${plugin} installed (router runs ${OWN_PLUGIN}), exiting for the supervisor to restart it`)
    dirty = true
    saveSlots()
    saveQueue()
    process.exit(0)
  }
}

// ---- main -----------------------------------------------------------------

loadSlots()
loadQueue()
// Adopt sessions that kept running while the router restarted.
for (const slot of slots.values()) {
  const pid = windowPid(slot.name)
  if (pid && alive(pid)) {
    Object.assign(runtime(slot.name), { pid, startedAt: Date.now() - QUICK_EXIT_MS, dialogDone: true })
    renameWindow(slot)
    log(`${slot.name}: adopted running session pid ${pid}`)
  }
}
dirty = true
saveSlots()

const original = handleUpdate
// Reset the crash guard when the user talks to a slot that gave up.
async function handleWithRevive(u: any): Promise<void> {
  const msg = u.message
  if (msg?.is_topic_message) {
    const r = rt.get(`t${msg.message_thread_id}`)
    if (r?.gaveUp) Object.assign(r, { gaveUp: false, quickExits: 0 })
  } else if (msg?.chat?.type === 'private') {
    const r = rt.get('main')
    if (r?.gaveUp) Object.assign(r, { gaveUp: false, quickExits: 0 })
  }
  await original(u)
}

log(`router up: tmux session ${TMUX_SESSION}, ${slots.size} slot(s), idle stop ${IDLE_MS / 60_000} min`)
setInterval(() => void tick().catch(err => log(`tick failed: ${err}`)), TICK_MS)
void tick()

// Scheduled messages (the schedule tool): the router is the one process that
// is always up, so it sends them, whether or not their session still runs.
const SCHEDULE_EVERY_MS = 15_000
const sendScheduled = scheduledSender(api)
let scheduling = false
setInterval(() => {
  if (scheduling) return
  scheduling = true
  const access = loadAccess()
  void deliverDue(
    scheduleDir(STATE_DIR),
    Date.now(),
    sendScheduled,
    chat => access.allowFrom.includes(chat) || chat in access.groups,
    (what, err) => (err === undefined ? logger.warn(what) : logger.warn(what, err)),
  )
    .then(n => n && log(`sent ${n} scheduled message(s)`))
    .catch(err => logger.warn('scheduled delivery', err))
    .finally(() => {
      scheduling = false
    })
}, SCHEDULE_EVERY_MS)

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))

;(async () => {
  // Telegram re-sends updates until a later getUpdates confirms them, so a
  // restart right after handling one would handle it twice. Keep the
  // offset on disk and save it after every update.
  let offset = 0
  try {
    offset = Number(readFileSync(OFFSET_FILE, 'utf8').trim()) || 0
  } catch (err) {
    ignored('read poll offset', err)
  }
  const saveOffset = () => {
    try {
      writeFileSync(OFFSET_FILE, `${offset}\n`)
    } catch (err) {
      log(`saving offset failed: ${err}`)
    }
  }
  for (let attempt = 0; ; ) {
    try {
      const updates: any[] = await api('getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: ['message', 'edited_message', 'callback_query', 'message_reaction', 'stopped_message_generation', 'poll_answer'],
      })
      attempt = 0
      for (const u of updates) {
        offset = u.update_id + 1
        try {
          await handleWithRevive(u)
        } catch (err) {
          log(`update ${u.update_id} failed: ${err}`)
        }
        saveOffset()
      }
    } catch (err: any) {
      attempt++
      const delay = Math.min(1000 * attempt, 15_000)
      log(`getUpdates failed (${err?.message ?? err}), retrying in ${delay / 1000}s`)
      await sleep(delay)
    }
  }
})()
