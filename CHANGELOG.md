# Changelog

All notable changes to this plugin. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/) from 1.0.0 on.

## [1.7.0] - 2026-11-20

### Added

- Carrying on after an interrupted turn (router mode): when a session dies while Claude is working (killed, crashed, or the host restarted), the router says so in the chat, brings the session back, and once it connects asks Claude to work out where the task stood and carry on, then tells the chat it is doing so. Claude is told not to blindly rerun a command that may have caused the interruption. Only once: a session cut off again within 10 minutes of carrying on does not carry on by itself, and the chat is told to send a message instead. Sessions that were idle, or that were stopped on purpose (`/restart`, idle stop, updates), are not asked to carry on. Sessions say what they understand in their hello (`can: ["resume"]`); for an older plugin the chat is asked to nudge Claude.

### Fixed

- `/restart` no longer restarts a session forever when the new process keeps failing or never connects: it starts it again once, then the usual crash and start-timeout handling (and its notice) takes over.
- A `/restart` question nobody answered, or one whose message could not be sent, no longer blocks every later `/restart` with "already restarting". A `/restart` sent while the session was stopping anyway now restarts it instead of leaving the status message at "Restarting".
- `/restart` and `/sessions` ignore edited messages: editing an old message into `/restart` restarted the session.
- Supervisor: after the supervisor was killed (SIGKILL, out of memory) its router kept running, and the next supervisor took it for another router and stopped the service. It now stops the router it left behind and carries on.
- Supervisor: a missing tmux session no longer restarts the tmux unit while its tmux server runs (which ended the sessions); the session is created in the running server, and the unit is restarted only when there is no server.
- Supervisor: the supervisor's own settings (`TELEGRAM_SUPERVISOR_*`) no longer reach the router and the Claude Code sessions.
- Supervisor: a version is remembered as good once its router has run a minute, not only when it exits by itself, so a service restart or stop no longer loses the version to fall back to.
- Launcher: Ctrl-C or SIGTERM stops it and the supervisor when run by hand (the supervisor now exits with 130 or 143 on those signals).
- `install.sh --service`: the tmux unit only ends a tmux session it created itself, so removing the service no longer ends someone else's `claude` session. Works from shells without `XDG_RUNTIME_DIR` (su, sudo -u) when the service is already running; honours `CLAUDE_CONFIG_DIR`; keeps the last line of a `.env` without a final newline intact; `claude auth status` no longer reads the piped script.
- Rich replies keep a wide table that has a header but no rows instead of dropping it.

## [1.6.1] - 2026-11-20

### Fixed

- `install.sh` checks that Claude Code is signed in (`claude auth status`). With `--service` it stops if not: a session the service starts would wait at the login screen, and before pairing nobody could be told on Telegram. Without `--service` it only warns.
- `install.sh --service` makes sure Claude Code trusts the working folder (or a folder above it). If it does not, the script opens Claude Code there once to answer the trust question; without a terminal it stops and says what to run.

## [1.6.0] - 2026-11-20

### Added

- Running as a service: `install.sh --service` sets up two systemd user services that start at boot: `claude-telegram-tmux` holds the tmux session the sessions run in, and `claude-telegram` runs `service/supervisor.ts`, which keeps the router running from the installed plugin version. A version whose router fails three times right after starting is replaced by the last version that ran fine, with a Telegram notice, until another version is installed. The supervisor refuses to start beside another supervisor or router, makes sure the tmux session exists, and is copied out of the plugin; it updates itself from a plugin version that has run for 10 minutes, and its launcher (`service/launcher.sh`) puts the previous copy back if a new one keeps failing. Restarting the service leaves the sessions running. `install.sh --remove-service` removes it.
- The router reads its settings from `.env` in the state directory too (the real environment wins), and sessions it starts use the bundled command helper unless `TELEGRAM_COMMAND_HELPER` is set.
- End-to-end tests for the supervisor and launcher (`test/supervisor.e2e.test.ts`).

## [1.5.1] - 2026-11-20

### Fixed

- A message that woke a stopped session could be lost: a session resumed after its last turn was cut off dropped the channel message it got while starting. For messages handed to Claude in the first 90 seconds after the server starts, the server now checks the session transcript 10 seconds later and hands the message over once more if it is not there. Nothing is resent when the transcript cannot be read.
- Every message handed to Claude is logged with its id, so a lost one shows where it went missing.

## [1.5.0] - 2026-11-20

### Added

- `/restart` (router mode) restarts the session of the chat or topic it is sent in and resumes its conversation, e.g. to load a plugin update right away or to unstick a session. An idle session restarts at once; while Claude is replying, buttons offer to wait for the reply to finish or to stop it now. The status message is edited to say when the session is back and which plugin version it runs. A session that ignores SIGTERM is killed after 15 seconds. Only allowlisted users can use it.
- End-to-end tests for the router (`test/router.e2e.test.ts`): a fake Bot API, a private tmux server and a stand-in for Claude Code. Skipped where tmux is not installed.

