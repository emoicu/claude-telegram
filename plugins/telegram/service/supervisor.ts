#!/usr/bin/env bun
/**
 * Supervisor for the Telegram router, run by service/launcher.sh (which the
 * claude-telegram systemd user service starts). install.sh --service copies
 * this file out of the plugin, to <state dir>/service/, so a broken plugin
 * update cannot break the one thing that puts the previous version back.
 *
 * It keeps the router running from the installed plugin version:
 * - finds the version Claude Code installed in plugins/installed_plugins.json
 *   and runs its router.ts; the router exits once a newer version is installed
 *   (TELEGRAM_ROUTER_SELF_UPDATE=1) and is started again from the new copy
 * - a version whose router fails within QUICK_SECS three times in a row is
 *   bad: the last version that ran longer (router-good) runs instead until
 *   another version is installed, and the allowed users get a Telegram notice
 * - makes sure the tmux session the router opens its windows in exists
 * - refuses to start while another supervisor or router runs (exit 75, which
 *   the launcher and the service do not restart)
 * - updates itself: once a plugin version has run STABLE_SECS, a newer copy of
 *   this file in that version replaces this one (the old one is kept as
 *   supervisor.prev.ts for the launcher to put back) and the supervisor exits
 *   for the launcher to start the new one
 *
 * Self-contained on purpose: it outlives the plugin copy it came from, so it
 * imports nothing from the plugin.
 *
 * Environment (all optional; the state dir's .env is read too, real env wins):
 *   TELEGRAM_SUPERVISOR_PLUGIN      plugin id (default telegram@emoicu-plugins)
 *   TELEGRAM_SUPERVISOR_TMUX_UNIT   systemd user unit that owns the tmux session; started
 *                                   when the session is missing (set by the service)
 *   TELEGRAM_ROUTER_TMUX            tmux session (default claude)
 *   TELEGRAM_ROUTER_MAIN_CWD        the router's working directory (default: home)
 *   TELEGRAM_SUPERVISOR_QUICK_SECS, _STABLE_SECS, _POLL_MS, _PAUSE_MS, _DIR   for tests
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Bump when this file changes; installed copies update to a higher one. */
export const SUPERVISOR_VERSION = 2

/** Exit code for "another supervisor or router is running": not restarted. */
export const CONFLICT = 75

/** SUPERVISOR_VERSION of a copy of this file, from its text. */
export function versionOf(text: string): number | undefined {
  const m = /SUPERVISOR_VERSION = (\d+)/.exec(text)
  return m ? Number(m[1]) : undefined
}

