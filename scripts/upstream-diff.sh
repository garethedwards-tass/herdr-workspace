#!/bin/sh
# Shows how Herdr's own mod differs from Herdr Ranch's copy of it, to take in a Herdr update.
# Usage: scripts/upstream-diff.sh agents|files|spaces
# Lines marked `ranch:` in the copy are Herdr Ranch's own; the rest should match Herdr's.
# After taking the changes in, put the new sha-256 (printed below) and Herdr's version in the
# copy's checkUpstream(...) line and its RECIPE.md.
set -e
name=${1:?usage: $0 agents|files|spaces}
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
here=$(cd "$(dirname "$0")/.." && pwd)
theirs="$home/mods/$name/main.js"
ours="$here/herdr-ranch-$name/mods/herdr-ranch-$name/main.js"
[ -f "$theirs" ] || { echo "no $theirs" >&2; exit 1; }
echo "Herdr $(herdr-app --version 2>/dev/null | awk '{print $2}') $name/main.js sha-256: $( (shasum -a 256 "$theirs" 2>/dev/null || sha256sum "$theirs") | awk '{print $1}')"
diff -u "$theirs" "$ours" || true
