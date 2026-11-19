# Changelog

All notable changes to this plugin. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/) from 1.0.0 on.

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

[1.2.0]: https://github.com/emoicu/claude-telegram/releases/tag/v1.2.0
[1.1.0]: https://github.com/emoicu/claude-telegram/releases/tag/v1.1.0
[1.0.0]: https://github.com/emoicu/claude-telegram/releases/tag/v1.0.0
