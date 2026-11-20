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
#   5. with --service: runs the multi-session router around the clock as a
#      systemd user service (see "Running as a service" in the README)
#
#   bash install.sh --service          install, then set up the service
#   bash install.sh --remove-service   stop and remove the service only
#
# Non-interactive: TELEGRAM_BOT_TOKEN=... bash install.sh
#   with --service also TELEGRAM_ROUTER_MAIN_CWD=/path (default ~/projects)
# The token is only sent to the Telegram Bot API.
set -euo pipefail

SERVICE=""
for arg in "$@"; do
  case "$arg" in
    --service) SERVICE=install ;;
    --remove-service) SERVICE=remove ;;
    -h | --help) echo "Usage: install.sh [--service | --remove-service]  (see the comments at the top of this script)"; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

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

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
# Shells started by su or sudo -u have no XDG_RUNTIME_DIR; systemctl --user needs it.
if [ -n "$SERVICE" ] && [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then export XDG_RUNTIME_DIR="/run/user/$(id -u)"; fi
UNIT=claude-telegram.service
TMUX_UNIT=claude-telegram-tmux.service
SERVICE_DIR="$STATE_DIR/service"

if [ "$SERVICE" = remove ]; then
  say "Removing the service"
  if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
    # Stopping the tmux unit ends the Claude Code sessions too.
    systemctl --user disable --now "$UNIT" "$TMUX_UNIT" >/dev/null 2>&1 || true
    rm -f "$UNIT_DIR/$UNIT" "$UNIT_DIR/$TMUX_UNIT"
    systemctl --user daemon-reload
    ok "Stopped and removed $UNIT and $TMUX_UNIT"
  else
    warn "No systemd user manager here; stop the launcher yourself if you started it"
  fi
  rm -rf "$SERVICE_DIR"
  ok "Removed $SERVICE_DIR (the plugin, token and router state are kept)"
  exit 0
fi

say "Checking requirements"
command -v claude >/dev/null || die "Claude Code not found. Install it first: https://docs.claude.com/en/docs/claude-code"
ok "Claude Code $(claude --version 2>/dev/null | head -1)"
# A session the service starts cannot sign in by itself: it would sit at the
# login screen, and nobody could be told on Telegram before pairing.
if claude auth status </dev/null >/dev/null 2>&1; then
  ok "Claude Code is signed in"
elif [ -n "$SERVICE" ]; then
  die "Claude Code is not signed in. Run claude once and sign in (or claude setup-token), then run this again"
else
  warn "Claude Code is not signed in yet: it asks you to sign in when you first start it"
fi
if ! command -v bun >/dev/null && [ -x "$HOME/.bun/bin/bun" ]; then PATH="$HOME/.bun/bin:$PATH"; fi
command -v bun >/dev/null || die "Bun not found. Install it with: curl -fsSL https://bun.sh/install | bash"
ok "Bun $(bun --version)"
command -v curl >/dev/null || die "curl not found"
if [ -n "$SERVICE" ] && ! command -v tmux >/dev/null; then die "tmux not found: the service runs the sessions in tmux. Install it (apt install tmux) and run this again"; fi
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

if [ "$SERVICE" = install ]; then
  say "Service"
  root=$(bun -e 'const p = require(process.argv[1]); console.log(p.plugins?.[process.argv[2]]?.[0]?.installPath ?? "")' "$CLAUDE_DIR/plugins/installed_plugins.json" "$PLUGIN" 2>/dev/null || true)
  [ -n "$root" ] && [ -f "$root/service/supervisor.ts" ] || die "This plugin version has no service files; update it (claude plugin update $PLUGIN) and run this again"
  if [ -S "$STATE_DIR/router.sock" ] && bun -e 'Bun.connect({ unix: process.argv[1], socket: { data() {} } }).then(s => { s.end(); process.exit(0) }, () => process.exit(1))' "$STATE_DIR/router.sock" 2>/dev/null \
    && ! systemctl --user is-active --quiet "$UNIT" 2>/dev/null; then
    die "A Telegram router is already running outside this service. Stop it first (two would compete for the bot), then run this again"
  fi

  workdir=$(sed -n 's/^TELEGRAM_ROUTER_MAIN_CWD=//p' "$ENV_FILE" | head -1)
  if [ -z "$workdir" ]; then
    workdir="${TELEGRAM_ROUTER_MAIN_CWD:-}"
    if [ -z "$workdir" ] && [ -r /dev/tty ]; then
      read -r -p "  Folder Claude works in [$HOME/projects]: " workdir </dev/tty
    fi
    workdir="${workdir:-$HOME/projects}"
    workdir="${workdir/#\~/$HOME}"
    # Start on a new line even if the file does not end with one.
    if [ -s "$ENV_FILE" ] && [ -n "$(tail -c 1 "$ENV_FILE")" ]; then echo >>"$ENV_FILE"; fi
    printf 'TELEGRAM_ROUTER_MAIN_CWD=%s\nTELEGRAM_ROUTER_PROJECTS=%s\n' "$workdir" "$workdir" >>"$ENV_FILE"
  fi
  mkdir -p "$workdir"
  ok "Claude works in $workdir (TELEGRAM_ROUTER_MAIN_CWD in $ENV_FILE)"

  # Claude Code asks once per folder whether to trust it, and nobody is there
  # to answer for a session the service starts. Trusting a folder covers the
  # folders inside it.
  trusted() {
    bun -e '
      const [file, dir] = process.argv.slice(1)
      let projects = {}
      try { projects = require(file).projects ?? {} } catch {}
      for (let d = dir; d && d !== "/"; d = d.slice(0, d.lastIndexOf("/")) || "/") {
        if (projects[d]?.hasTrustDialogAccepted) process.exit(0)
      }
      process.exit(1)' "${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json" "$(cd "$workdir" && pwd -P)" 2>/dev/null
  }
  if trusted; then
    ok "Claude Code trusts $workdir"
  elif [ -r /dev/tty ]; then
    echo "  Claude Code has not been told to trust $workdir yet. It will open there now:"
    echo "  answer the trust question with Yes, then type /exit."
    read -r -p "  Press Enter to open it... " _ </dev/tty
    (cd "$workdir" && claude </dev/tty >/dev/tty 2>&1) || true
    trusted || die "$workdir is still not trusted. Run: cd $workdir && claude, answer Yes, type /exit, then run this again"
    ok "Claude Code trusts $workdir"
  else
    die "Claude Code has not been told to trust $workdir. Run: cd $workdir && claude, answer Yes, type /exit, then run this again"
  fi

  # A copy outside the plugin: a broken plugin update cannot break it.
  mkdir -p "$SERVICE_DIR"
  cp "$root/service/supervisor.ts" "$SERVICE_DIR/supervisor.ts"
  cp "$root/service/launcher.sh" "$SERVICE_DIR/launcher.sh"
  chmod 755 "$SERVICE_DIR/launcher.sh"
  rm -f "$SERVICE_DIR/supervisor.prev.ts" "$SERVICE_DIR/supervisor.bad"
  ok "Supervisor copied to $SERVICE_DIR"

  if command -v systemctl >/dev/null && command -v loginctl >/dev/null; then
    # Without lingering, user services stop at logout and start only at login.
    if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != yes ]; then
      if loginctl enable-linger "$USER" 2>/dev/null || sudo loginctl enable-linger "$USER"; then
        ok "Lingering enabled: the service starts at boot, without logging in"
        sleep 2 # the user manager starts now
      else
        warn "Could not enable lingering: the service only runs while you are logged in. Ask an admin to run: loginctl enable-linger $USER"
      fi
    else
      ok "Lingering already enabled: the service starts at boot"
    fi
    # The user manager started just now: systemctl --user needs its runtime dir.
    if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then export XDG_RUNTIME_DIR="/run/user/$(id -u)"; fi
  fi
  if ! command -v systemctl >/dev/null || ! systemctl --user show-environment >/dev/null 2>&1; then
    warn "No systemd user manager here (a container, WSL without systemd, or a shell without a login session)."
    cat <<EOF
  Start it yourself instead; it stops when the machine restarts:
    tmux new-session -d -s claude -n log tail -F $STATE_DIR/router/router.log
    tmux new-window -d -t claude: -n supervisor $SERVICE_DIR/launcher.sh
