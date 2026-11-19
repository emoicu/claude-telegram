// Collects the facts for /doctor (lib/doctor.ts holds the checks).

import { closeSync, fstatSync, openSync, readFileSync, readSync, statfsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  checkAccess,
  checkActivityHook,
  checkDisk,
  checkFileMode,
  checkLog,
  checkScheduled,
  formatReport,
  type LogSummary,
  summarizeLog,
} from '../lib/doctor.ts'
import { listScheduled, scheduleDir } from '../lib/schedule.ts'
import type { T } from '../lib/i18n.ts'
import { loadAccess } from './access-store.ts'
import { ACCESS_FILE, channelMode, ENV_FILE, routed, SLOT, STATE_DIR } from './config.ts'

const DAY_MS = 86_400_000

function modeOf(path: string): number | undefined {
  try {
    return statSync(path).mode
  } catch {
    return undefined
  }
}

function mtimeOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

function logSummary(path: string, now: number): LogSummary | undefined {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return undefined
  }
  try {
    const size = fstatSync(fd).size
    const len = Math.min(size, 256 * 1024)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    return summarizeLog(buf.toString('utf8'), now - DAY_MS)
  } finally {
    closeSync(fd)
  }
}

function groupTitles(): Record<string, string | undefined> {
  try {
    const seen = JSON.parse(readFileSync(join(STATE_DIR, 'unlisted-groups.json'), 'utf8')) as Record<string, { title?: string }>
    return Object.fromEntries(Object.entries(seen).map(([id, g]) => [id, g.title]))
  } catch {
    return {}
  }
}

function freeBytes(): number | undefined {
  try {
    const s = statfsSync(STATE_DIR)
    return s.bavail * s.bsize
  } catch {
    return undefined
  }
}

export function doctorReport(info: { botUsername: string; pluginVersion: string; claudeVersion?: string }, t: T): string {
  const now = Date.now()
  const header = [
    t('doctorVersions', { bot: info.botUsername || '?', plugin: info.pluginVersion, claude: info.claudeVersion ?? '?', bun: Bun.version }),
    t('doctorMode', {
      mode: routed ? t('doctorModeRouter', { slot: SLOT }) : channelMode.poll ? t('doctorModeSingle') : t('doctorModeOff'),
      reason: channelMode.reason,
    }),
  ]
  const checks = [
    ...checkAccess(loadAccess(), groupTitles(), t),
    checkFileMode(t('doctorEnvFile'), modeOf(ENV_FILE), t),
    checkFileMode('access.json', modeOf(ACCESS_FILE), t),
    checkLog(t('doctorServerLog'), logSummary(join(STATE_DIR, 'logs', `server-${SLOT}.log`), now), t),
    ...(routed ? [checkLog(t('doctorRouterLog'), logSummary(join(STATE_DIR, 'router', 'router.log'), now), t)] : []),
    checkActivityHook(mtimeOf(join(STATE_DIR, 'activity', `${SLOT}.jsonl`)), now, t),
    checkScheduled(listScheduled(scheduleDir(STATE_DIR)).map(s => s.at), now, t),
    checkDisk(freeBytes(), t),
  ]
  return formatReport(header, checks, t)
}
