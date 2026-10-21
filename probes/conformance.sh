#!/bin/sh
# Overseer conformance suite: runs real headless sessions with both plugins and
# asserts on Overseer's debug trace. Uses haiku to keep the cost low.
#
#   probes/conformance.sh                      # this machine
#   probes/conformance.sh --host <ssh-host>     # another machine, over ssh
#   probes/conformance.sh --skip-codex          # Claude scenarios only
set -eu
set -f

here=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$here")
host=""
skip_codex=0
while [ $# -gt 0 ]; do
  case "$1" in
    --host) host=$2; shift 2 ;;
    --skip-codex) skip_codex=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -n "$host" ]; then
  remote=/tmp/overseer-conformance
  ssh "$host" "rm -rf $remote && mkdir -p $remote"
  (cd "$repo" && COPYFILE_DISABLE=1 tar --no-xattrs -cf - plugins probes 2>/dev/null || COPYFILE_DISABLE=1 tar cf - plugins probes) | ssh "$host" "tar xf - -C $remote"
  flags=""
  [ "$skip_codex" = 1 ] && flags="--skip-codex"
  status=0
  ssh "$host" "bash -lc 'sh $remote/probes/conformance.sh $flags'" || status=$?
  [ "$status" = 0 ] && ssh "$host" "rm -rf $remote"
  exit $status
fi

fail=0
work=$(mktemp -d "${TMPDIR:-/tmp}/overseer-conf.XXXXXX")
trap '[ "$fail" = 0 ] && rm -rf "$work" || echo "kept traces in $work"' EXIT
plugins="--plugin-dir $repo/plugins/overseer --plugin-dir $repo/plugins/overseer-courier"
fail=0

echo "Overseer conformance on $(uname -sm), Claude Code $(claude --version | cut -d' ' -f1)"
command -v codex >/dev/null 2>&1 && echo "codex: $(codex --version 2>/dev/null)"

run() { # name, debug script, allowed tools, prompt
  name=$1; script=$2; tools=$3; prompt=$4
  dir="$work/$name"; mkdir -p "$dir"
  ( cd "$dir" && OVERSEER_DEBUG_FILE="$dir/trace.json" OVERSEER_DEBUG_SCRIPT="$script" \
      claude -p $plugins --model haiku --allowedTools $tools -- "$prompt" >"$dir/out.txt" 2>"$dir/err.txt" ) || true
  python3 -I "$here/check.py" "$name" "$dir" || fail=1
}

run claude '[
  {"at":"step","index":1,"op":"model","value":"claude-sonnet-5-5"},
  {"at":"step","index":1,"op":"effort","value":"low"},
  {"at":"step","index":1,"op":"send","value":"In your final reply include the word BANANA."},
  {"at":"step","index":3,"op":"pause","ms":3000},
  {"at":"step","index":4,"op":"clear"},
  {"at":"complete","op":"send","delayMs":3000,"value":"Reply with exactly the word MANGO."}
]' "Bash(echo:*) Bash(sleep:*) Agent" \
"Use the Agent tool once: subagent_type general-purpose, description 'probe worker', foreground, prompt: 'Run these as separate Bash tool calls, one at a time: echo one, then echo two, then echo three, then echo four. Then reply DONE and quote verbatim any messages you received during the task.' After it returns, run Bash: sleep 20. Then reply FINISHED."

# a model id that doesn't exist: the request fails, Overseer drops the override and revives the agent
run recover '[
  {"at":"step","index":1,"op":"model","value":"claude-nonexistent-9-9"}
]' "Bash(echo:*) Agent" \
"Use the Agent tool once: subagent_type general-purpose, description 'recover worker', foreground, prompt: 'Run echo one, then echo two, as separate Bash tool calls. Then reply DONE.' After it returns, run Bash: echo waiting, then wait for any further agent notifications and reply FINISHED."

# Stop from the pane: the agent's next request is answered with an end, and the run finishes there
run stop '[
  {"at":"step","index":1,"op":"stop"}
]' "Bash(echo:*) Agent" \
"Use the Agent tool once: subagent_type general-purpose, description 'stop worker', foreground, prompt: 'Run echo one, echo two, echo three, echo four as separate Bash tool calls, then reply DONE.' After it returns, reply FINISHED."

if [ "$skip_codex" = 0 ]; then
  run codexapply '[
    {"kind":"codex","at":"tool","op":"effort","value":"high"},
    {"kind":"codex","at":"tool","op":"applyNow"}
  ]' "mcp__overseer__codex" \
"Call the mcp__overseer__codex tool once with name 'apply-codex' and prompt: 'Run these shell commands one at a time as separate commands: echo A; sleep 4; echo B. Then reply with the letters you saw.' Then reply FINISHED and quote the Codex reply."

  run codex '[
    {"kind":"codex","at":"tool","op":"send","value":"Change of plan: stop running commands now and reply with exactly STEERED."},
    {"kind":"codex","at":"complete","op":"send","delayMs":2000,"value":"Reply with exactly PING2."}
  ]' "mcp__overseer__codex Bash(sleep:*)" \
"Call the mcp__overseer__codex tool once with name 'probe-codex' and prompt: 'Run these shell commands one at a time as separate commands: echo A; sleep 3; echo B; sleep 3; echo C. Then reply with the letters you saw.' When it returns, call the mcp__overseer__codex tool a second time with name 'probe-wait' and prompt: 'Run sleep 8, then reply with exactly WAITED.' Then reply FINISHED and quote the first Codex reply."
fi

[ "$fail" = 0 ] && echo "ALL PASSED" || echo "SOME CHECKS FAILED"
exit $fail
