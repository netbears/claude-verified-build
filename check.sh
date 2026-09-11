#!/usr/bin/env sh
# Syntax-check the engine. `export const meta = {...}` must stay at the top level; the body
# below it uses a top-level `return`, which is a Workflow-runtime feature that bare
# `node --check` rejects — so wrap only the body in an async function before checking.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp --suffix=.js)
awk 'BEGIN{m=0} { print; if (!m && $0 ~ /^}$/) { m=1; print "async function _w(){" } } END{ print "}" }' \
  "$HERE/workflows/build-verify-patch.js" > "$TMP"
node --check "$TMP" && echo "syntax OK"
rm -f "$TMP"