EOF
    exit 0
  fi

  # systemd starts units with a bare PATH: give them the folders of the tools.
  path=""
  for tool in claude bun tmux; do
    d=$(dirname "$(command -v "$tool")")
    case ":$path:" in *":$d:"*) ;; *) path="${path:+$path:}$d" ;; esac
  done
  path="$path:/usr/local/bin:/usr/bin:/bin"
  tmux_bin=$(command -v tmux)
  mkdir -p "$UNIT_DIR"
  cat >"$UNIT_DIR/$TMUX_UNIT" <<EOF
# Written by claude-telegram's install.sh --service.
# The tmux session the router opens the Claude Code sessions in. A unit of its
# own, so restarting $UNIT leaves the sessions running.
[Unit]
Description=tmux session for the Claude Code Telegram sessions

# oneshot + RemainAfterExit: the tmux server it forks stays in this unit;
# stopping the unit ends the session it made, and the Claude sessions in it.
# A session that already existed (someone else's tmux) is used but never
# ended: the owned file marks the session this unit made.
[Service]
Type=oneshot
RemainAfterExit=yes
Environment=PATH=$path
Environment=LANG=C.UTF-8
ExecStart=/bin/sh -c '$tmux_bin has-session -t =claude 2>/dev/null && exit 0; $tmux_bin -u new-session -d -s claude -n log tail -n 50 -F $STATE_DIR/router/router.log && touch %t/claude-telegram-tmux.owned'
ExecStop=/bin/sh -c '[ -e %t/claude-telegram-tmux.owned ] || exit 0; rm -f %t/claude-telegram-tmux.owned; $tmux_bin kill-session -t =claude 2>/dev/null; exit 0'
EOF
  cat >"$UNIT_DIR/$UNIT" <<EOF
