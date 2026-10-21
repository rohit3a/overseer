#!/bin/sh
# Copies the plugin API declarations this Claude Code build writes into
# dev-types/ for `tsc`. The engine writes them when the plugin-authoring
# skill loads, and beside a mod it loads from a watched folder.
set -eu
cd "$(dirname "$0")/.."
src=$(ls -t /tmp/claude-*/bundled-skills/*/*/plugin-authoring/types/claude-code.d.ts plugins/overseer/.claude-plugin/types/claude-code/index.d.ts 2>/dev/null | head -1 || true)
[ -n "$src" ] || { echo "no claude-code.d.ts found; load the plugin-authoring skill in Claude Code once" >&2; exit 1; }
mkdir -p dev-types/claude-code
cp "$src" dev-types/claude-code/index.d.ts
echo "types from $src"
