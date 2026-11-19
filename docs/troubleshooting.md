# Troubleshooting

Start with `/doctor` in a direct message to the bot. It answers without a Claude turn and checks access, file permissions, recent log errors, the hooks, scheduled messages and disk space. If the bot does not answer at all, work through the first section.

Logs are in `~/.claude/channels/telegram/`: `logs/server-<slot>.log` for each session (`main` without the router), `router/router.log` for the router. Set `TELEGRAM_LOG_LEVEL=debug` for more.

## The bot does not answer

- **Claude Code was started without the channel.** Start it with `claude --dangerously-load-development-channels plugin:telegram@emoicu-plugins`, or `claude-telegram` from the installer. A plain `claude` session loads the plugin's tools but does not poll Telegram.
- **The official plugin competes for the bot.** Only one process can poll a bot; the other gets `409 Conflict`. Run `claude plugin disable telegram@claude-plugins-official`.
- **Another session or the router is polling.** In router mode only the router polls; check that it runs (`router/router.log`). Without it, the session that started last wins.
- **Claude Code skipped the channel after a failed start.** If the plugin once failed to start, Claude Code may note it in `~/.claude/mcp-needs-auth-cache.json` and skip it in new sessions for a while. Remove the `plugin:telegram:telegram` entry from that file and restart. The router does this for its sessions.
- **The token is wrong or revoked.** `scripts/install.sh` (or `/telegram:configure <token>`) checks and saves a new one.
- **You are not on the allowlist.** In `allowlist` mode the bot ignores strangers, you included. Check with `/telegram:access` at the terminal.

## Messages arrive but nothing happens

- The session may be waiting at the terminal for a prompt that is not relayed (a built-in safety check). The bot says so when the notice is on (`TELEGRAM_NOTIFY`).
- A turn that ended on an API error (usage limit, overload, expired login) is reported in the chat with what to do. Without that notice, look at the terminal.

## `/new`, `/model`, `/effort`, `/usage` are forwarded to Claude

They need a command helper: `TELEGRAM_COMMAND_HELPER=builtin` with Claude Code running inside tmux, or a path to your own script. See [Configuration](../README.md#configuration).

## No live status, or Stop does not work

- The status line appears only for turns longer than `TELEGRAM_STATUS_AFTER_SEC` (30 s by default when reaction status is on).
- Outside tmux, Stop takes effect at Claude's next tool call: a turn that only writes text runs to its end.
- The activity hook is loaded when a session starts. After an update, `/doctor` shows "Activity hook has not reported yet" until the session has been restarted and has done a turn.

## Scheduled messages are late

They are sent by the process that polls Telegram: the router, or the session without one. If it is not running they wait, and `/doctor` reports them as overdue. A failed send is retried every minute, up to 5 times.

## Always allow keeps asking

It covers the same permission suggestions in the same conversation, for up to 24 hours. A new conversation (`/new`, a restart without resume) starts over, and a prompt with different suggestions (another directory, another command prefix) is a new prompt. The `PermissionRequest` hook loads when a session starts, so restart sessions after an update.

## After an update nothing changed

`claude plugin update telegram@emoicu-plugins` installs the new copy; running sessions keep the old one. Restart Claude Code. The router (with `TELEGRAM_ROUTER_SELF_UPDATE=1`) restarts itself and its sessions once they have been idle for five minutes.