/** KEY=value lines of an env file. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = /^(\w+)=(.*)$/.exec(line)
    if (m) out[m[1]!] = m[2]!
  }
  return out
}

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(CLAUDE_DIR, 'channels', 'telegram')
const DIR = process.env.TELEGRAM_SUPERVISOR_DIR ?? import.meta.dir
const SELF = join(DIR, 'supervisor.ts')
const PREV = join(DIR, 'supervisor.prev.ts')
const BAD = join(DIR, 'supervisor.bad')
const RESTORED = join(DIR, 'supervisor.restored')
const GOOD = join(DIR, 'router-good')
const LOCK = join(DIR, 'supervisor.pid')
const ROUTER_PID = join(DIR, 'router.pid')
const LOG = join(DIR, 'supervisor.log')
const SOCKET = join(STATE_DIR, 'router.sock')

function num(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

function log(msg: string): void {
  const line = `${new Date().toISOString()} supervisor: ${msg}`
  console.log(line)
  try {
    if (existsSync(LOG) && statSync(LOG).size > 1024 * 1024) renameSync(LOG, `${LOG}.1`)
    appendFileSync(LOG, `${line}\n`)
  } catch {
    // The journal still has it.
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  // kill -0 succeeds on a zombie too.
  const state = readText(`/proc/${pid}/stat`)?.split(') ')[1]?.[0]
  return state !== 'Z'
}

// ---- messages --------------------------------------------------------------
// The one exception to locales/: this file must not import from the plugin
// copy it came from, so it carries its few messages for each locale itself.

const MESSAGES = {
  en: {
    fallback: (bad: string, good: string, n: number) =>
      `⚠️ The new Telegram router (${bad}) failed ${n} times right after starting. Went back to ${good}; it moves to the next version once one is installed.`,
    noFallback: (n: number, log: string) =>
      `⚠️ The Telegram router failed ${n} times right after starting and there is no earlier version to go back to. See ${log}`,
    restored: (log: string) =>
      `⚠️ An updated Telegram supervisor kept failing to start, so the previous one was put back. See ${log}`,
    conflict: (why: string) => `⚠️ The Telegram service did not start: ${why}. Stop the other one, then: systemctl --user restart claude-telegram`,
  },
  zh: {
    fallback: (bad: string, good: string, n: number) =>
      `⚠️ 新版 Telegram 路由器（${bad}）连续 ${n} 次启动就崩溃，已自动退回 ${good}。装了下一个版本后会自动换过去。`,
    noFallback: (n: number, log: string) => `⚠️ Telegram 路由器连续 ${n} 次启动就崩溃，也没有可退回的旧版本。请看日志：${log}`,
    restored: (log: string) => `⚠️ 更新后的 Telegram 守护脚本反复启动失败，已换回上一个版本。日志：${log}`,
    conflict: (why: string) => `⚠️ Telegram 服务没有启动：${why}。停掉另一个后运行：systemctl --user restart claude-telegram`,
  },
}

function messages(): (typeof MESSAGES)['en'] {
  return (readText(join(STATE_DIR, 'language')) ?? '').trim().startsWith('zh') ? MESSAGES.zh : MESSAGES.en
}

/** Tell the allowed users (access.json allowFrom) something; best effort. */
async function notify(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  let ids: string[] = []
  try {
    ids = JSON.parse(readFileSync(join(STATE_DIR, 'access.json'), 'utf8')).allowFrom ?? []
  } catch {
    // No access file yet.
  }
  if (!token || !ids.length) return log(`not notified (no token or allowed users): ${text}`)
  const root = (process.env.TELEGRAM_API_ROOT || 'https://api.telegram.org').replace(/\/+$/, '')
  for (const chat_id of ids) {
    try {
      const res = await fetch(`${root}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id, text }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) log(`notify ${chat_id}: HTTP ${res.status}`)
    } catch (err) {
      log(`notify ${chat_id}: ${err}`)
    }
  }
}

// ---- plugin versions -------------------------------------------------------

/** Directory of the installed plugin version. */
function installedRoot(plugin: string): string | undefined {
  try {
    const all = JSON.parse(readFileSync(join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'), 'utf8'))
    return all.plugins?.[plugin]?.[0]?.installPath
  } catch {
    return undefined
  }
}

/**
 * Replace this file with a newer copy from a plugin version that has proven
 * itself, keeping this one for the launcher to put back. Skips versions the
 * launcher already put back once (supervisor.bad).
 */
export function selfUpdate(root: string): boolean {
  const text = readText(join(root, 'service', 'supervisor.ts'))
  const next = text ? versionOf(text) : undefined
  if (!text || next == null || next <= SUPERVISOR_VERSION) return false
  const bad = (readText(BAD) ?? '').split(/\s+/).filter(Boolean).map(Number)
  if (bad.includes(next)) return false
  copyFileSync(SELF, PREV)
  writeFileSync(`${SELF}.tmp`, text)
  renameSync(`${SELF}.tmp`, SELF)
  log(`updated the supervisor from version ${SUPERVISOR_VERSION} to ${next} (from ${root}); restarting`)
  return true
}

// ---- tmux --------------------------------------------------------------------

function hasSession(name: string): boolean {
  try {
    execFileSync('tmux', ['-u', 'has-session', '-t', `=${name}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * The router opens its sessions as windows of this tmux session. Under
 * systemd its own unit owns it, so restarting the supervisor's service does
 * not take the sessions down with it.
 */
function serverRunning(): boolean {
  try {
    execFileSync('tmux', ['-u', 'list-sessions'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function ensureTmux(name: string): void {
  if (hasSession(name)) return
  const unit = process.env.TELEGRAM_SUPERVISOR_TMUX_UNIT
  try {
    // With no tmux server at all, a server started from here would live in
    // this service and end with it: let the tmux unit start it. Restart, not
    // start, as the oneshot unit stays active after its server is gone; its
    // stop step has nothing to end then. A running server only needs the
    // session: never restart the unit then, that would end its sessions.
    if (unit && !serverRunning()) {
      log(`no tmux server, restarting ${unit}`)
      execFileSync('systemctl', ['--user', 'restart', unit], { stdio: 'ignore', timeout: 30_000 })
      if (!hasSession(name)) log(`${unit} did not create tmux session ${name}`)
    } else {
      log(`creating tmux session ${name}`)
      const routerLog = join(STATE_DIR, 'router', 'router.log')
      execFileSync('tmux', ['-u', 'new-session', '-d', '-s', name, '-n', 'log', 'tail', '-n', '50', '-F', routerLog], { stdio: 'ignore' })
    }
  } catch (err) {
    log(`could not create tmux session ${name}: ${err}`)
  }
}

// ---- single instance ---------------------------------------------------------

/** Does something answer on the router socket? */
async function routerListening(): Promise<boolean> {
  if (!existsSync(SOCKET)) return false
  try {
    const sock = await Promise.race([
      Bun.connect({ unix: SOCKET, socket: { data() {} } }),
      Bun.sleep(2000).then(() => undefined),
    ])
    if (!sock) return false
    sock.end()
    return true
  } catch {
    return false
  }
}

/**
 * A supervisor that was killed (SIGKILL, out of memory) leaves its router
 * running, which would then look like another router. Stop it: it is ours.
 */
async function stopOrphanRouter(): Promise<void> {
  const pid = Number(readText(ROUTER_PID))
  // Called only when no supervisor holds the lock, so whoever started it is gone.
  if (!pid || !alive(pid) || !(readText(`/proc/${pid}/cmdline`) ?? '').includes('router.ts')) return
  log(`stopping router pid ${pid} left behind by an earlier supervisor`)
  process.kill(pid, 'SIGTERM')
  for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(100)
  if (alive(pid)) process.kill(pid, 'SIGKILL')
  rmSync(ROUTER_PID, { force: true })
}

/** Why this supervisor must not run, if another one or a router runs. */
async function conflict(): Promise<string | undefined> {
  const other = await conflictingSupervisor()
  if (other) return `another supervisor is running (pid ${other})`
  if (await routerListening()) return `a Telegram router is already running (${SOCKET} answers)`
  return undefined
}

/** pid of another live supervisor holding the lock. */
async function conflictingSupervisor(): Promise<number | undefined> {
  const pid = Number(readText(LOCK))
  return pid && pid !== process.pid && alive(pid) && (readText(`/proc/${pid}/cmdline`) ?? 'supervisor').includes('supervisor') ? pid : undefined
}

/** The environment for the router: the supervisor's own settings stay here. */
function routerEnv(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TELEGRAM_SUPERVISOR_')))
}

// ---- main --------------------------------------------------------------------

async function main(): Promise<void> {
  for (const [k, v] of Object.entries(parseEnv(readText(join(STATE_DIR, '.env')) ?? ''))) {
    if (process.env[k] === undefined) process.env[k] = v
  }
  const PLUGIN = process.env.TELEGRAM_SUPERVISOR_PLUGIN || 'telegram@emoicu-plugins'
  const SESSION = process.env.TELEGRAM_ROUTER_TMUX || 'claude'
  const CWD = process.env.TELEGRAM_ROUTER_MAIN_CWD || homedir()
  const QUICK_MS = num('TELEGRAM_SUPERVISOR_QUICK_SECS', 60) * 1000
  const STABLE_MS = num('TELEGRAM_SUPERVISOR_STABLE_SECS', 600) * 1000
  const POLL_MS = num('TELEGRAM_SUPERVISOR_POLL_MS', 5000)
  const PAUSE_MS = num('TELEGRAM_SUPERVISOR_PAUSE_MS', 5000) // before starting the router again
  const MAX_CRASHES = 3
  const say = messages()

  mkdirSync(DIR, { recursive: true })
  if (!(await conflictingSupervisor())) await stopOrphanRouter()
  const why = await conflict()
  if (why) {
    log(`not starting: ${why}`)
    await notify(say.conflict(why))
    process.exit(CONFLICT)
  }
  writeFileSync(LOCK, String(process.pid))
  log(`supervisor ${SUPERVISOR_VERSION} up (pid ${process.pid}, plugin ${PLUGIN}, tmux session ${SESSION})`)
  if (existsSync(RESTORED)) {
    rmSync(RESTORED, { force: true })
    await notify(say.restored(LOG))
  }

  let child: ReturnType<typeof Bun.spawn> | undefined
  const quit = (code: number) => {
    child?.kill()
    process.exit(code)
  }
  process.on('SIGTERM', () => quit(143))
  process.on('SIGINT', () => quit(130))

  let crashes = 0 // quick failures of the current version in a row
  let bad: string | undefined // version found broken; cleared once another is installed
  let notifiedMissing = false
  for (;;) {
    const root = installedRoot(PLUGIN)
    if (bad && root !== bad) {
      log(`${root} installed, no longer running the earlier version`)
      bad = undefined
      crashes = 0
    }
    const good = readText(GOOD)?.trim()
    const fallback = !!bad && !!good && good !== bad && existsSync(join(good, 'router.ts'))
    const run = fallback ? good! : root
    if (!run || !existsSync(join(run, 'router.ts'))) {
      if (!notifiedMissing) log(`no router to run: ${PLUGIN} is not installed (${join(CLAUDE_DIR, 'plugins', 'installed_plugins.json')})`)
      notifiedMissing = true
      await Bun.sleep(Math.max(POLL_MS, 5000))
      continue
    }
    notifiedMissing = false
    ensureTmux(SESSION)
    log(fallback ? `${bad} is broken, running the earlier ${run}` : `starting router ${run}`)
    const startedAt = Date.now()
    child = Bun.spawn([process.execPath, join(run, 'router.ts')], {
      cwd: existsSync(CWD) ? CWD : homedir(),
      // The earlier version must not exit for the broken one: this loop
      // stops it once another version is installed.
      env: { ...routerEnv(), TELEGRAM_ROUTER_TMUX: SESSION, TELEGRAM_ROUTER_SELF_UPDATE: fallback ? '' : '1' },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    writeFileSync(ROUTER_PID, String(child.pid))
    let switched = false
    let checkedSelf = false
    let markedGood = false
    let tmuxCheckedAt = Date.now()
    const watch = setInterval(() => {
      // The router cannot open windows without its tmux session.
      if (Date.now() - tmuxCheckedAt >= 5000) {
        tmuxCheckedAt = Date.now()
        ensureTmux(SESSION)
      }
      // A version that has run a while is what a broken update falls back
      // to. Noted while it runs: a service stop or restart ends it without
      // the exit below.
      if (!fallback && !markedGood && Date.now() - startedAt >= QUICK_MS) {
        markedGood = true
        if (readText(GOOD)?.trim() !== run) writeFileSync(GOOD, run)
      }
      if (fallback) {
        const now = installedRoot(PLUGIN)
        if (now && now !== bad && !switched) {
          switched = true
          child?.kill()
        }
      } else if (!checkedSelf && Date.now() - startedAt >= STABLE_MS) {
        checkedSelf = true
        try {
          if (selfUpdate(run)) {
            clearInterval(watch)
            child?.kill()
            void child?.exited.then(() => process.exit(0))
          }
        } catch (err) {
          log(`self-update failed: ${err}`)
        }
      }
    }, POLL_MS)
    const code = await child.exited
    clearInterval(watch)
    const ran = Date.now() - startedAt
    log(`router exited with ${code} after ${Math.round(ran / 1000)}s`)

    let pause = PAUSE_MS
    if (ran >= QUICK_MS) {
      crashes = 0
    } else if (code !== 0 && !fallback) {
      // 0 is the router exiting for an update, not a failure.
      crashes++
      log(`${run} failed ${crashes} time(s) in a row within ${QUICK_MS / 1000}s`)
      if (crashes >= MAX_CRASHES) {
        pause = PAUSE_MS * 6
        if (!bad) {
          bad = root
          if (good && good !== bad && existsSync(join(good, 'router.ts'))) {
            log(`going back to ${good}`)
            await notify(say.fallback(bad?.split('/').pop() ?? '?', good.split('/').pop() ?? '?', crashes))
            pause = Math.min(PAUSE_MS, 1000)
          } else {
            log('no earlier version to go back to')
            await notify(say.noFallback(crashes, LOG))
          }
        }
      }
    } else if (code !== 0 && !switched) {
      pause = PAUSE_MS * 6 // the earlier version fails too
    }
    if (switched) pause = Math.min(PAUSE_MS, 1000)
    await Bun.sleep(pause)
  }
}

if (import.meta.main) await main()
