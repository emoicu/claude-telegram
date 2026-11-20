import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Channel, FakeTelegram, runHook } from './harness'

const OWNER = 1111
const allowlist = { dmPolicy: 'allowlist', allowFrom: [String(OWNER)], groups: {}, pending: {} }

let tg: FakeTelegram
let ch: Channel
const env = () => ({ TELEGRAM_STATE_DIR: ch.stateDir, TELEGRAM_API_ROOT: tg.url })

beforeEach(async () => {
  tg = new FakeTelegram()
  ch = new Channel(tg, { access: allowlist })
  await ch.start(tg)
})
afterEach(async () => {
  await ch.stop()
  tg.stop()
})

describe('StopFailure hook', () => {
  const failure = {
    hook_event_name: 'StopFailure',
    error: 'rate_limit',
    error_details: '429 Too Many Requests',
    last_assistant_message: 'API Error: Rate limit reached',
  }

  test('tells the chat once, not on every failing turn', async () => {
    await runHook('failure-telegram.ts', failure, env())
    const alert = await tg.waitFor(c => c.method === 'sendMessage' && /rate limit/i.test(c.body.text), 'alert')
    expect(String(alert.body.chat_id)).toBe(String(OWNER))
    expect(alert.body.text).toContain('API Error: Rate limit reached')
    await runHook('failure-telegram.ts', failure, env())
    expect(tg.sent('sendMessage').filter(c => /rate limit/i.test(c.body.text))).toHaveLength(1)
  })

  test('speaks the language chosen with /language', async () => {
    writeFileSync(join(ch.stateDir, 'language'), 'zh\n')
    await runHook('failure-telegram.ts', failure, env())
    const alert = await tg.waitFor(c => c.method === 'sendMessage' && /用量或速率达到上限/.test(c.body.text), 'Chinese alert')
    expect(alert.body.text).toContain('发 /usage 看什么时候重置')
  })

  test('does nothing outside the channel session', async () => {
    await runHook('failure-telegram.ts', failure, { ...env(), TELEGRAM_CHANNEL_MODE: 'never' })
    await Bun.sleep(300)
    expect(tg.sent('sendMessage')).toHaveLength(0)
  })
})

describe('Always allow', () => {
  const prompt = (command: string) => ({
    hook_event_name: 'PermissionRequest',
    session_id: 'sess-1',
    tool_name: 'Bash',
    tool_input: { command },
    permission_suggestions: [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run test *' }], behavior: 'allow', destination: 'localSettings' },
    ],
  })

  test('the button remembers the prompt and the hook allows the next one by itself', async () => {
    // 1. Claude Code is about to ask: the hook records the prompt and stays silent.
    const first = await runHook('permission-telegram.ts', prompt('npm run test'), env())
    expect(first.stdout).toBe('')
    expect(existsSync(join(ch.stateDir, 'permissions', 'pending-main.json'))).toBe(true)

    // 2. The prompt is relayed to Telegram and the owner presses Always allow.
    ch.notify('notifications/claude/channel/permission_request', {
      request_id: 'qwert',
      tool_name: 'Bash',
      description: 'Run tests',
      input_preview: '{"command":"npm run test"}',
    })
    const msg = await tg.waitFor(c => c.method === 'sendMessage' && /Permission/.test(c.body.text), 'prompt')
    tg.press(OWNER, 'perm:always:qwert', msg.result.message_id, msg.body.text)
    expect(await ch.waitNotification('notifications/claude/channel/permission')).toEqual({ request_id: 'qwert', behavior: 'allow' })
    const toast = await tg.waitFor(c => c.method === 'answerCallbackQuery', 'toast')
    expect(toast.body.text).toContain('Bash(npm run test *)')

    // 3. The same kind of prompt later in the conversation: allowed, with session rules.
    const next = await runHook('permission-telegram.ts', prompt('npm run test --watch'), env())
    const out = JSON.parse(next.stdout)
    expect(out.hookSpecificOutput.decision.behavior).toBe('allow')
    expect(out.hookSpecificOutput.decision.updatedPermissions[0].destination).toBe('session')

    // 4. Another conversation is not covered.
    const other = await runHook('permission-telegram.ts', { ...prompt('npm run test'), session_id: 'sess-2' }, env())
    expect(other.stdout).toBe('')
  })

  test('an extra directory allowed for Read does not allow Write there', async () => {
    const outside = (tool: string) => ({
      hook_event_name: 'PermissionRequest',
      session_id: 'sess-1',
      tool_name: tool,
      tool_input: { file_path: '/etc/hosts' },
      permission_suggestions: [{ type: 'addDirectories', directories: ['/etc'], destination: 'session' }],
    })
    expect((await runHook('permission-telegram.ts', outside('Read'), env())).stdout).toBe('')
    ch.notify('notifications/claude/channel/permission_request', {
      request_id: 'asdfg',
      tool_name: 'Read',
      description: 'Read a file',
      input_preview: '{"file_path":"/etc/hosts"}',
    })
    const msg = await tg.waitFor(c => c.method === 'sendMessage' && /Permission/.test(c.body.text), 'prompt')
    tg.press(OWNER, 'perm:always:asdfg', msg.result.message_id, msg.body.text)
    const toast = await tg.waitFor(c => c.method === 'answerCallbackQuery', 'toast')
    expect(toast.body.text).toContain('access to /etc')

    expect(JSON.parse((await runHook('permission-telegram.ts', outside('Read'), env())).stdout).hookSpecificOutput.decision.behavior).toBe('allow')
    for (const tool of ['Write', 'Edit', 'Bash']) {
      expect((await runHook('permission-telegram.ts', outside(tool), env())).stdout).toBe('')
    }
  })

  test('without a hook record the button allows once', async () => {
    ch.notify('notifications/claude/channel/permission_request', {
      request_id: 'zxcvb',
      tool_name: 'Bash',
      description: 'List',
      input_preview: '{"command":"ls"}',
    })
    const msg = await tg.waitFor(c => c.method === 'sendMessage' && /Permission/.test(c.body.text), 'prompt')
    tg.press(OWNER, 'perm:always:zxcvb', msg.result.message_id, msg.body.text)
    expect(await ch.waitNotification('notifications/claude/channel/permission')).toEqual({ request_id: 'zxcvb', behavior: 'allow' })
    const toast = await tg.waitFor(c => c.method === 'answerCallbackQuery', 'toast')
    expect(toast.body.text).toContain('once')
    expect(existsSync(join(ch.stateDir, 'permissions', 'remembered-main.json'))).toBe(false)
  })
})

