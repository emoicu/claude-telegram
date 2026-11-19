#!/usr/bin/env bun
/**
 * PermissionRequest hook: the other half of the "Always allow" button.
 *
 * The channel relays a permission prompt to Telegram as allow or deny for a
 * single call. This hook records each prompt's permission suggestions so the
 * button can remember them, and allows later prompts the user already chose
 * "Always allow" for in the same conversation, passing the suggestions to
 * Claude Code as session rules. It never denies, and when it has nothing to
 * say it prints nothing, so the normal prompt (and its relay) goes ahead.
 *
 * Runs for every session that has the plugin enabled, so it first checks
 * that its Claude Code process loaded the plugin as a channel (same rule as
 * server.ts).
 */
import {
  addPending,
  allowOutput,
  loadList,
  matchRemembered,
  type PendingPrompt,
  pendingFile,
  type Remembered,
  rememberedFile,
  type Suggestion,
  saveList,
} from '../lib/remember'
import { SLOT, STATE_DIR, isChannelSession, readHookInput } from './lib'

type HookInput = {
  hook_event_name?: string
  session_id?: string
  tool_name?: string
  tool_input?: unknown
  permission_suggestions?: Suggestion[]
}

async function main(): Promise<void> {
  const input = (await readHookInput<HookInput>()) ?? {}
  if (input.hook_event_name && input.hook_event_name !== 'PermissionRequest') return
  if (!input.tool_name || !input.session_id) return
  if (!isChannelSession()) return

  const now = Date.now()
  const toolInput = JSON.stringify(input.tool_input ?? {})
  const remembered = loadList<Remembered>(rememberedFile(STATE_DIR, SLOT))
  const hit = matchRemembered(remembered, input.session_id, input.tool_name, toolInput, input.permission_suggestions, now)
  if (hit) {
    process.stdout.write(`${JSON.stringify(allowOutput(input.permission_suggestions ?? []))}\n`)
    return
  }

  const file = pendingFile(STATE_DIR, SLOT)
  const pending = loadList<PendingPrompt>(file)
  addPending(
    pending,
    { at: now, session: input.session_id, tool: input.tool_name, input: toolInput, suggestions: input.permission_suggestions ?? [] },
    now,
  )
  try {
    saveList(file, pending)
  } catch {
    // Without the record the button just allows once.
  }
}

await main()
