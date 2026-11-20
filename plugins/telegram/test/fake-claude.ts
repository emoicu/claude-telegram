#!/usr/bin/env bun
// Stand-in for Claude Code in the router end-to-end tests: it writes the
// session file the router reads (status from $CLAUDE_CONFIG_DIR/fake-status),
// keeps a transcript file so --resume counts as valid, says hello on the
// router socket like server.ts and logs every start to starts.log. With a
// fake-crash file it exits right after starting. Lines from the router go to
// received.log.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
if (args.includes('--version')) {
  console.log('1.0.0 (Claude Code)')
  process.exit(0)
}
const dir = process.env.CLAUDE_CONFIG_DIR!
const r = args.indexOf('--resume')
const sessionId = r >= 0 ? args[r + 1]! : crypto.randomUUID()
mkdirSync(join(dir, 'sessions'), { recursive: true })
mkdirSync(join(dir, 'projects', 'test'), { recursive: true })
writeFileSync(join(dir, 'projects', 'test', `${sessionId}.jsonl`), '')
appendFileSync(join(dir, 'starts.log'), `${process.pid} ${args.join(' ')}\n`)
// A Claude that dies right away, before it connects.
if (existsSync(join(dir, 'fake-crash'))) process.exit(1)

const status = () => {
  try {
    return readFileSync(join(dir, 'fake-status'), 'utf8').trim() || 'idle'
  } catch {
    return 'idle'
  }
}
const write = () => writeFileSync(join(dir, 'sessions', `${process.pid}.json`), JSON.stringify({ sessionId, status: status() }))
write()
setInterval(write, 200)

await Bun.connect({
  unix: process.env.TELEGRAM_ROUTER_SOCKET!,
  socket: {
    open(sock) {
      // An older plugin (fake-no-resume) does not say what it can do.
      const can = existsSync(join(dir, 'fake-no-resume')) ? {} : { can: ['resume'] }
      sock.write(`${JSON.stringify({ hello: process.env.TELEGRAM_SLOT, plugin: '9.9.9', ...can })}\n`)
    },
    data(_sock, chunk) {
      appendFileSync(join(dir, 'received.log'), chunk.toString())
    },
  },
})

process.on('SIGTERM', () => {
  if (!existsSync(join(dir, 'fake-ignore-term'))) process.exit(0)
})
