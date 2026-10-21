// A mod's child process gets its stdin closed after one write, but Codex's
// app-server speaks JSON-RPC over a long-lived stdin. This POSIX sh script
// bridges the two: the mod drops numbered request files (plus an `.ok` marker
// once each is fully written) into an inbox folder, and a loop feeds them,
// in order, through a FIFO into `codex app-server`.
//
// `exec` makes codex the process the mod holds, so ending the mod's stream
// kills codex itself; the feeder loop exits when codex is gone (`kill -0 $pid`)
// or a `quit` file appears, and stops codex if Claude Code itself disappears.
export const BRIDGE_SCRIPT = `inbox=$1; shift
pipe="$inbox/pipe"
rm -f "$pipe"
mkfifo "$pipe" || { echo "overseer: mkfifo failed" >&2; exit 97; }
pid=$$
host=$PPID
(
  while :; do
    for ok in "$inbox"/*.ok; do
      [ -e "$ok" ] || continue
      f="\${ok%.ok}.json"
      [ -e "$f" ] && cat "$f"
      rm -f "$f" "$ok"
    done
    [ -e "$inbox/quit" ] && exit 0
    kill -0 "$pid" 2>/dev/null || exit 0
    # Claude Code itself is gone (crashed, force-quit): take codex down too
    kill -0 "$host" 2>/dev/null || { kill "$pid" 2>/dev/null; exit 0; }
    sleep 0.05
  done
) > "$pipe" &
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
