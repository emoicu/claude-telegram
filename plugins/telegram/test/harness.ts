// End-to-end test harness: a fake Telegram Bot API server and an MCP client
// that runs server.ts as Claude Code would (stdio), so whole flows can be
// tested without a real bot, network or Claude.

import { type Subprocess, spawn } from 'bun'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type Call = { method: string; body: Record<string, any>; result?: any }
type Failure = { error_code: number; description: string; parameters?: Record<string, unknown> }

const BOT = { id: 999000, is_bot: true, first_name: 'Test', username: 'test_bot' }

/** A Bot API server that records every call and serves queued updates. */
export class FakeTelegram {
  readonly calls: Call[] = []
  private updates: any[] = []
  private nextUpdate = 1
  private nextMessage = 5000
  private pollers: (() => void)[] = []
  private failures = new Map<string, (Failure | null)[]>()
  private files = new Map<string, { file_path: string; file_unique_id: string; content?: string }>()
  private server: ReturnType<typeof Bun.serve>

  constructor() {
    this.server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: req => this.handle(req) })
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`
  }

  stop(): void {
    for (const wake of this.pollers.splice(0)) wake()
    this.server.stop(true)
  }

  /** Queue an update (update_id is filled in unless given). */
  push(update: Record<string, unknown>): void {
    this.updates.push({ ...update, update_id: update.update_id ?? this.nextUpdate++ })
    for (const wake of this.pollers.splice(0)) wake()
  }

  /** A private message from `user` (id doubles as chat id). */
  dm(user: number, text: string, extra: Record<string, unknown> = {}): number {
    const message_id = this.nextMessage++
    this.push({
      message: {
        message_id,
        date: Math.floor(Date.now() / 1000),
        chat: { id: user, type: 'private', first_name: `U${user}` },
        from: { id: user, is_bot: false, first_name: `U${user}`, username: `u${user}` },
        text,
        ...extra,
      },
    })
    return message_id
  }

  /** A message from `user` in group `chat`. */
  group(chat: number, user: number, text: string, extra: Record<string, unknown> = {}): number {
    const message_id = this.nextMessage++
    this.push({
      message: {
        message_id,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chat, type: 'supergroup', title: `G${chat}` },
        from: { id: user, is_bot: false, first_name: `U${user}`, username: `u${user}` },
        text,
        ...extra,
      },
    })
    return message_id
  }

  /** A press on an inline button of message `messageId` (in the user's DM, or in group `chat`). */
  press(user: number, data: string, messageId: number, text = '', chat?: number): void {
    this.push(this.pressUpdate(user, data, messageId, text, chat))
  }

  /** The callback_query update of a press, for sending it some other way (a fake router). */
  pressUpdate(user: number, data: string, messageId: number, text = '', chat?: number): Record<string, unknown> {
    return {
      update_id: this.nextUpdate++,
      callback_query: {
        id: `cb${this.nextUpdate}`,
        from: { id: user, is_bot: false, first_name: `U${user}` },
        chat_instance: '1',
        data,
        message: {
          message_id: messageId,
          date: 0,
          chat: chat == null ? { id: user, type: 'private' } : { id: chat, type: 'supergroup', title: `G${chat}` },
          text,
        },
      },
    }
  }

  /**
   * Answer the next calls of `method` with these errors, in order; a null
   * lets that call through.
   */
  failNext(method: string, ...errors: (Failure | null)[]): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), ...errors])
  }

  /** What getFile returns for `file_id`; `content` is served for download, none answers 404. */
  serveFile(file_id: string, file: { file_path: string; file_unique_id: string; content?: string }): void {
    this.files.set(file_id, file)
  }

  sent(method?: string | RegExp): Call[] {
    return this.calls.filter(c => (method === undefined ? true : typeof method === 'string' ? c.method === method : method.test(c.method)))
  }

  /** Wait for a call matching `pred` (default 5 s). */
  async waitFor(pred: (c: Call) => boolean, what = 'call', timeoutMs = 5000): Promise<Call> {
    const end = Date.now() + timeoutMs
    for (;;) {
      const hit = this.calls.find(pred)
      if (hit) return hit
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}; calls: ${this.calls.map(c => c.method).join(', ')}`)
      await Bun.sleep(20)
    }
  }

  private async handle(req: Request): Promise<Response> {
    const pathname = new URL(req.url).pathname
    const download = /^\/file\/bot[^/]+\/(.+)$/.exec(pathname)
    if (download) {
      this.calls.push({ method: 'download', body: { file_path: download[1] } })
      const file = [...this.files.values()].find(f => f.file_path === download[1] && f.content != null)
      return file ? new Response(file.content) : new Response('Not Found', { status: 404 })
    }
    const m = /\/bot[^/]+\/(\w+)$/.exec(pathname)
    if (!m) return Response.json({ ok: false, error_code: 404, description: 'Not Found' }, { status: 404 })
    const method = m[1]!
    let body: Record<string, any> = {}
    const type = req.headers.get('content-type') ?? ''
    if (type.includes('json')) body = (await req.json().catch(() => ({}))) as Record<string, any>
    else if (type.includes('form')) {
      const form = await req.formData()
      for (const [k, v] of form.entries()) body[k] = typeof v === 'string' ? v : `<file ${(v as File).name}>`
    }
    const failure = this.failures.get(method)?.shift()
    if (failure) {
      this.calls.push({ method, body, result: { failed: failure.error_code } })
      return Response.json({ ok: false, ...failure }, { status: failure.error_code })
    }
    const result = await this.result(method, body)
    if (method !== 'getUpdates') this.calls.push({ method, body, result })
    return Response.json({ ok: true, result })
  }

  private async result(method: string, body: Record<string, any>): Promise<unknown> {
    switch (method) {
      case 'getMe':
        return BOT
      case 'getFile': {
        const file = this.files.get(String(body.file_id))
        return file ? { file_id: body.file_id, file_unique_id: file.file_unique_id, file_path: file.file_path } : { file_id: body.file_id, file_unique_id: 'u' }
      }
      case 'getUpdates': {
        const offset = Number(body.offset ?? 0)
        this.updates = this.updates.filter(u => u.update_id >= offset)
        if (!this.updates.length) {
          // Long poll, but short: tests should not wait on it.
          await new Promise<void>(resolve => {
            const t = setTimeout(resolve, Math.min(Number(body.timeout ?? 0), 1) * 1000)
            this.pollers.push(() => {
              clearTimeout(t)
              resolve()
            })
          })
        }
        return this.updates.slice()
      }
      case 'sendMessage':
      case 'sendRichMessage':
      case 'sendPhoto':
      case 'sendDocument':
      case 'editMessageText':
        return {
          message_id: method === 'editMessageText' ? Number(body.message_id) : this.nextMessage++,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(body.chat_id), type: 'private' },
          from: BOT,
          text: body.text ?? body.rich_message?.markdown ?? '',
        }
      case 'sendPoll': {
        const options = typeof body.options === 'string' ? JSON.parse(body.options) : (body.options ?? [])
        return {
          message_id: this.nextMessage++,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(body.chat_id), type: 'private' },
          from: BOT,
          poll: {
            id: `poll${this.nextMessage}`,
            question: body.question,
            options: options.map((o: { text: string }) => ({ text: o.text, voter_count: 0 })),
            total_voter_count: 0,
            is_closed: false,
            is_anonymous: false,
            type: 'regular',
            allows_multiple_answers: Boolean(body.allows_multiple_answers),
          },
        }
      }
      case 'sendMediaGroup': {
        const media = typeof body.media === 'string' ? JSON.parse(body.media) : (body.media ?? [])
        return media.map(() => ({
          message_id: this.nextMessage++,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(body.chat_id), type: 'private' },
          from: BOT,
        }))
      }
      default:
        return true
    }
  }
}

