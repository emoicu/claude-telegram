#!/usr/bin/env bun
/**
 * Activity hook (UserPromptSubmit, PreToolUse, PostToolUseFailure, Stop,
 * StopFailure): reports the turn's progress to the channel server for the
 * live status, and carries out the Telegram Stop button.
 *
 * Events go to <state>/activity/<slot>.jsonl (see lib/activity.ts). When the
 * user pressed Stop during this turn, the next tool call is refused and the
 * turn ends (`continue: false`), which works even when the session is not in
 * tmux and the Escape key cannot be sent. Prints nothing otherwise.
 *
 * Runs for every session that has the plugin enabled, so it first checks
 * that its Claude Code process loaded the plugin as a channel (same rule as
 * server.ts). TELEGRAM_STATUS=off disables it.
 */
import { rmSync, statSync } from 'node:fs'
import { activityFile, readActivity, recordEvent, stopFlagFile, stopRequested } from '../lib/activity'
import { describeTool } from '../lib/format'
import { SLOT, STATE_DIR, isChannelSession, readHookInput, t } from './lib'

type HookInput = {
  hook_event_name?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
}

function flagTime(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs
  } catch {
    return undefined
  }
}

async function main(): Promise<void> {
  if (process.env.TELEGRAM_STATUS === 'off') return
  const input = (await readHookInput<HookInput>()) ?? {}
  const event = input.hook_event_name
  if (!event || !isChannelSession()) return

  const file = activityFile(STATE_DIR, SLOT)
  const flag = stopFlagFile(STATE_DIR, SLOT)
  const now = Date.now()
  try {
    switch (event) {
      case 'UserPromptSubmit':
        recordEvent(file, { t: now, e: 'start' })
        return
      case 'PreToolUse': {
        if (stopRequested(flagTime(flag), readActivity(file, now))) {
          rmSync(flag, { force: true })
          recordEvent(file, { t: now, e: 'stop' })
          process.stdout.write(
            `${JSON.stringify({
              continue: false,
              stopReason: 'Stopped from Telegram.',
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: 'The user pressed Stop in Telegram. Stop here and wait for their next message.',
              },
            })}\n`,
          )
          return
        }
        const label = input.tool_name ? describeTool(input.tool_name, input.tool_input ?? {}, t) : undefined
        recordEvent(file, { t: now, e: 'tool', ...(label ? { label } : {}) })
        return
      }
      case 'PostToolUseFailure':
        recordEvent(file, { t: now, e: 'tool_failed' })
        return
      case 'Stop':
      case 'StopFailure':
        recordEvent(file, { t: now, e: 'stop' })
        rmSync(flag, { force: true })
        return
    }
  } catch {
    // The status falls back to Claude Code's own files.
  }
}

await main()
