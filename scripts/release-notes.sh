#!/bin/bash
# Prints the release notes of VERSION: the section "## [VERSION]" of CHANGELOG.md without its link line.
# Fails when the section is missing or empty.
# Usage: scripts/release-notes.sh VERSION
set -euo pipefail
cd "$(dirname "$0")/.."

version="${1:?usage: scripts/release-notes.sh VERSION}"
notes="$(awk -v heading="## [$version]" '
  index($0, heading) == 1 { found = 1; next }
  found && /^## \[/ { exit }
  found && /^\[[^]]+\]: / { next }
  found { print }
' CHANGELOG.md)"

if ! printf '%s' "$notes" | grep -q '[^[:space:]]'; then
  echo "CHANGELOG.md has no section for $version" >&2
  exit 1
fi
printf '%s\n' "$notes"
