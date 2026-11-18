// Leveled logging for the channel server, router and hooks.
//
// Lines go to stderr (stdout is the MCP protocol stream) and, when a file is
// given, are appended to it with simple size-based rotation, so problems can
// be traced after the fact. Bot tokens are redacted from every line.

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export type Level = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Parse a level name (case-insensitive); anything unknown falls back. */
export function parseLevel(value: string | undefined, fallback: Level = 'info'): Level {
  const v = value?.trim().toLowerCase()
  return v && v in ORDER ? (v as Level) : fallback
}

/** A short, single-line description of a thrown value. */
export function errText(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code
    return `${err.name === 'Error' ? '' : `${err.name}: `}${err.message}${typeof code === 'string' ? ` (${code})` : ''}`
  }
  return String(err)
}

const TOKEN_RE = /(?<!\d)\d{6,}:[A-Za-z0-9_-]{30,}/g

/** Hide anything shaped like a Telegram bot token. */
export function redact(text: string): string {
  return text.replace(TOKEN_RE, '<redacted-token>')
}

export type LogOptions = {
  /** Minimum level to emit. Default: info. */
  level?: Level
  /** Append lines to this file as well as writing them to stderr. */
  file?: string
  /** Rotate the file to `<file>.1` once it grows past this many bytes. Default 1 MiB. */
  maxBytes?: number
  /** Where non-file output goes. Default: process.stderr. Tests replace it. */
  write?: (line: string) => void
  /** Clock, for tests. */
  now?: () => Date
}

export type Logger = {
  readonly level: Level
  debug(msg: string, err?: unknown): void
  info(msg: string, err?: unknown): void
  warn(msg: string, err?: unknown): void
  error(msg: string, err?: unknown): void
  /** Same options, longer prefix: `prefix/sub`. */
  child(sub: string): Logger
}

/** Format one log line (without the trailing newline). */
export function formatLine(time: Date, prefix: string, level: Level, msg: string, err?: unknown): string {
  const detail = err === undefined ? '' : `: ${errText(err)}`
  return redact(`${time.toISOString()} ${level.toUpperCase().padEnd(5)} ${prefix}: ${msg}${detail}`).replace(/\r?\n/g, '\\n')
}

export function createLogger(prefix: string, opts: LogOptions = {}): Logger {
  const level = opts.level ?? 'info'
  const maxBytes = opts.maxBytes ?? 1024 * 1024
  const write = opts.write ?? ((line: string) => process.stderr.write(line))
  const now = opts.now ?? (() => new Date())
  let fileReady = false

  const toFile = (line: string): void => {
    if (!opts.file) return
    try {
      if (!fileReady) {
        mkdirSync(dirname(opts.file), { recursive: true, mode: 0o700 })
        fileReady = true
      }
      try {
        if (statSync(opts.file).size > maxBytes) renameSync(opts.file, `${opts.file}.1`)
      } catch {
        // No file yet: nothing to rotate.
      }
      appendFileSync(opts.file, line, { mode: 0o600 })
    } catch {
      // Logging must never take the process down; stderr still has the line.
    }
  }

  const emit = (lvl: Level, msg: string, err?: unknown): void => {
    if (ORDER[lvl] < ORDER[level]) return
    const line = `${formatLine(now(), prefix, lvl, msg, err)}\n`
    write(line)
    toFile(line)
  }

  return {
    level,
    debug: (m, e) => emit('debug', m, e),
    info: (m, e) => emit('info', m, e),
    warn: (m, e) => emit('warn', m, e),
    error: (m, e) => emit('error', m, e),
    child: sub => createLogger(`${prefix}/${sub}`, opts),
  }
}
