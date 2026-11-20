#!/usr/bin/env bun
/**
 * PreToolUse hook for AskUserQuestion: in the Telegram channel session, send
 * the questions to the chat as inline buttons instead of the terminal picker,
 * which a remote user can neither see nor answer.
 *
 * The hook stores the questions in <state>/ask/<id>.json, posts one message
 * per question with a button per option (multi-select questions get a Done
 * button), then denies the tool call with a reason telling Claude to end its
 * turn. The record is written before the first message goes out, so a tap
 * that comes while later questions are still being sent finds it; each
 * message id is added to it as soon as that message is sent. server.ts handles the button presses and, once every question is
 * answered, delivers the answers to Claude as a channel message. The user can
 * also just type a free-form answer.
 *
 * If anything fails before the questions are sent, the hook stays silent and
 * the normal terminal picker is used.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { STATE_DIR, botCall, isChannelSession, readHookInput, readToken, t, targets } from './lib'

type Option = { label?: string; description?: string }
type Question = { question?: string; header?: string; multiSelect?: boolean; options?: Option[] }
type HookInput = { hook_event_name?: string; tool_name?: string; tool_input?: { questions?: Question[] } }

type StoredQuestion = { options: string[]; selected: number[]; done: boolean; messages: Record<string, number>; text: string }
type Sent = { qi: number; chat: string; id: number }

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Write the record atomically, so server.ts never reads half of it. */
function writeRecord(file: string, record: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 })
  renameSync(tmp, file)
}

/** What server.ts shows on a question's message once it is answered. */
const answeredText = (q: StoredQuestion): string => `${q.text}\n\n✅ ${q.selected.map(i => q.options[i]).join(', ') || t('askNone')}`

/**
 * The record on disk with every message this hook sent added to it.
 * server.ts may have stored an answer in it meanwhile, so the file is read
 * again rather than overwritten with this hook's copy. `touched` tells
 * whether something other than this hook changed the file since its last
 * write.
 */
function addMessages<R extends { questions: StoredQuestion[] }>(
  file: string,
  fallback: R,
  sent: Sent[],
  last: { written: string },
): { rec: R; touched: boolean } {
  let raw = ''
  let rec = fallback
  try {
    raw = readFileSync(file, 'utf8')
    rec = JSON.parse(raw)
  } catch {}
  const touched = raw !== '' && raw !== last.written
  let changed = false
  for (const { qi, chat, id } of sent) {
    const q = rec.questions?.[qi]
    if (!q || q.messages?.[chat] === id) continue
    q.messages = { ...q.messages, [chat]: id }
    changed = true
  }
  if (changed || raw === '') {
    last.written = JSON.stringify(rec)
    writeRecord(file, rec)
  }
  return { rec, touched }
}

async function main(): Promise<void> {
  if (process.env.TELEGRAM_ASK === 'off') return
  const input = await readHookInput<HookInput>()
  if (input?.tool_name !== 'AskUserQuestion') return
  const questions = (input.tool_input?.questions ?? []).filter(q => q.question && q.options?.length)
  if (!questions.length) return
  if (!isChannelSession()) return
  const token = readToken()
  const chats = targets()
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

  for (const [qi, q] of record.questions.entries()) {
    const lines = [`❓ ${q.header ? `${q.header}: ` : ''}${q.question}`, '']
    q.options.forEach((label, i) => {
      lines.push(`${i + 1}. ${label}${q.descriptions[i] ? ` — ${q.descriptions[i]}` : ''}`)
    })
    lines.push('', t(q.multiSelect ? 'askHintMulti' : 'askHintSingle'))
    if (record.questions.length > 1) lines.push(t('askCounter', { i: qi + 1, n: record.questions.length }))
    q.text = lines.join('\n')
  }

  // Before sending anything: a tap on the first question may come before
  // the last one is sent.
  const file = join(STATE_DIR, 'ask', `${id}.json`)
  const last = { written: JSON.stringify(record) }
  try {
    mkdirSync(join(STATE_DIR, 'ask'), { recursive: true, mode: 0o700 })
    writeRecord(file, record)
  } catch {
    return // no record, no answers: use the terminal picker
  }

  const sent: Sent[] = []
  let touched = false
  for (const [qi, q] of record.questions.entries()) {
    const rows = q.options.map((label, i) => [{ text: clip(`${i + 1}. ${label}`, 60), callback_data: `ask:${id}:${qi}:${i}` }])
    if (q.multiSelect) rows.push([{ text: t('askDone'), callback_data: `ask:${id}:${qi}:d` }])
    for (const target of chats) {
      const res = await botCall(token, 'sendMessage', { ...target, text: q.text, reply_markup: { inline_keyboard: rows } })
      if (!res?.ok) continue
      q.messages[target.chat_id] = res.result.message_id
      sent.push({ qi, chat: target.chat_id, id: res.result.message_id })
      try {
        touched = addMessages(file, record, sent, last).touched || touched
      } catch {}
    }
  }
  if (!sent.length) {
    // Nothing reached Telegram: fall back to the terminal picker.
    rmSync(file, { force: true })
    return
  }

  // Answered while the questions were still going out: server.ts may have
  // written back a copy without the later message ids, and could not update
  // a message whose id it did not know yet. Settle that once it is done.
  if (touched) {
    try {
      await Bun.sleep(1000)
      const { rec } = addMessages(file, record, sent, last)
      for (const { qi, chat, id: message_id } of sent) {
        const q = rec.questions[qi]
        if (q?.done) await botCall(token, 'editMessageText', { chat_id: chat, message_id, text: answeredText(q) })
      }
    } catch {}
  }

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
