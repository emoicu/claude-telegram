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
- **Live draft and Stop**: in direct messages the work status is a streamed draft (`sendMessageDraft`) showing the current step and what Claude last wrote, with Telegram's stop button; in groups it is a status message with a ⏹ Stop button. Stopping presses Escape in the session's tmux pane, like a user at the terminal. `TELEGRAM_STATUS_STYLE=message` keeps the old status message everywhere.
- **Rich replies**: `reply` and `edit_message` accept `format: "rich"`, sent as a Bot API 10.1 rich message written in GitHub-flavored Markdown (tables, fenced code, task lists, collapsible `<details>`), up to 32768 characters per message. If Telegram rejects it, the text goes out as plain chunks instead.
- **Progress checklists**: a `progress` tool posts a task checklist (rich task list, plain text as a fallback) and edits that one message as steps start and finish, instead of sending new messages. Claude passes the whole step list each call (`todo`, `doing`, `done`, `failed`, `skipped`); a call after everything is done, or with `new: true`, starts a fresh one. The current checklist per chat is kept in `progress.json` in the state directory, so a restarted session keeps editing it.
- **Local times**: in `reply` and `edit_message`, `{{time:VALUE}}` or `{{time:VALUE|FORMAT}}` becomes a Telegram date_time entity (Bot API 9.5), shown in the reader's own time zone. VALUE is ISO-8601 with a zone, Unix seconds, or `now` / `now+30m` / `now-2h`; FORMAT is Telegram's (`t`, `T`, `d`, `D`, `w`, combined like `wDT`, or `r` for relative). Works with `markdownv2` and `rich`; plain text gets a UTC time.
- **Reaction shortcuts**: reacting to one of the bot's messages sends Claude a short instruction quoting that message, e.g. 👍 go ahead, 👌 take your recommended option, 👎 try another approach, 🤔 explain more simply, 👀 more detail, ✍ write it down, ❤ remember this preference, 🔥 do it without asking, 🙏 pause (also interrupts the running turn), 🎉 wrap up. The same shortcuts can also appear as buttons under the latest reply (👍 👎 🤔 🔥 and ⋯ for the rest): off by default, `TELEGRAM_QUICK_BUTTONS=dm` shows them in direct messages, `all` also in groups. Override or extend the map in `reactions.json` in the state directory: `{"emoji": "meaning"}` or `{"emoji": {"meaning": "…", "label": "…"}}`, `null` removes one.
- **Questions as buttons**: a `PreToolUse` hook (`hooks/ask-telegram.ts`) catches `AskUserQuestion` in the channel session and posts each question to the chat with a button per option (multi-select questions get a Done button) instead of the terminal picker. Once every question is answered, the answers reach Claude as a channel message; typing a free-form answer works too. If nothing can be sent, the terminal picker is used as usual. Disable with `TELEGRAM_ASK=off`.
- **Unlisted groups**: messages from a group that is not allowlisted are still dropped, but its id and title are recorded in `unlisted-groups.json` in the state directory, so you can find the id for `/telegram:access group add`.
- **Multi-session router (experimental)**: `router.ts` lets one bot drive many sessions. Direct messages go to an always-on `main` session; each topic of a forum group gets its own Claude Code session in a tmux window, started on demand with `--resume` of the topic's previous conversation, stopped after 30 idle minutes, and capped by free memory (with a reserve) and CPU load. Sessions run `server.ts` in router mode (`TELEGRAM_ROUTER_SOCKET`): it receives its topic's updates over a unix socket and posts into its topic. `/sessions` lists them. Once Claude Code has updated itself on disk, sessions still on the old version are restarted after five quiet minutes (main resumes right away and says so in the chat). A session that has not connected two minutes after starting is reported in its chat with the last lines of its terminal and restarted once; messages waiting for a session are kept on disk across router restarts. See the header of `router.ts` for settings.
- `zod` is declared as a direct dependency.

The first commit is the unmodified upstream code; see the git history for each change.