### Fixed

- The router reads tmux's output without a UTF-8 locale too. With `LANG` unset tmux printed the tabs of its format strings as `_`, so the router could not find the process of a session window. It now runs tmux with `-u`.

## [1.4.3] - 2026-11-20

### Changed

- Rich replies send a table as a list when its widest row is over 50 columns (CJK characters and emoji count two): on a phone, such a table was squeezed into narrow, hard-to-read columns. Two-column tables become `- **first**: second`, wider ones list the other cells as `header: cell` sub-items. Set the limit with `TELEGRAM_TABLE_MAX_WIDTH` (`0` keeps every table).

## [1.4.2] - 2026-11-20

### Changed

- The router looks for a newer plugin or Claude Code every 30 seconds instead of every 10 minutes, so it switches to a new version within half a minute of `claude plugin update`. Sessions still wait until they have been idle for five minutes. Where the `claude` path does not show the version, `claude --version` still runs at most every 10 minutes.

## [1.4.1] - 2026-11-20

### Fixed

- The router restarts a session whose process has exited but is still a zombie (not yet collected by tmux). It used to take the zombie for a running session and wait for it forever, so direct messages went unanswered until the router was restarted. On Linux the process state in `/proc/<pid>/stat` is now checked too (`lib/proc.ts`).

## [1.4.0] - 2026-11-20

### Added

- **`choose` tool**: Claude asks the user to pick from 2 to 12 options with a native Telegram poll (several answers by default, `multiple: false` for one). The vote reaches Claude as a channel message listing what was picked and what was not; withdrawing the vote is reported too. Works in direct messages and forum topics: each session keeps the polls it sent in `polls[-<slot>].json`, and the router hands a vote to the session that sent the poll, starting it if needed. Logic in `lib/polls.ts`.

## [1.3.2] - 2026-11-20

### Fixed

- Rich messages no longer turn "#1 merged" at the start of a line, list item or quote into a big heading. Telegram's rich Markdown, unlike GitHub's, needs no space after `#`; the plugin now escapes such a `#` (`escapeTightHashes` in `lib/format.ts`) in replies, edits, checklists and its own messages. Real headings and code blocks are unchanged.

## [1.3.1] - 2026-11-20

### Changed

- Dependencies: `@modelcontextprotocol/sdk` 1.32.0 → 1.32.2, `grammy` 1.41.1 → 1.46.0, `zod` 4.6.6 → 4.6.7. TypeScript stays on 5.x for now.
- CI uses `actions/checkout@v7`.
- Photo and document albums are built with their own types, which grammy 1.46 requires; an end-to-end test covers them.

## [1.3.0] - 2026-11-19

### Added

- **Take back a reaction shortcut** by removing the reaction. ❤ (remember) and 🔥 (do it without asking) wait 10 seconds before they reach Claude; removing the reaction in that time drops them. Removed within 30 minutes after that, Claude is asked to undo what it did; later, removing a reaction does nothing. `TELEGRAM_REACTION_HOLD_SEC` and `TELEGRAM_REACTION_UNDO_MIN` set the times, `"hold": true` in `reactions.json` holds other shortcuts too, and `/help` explains it. Logic in `lib/holds.ts`.

## [1.2.2] - 2026-11-19

### Changed

- No headings in rich messages: titles and section names are bold lines with an empty line around them (a blank Braille character, since Telegram drops blank lines), instead of headings, which show very big in Telegram (`/start`, `/help`, `/session`, `/doctor`, `/usage`, `/sessions`, the progress checklist).

## [1.2.1] - 2026-11-19

### Fixed

- `/sessions` is in the command menu (direct messages and topics) when the router runs. The router always answered it, but it never showed up in the menu.

## [1.2.0] - 2026-11-19

### Changed

- Longer command answers are spaced-out rich messages with headings and bold values, falling back to plain text: `/start`, `/help`, `/session` (with a context bar), `/doctor` (what needs attention first, passing checks folded away), `/usage` and `/sessions`. Short answers (`/status`, pickers, confirmations, pairing) stay plain text.
- `/usage` (built-in command helper) answers with a rich message: a bar and a 🟢 🟡 🔴 level per limit, translated titles, and reset times shown in the reader's own time zone with a countdown, instead of the panel's raw UTC text. Parsing and formatting are in `lib/usage.ts`.

## [1.1.0] - 2026-11-19

### Added

