#!/usr/bin/env bash
# List upstream commits to the Telegram plugin that this fork has not taken
# in yet, i.e. those after the base recorded below. Needs the GitHub CLI.
#
# After merging upstream changes, move BASE to the upstream commit merged.
set -euo pipefail

REPO=anthropics/claude-plugins-official
DIR=external_plugins/telegram
BASE=b5b01ac # upstream commit this fork is based on (see README)

base_date=$(gh api "repos/$REPO/commits/$BASE" --jq .commit.committer.date)
new=$(gh api -X GET "repos/$REPO/commits" -f path="$DIR" -f since="$base_date" -f per_page=100 \
  --jq '.[] | "\(.sha[0:7]) \(.commit.committer.date[0:10]) \(.commit.message | split("\n")[0])"' |
  grep -v "^${BASE}" || true)

if [ -z "$new" ]; then
  echo "Up to date: no upstream changes to $DIR since $BASE ($base_date)."
else
  echo "Upstream changes to $DIR since $BASE:"
  echo "$new"
  echo
  echo "Compare: https://github.com/$REPO/compare/$BASE...main"
fi
