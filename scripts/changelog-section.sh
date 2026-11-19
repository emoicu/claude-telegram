#!/usr/bin/env bash
# Print the CHANGELOG.md section of one version (without its heading).
# Usage: scripts/changelog-section.sh 1.0.0
set -euo pipefail
version="${1:?usage: changelog-section.sh <version>}"
file="$(dirname "$0")/../CHANGELOG.md"
awk -v v="$version" '
  /^## \[/ { if (on) exit; on = index($0, "## [" v "]") == 1; next }
  /^\[[^]]+\]: / { if (on) exit }
  on { print }
' "$file" | sed -e '/./,$!d' | sed -e ':a' -e '/^\n*$/{$d;N;ba' -e '}'
