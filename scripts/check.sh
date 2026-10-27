#!/bin/sh
# Fast checks that need no API key: manifests, hooks scan, types, plugin tests.
set -eu
cd "$(dirname "$0")/.."
claude plugin validate .
claude plugin validate plugins/overseer
claude plugin validate plugins/overseer-courier
if [ -f dev-types/claude-code/index.d.ts ]; then
  npx -y -p typescript@5.9.3 tsc -p tsconfig.json
else
  echo "skipping tsc: run scripts/types.sh first"
fi
claude plugin test plugins/overseer
claude plugin test plugins/overseer-courier
