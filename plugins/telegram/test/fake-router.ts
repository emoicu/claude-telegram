#!/usr/bin/env bun
// Stands in for router.ts in the supervisor tests: copied into each fake
// plugin version directory. Logs each start to $CLAUDE_CONFIG_DIR/runs.log,
// exits 3 right away when a "crash" file sits next to it, and otherwise runs
// until killed, or (TELEGRAM_ROUTER_SELF_UPDATE=1) exits 0 once another
// version is installed, like the real router.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const dir = import.meta.dir
const claudeDir = process.env.CLAUDE_CONFIG_DIR!
appendFileSync(
  join(claudeDir, 'runs.log'),
  `${basename(dir)} self=${process.env.TELEGRAM_ROUTER_SELF_UPDATE ?? ''} cwd=${process.cwd()} tmux=${process.env.TELEGRAM_ROUTER_TMUX ?? ''}\n`,
)
if (existsSync(join(dir, 'crash'))) process.exit(3)

function installed(): string | undefined {
  try {
    return JSON.parse(readFileSync(join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8')).plugins['telegram@emoicu-plugins'][0].installPath
  } catch {
    return undefined
  }
}

setInterval(() => {
  if (process.env.TELEGRAM_ROUTER_SELF_UPDATE === '1' && installed() !== dir) process.exit(0)
}, 100)
