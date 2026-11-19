#!/usr/bin/env bash
# Install the Telegram channel plugin for Claude Code.
#
#   curl -fsSL https://raw.githubusercontent.com/emoicu/claude-telegram/main/scripts/install.sh | bash
#
# What it does, each step skipped when already done:
#   1. checks for Claude Code and Bun (and tmux, needed for the router)
#   2. adds the emoicu-plugins marketplace and installs telegram@emoicu-plugins,
#      disabling the official telegram plugin if it is enabled
#   3. asks for the bot token, checks it with Telegram (getMe) and saves it to
#      ~/.claude/channels/telegram/.env (mode 600)
#   4. writes a launcher, ~/.local/bin/claude-telegram
#
# Non-interactive: TELEGRAM_BOT_TOKEN=... bash install.sh
# The token is only sent to the Telegram Bot API.
set -euo pipefail

MARKETPLACE_REPO="${CLAUDE_TELEGRAM_REPO:-emoicu/claude-telegram}"
PLUGIN="telegram@emoicu-plugins"
STATE_DIR="${TELEGRAM_STATE_DIR:-$HOME/.claude/channels/telegram}"
API_ROOT="${TELEGRAM_API_ROOT:-https://api.telegram.org}"
BIN_DIR="${CLAUDE_TELEGRAM_BIN_DIR:-$HOME/.local/bin}"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*" >&2; }
die() {
  printf '  \033[31m✗\033[0m %s\n' "$*" >&2
  exit 1
}

say "Checking requirements"
command -v claude >/dev/null || die "Claude Code not found. Install it first: https://docs.claude.com/en/docs/claude-code"
ok "Claude Code $(claude --version 2>/dev/null | head -1)"
if ! command -v bun >/dev/null && [ -x "$HOME/.bun/bin/bun" ]; then PATH="$HOME/.bun/bin:$PATH"; fi
command -v bun >/dev/null || die "Bun not found. Install it with: curl -fsSL https://bun.sh/install | bash"
ok "Bun $(bun --version)"
command -v curl >/dev/null || die "curl not found"
if command -v tmux >/dev/null; then ok "tmux $(tmux -V | cut -d' ' -f2)"; else warn "tmux not found: fine for one session, needed for the multi-session router and /new, /model, /effort"; fi

say "Installing the plugin"
if claude plugin marketplace list 2>/dev/null | grep -q emoicu-plugins; then
  claude plugin marketplace update emoicu-plugins >/dev/null && ok "Marketplace emoicu-plugins updated"
else
  claude plugin marketplace add "$MARKETPLACE_REPO" >/dev/null && ok "Marketplace emoicu-plugins added"
fi
if claude plugin list 2>/dev/null | grep -q "$PLUGIN"; then
  claude plugin update "$PLUGIN" >/dev/null && ok "$PLUGIN updated"
else
  claude plugin install "$PLUGIN" >/dev/null && ok "$PLUGIN installed"
fi
if claude plugin list 2>/dev/null | grep -A3 "telegram@claude-plugins-official" | grep -qi enabled; then
  claude plugin disable telegram@claude-plugins-official >/dev/null && ok "Official telegram plugin disabled (the two would compete for the bot)"
fi

say "Bot token"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
ENV_FILE="$STATE_DIR/.env"
current=""
[ -f "$ENV_FILE" ] && current=$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "$ENV_FILE" | head -1)
token="${TELEGRAM_BOT_TOKEN:-}"
if [ -z "$token" ] && [ -n "$current" ]; then
  ok "Already saved in $ENV_FILE"
elif [ -z "$token" ]; then
  if [ ! -r /dev/tty ]; then die "No terminal to ask for the token: run again with TELEGRAM_BOT_TOKEN=..."; fi
  echo "  Create a bot with @BotFather (/newbot) and paste its token (input is hidden):"
  read -r -s -p "  Token: " token </dev/tty
  echo
fi
if [ -n "$token" ]; then
  [[ "$token" =~ ^[0-9]{5,}:[A-Za-z0-9_-]{30,}$ ]] || die "That does not look like a bot token (123456789:AA...)"
  me=$(curl -fsS --max-time 20 "$API_ROOT/bot$token/getMe" 2>/dev/null) || die "Telegram rejected the token (or is unreachable). Check it with @BotFather"
  username=$(printf '%s' "$me" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')
  ok "Token works: @${username:-?}"
  tmp=$(mktemp "$STATE_DIR/.env.XXXXXX")
  chmod 600 "$tmp"
  { [ -f "$ENV_FILE" ] && grep -v '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" || true; printf 'TELEGRAM_BOT_TOKEN=%s\n' "$token"; } >"$tmp"
  mv "$tmp" "$ENV_FILE"
  ok "Saved to $ENV_FILE (readable by you only)"
fi
chmod 600 "$ENV_FILE"

say "Launcher"
mkdir -p "$BIN_DIR"
cat >"$BIN_DIR/claude-telegram" <<'LAUNCHER'
#!/usr/bin/env bash
# Start Claude Code with the Telegram channel loaded. Arguments go to claude.
# The development flag is needed because this fork is not on the channels
# allowlist; Claude Code asks you to confirm it on every start.
exec claude --dangerously-load-development-channels plugin:telegram@emoicu-plugins "$@"
LAUNCHER
chmod 755 "$BIN_DIR/claude-telegram"
ok "$BIN_DIR/claude-telegram"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) warn "$BIN_DIR is not on your PATH; add it, or run the launcher by its full path" ;; esac

say "Done. Next:"
cat <<EOF
  1. Start Claude Code with the channel:   claude-telegram
  2. DM your bot${username:+ @$username}; it answers with a 6-character code.
  3. In Claude Code:                       /telegram:access pair <code>
                                           /telegram:access policy allowlist
  Then send /doctor to the bot to check everything.
  Many sessions, one per forum topic: see "Multi-session router" in the README.
EOF
