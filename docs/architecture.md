# Architecture

```
Telegram ──long polling──▶ router.ts ──unix socket──▶ server.ts (MCP) ──stdio──▶ Claude Code session
   ▲                           │                          │                          │
   └──────── Bot API ◀─────────┴──────────────────────────┘          hooks/*.ts ◀─────┘
```

## Processes

- **`server.ts`** is the MCP server Claude Code starts for the plugin. Loaded as a channel, it pushes inbound messages into the session (`notifications/claude/channel`), relays permission prompts, and exposes the tools (`reply`, `react`, `edit_message`, `download_attachment`, `progress`, `schedule`, `scheduled`). Without the router it polls Telegram itself; it only does so when its Claude Code process loaded it as a channel (`TELEGRAM_CHANNEL_MODE` overrides that).
- **`router.ts`** (optional) is the only poller when it runs. It keeps one session per forum topic plus `main` for direct messages, each in a tmux window, starts them on demand, stops idle ones and restarts outdated ones. It hands each update to its session over a unix socket and sends scheduled messages.
- **Hooks** (`hooks/hooks.json`) are short processes Claude Code runs on events. They reach Telegram directly through the Bot API and leave state for `server.ts` in the state directory. They act only in the channel session.

| Hook | Event | Does |
| --- | --- | --- |
| `ask-telegram.ts` | `PreToolUse` (AskUserQuestion) | Questions as buttons |
| `activity-telegram.ts` | `UserPromptSubmit`, `PreToolUse`, `PostToolUseFailure`, `Stop`, `StopFailure` | Turn activity for the status line; Stop outside tmux |
| `permission-telegram.ts` | `PermissionRequest` | Records prompts, answers remembered ones (Always allow) |
| `failure-telegram.ts` | `StopFailure` | Failure alerts |
| `notify-telegram.ts` | `Notification` | Notice when a prompt waits at the terminal |

## Code layout

- `lib/` pure functions with unit tests next to them: access rules, formatting and time tokens, logging, retry policy, schedule, Always allow store, activity, doctor checks, shortcuts, transcript scanning.
- `core/` stateful parts of the server: configuration (`config.ts`), access state and gates, permission relay, inbox pruning, doctor facts.
- `server.ts` wires them to grammY and the MCP SDK; `router.ts` is self-contained apart from `lib/`.
- `helpers/tmux-session-helper.ts` is the built-in command helper for `/new`, `/model`, `/effort`, `/usage`.
- `skills/` the `/telegram:access` and `/telegram:configure` skills.

## State directory

`~/.claude/channels/telegram/` (`TELEGRAM_STATE_DIR`), private to the user:

| Path | Contents |
| --- | --- |
| `.env` | Bot token and settings |
| `access.json` | Who may talk to Claude |
| `approved/` | Pairings approved at the terminal, picked up by the server |
| `inbox/` | Downloaded attachments |
| `logs/`, `router/` | Logs; the router's sessions and poll offset |
| `router.sock` | The router's socket for its sessions |
| `activity/` | Activity hook events and Stop flags, per session |
| `permissions/` | Pending and remembered permission prompts |
| `scheduled/` | One file per scheduled message |
| `progress.json`, `sent-messages*.json` | Checklist and recent message ids per chat |
| `reactions.json`, `help.md` | Optional overrides |

## Tests

`bun run check` type-checks, lints and runs `lib/**/*.test.ts` and `test/*.e2e.test.ts`. The end-to-end tests start `server.ts` and the hooks against a fake Bot API server (`test/harness.ts`) and talk to them over MCP as Claude Code would; `scripts/install.sh` is tested in a throwaway home with a stub `claude`.

## Releases

Bump `version` in `plugins/telegram/.claude-plugin/plugin.json`, add a section to `CHANGELOG.md`, merge, then push a tag `vX.Y.Z`; the release workflow checks that the tag matches the version and publishes the changelog section as the GitHub release. Installed copies update with `claude plugin update telegram@emoicu-plugins`.
