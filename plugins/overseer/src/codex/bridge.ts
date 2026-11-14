// A mod's child process gets its stdin closed after one write, but Codex's
// app-server speaks JSON-RPC over a long-lived stdin. This POSIX sh script
// bridges the two: the mod drops numbered request files (plus an `.ok` marker
// once each is fully written) into an inbox folder, and a loop feeds them,
// in order, through a FIFO into `codex app-server`.
//
// `exec` makes codex the process the mod holds, so ending the mod's stream
// kills codex itself; the feeder exits when codex is gone (`kill -0 $pid`)
// or a `quit` file appears, and stops codex if Claude Code itself disappears.
//
// The feeder is light while Codex idles: it checks every 50 ms for a second
// after a request, then every 2 s, and a SIGUSR1 (wakeBridge) wakes it at once,
// so a request never waits on the slow beat. It writes its pid to `$inbox/feeder.pid` once it can take the signal.
export const FEEDER_SCRIPT = `inbox=$1 pid=$2 host=$3
woke=0 sp= idle=0
trap 'woke=1; [ -n "$sp" ] && kill "$sp" 2>/dev/null' USR1
# the pid goes out only once the trap is set: an earlier signal would kill the feeder
echo $$ > "$inbox/feeder.pid.tmp" && mv "$inbox/feeder.pid.tmp" "$inbox/feeder.pid"
while :; do
  found=0
  for ok in "$inbox"/*.ok; do
    [ -e "$ok" ] || continue
    found=1
    f="\${ok%.ok}.json"
    [ -e "$f" ] && cat "$f"
    rm -f "$f" "$ok"
  done
  [ -e "$inbox/quit" ] && exit 0
  kill -0 "$pid" 2>/dev/null || exit 0
  # Claude Code itself is gone (crashed, force-quit): take codex down too
  kill -0 "$host" 2>/dev/null || { kill "$pid" 2>/dev/null; exit 0; }
  if [ "$found" = 1 ]; then idle=0; else idle=$((idle + 1)); fi
  if [ "$woke" = 1 ]; then woke=0; continue; fi
  if [ "$idle" -lt 20 ]; then t=0.05; else t=2; fi
  sleep "$t" & sp=$!
  # a wake that landed before $sp was set: don't sleep through it
  if [ "$woke" = 1 ]; then woke=0; kill "$sp" 2>/dev/null; fi
  wait "$sp" 2>/dev/null
  sp=
done
`

export const BRIDGE_SCRIPT = `inbox=$1; shift
pipe="$inbox/pipe"
rm -f "$pipe"
mkfifo "$pipe" || { echo "overseer: mkfifo failed" >&2; exit 97; }
sh -c "$OVERSEER_FEEDER" overseer-feeder "$inbox" $$ $PPID > "$pipe" 2>/dev/null &
exec "$@" app-server < "$pipe"
`

// request files sort by name, so names are fixed-width and increasing
let seq = 0
export const requestName = () => `${Date.now().toString().padStart(15, '0')}-${String(seq++ % 1_000_000).padStart(6, '0')}`

export const dirname = (path: string) => {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

// splits streamed output into whole lines, keeping a partial tail
export class LineBuffer {
  private tail = ''

  push(text: string): string[] {
    const joined = this.tail + text
    const parts = joined.split('\n')
    this.tail = parts.pop() ?? ''
    return parts.map(p => (p.endsWith('\r') ? p.slice(0, -1) : p)).filter(p => p !== '')
  }

  flush(): string[] {
    const rest = this.tail.trim()
    this.tail = ''
    return rest === '' ? [] : [rest]
  }
}

// shell-safe single quoting for the login-shell lookup
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