- **Chinese interface** and the groundwork for more languages: everything the bot itself shows (menus, `/help`, status line, checklists, buttons, permission prompts, failure alerts, `/doctor`, router and command-helper notices) is translated. `/language` switches it with buttons, for the server, the router, the hooks and the helper at once, and the command menu follows; `TELEGRAM_LANG` overrides it. Translations are in `plugins/telegram/locales/`.
- `help.<lang>.md` in the state directory replaces `/help` for one language.

## [1.0.0] - 2026-11-19

The first stable release. From here on, a breaking change to configuration, state files or tools means a new major version.

### Added

- **Failure alerts**: a `StopFailure` hook tells the chat when a turn ends on an API error (rate or usage limit, overload, expired login, billing...) with the error text and what to do, at most once every 10 minutes per error.
- **Always allow** on relayed permission prompts: the same kind of call is allowed for the rest of the conversation (up to 24 hours) through a `PermissionRequest` hook. Mode changes are never remembered.
- **Scheduled messages and reminders**: `schedule` and `scheduled` tools, one-off or daily / weekly, sent on time by the router (or the polling server) at no Claude usage.
- **Activity hook** for the live status and Stop: steps come from documented hooks as well as Claude Code's internal files, and Stop works outside tmux by ending the turn at the next tool call.
- **Retries** for Bot API calls on 429 (waiting `retry_after`), 5xx and, for calls that are safe to repeat, dropped connections.
- **`/doctor`** health check: access, file permissions, recent log errors, hooks, reminders, disk.
- **Leveled logging** to `logs/server-<slot>.log` and `router/router.log` with rotation and token redaction; `TELEGRAM_LOG_LEVEL`.
- `TELEGRAM_API_ROOT` for a self-hosted Bot API server.
- End-to-end tests against a fake Bot API server, strict type checking, Biome lint and a dependency audit in CI; Dependabot.

### Changed

- The progress tool also accepts `status` with todo-list names (`pending`, `in_progress`, `completed`).
- Server internals split into `core/` modules (configuration, access, permission relay, inbox, doctor) and pure helpers in `lib/`.
- Version numbers follow semver instead of `0.0.7-emoicu.N`.

### Fixed

- Errors that were silently swallowed (36 empty `catch` blocks) are logged.

### Security

- Upgraded dependencies with 76 known advisories (1 critical, 17 high), all in the MCP SDK's HTTP server transport, which this plugin does not use; `bun audit` now reports none.

## 0.0.7-emoicu.1 – 0.0.7-emoicu.42 - 2026-11-16 to 2026-11-18

Development versions on top of the upstream plugin v0.0.7.

- Quote-reply context, polling only in the session that loaded the plugin as a channel.
- Live work status (typing, status line or draft, Stop button), reaction status, progress checklists, rich replies, photo albums, message effects, times in the reader's time zone.
- Session commands from the chat: `/new`, `/model`, `/effort`, `/usage`, `/session`, `/help`; model and effort pickers.
- Questions (`AskUserQuestion`) and terminal-only prompts relayed to the chat.
- Reaction shortcuts and quick buttons.
- The multi-session router: one Claude Code session per forum topic, started on demand, resumed, stopped when idle, restarted after updates.
- Inbox pruning, Bot API timeouts, update pickup in running sessions, unit tests.

[1.7.0]: https://github.com/emoicu/claude-telegram/releases/tag/v1.7.0
[1.6.1]: https://github.com/emoicu/claude-telegram/releases/tag/v1.6.1
[1.6.0]: https://github.com/emoicu/claude-telegram/releases/tag/v1.6.0
[1.5.1]: https://github.com/emoicu/claude-telegram/releases/tag/v1.5.1
[1.5.0]: https://github.com/emoicu/claude-telegram/releases/tag/v1.5.0
[1.4.3]: https://github.com/emoicu/claude-telegram/releases/tag/v1.4.3
[1.4.2]: https://github.com/emoicu/claude-telegram/releases/tag/v1.4.2
[1.4.1]: https://github.com/emoicu/claude-telegram/releases/tag/v1.4.1
[1.4.0]: https://github.com/emoicu/claude-telegram/releases/tag/v1.4.0
[1.3.2]: https://github.com/emoicu/claude-telegram/releases/tag/v1.3.2
[1.3.1]: https://github.com/emoicu/claude-telegram/releases/tag/v1.3.1
[1.3.0]: https://github.com/emoicu/claude-telegram/releases/tag/v1.3.0
[1.2.2]: https://github.com/emoicu/claude-telegram/releases/tag/v1.2.2
[1.2.1]: https://github.com/emoicu/claude-telegram/releases/tag/v1.2.1
[1.2.0]: https://github.com/emoicu/claude-telegram/releases/tag/v1.2.0
[1.1.0]: https://github.com/emoicu/claude-telegram/releases/tag/v1.1.0
[1.0.0]: https://github.com/emoicu/claude-telegram/releases/tag/v1.0.0
