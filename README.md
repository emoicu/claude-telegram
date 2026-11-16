# claude-telegram

A personally maintained fork of the official Claude Code Telegram channel plugin.

- Upstream: `external_plugins/telegram` in [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official)
- Based on: upstream plugin v0.0.7 (commit `b5b01ac`)
- License: Apache-2.0, see [LICENSE](LICENSE)

## Install

```
/plugin marketplace add emoicu/claude-telegram
/plugin install telegram@emoicu-plugins
/plugin disable telegram@claude-plugins-official
```

This fork is not on the channels allowlist, so start Claude Code with the development flag instead of `--channels`:

```
claude --dangerously-load-development-channels plugin:telegram@emoicu-plugins
```

Claude Code shows a confirmation dialog on every start when this flag is used.

## Changes from upstream

- **Quote-reply context**: inbound messages carry `reply_to_message_id`, `reply_to_user` and `reply_to_text` when the user replies to or quotes a message.
- **Channel-only polling**: the plugin connects to Telegram only when its Claude Code process loaded it as a channel. Other sessions on the same host (for example `claude --bg`) no longer take over the bot. Override with `TELEGRAM_CHANNEL_MODE=always|never`.
- **Live work status**: while Claude is busy, the bot keeps the typing indicator alive and, for longer turns, shows a status message with elapsed time, the current step and a step count. The message is deleted when the turn ends. Disable with `TELEGRAM_STATUS=off`; preset the target chat with `TELEGRAM_STATUS_CHAT`.
- **Host-handled session commands**: when `TELEGRAM_COMMAND_HELPER` points at an executable, `/new`, `/usage`, `/model [name]` and `/effort [level]` are handled by the plugin, which runs `<helper> <command> [arg]` instead of forwarding the message to Claude. The commands are added to the bot menu, and the message gets a 👌 reaction as acknowledgement. Arguments are limited to letters, digits and `. _ : -`. A bare `/model` or `/effort` gets inline buttons under the message (with a Cancel button); picking one runs the helper with that option.
  - `TELEGRAM_COMMAND_HELPER=builtin` uses the bundled [`helpers/tmux-session-helper.ts`](plugins/telegram/helpers/tmux-session-helper.ts). It needs Claude Code running inside tmux: it waits until the session is idle, types the command into the session's pane (found via `~/.claude/sessions/<pid>.json`), reads the result from the screen and reports it to the chat.
  - Any other value is treated as the path of your own executable. It receives `TELEGRAM_HELPER_CLAUDE_PID`, `TELEGRAM_HELPER_CHAT_ID`, `TELEGRAM_BOT_TOKEN` and `TELEGRAM_STATE_DIR` in its environment and must return quickly (it is killed after 30 seconds).
- **`/session` command**: replies with the owning session's model, effort, permission mode, context size (prompt tokens of the latest API call), message count, API-equivalent cost so far, working directory and versions, read from local files without a model turn. Set `TELEGRAM_CONTEXT_WINDOW` (tokens) to also show context as a percentage.
- **Terminal-prompt notice**: a `Notification` hook (`hooks/notify-telegram.ts`) messages the chat when Claude Code waits for someone at the terminal, for example a built-in safety check that is never relayed to channels. It only notifies, never answers; prompts already relayed with Allow/Deny buttons are skipped. Runs only in the channel session; disable with `TELEGRAM_NOTIFY=off`.
- **Questions as buttons**: a `PreToolUse` hook (`hooks/ask-telegram.ts`) catches `AskUserQuestion` in the channel session and posts each question to the chat with a button per option (multi-select questions get a Done button) instead of the terminal picker. Once every question is answered, the answers reach Claude as a channel message; typing a free-form answer works too. If nothing can be sent, the terminal picker is used as usual. Disable with `TELEGRAM_ASK=off`.
- **Unlisted groups**: messages from a group that is not allowlisted are still dropped, but its id and title are recorded in `unlisted-groups.json` in the state directory, so you can find the id for `/telegram:access group add`.
- **Multi-session router (experimental)**: `router.ts` lets one bot drive many sessions. Direct messages go to an always-on `main` session; each topic of a forum group gets its own Claude Code session in a tmux window, started on demand with `--resume` of the topic's previous conversation, stopped after 30 idle minutes, and capped by free memory (with a reserve) and CPU load. Sessions run `server.ts` in router mode (`TELEGRAM_ROUTER_SOCKET`): it receives its topic's updates over a unix socket and posts into its topic. `/sessions` lists them. Once Claude Code has updated itself on disk, sessions still on the old version are restarted after five quiet minutes (main resumes right away and says so in the chat). See the header of `router.ts` for settings.
- `zod` is declared as a direct dependency.

The first commit is the unmodified upstream code; see the git history for each change.