describe('AskUserQuestion hook', () => {
  const ask = {
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [
        { header: 'Color', question: 'Which color?', options: [{ label: 'Red' }, { label: 'Blue' }] },
        { header: 'Size', question: 'Which size?', options: [{ label: 'S' }, { label: 'L' }] },
      ],
    },
  }

  test('the record exists before the first question is sent, so an early tap works', async () => {
    const askDir = join(ch.stateDir, 'ask')
    const recordAtSend: boolean[] = []
    let tapped = false
    // Tap the first question as soon as Telegram has it, while the hook is
    // still sending the second one.
    const push = tg.calls.push.bind(tg.calls)
    tg.calls.push = (...calls) => {
      for (const c of calls) {
        if (c.method !== 'sendMessage' || !/Which/.test(c.body.text)) continue
        recordAtSend.push(existsSync(askDir) && readdirSync(askDir).some(n => n.endsWith('.json')))
        if (!tapped) {
          tapped = true
          const id = /^ask:([0-9a-f]{8}):/.exec(c.body.reply_markup.inline_keyboard[0][0].callback_data)![1]
          tg.press(OWNER, `ask:${id}:0:1`, c.result.message_id, c.body.text)
        }
      }
      return push(...calls)
    }
    const out = await runHook('ask-telegram.ts', ask, env())
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
    expect(recordAtSend).toEqual([true, true])

    const toast = await tg.waitFor(c => c.method === 'answerCallbackQuery', 'toast')
    expect(toast.body.text).toBe('Selected: Blue')

    // The record ends up with both messages, and the second answer delivers both.
    const [name] = readdirSync(askDir).filter(n => n.endsWith('.json'))
    const second = tg.sent('sendMessage').find(c => /Which size/.test(c.body.text))!
    tg.press(OWNER, `ask:${name!.slice(0, 8)}:1:0`, second.result.message_id, second.body.text)
    const answers = await ch.waitNotification('notifications/claude/channel')
    expect(answers.content).toContain('→ Blue')
    expect(answers.content).toContain('→ S')
    const rec = JSON.parse(readFileSync(join(askDir, name!), 'utf8'))
    expect(rec.delivered).toBe(true)
  })

  test('nothing sent: no record is left behind', async () => {
    tg.failNext('sendMessage', { error_code: 400, description: 'Bad Request: chat not found' }, { error_code: 400, description: 'Bad Request: chat not found' })
    const out = await runHook('ask-telegram.ts', ask, env())
    expect(out.stdout).toBe('')
    const askDir = join(ch.stateDir, 'ask')
    expect(existsSync(askDir) ? readdirSync(askDir) : []).toEqual([])
  })
})