# Written by claude-telegram's install.sh --service.
[Unit]
Description=Claude Code Telegram channel (multi-session router)
Wants=$TMUX_UNIT
After=$TMUX_UNIT
# Keep restarting, however often it fails.
StartLimitIntervalSec=0

[Service]
Environment=PATH=$path
Environment=LANG=C.UTF-8
Environment=TELEGRAM_SUPERVISOR_TMUX_UNIT=$TMUX_UNIT
${CLAUDE_CONFIG_DIR:+Environment=CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR}
ExecStart=$SERVICE_DIR/launcher.sh
Restart=always
RestartSec=5
# 75: another router or supervisor is running; restarting would not help.
RestartPreventExitStatus=75

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT" >/dev/null 2>&1
  systemctl --user restart "$UNIT"
  ok "$UNIT enabled and started"


  say "Done. The bot is running."
  cat <<EOF
  Status:   systemctl --user status claude-telegram
  Logs:     journalctl --user -u claude-telegram -f    (or $STATE_DIR/router/router.log)
  Sessions: tmux attach -t claude
  Restart:  systemctl --user restart claude-telegram   (the sessions keep running)
  Remove:   bash install.sh --remove-service
  If you have not paired yet: DM your bot${username:+ @$username}, then in Claude Code run
            /telegram:access pair <code>
EOF
  exit 0
fi

say "Done. Next:"
cat <<EOF
  1. Start Claude Code with the channel:   claude-telegram
  2. DM your bot${username:+ @$username}; it answers with a 6-character code.
  3. In Claude Code:                       /telegram:access pair <code>
                                           /telegram:access policy allowlist
  Then send /doctor to the bot to check everything.
  Many sessions, one per forum topic: see "Multi-session router" in the README.
EOF
