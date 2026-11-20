#!/usr/bin/env bash
# Starts the Telegram supervisor (supervisor.ts next to this file) and starts
# it again whenever it exits. The claude-telegram systemd user service runs
# this; without systemd, run it in the background yourself.
#
# A supervisor that updated itself keeps the previous copy as
# supervisor.prev.ts. If the new one fails within a few seconds three times in
# a row, this puts the previous one back, remembers the broken version in
# supervisor.bad so it is not taken again, and leaves supervisor.restored for
# the supervisor to tell the user. Kept tiny on purpose: it never updates.
dir=$(cd "$(dirname "$0")" && pwd)
quick=${TELEGRAM_LAUNCHER_QUICK_SECS:-30}
pause=${TELEGRAM_LAUNCHER_PAUSE_SECS:-2}
fails=0
while true; do
  start=$(date +%s)
  bun "$dir/supervisor.ts"
  code=$?
  # 75: another supervisor or router runs; starting again would not help.
  [ "$code" -eq 75 ] && exit 75
  if [ "$code" -ne 0 ] && [ $(($(date +%s) - start)) -lt "$quick" ]; then
    fails=$((fails + 1))
  else
    fails=0
  fi
  if [ "$fails" -ge 3 ] && [ -f "$dir/supervisor.prev.ts" ]; then
    echo "launcher: supervisor failed $fails times right after starting, putting back the previous one" >&2
    sed -n 's/.*SUPERVISOR_VERSION = \([0-9][0-9]*\).*/\1/p' "$dir/supervisor.ts" | head -1 >>"$dir/supervisor.bad"
    mv -f "$dir/supervisor.prev.ts" "$dir/supervisor.ts"
    date +%s >"$dir/supervisor.restored"
    fails=0
  fi
  if [ "$fails" -ge 3 ]; then sleep 30; else sleep "$pause"; fi
done
