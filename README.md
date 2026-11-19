<div align="center">

# claude-telegram

**Drive Claude Code from Telegram: chat with your sessions, watch them work, and steer them from your phone.**

[![test](https://github.com/emoicu/claude-telegram/actions/workflows/test.yml/badge.svg)](https://github.com/emoicu/claude-telegram/actions/workflows/test.yml)
[![version](https://img.shields.io/badge/version-1.2.0-blue)](plugins/telegram/.claude-plugin/plugin.json)
[![license](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-channel%20plugin-d97757)](https://docs.claude.com/en/docs/claude-code)
[![Bun](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)

[Features](#features) · [Quick start](#quick-start) · [Usage](#usage) · [Multi-session router](#multi-session-router) · [Configuration](#configuration) · [Changes from upstream](#changes-from-upstream)

</div>

---

A personally maintained fork of the official [Claude Code Telegram channel plugin](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram). The upstream plugin forwards your messages to Claude and lets Claude reply. This fork turns it into a full remote control: live status, a Stop button, progress checklists, questions and permission prompts as buttons, rich formatting, and one bot that drives many sessions, one per forum topic.

## Features

**💬 Conversation**
- Send text, photos, files and voice messages; get back text, photos and files, with several photos grouped into one album
- Rich replies in GitHub-flavored Markdown: headings, tables, code blocks, task lists, collapsible sections (up to 32k characters)
- Quote-reply context: Claude sees which message you replied to or quoted
- Times rendered in each reader's own time zone

**👀 Live work status**
- Reactions on your message track it: 👀 received → ✍ working → 👍 done
- For longer turns, a status line (elapsed time · step · current action) with a **Stop** button
- Progress checklists that update in place instead of flooding the chat, with a 🎉 effect when done

**🕹️ Control from your phone**
- `AskUserQuestion` prompts arrive as buttons; permission prompts as **Allow / Deny**, plus **Always allow** to stop asking for the same kind of call in this conversation
- Reaction shortcuts: 👍 go ahead, 👎 try another way, 🤔 explain simpler, 🔥 just do it, 🙏 pause…
- Session commands without touching the terminal: `/new`, `/model`, `/effort`, `/usage`, `/session`, `/doctor`
- English or Chinese interface (`/language`)
- A notice when the terminal is waiting for someone
- Scheduled messages and reminders (`schedule` tool), one-off or daily / weekly, sent on time by the plugin itself at no Claude usage
- An alert when a turn fails on a rate or usage limit, API overload, expired login or billing problem

**🗂️ Many sessions, one bot**
- Direct messages go to an always-on main session
- Each topic of a forum group is its own Claude Code session, started on demand and resumed later
- Idle sessions are stopped, new ones are capped by free memory and CPU
- Sessions and the router restart themselves when Claude Code or the plugin is updated

**🔒 Safe by default**
- Pairing and allowlists from upstream; only approved users reach Claude
- Polls only in the session that loaded it as a channel, so other sessions never steal the bot
- Long polling: no public port, no webhook, no domain needed

## Quick start

**Requirements:** [Claude Code](https://docs.claude.com/en/docs/claude-code), [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`), and a Telegram account.

**1. Create a bot.** Message [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token it gives you.

**Shortcut:** steps 2–4 in one go, on Linux or macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/emoicu/claude-telegram/main/scripts/install.sh | bash
```

It installs the plugin, checks the token with Telegram and saves it (mode 600), and adds a `claude-telegram` launcher. Read [the script](scripts/install.sh) first if you like; it is short.

**2. Install the plugin** (inside a `claude` session):

```
/plugin marketplace add emoicu/claude-telegram
/plugin install telegram@emoicu-plugins
/plugin disable telegram@claude-plugins-official
```

**3. Save the token:**

```
/telegram:configure 123456789:AAHfiqksKZ8...
```

**4. Restart Claude Code with the channel loaded.** This fork is not on the channels allowlist, so use the development flag (Claude Code asks for confirmation on every start):

```sh
claude --dangerously-load-development-channels plugin:telegram@emoicu-plugins
```

**5. Pair.** DM your bot; it answers with a 6-character code. In Claude Code:

```
/telegram:access pair <code>
/telegram:access policy allowlist
```

That's it: your next message reaches Claude. Send `/doctor` to the bot to check the setup. For groups and multi-user setups, see [ACCESS.md](plugins/telegram/ACCESS.md); if something does not work, [troubleshooting](docs/troubleshooting.md).

## Usage

Send messages, photos or files to the bot as you would to a person. Reply to a message to point at it.

### Commands

| Command | What it does |
| --- | --- |
| `/help` | Guide to everything this install supports |
| `/session` | Model, effort, context size, cost and versions of the current session |
| `/doctor` | Health check: who can reach Claude, file permissions, recent errors in the logs, hooks, reminders, disk |
| `/language` | Language of the bot's own messages: English or Chinese (中文) |
| `/new` | Start a fresh conversation |
| `/model [name]` | Switch model; without a name, shows buttons |
| `/effort [level]` | Change thinking effort; without a level, shows buttons |
| `/usage` | Plan usage |
| `/sessions` | All running sessions and their memory (router mode) |
| `/status` | Pairing status |

`/new`, `/model`, `/effort` and `/usage` need a [command helper](#configuration); the bundled one works when Claude Code runs inside tmux.

### Reaction shortcuts

React to one of the bot's messages to send Claude an instruction about it:

| | | | |
| --- | --- | --- | --- |
| 👍 go ahead | 👌 take your recommendation | 👎 try another approach | 🤔 explain more simply |
| 👀 more detail | ✍ write it down | ❤ remember this preference | 🔥 do it without asking |
| 🙏 pause (interrupts the turn) | 🎉 wrap up | | |

Customise them in `reactions.json` in the state directory.

## Multi-session router

`router.ts` lets one bot drive many sessions. Turn on topics in a Telegram group, add the bot as an admin so it sees every message, allow the group with `/telegram:access group add <id>`, and run the router inside tmux:

```sh
tmux new-session -s claude 'bun ~/.claude/plugins/cache/emoicu-plugins/telegram/<version>/router.ts'
```

- Direct messages → the `main` session, always running
- Each forum topic → its own session in a tmux window, resuming its previous conversation
- A topic named like a folder in `TELEGRAM_ROUTER_PROJECTS` works in that folder
- Closing a topic stops its session; `/sessions` lists them all

Run it from a loop with `TELEGRAM_ROUTER_SELF_UPDATE=1` and it restarts from the newest installed copy after `claude plugin update`. All settings are documented in the header of [`router.ts`](plugins/telegram/router.ts).

## Configuration

Everything is optional; set variables in `~/.claude/channels/telegram/.env` or the environment.

| Variable | Default | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | — | Bot token (written by `/telegram:configure`) |
| `TELEGRAM_STATE_DIR` | `~/.claude/channels/telegram` | State directory; use one per bot |
| `TELEGRAM_COMMAND_HELPER` | off | `builtin` or a path; enables `/new`, `/model`, `/effort`, `/usage` |
| `TELEGRAM_STATUS` | on | `off` disables live status, Stop and the activity hook |
| `TELEGRAM_STATUS_STYLE` | draft in DMs | `message` uses a status message everywhere |
| `TELEGRAM_STATUS_AFTER_SEC` | 30 | Delay before the status line appears |
| `TELEGRAM_REACTION_STATUS` | on | `off` falls back to a static acknowledgement reaction |
| `TELEGRAM_QUICK_BUTTONS` | off | `dm` or `all`: shortcut buttons under the latest reply |
| `TELEGRAM_ASK` | on | `off` keeps `AskUserQuestion` in the terminal |
| `TELEGRAM_NOTIFY` | on | `off` disables the terminal-prompt notice and failure alerts |
| `TELEGRAM_CONTEXT_WINDOW` | — | Context size in tokens, to show usage as a percentage |
| `TELEGRAM_INBOX_KEEP_DAYS` | 30 | Delete downloaded files older than this (`0` keeps all) |
| `TELEGRAM_CHANNEL_MODE` | auto | `always` / `never` override channel-only polling |
| `TELEGRAM_API_ROOT` | `https://api.telegram.org` | Bot API base URL, for a self-hosted Bot API server (the tests point it at a fake one) |
| `TELEGRAM_LANG` | — | `en` or `zh`: language of the bot's messages, overriding `/language` |
| `TELEGRAM_LOG_LEVEL` | info | `debug`, `info`, `warn` or `error`; `debug` also shows errors that are expected and ignored |

Put a `help.md` (or `help.<lang>.md`, e.g. `help.zh.md`) in the state directory to replace the `/help` text.

## How it works

```
Telegram ──long polling──▶ router.ts ──unix socket──▶ server.ts (MCP) ──▶ Claude Code session
   ▲                           │                          │
   └──────── Bot API ◀─────────┴──────────────────────────┘
```

Without the router, `server.ts` polls Telegram itself for a single session. With it, the router is the only poller and hands each update to the session that owns the chat or topic. Replies always go straight to the Bot API. More in [docs/architecture.md](docs/architecture.md); who can reach Claude and what is stored where in [SECURITY.md](SECURITY.md).

Releases and what changed in each: [CHANGELOG.md](CHANGELOG.md).

## Development

```sh
cd plugins/telegram
bun install
bun run check   # strict type check (tsc), lint (Biome), unit and end-to-end tests
```

Pure helpers live in `plugins/telegram/lib/` with tests next to them, stateful parts of the server in `plugins/telegram/core/`. End-to-end tests in `plugins/telegram/test/` run `server.ts` and the hooks against a fake Bot API server (`test/harness.ts`) and drive them as Claude Code would over MCP: inbound gating and pairing, the reply, progress and schedule tools, permission buttons including Always allow, reaction shortcuts and the hooks. No bot token or network is needed. CI runs the same checks on every push, plus `bun audit` of the production dependencies; Dependabot proposes dependency updates weekly. `scripts/check-upstream.sh` lists upstream changes since the fork base. See [CLAUDE.md](CLAUDE.md) for repository conventions.

## Changes from upstream

Based on upstream plugin v0.0.7 (commit `b5b01ac`); the latest upstream change to the plugin, `1e96c6b` of 2026-08-13, is included. The first commit is the unmodified upstream code, and every local change is marked `LOCAL PATCH` in the code.

<details>
<summary>Full list of changes</summary>

- **Quote-reply context**: inbound messages carry `reply_to_message_id`, `reply_to_user` and `reply_to_text` when the user replies to or quotes a message.
- **Channel-only polling**: the plugin connects to Telegram only when its Claude Code process loaded it as a channel. Other sessions on the same host (for example `claude --bg`) no longer take over the bot. Override with `TELEGRAM_CHANNEL_MODE=always|never`.
- **Live work status**: while Claude is busy, the bot keeps the typing indicator alive and, for longer turns, shows a one-line status (elapsed time · step count · current step), plus one short line of what Claude last wrote. The message is deleted when the turn ends. Busy/idle comes from Claude Code's session file and steps from the transcript, both internal formats, so an activity hook (`hooks/activity-telegram.ts` on `UserPromptSubmit`, `PreToolUse`, `PostToolUseFailure`, `Stop`, `StopFailure`) also reports the turn through documented hooks: its steps are preferred, and it decides busy/idle when the session file cannot be read. It adds about 10–60 ms to each tool call. Disable with `TELEGRAM_STATUS=off`; preset the target chat with `TELEGRAM_STATUS_CHAT`.
- **Host-handled session commands**: when `TELEGRAM_COMMAND_HELPER` points at an executable, `/new`, `/usage`, `/model [name]` and `/effort [level]` are handled by the plugin, which runs `<helper> <command> [arg]` instead of forwarding the message to Claude. The commands are added to the bot menu, and the message gets a 👌 reaction as acknowledgement. Arguments are limited to letters, digits and `. _ : -`. A bare `/model` or `/effort` gets inline buttons under the message (with a Cancel button); picking one runs the helper with that option.
  - `TELEGRAM_COMMAND_HELPER=builtin` uses the bundled [`helpers/tmux-session-helper.ts`](plugins/telegram/helpers/tmux-session-helper.ts). It needs Claude Code running inside tmux: it waits until the session is idle, types the command into the session's pane (found via `~/.claude/sessions/<pid>.json`), reads the result from the screen and reports it to the chat.
  - Any other value is treated as the path of your own executable. It receives `TELEGRAM_HELPER_CLAUDE_PID`, `TELEGRAM_HELPER_CHAT_ID`, `TELEGRAM_BOT_TOKEN` and `TELEGRAM_STATE_DIR` in its environment and must return quickly (it is killed after 30 seconds).
- **Languages**: everything the bot itself shows (menus, `/help`, status line, checklists, buttons, permission prompts, alerts, `/doctor`, router notices) is translated; `/language` switches between English and Chinese for the server, the router, the hooks and the command helper at once, and the command menu follows. Claude's own answers are in whatever language you write. Text meant for Claude and the logs stay in English. Translations live in `plugins/telegram/locales/`; adding a language is one file plus a line in `lib/i18n.ts`, and a test checks that every key and placeholder is there.
- **`/doctor` command**: checks access (open groups, pairing mode, waiting codes), that `.env` and `access.json` are private, warnings and errors in the server and router logs of the last 24 hours, that the activity hook reports, overdue scheduled messages and free disk space, and answers with a one-line verdict plus every check. Checks are in `lib/doctor.ts`.
- **Retries**: Bot API calls that hit a rate limit (429) wait the `retry_after` Telegram asks for (up to 60 s); server errors back off 1, 2, 4 s; dropped connections are retried only for calls that are safe to repeat, never for sends. Applies to the channel server and the router.
- **`/session` command**: replies with the owning session's model, effort, permission mode, context size (prompt tokens of the latest API call), message count, API-equivalent cost so far, working directory and versions, read from local files without a model turn. Set `TELEGRAM_CONTEXT_WINDOW` (tokens) to also show context as a percentage.
- **Terminal-prompt notice**: a `Notification` hook (`hooks/notify-telegram.ts`) messages the chat when Claude Code waits for someone at the terminal, for example a built-in safety check that is never relayed to channels. It only notifies, never answers; prompts already relayed with Allow/Deny buttons are skipped. Runs only in the channel session; disable with `TELEGRAM_NOTIFY=off`.
- **Scheduled messages**: the `schedule` tool queues a message (rich Markdown, `{{time:…}}` tokens work) for a time up to a year ahead, optionally repeating daily or weekly; `scheduled` lists or cancels them. Each one is a file in `~/.claude/channels/telegram/scheduled/`. The process that polls Telegram checks every 15 s and sends them: the router in router mode (so a stopped topic session still gets its reminder), the channel server otherwise. The allowlist is checked again at send time; a failed send is retried a minute later, up to 5 times.
- **Always allow**: the channel's permission verdict only covers one call, so a `PermissionRequest` hook (`hooks/permission-telegram.ts`) records each prompt's permission suggestions. Pressing **Always allow** marks them as remembered, and the hook then allows later prompts with the same suggestions (same allow rules or directories; the exact same call when Claude Code suggests none) in the same conversation for up to 24 hours, passing them to Claude Code as session rules. Mode changes are never remembered. The hook prints nothing otherwise, so the normal prompt and its relay go ahead. State lives in `~/.claude/channels/telegram/permissions/`.
- **Failure alerts**: a `StopFailure` hook (`hooks/failure-telegram.ts`) messages the chat when a turn ends on an API error (rate or usage limit, overload, expired login, billing, ...), with the error text and what to do. The same error in the same session is reported at most once every 10 minutes. Runs only in the channel session; disable with `TELEGRAM_NOTIFY=off`.
- **Live draft and Stop**: in direct messages the work status is a streamed draft (`sendMessageDraft`) showing the current step and what Claude last wrote, with Telegram's stop button; in groups it is a status message with a ⏹ Stop button. Stopping presses Escape in the session's tmux pane, like a user at the terminal. Outside tmux the activity hook ends the turn instead: the next tool call is refused and the turn stops (`continue: false`). `TELEGRAM_STATUS_STYLE=message` keeps the old status message everywhere.
- **Reaction status**: the user's message shows where it is: 👀 received, ✍ while Claude works on it (messages sent mid-turn join the running turn), 👍 once the turn is over, cleared if it was stopped. Needs the live status; `TELEGRAM_REACTION_STATUS=off` falls back to the static `ackReaction`. With it on, the live status line only appears for turns longer than 30 seconds (otherwise 3 s for drafts, 8 s for status messages); `TELEGRAM_STATUS_AFTER_SEC` sets that delay.
- **Albums**: when `reply` attaches two or more photos (or two or more documents), they go as one album of up to 10 instead of one message each.
- **Message effects**: in direct messages, the reply right after a progress checklist finishes plays 🎉; `reply` also takes `effect` (🎉 🔥 👍 ❤️, or `none` to skip). If Telegram rejects an effect the message is sent without it.
- **Rich replies**: `reply` and `edit_message` accept `format: "rich"`, sent as a Bot API 10.1 rich message written in GitHub-flavored Markdown (tables, fenced code, task lists, collapsible `<details>`), up to 32768 characters per message. If Telegram rejects it, the text goes out as plain chunks instead.
- **Leveled logs**: the server and router log with a time and level to stderr and to `logs/server-<slot>.log` and `router/router.log` in the state directory (rotated at 1 MiB, bot tokens redacted). Errors the code deliberately carries on after are logged too: a missing file at debug level, anything else as a warning. Set `TELEGRAM_LOG_LEVEL` to change the level.
- **Inbox cleanup**: downloaded photos and files in `inbox/` older than `TELEGRAM_INBOX_KEEP_DAYS` (default 30, `0` keeps everything) are deleted at startup and every six hours.
- **Progress checklists**: a `progress` tool posts a task checklist (rich task list, plain text as a fallback) and edits that one message as steps start and finish, instead of sending new messages. Claude passes the whole step list each call (`todo`, `doing`, `done`, `failed`, `skipped`); a call after everything is done, or with `new: true`, starts a fresh one. The current checklist per chat is kept in `progress.json` in the state directory, so a restarted session keeps editing it.
- **Local times**: in `reply` and `edit_message`, `{{time:VALUE}}` or `{{time:VALUE|FORMAT}}` becomes a Telegram date_time entity (Bot API 9.5), shown in the reader's own time zone. VALUE is ISO-8601 with a zone, Unix seconds, or `now` / `now+30m` / `now-2h`; FORMAT is Telegram's (`t`, `T`, `d`, `D`, `w`, combined like `wDT`, or `r` for relative). Works with `markdownv2` and `rich`; plain text gets a UTC time.
- **Reaction shortcuts**: reacting to one of the bot's messages sends Claude a short instruction quoting that message, e.g. 👍 go ahead, 👌 take your recommended option, 👎 try another approach, 🤔 explain more simply, 👀 more detail, ✍ write it down, ❤ remember this preference, 🔥 do it without asking, 🙏 pause (also interrupts the running turn), 🎉 wrap up. The same shortcuts can also appear as buttons under the latest reply (👍 👎 🤔 🔥 and ⋯ for the rest): off by default, `TELEGRAM_QUICK_BUTTONS=dm` shows them in direct messages, `all` also in groups. Override or extend the map in `reactions.json` in the state directory: `{"emoji": "meaning"}` or `{"emoji": {"meaning": "…", "label": "…"}}`, `null` removes one.
- **Questions as buttons**: a `PreToolUse` hook (`hooks/ask-telegram.ts`) catches `AskUserQuestion` in the channel session and posts each question to the chat with a button per option (multi-select questions get a Done button) instead of the terminal picker. Once every question is answered, the answers reach Claude as a channel message; typing a free-form answer works too. If nothing can be sent, the terminal picker is used as usual. Disable with `TELEGRAM_ASK=off`.
- **Full `/help`**: the help command sends a guide (rich message) built from what the install has turned on: talking to Claude, reaction shortcuts, the available commands and topics (router mode). Put a `help.md` in the state directory to send your own text instead, e.g. a translation.
- **Unlisted groups**: messages from a group that is not allowlisted are still dropped, but its id and title are recorded in `unlisted-groups.json` in the state directory, so you can find the id for `/telegram:access group add`.
- **Multi-session router (experimental)**: `router.ts` lets one bot drive many sessions. Direct messages go to an always-on `main` session; each topic of a forum group gets its own Claude Code session in a tmux window, started on demand with `--resume` of the topic's previous conversation, stopped after 30 idle minutes, and capped by free memory (with a reserve) and CPU load. Sessions run `server.ts` in router mode (`TELEGRAM_ROUTER_SOCKET`): it receives its topic's updates over a unix socket and posts into its topic. `/sessions` lists them, and first forgets topics that were deleted in Telegram (bots get no event for that; reopening an open topic is used as a no-op probe). Once Claude Code or this plugin has been updated on disk, sessions still on the old version are restarted after five quiet minutes (main resumes right away and says so in the chat); sessions start with `--system-prompt-snapshot off` so a resumed conversation gets the current plugin instructions, and with `TELEGRAM_ROUTER_SELF_UPDATE=1` the router exits for its supervisor loop to start the new copy. Bot API requests time out instead of hanging, and the getUpdates offset is kept on disk so a restart does not handle an update twice. A session that has not connected two minutes after starting is reported in its chat with the last lines of its terminal and restarted once; messages waiting for a session are kept on disk across router restarts. See the header of `router.ts` for settings.
- `zod` is declared as a direct dependency.

</details>

## License

Apache-2.0, same as upstream. See [LICENSE](LICENSE).
