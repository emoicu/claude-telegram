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
- `zod` is declared as a direct dependency.

The first commit is the unmodified upstream code; see the git history for each change.
