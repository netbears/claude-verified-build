#!/usr/bin/env sh
# Check the engine: that the built file matches src/, a syntax check, then the tests.
#
# The engine is developed as the parts under src/ and assembled by build.js into
# workflows/build-verify-patch.js, which is what ships and what the tests run; so the
# first check is that the committed file is what src/ builds (`node build.js` refreshes
# it). `export const meta = {...}` must stay at the top level; the body below it uses a
# top-level `return`, which is a Workflow-runtime feature that bare `node --check`
# rejects — so wrap only the body in an async function before checking. The tests
# then run the whole engine against a stubbed runtime (test/engine.test.js) and the
# pure helpers in isolation (test/helpers.test.js).
#
#   ./check.sh            # build check + syntax + tests
#   ./check.sh --syntax   # build check + syntax only (no node:test needed)
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  echo "check.sh: node is required (https://nodejs.org, v18 or later)" >&2
  exit 1
fi
MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$MAJOR" -lt 18 ]; then
  echo "check.sh: node $MAJOR is too old; v18 or later is needed for node:test" >&2
  exit 1
fi
node "$HERE/build.js" --check
TMPDIR_=$(mktemp -d)
trap 'rm -rf "$TMPDIR_"' EXIT
awk 'BEGIN{m=0} { print; if (!m && $0 ~ /^}$/) { m=1; print "async function _w(){" } } END{ print "}" }' \
  "$HERE/workflows/build-verify-patch.js" > "$TMPDIR_/engine.mjs"
node --check "$TMPDIR_/engine.mjs" && echo "syntax OK"
if [ "${1:-}" = "--syntax" ]; then exit 0; fi
cd "$HERE" && node --test test/*.test.js
