// Is a process still running? process.kill(pid, 0) also succeeds for a
// zombie: a process that has exited but whose parent (for a session, the tmux
// server) has not collected it yet. The router would then wait forever for a
// session that is gone, so on Linux the state in /proc/<pid>/stat is checked
// as well.

import { readFileSync } from 'node:fs'

/** The state letter of a /proc/<pid>/stat line (R, S, D, Z, ...). */
export function procState(stat: string): string | undefined {
  // "<pid> (<comm>) <state> ...": comm may hold spaces and parentheses.
  const end = stat.lastIndexOf(')')
  if (end < 0) return undefined
  return stat.slice(end + 1).trim().split(/\s+/)[0] || undefined
}

export function isAlive(pid: number | undefined, readStat: (pid: number) => string = p => readFileSync(`/proc/${p}/stat`, 'utf8')): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  let stat: string
  try {
    stat = readStat(pid)
  } catch {
    return true // no /proc (macOS): the signal check is all there is
  }
  const state = procState(stat)
  return state !== 'Z' && state !== 'X'
}
