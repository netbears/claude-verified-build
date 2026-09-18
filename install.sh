#!/usr/bin/env sh
# Install (or update) the two verified-build skills and the one engine they both drive
# into one or more Claude Code config directories. The three files travel together: each
# skill is only an entry point and drives $CLAUDE_CONFIG_DIR/workflows/build-verify-patch.js.
#
#   ./install.sh                      # into $CLAUDE_CONFIG_DIR, or ~/.claude if unset
#   ./install.sh ~/.claude-work ~/.claude-personal
#   ./install.sh user@host:~/.claude  # remote targets go through ssh + scp
#
# Before copying anything it checks the tools an install and a run depend on, and
# runs ./check.sh when node is available, so a broken engine is never installed.
# Pass --no-check to skip the engine check (for a box without node).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SKILL="$HERE/skills/verified-build/SKILL.md"
SKILL_SMALL="$HERE/skills/verified-build-small/SKILL.md"
ENGINE="$HERE/workflows/build-verify-patch.js"

CHECK=1
if [ "${1:-}" = "--no-check" ]; then CHECK=0; shift; fi
if [ "$#" -eq 0 ]; then set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; fi

fail() { echo "install.sh: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# --- dependencies -------------------------------------------------------------
# git: every lane of a run commits and diffs. node: only for check.sh. ssh/scp: remote
# targets. A checksum tool: md5sum (GNU) or md5 (BSD/macOS) — same digest, different name.
have git || fail "git is required: every lane of a run commits and diffs"
if have md5sum; then SUM='md5sum'; elif have md5; then SUM='md5 -r'; else fail "need md5sum or md5 to print checksums"; fi
for T in "$@"; do
  case "$T" in *:*) have ssh || fail "ssh is required for remote target $T"; have scp || fail "scp is required for remote target $T" ;; esac
done
if [ "$CHECK" -eq 1 ]; then
  if have node; then
    "$HERE/check.sh" || fail "check.sh failed; nothing installed"
  else
    echo "install.sh: WARNING node not found, engine not checked (node is needed only for check.sh; a run does not need it)" >&2
  fi
fi

# --- install ------------------------------------------------------------------
# A remote path may start with `~`. The remote shell expands it only when unquoted, so
# it is rewritten to $HOME inside a double-quoted command (which also survives spaces);
# scp keeps the original spelling, which both its legacy and SFTP modes expand.
for T in "$@"; do
  case "$T" in
    *:*)
      HOST=${T%%:*}; DIR=${T#*:}
      case "$DIR" in
        '~') RDIR='$HOME' ;;
        '~/'*) RDIR='$HOME'${DIR#\~} ;;
        *) RDIR=$DIR ;;
      esac
      ssh "$HOST" "mkdir -p \"$RDIR/skills/verified-build\" \"$RDIR/skills/verified-build-small\" \"$RDIR/workflows\""
      scp -q "$SKILL" "$HOST:$DIR/skills/verified-build/SKILL.md"
      scp -q "$SKILL_SMALL" "$HOST:$DIR/skills/verified-build-small/SKILL.md"
      scp -q "$ENGINE" "$HOST:$DIR/workflows/build-verify-patch.js"
      echo "installed to $T"
      ssh "$HOST" "if command -v md5sum >/dev/null 2>&1; then S=md5sum; else S='md5 -r'; fi; \$S \"$RDIR/skills/verified-build/SKILL.md\" \"$RDIR/skills/verified-build-small/SKILL.md\" \"$RDIR/workflows/build-verify-patch.js\""
      ;;
    *)
      mkdir -p "$T/skills/verified-build" "$T/skills/verified-build-small" "$T/workflows"
      cp "$SKILL" "$T/skills/verified-build/SKILL.md"
      cp "$SKILL_SMALL" "$T/skills/verified-build-small/SKILL.md"
      cp "$ENGINE" "$T/workflows/build-verify-patch.js"
      echo "installed to $T"; $SUM "$T/skills/verified-build/SKILL.md" "$T/skills/verified-build-small/SKILL.md" "$T/workflows/build-verify-patch.js"
      ;;
  esac
done
echo "source:"; $SUM "$SKILL" "$SKILL_SMALL" "$ENGINE"
echo "Every line above should carry the same three digests. Restart the Claude Code session that will use it."