type Json = Record<string, any>

/** server.ts as an MCP server over stdio, in a throwaway state directory. */
export class Channel {
  readonly stateDir: string
  readonly notifications: Json[] = []
  readonly stderr: string[] = []
  private proc: Subprocess<'pipe', 'pipe', 'pipe'>
  private nextId = 1
  private waiting = new Map<number, (msg: Json) => void>()

  constructor(tg: FakeTelegram, opts: { access?: Json; env?: Record<string, string> } = {}) {
    this.stateDir = mkdtempSync(join(tmpdir(), 'tg-e2e-'))
    const claudeDir = join(this.stateDir, 'claude-config')
    mkdirSync(claudeDir)
    writeFileSync(join(this.stateDir, '.env'), `TELEGRAM_BOT_TOKEN=123456:${'x'.repeat(35)}\n`, { mode: 0o600 })
    if (opts.access) writeFileSync(join(this.stateDir, 'access.json'), JSON.stringify(opts.access))
    this.proc = spawn(['bun', join(import.meta.dir, '..', 'server.ts')], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: this.stateDir,
        CLAUDE_CONFIG_DIR: claudeDir,
        TELEGRAM_STATE_DIR: this.stateDir,
        TELEGRAM_API_ROOT: tg.url,
        TELEGRAM_CHANNEL_MODE: 'always',
        TELEGRAM_STATUS: 'off',
        TELEGRAM_LOG_LEVEL: 'debug',
        ...opts.env,
      },
    })
    void this.readLines(this.proc.stdout, line => this.onMessage(JSON.parse(line)))
    void this.readLines(this.proc.stderr, line => this.stderr.push(line))
  }

  private async readLines(stream: ReadableStream<Uint8Array>, each: (line: string) => void): Promise<void> {
    const decoder = new TextDecoder()
    let buf = ''
    for await (const chunk of stream) {
      buf += decoder.decode(chunk, { stream: true })
      let nl = buf.indexOf('\n')
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) {
          try {
            each(line)
          } catch {
            this.stderr.push(`unparsed stdout: ${line}`)
          }
        }
        nl = buf.indexOf('\n')
      }
    }
  }

  private onMessage(msg: Json): void {
    if (msg.id != null && this.waiting.has(msg.id)) {
      this.waiting.get(msg.id)!(msg)
      this.waiting.delete(msg.id)
    } else if (msg.method) this.notifications.push(msg)
  }

  private write(msg: Json): void {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
    this.proc.stdin.flush()
  }

  request(method: string, params: Json = {}, timeoutMs = 5000): Promise<Json> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${method} timed out; stderr:\n${this.stderr.slice(-10).join('\n')}`)), timeoutMs)
      this.waiting.set(id, msg => {
        clearTimeout(t)
        resolve(msg)
      })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params: Json = {}): void {
    this.write({ method, params })
  }

  /** The MCP handshake only (a server that does not poll Telegram). */
  async handshake(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '1' },
    })
    this.notify('notifications/initialized')
  }

  /** MCP handshake, then wait until the bot polls Telegram. */
  async start(tg: FakeTelegram): Promise<void> {
    await this.handshake()
    await tg.waitFor(c => c.method === 'setMyCommands' || c.method === 'deleteWebhook', 'bot start', 10_000)
    await Bun.sleep(200)
  }

  /** Call a tool; returns its text, or throws with the error text. */
  async tool(name: string, args: Json): Promise<string> {
    const res = await this.request('tools/call', { name, arguments: args })
    const text = (res.result?.content ?? []).map((c: Json) => c.text).join('\n')
    if (res.error) throw new Error(res.error.message)
    if (res.result?.isError) throw new Error(text)
    return text
  }

  async waitNotification(method: string, pred: (params: Json) => boolean = () => true, timeoutMs = 5000): Promise<Json> {
    const end = Date.now() + timeoutMs
    for (;;) {
      const hit = this.notifications.find(n => n.method === method && pred(n.params ?? {}))
      if (hit) return hit.params ?? {}
      if (Date.now() > end) throw new Error(`timed out waiting for ${method}; stderr:\n${this.stderr.slice(-15).join('\n')}`)
      await Bun.sleep(20)
    }
  }

  async stop(): Promise<void> {
    this.proc.kill()
    await this.proc.exited
  }
}

/** Run a hook script as Claude Code would: JSON on stdin, output on stdout. */
export async function runHook(
  script: string,
  input: Record<string, unknown>,
  env: Record<string, string>,
): Promise<{ stdout: string; code: number }> {
  const proc = spawn(['bun', join(import.meta.dir, '..', 'hooks', script)], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
    env: { PATH: process.env.PATH ?? '', TELEGRAM_CHANNEL_MODE: 'always', ...env },
  })
  proc.stdin.write(JSON.stringify(input))
  proc.stdin.end()
  const stdout = await new Response(proc.stdout).text()
  return { stdout, code: await proc.exited }
}
