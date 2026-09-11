#!/usr/bin/env sh
# Install (or update) the verified-build skill and its engine into one or more Claude
# Code config directories. The two files are a pair and must travel together: the skill
# is only the entry point and drives $CLAUDE_CONFIG_DIR/workflows/build-verify-patch.js.
#
#   ./install.sh                      # into $CLAUDE_CONFIG_DIR, or ~/.claude if unset
#   ./install.sh ~/.claude-work ~/.claude-personal
#   ./install.sh user@host:~/.claude  # remote targets go through scp
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
if [ "$#" -eq 0 ]; then set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; fi
for T in "$@"; do
  case "$T" in
    *:*)
      HOST=${T%%:*}; DIR=${T#*:}
      ssh "$HOST" "mkdir -p '$DIR/skills/verified-build' '$DIR/workflows'"
      scp -q "$HERE/skills/verified-build/SKILL.md" "$HOST:$DIR/skills/verified-build/SKILL.md"
      scp -q "$HERE/workflows/build-verify-patch.js" "$HOST:$DIR/workflows/build-verify-patch.js"
      echo "installed to $T"; ssh "$HOST" "md5sum '$DIR/skills/verified-build/SKILL.md' '$DIR/workflows/build-verify-patch.js'"
      ;;
    *)
      mkdir -p "$T/skills/verified-build" "$T/workflows"
      cp "$HERE/skills/verified-build/SKILL.md" "$T/skills/verified-build/SKILL.md"
      cp "$HERE/workflows/build-verify-patch.js" "$T/workflows/build-verify-patch.js"
      echo "installed to $T"; md5sum "$T/skills/verified-build/SKILL.md" "$T/workflows/build-verify-patch.js"
      ;;
  esac
done
echo "source:"; md5sum "$HERE/skills/verified-build/SKILL.md" "$HERE/workflows/build-verify-patch.js"
