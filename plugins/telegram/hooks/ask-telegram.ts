#!/usr/bin/env bun
/**
 * PreToolUse hook for AskUserQuestion: in the Telegram channel session, send
 * the questions to the chat as inline buttons instead of the terminal picker,
 * which a remote user can neither see nor answer.
 *
 * The hook stores the questions in <state>/ask/<id>.json, posts one message
 * per question with a button per option (multi-select questions get a Done
 * button), then denies the tool call with a reason telling Claude to end its
 * turn. server.ts handles the button presses and, once every question is
 * answered, delivers the answers to Claude as a channel message. The user can
 * also just type a free-form answer.
 *
 * If anything fails before the questions are sent, the hook stays silent and
 * the normal terminal picker is used.
 */
import { mkdirSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'
import { STATE_DIR, botCall, isChannelSession, readHookInput, readToken, recipients } from './lib'

type Option = { label?: string; description?: string }
type Question = { question?: string; header?: string; multiSelect?: boolean; options?: Option[] }
type HookInput = { hook_event_name?: string; tool_name?: string; tool_input?: { questions?: Question[] } }

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

async function main(): Promise<void> {
  if (process.env.TELEGRAM_ASK === 'off') return
  const input = await readHookInput<HookInput>()
  if (!input || input.tool_name !== 'AskUserQuestion') return
  const questions = (input.tool_input?.questions ?? []).filter(q => q.question && q.options?.length)
  if (!questions.length) return
  if (!isChannelSession()) return
  const token = readToken()
  const chats = recipients()
  if (!token || !chats.length) return

  const id = randomBytes(4).toString('hex')
  const record = {
    id,
    created: Date.now(),
    delivered: false,
    questions: questions.map(q => ({
      header: q.header ?? '',
      question: q.question!,
      multiSelect: !!q.multiSelect,
      options: q.options!.map(o => o.label ?? ''),
      descriptions: q.options!.map(o => o.description ?? ''),
      selected: [] as number[],
      done: false,
      messages: {} as Record<string, number>,
      text: '',
    })),
  }

  let sent = 0
  for (const [qi, q] of record.questions.entries()) {
    const lines = [`❓ ${q.header ? `${q.header}: ` : ''}${q.question}`, '']
    q.options.forEach((label, i) => {
      lines.push(`${i + 1}. ${label}${q.descriptions[i] ? ` — ${q.descriptions[i]}` : ''}`)
    })
    lines.push('', q.multiSelect ? 'Tap one or more options, then Done. Or type your answer.' : 'Tap an option, or type your answer.')
    if (record.questions.length > 1) lines.push(`(question ${qi + 1} of ${record.questions.length})`)
    q.text = lines.join('\n')
    const rows = q.options.map((label, i) => [{ text: clip(`${i + 1}. ${label}`, 60), callback_data: `ask:${id}:${qi}:${i}` }])
    if (q.multiSelect) rows.push([{ text: '✅ Done', callback_data: `ask:${id}:${qi}:d` }])
    for (const chat_id of chats) {
      const res = await botCall(token, 'sendMessage', { chat_id, text: q.text, reply_markup: { inline_keyboard: rows } })
      if (res?.ok) {
        q.messages[chat_id] = res.result.message_id
        sent++
      }
    }
  }
  if (!sent) return // nothing reached Telegram: fall back to the terminal picker

  mkdirSync(join(STATE_DIR, 'ask'), { recursive: true, mode: 0o700 })
  writeFileSync(join(STATE_DIR, 'ask', `${id}.json`), JSON.stringify(record))

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'The user is not at the terminal; they talk to you through Telegram. ' +
          'Your questions were sent to the Telegram chat with a button per option. ' +
          'Do not call AskUserQuestion again and do not repeat the questions: end your turn now. ' +
          'Their answers will arrive as a channel message (they may also type a free-form answer).',
      },
    }),
  )
}

await main()
