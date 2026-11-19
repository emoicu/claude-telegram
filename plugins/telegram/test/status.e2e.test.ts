import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Channel, FakeTelegram, runHook } from './harness'

// Live status and Stop, driven by the activity hook alone: in the tests there
// is no Claude Code session file, as when its format changes.

const OWNER = 1111
const allowlist = { dmPolicy: 'allowlist', allowFrom: [String(OWNER)], groups: {}, pending: {} }

let tg: FakeTelegram
let ch: Channel
const hook = (input: Record<string, unknown>) =>
  runHook('activity-telegram.ts', input, { TELEGRAM_STATE_DIR: ch.stateDir, TELEGRAM_API_ROOT: tg.url })
const tool = (command: string) => hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } })

beforeEach(async () => {
  tg = new FakeTelegram()
  ch = new Channel(tg, {
    access: allowlist,
    env: {
      TELEGRAM_STATUS: 'on',
      TELEGRAM_STATUS_STYLE: 'message',
      TELEGRAM_STATUS_AFTER_SEC: '0',
      TELEGRAM_REACTION_STATUS: 'off',
    },
  })
  await ch.start(tg)
  // A message from the owner makes their chat the one that gets the status.
  tg.dm(OWNER, 'do the thing')
  await ch.waitNotification('notifications/claude/channel')
})
afterEach(async () => {
  await ch.stop()
  tg.stop()
})

const statusMessage = () =>
  tg.waitFor(c => c.method === 'sendMessage' && JSON.stringify(c.body.reply_markup ?? {}).includes('stop:run'), 'status message', 8000)

describe('live status from hooks', () => {
  test('shows the current step with a Stop button and goes away when the turn ends', async () => {
    await hook({ hook_event_name: 'UserPromptSubmit' })
    await tool('ls -la')
    const status = await statusMessage()
    expect(status.body.text).toContain('Running: ls -la')
    expect(status.body.text).toMatch(/1 step|step 1|1\b/)

    await tool('npm test')
    await tg.waitFor(c => c.method === 'editMessageText' && /npm test/.test(c.body.text), 'status update', 10_000)

    await hook({ hook_event_name: 'Stop' })
    const del = await tg.waitFor(c => c.method === 'deleteMessage', 'status removed', 8000)
    expect(del.body.message_id).toBe(status.result.message_id)
  }, 30_000)
})

describe('Stop button', () => {
  test('without tmux the next tool call ends the turn', async () => {
    await hook({ hook_event_name: 'UserPromptSubmit' })
    await tool('sleep 1')
    const status = await statusMessage()

    tg.press(OWNER, 'stop:run', status.result.message_id, status.body.text)
    const toast = await tg.waitFor(c => c.method === 'answerCallbackQuery', 'toast')
    expect(toast.body.text).toBe('Stopping at the next step…')
    const flag = join(ch.stateDir, 'activity', 'main.stop')
    expect(existsSync(flag)).toBe(true)

    const next = await tool('rm -rf build')
    const out = JSON.parse(next.stdout)
    expect(out.continue).toBe(false)
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(existsSync(flag)).toBe(false)

    // The call after that runs normally again.
    expect((await tool('ls')).stdout).toBe('')
  }, 30_000)

  test('a Stop when nothing runs says so and sets no flag', async () => {
    await hook({ hook_event_name: 'UserPromptSubmit' })
    await tool('ls')
    const status = await statusMessage()
    await hook({ hook_event_name: 'Stop' })
    tg.press(OWNER, 'stop:run', status.result.message_id, status.body.text)
    const toast = await tg.waitFor(c => c.method === 'answerCallbackQuery', 'toast')
    expect(toast.body.text).toBe('Claude is not working on anything right now.')
    expect(existsSync(join(ch.stateDir, 'activity', 'main.stop'))).toBe(false)
  }, 30_000)

  test('a stranger cannot stop', async () => {
    await hook({ hook_event_name: 'UserPromptSubmit' })
    await tool('ls')
    const status = await statusMessage()
    tg.press(2222, 'stop:run', status.result.message_id, status.body.text)
    const toast = await tg.waitFor(c => c.method === 'answerCallbackQuery', 'toast')
    expect(toast.body.text).toBe('Not authorized.')
    expect(existsSync(join(ch.stateDir, 'activity', 'main.stop'))).toBe(false)
  }, 30_000)
})
