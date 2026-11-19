// Downloaded photos and files pile up in the inbox; prune old ones.

import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ignored, INBOX_DIR } from './config.ts'

// LOCAL PATCH: downloaded photos and files pile up in the inbox. Delete those
// older than TELEGRAM_INBOX_KEEP_DAYS (default 30, 0 keeps everything), at
// startup and every six hours.
const INBOX_KEEP_DAYS = Number(process.env.TELEGRAM_INBOX_KEEP_DAYS ?? 30)

export function pruneInbox(): void {
  if (!(INBOX_KEEP_DAYS > 0)) return
  const cutoff = Date.now() - INBOX_KEEP_DAYS * 86_400_000
  let names: string[]
  try {
    names = readdirSync(INBOX_DIR)
  } catch {
    return
  }
  for (const name of names) {
    const p = join(INBOX_DIR, name)
    try {
      const st = statSync(p)
      if (st.isFile() && st.mtimeMs < cutoff) rmSync(p)
    } catch (err) {
      ignored(`inbox prune: ${name}`, err)
    }
  }
}
/** Prune now and every six hours. */
export function startInboxPruning(): void {
  pruneInbox()
  setInterval(pruneInbox, 6 * 3600_000).unref()
}
