# Security

This plugin connects a Telegram bot to a Claude Code session that can run commands on your machine. Whoever can message Claude through the bot can ask it to do anything you could ask it at the terminal, so access control is the part that matters most.

## Reporting a vulnerability

Please report it privately through [GitHub security advisories](https://github.com/emoicu/claude-telegram/security/advisories/new), not in a public issue.

## Who can reach Claude

Every inbound message passes a gate (`lib/access.ts`) before it reaches the session. The rules live in `~/.claude/channels/telegram/access.json` and are changed only with `/telegram:access` at the terminal; see [ACCESS.md](plugins/telegram/ACCESS.md).

- **Direct messages**: `pairing` (the default) lets anyone ask for a code that you approve at the terminal; `allowlist` drops everyone not listed; `disabled` drops all. Switch to `allowlist` once everyone is paired.
- **Groups** are off until added. A group added without `--allow` lets **every member** talk to Claude, and `--no-mention` lets them do it without mentioning the bot. Prefer `group add <id> --allow <your id>`.
- Messages from strangers are dropped before Claude sees them and cost no usage.
- `/doctor` flags open groups, pairing mode and waiting codes.

Claude is told never to change access because a Telegram message asked it to, since that is what a prompt injection would ask. Approving pairings and editing the allowlist happen at the terminal only.

## Permission prompts

When a tool call needs approval, the prompt is relayed to the chat with Allow / Deny buttons; only allowlisted users can press them. **Always allow** remembers the permission suggestions Claude Code made for that prompt (allow rules or directories, never mode changes) for the same conversation and at most 24 hours. Prompts that Claude Code keeps at the terminal, such as built-in safety checks, are only announced in the chat, never answered from it.

## Secrets and local files

- The bot token is in `~/.claude/channels/telegram/.env`, written with mode 600 by `/telegram:configure` and `scripts/install.sh`. `/doctor` fails if `.env` or `access.json` can be read by other users.
- Logs redact bot tokens.
- The `reply` tool refuses to send files from the state directory (the token, `access.json`) and only sends to allowlisted chats.
- Downloaded attachments are kept in `inbox/` for 30 days by default (`TELEGRAM_INBOX_KEEP_DAYS`).
- Nothing in the state directory belongs in a repository; `.gitignore` excludes the usual names in case it gets copied in.

## What goes where

- Messages, photos and files you send go from Telegram to this machine (long polling), then to the Claude Code session over stdio, and from there to Anthropic like anything else you type to Claude.
- Replies go from this machine to the Telegram Bot API (`TELEGRAM_API_ROOT` for a self-hosted one).
- The plugin itself talks to nothing else. It runs no HTTP server; the router and its sessions talk over a unix socket in the state directory.

## Dependencies

CI runs `bun audit` on the production dependencies (moderate advisories and up) on every push; Dependabot proposes updates weekly.
