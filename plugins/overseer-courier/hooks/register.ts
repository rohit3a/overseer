import type { EngineInterface, Register } from 'claude-code'

// Overseer queues messages for subagents in its `outbox`. A plugin never sees
// the requests of an agent its own call resumed, so Overseer can't send them
// itself without going blind to that agent. This plugin sends them instead,
// from its own timer, so Overseer keeps watching (and steering) the agent.
//
// 2.1.280 (the desktop app's build before 3.1623) has no $.state. There the
// outbox is a file Overseer writes, and this plugin writes its receipts (what
// it picked up, and when it last ran) to a file beside it, in a folder only
// this user can enter.

const outbox = { plugin: 'overseer', key: 'outbox' } as const
const sentRef = { plugin: 'overseer-courier', key: 'sent' } as const
const heartbeatRef = { plugin: 'overseer-courier', key: 'heartbeat' } as const

type Item = { id: string; to: string; text: string }

// a send the engine rejected is tried again on the next ticks, this many times in all
const TRIES = 3
const KEPT = 500

// Same check as Overseer's: a path someone else made first is never used.
const PRIVATE_DIR = 'umask 077; d=$1; if [ -e "$d" ] || [ -L "$d" ]; then [ -d "$d" ] && [ ! -L "$d" ] && [ -O "$d" ] && chmod 700 "$d"; else mkdir -m 700 "$d"; fi'

async function privateDir($: EngineInterface): Promise<string> {
  const dir = `${((await $.env.get('TMPDIR')) || '/tmp').replace(/\/+$/, '')}/overseer-${await $.session.id()}`
  const made = await $.process.run(['sh', '-c', PRIVATE_DIR, 'overseer-courier', dir]).catch(() => undefined)
  return made?.exitCode === 0 ? dir : ''
}

// ids picked up and not given back, in order; `sent` carries them across reloads
let sent: string[] = []
let inFlight = new Set<string>()
const tries = new Map<string, number>()
// without $.state: the session's folder, '' while there is none
let dir = ''
let hasState = true
// receipt-file writes, in order; session.end waits them out
let writes: Promise<void> = Promise.resolve()

// past KEPT ids, the oldest go, but never one still waiting in the outbox: it would be sent again
const remember = (ids: string[], waiting: Set<string>) => {
  sent = [...sent, ...ids]
  let extra = sent.length - KEPT
  if (extra > 0) sent = sent.filter(id => waiting.has(id) || extra-- <= 0)
  inFlight = new Set(sent)
}

const forget = (ids: string[]) => {
  const gone = new Set(ids)
  sent = sent.filter(id => !gone.has(id))
  for (const id of ids) inFlight.delete(id)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    // On a build without $.state, `$.state.get` throws right here; a refusal
    // by the host comes back as a rejected promise instead.
    let held: Promise<{ value?: string[] }> | undefined
    try {
      held = $.state.get(sentRef)
    } catch {
      held = undefined
    }
    hasState = held !== undefined
    if (!hasState) dir = await privateDir($)
    const readJson = async <T>(name: string, empty: T): Promise<T> => {
      if (dir === '') return empty
      try {
        return JSON.parse(await $.fs.read(`${dir}/${name}`)) as T
      } catch {
        // not written yet, or caught mid-write: read again next time
        return empty
      }
    }

    sent = hasState ? ((await held!.catch(() => ({ value: [] }))).value ?? []) : (await readJson<{ sent?: string[] }>('courier.json', {})).sent ?? []
    inFlight = new Set(sent)

    let heartbeat = 0
    // One write at a time, each of the receipts as they are when it runs, so a
    // slow write can't land after a newer one and bring back an older list.
    // A file write is bound to this session's folder; session.end waits these out.
    const saveReceipts = () => {
      const at = dir
      if (!hasState && at === '') return Promise.resolve()
      const write = writes.then(() =>
        hasState ? $.state.set(sentRef, sent).then(() => undefined) : $.fs.write(`${at}/courier.json`, JSON.stringify({ sent, heartbeat })),
      )
      writes = write.catch(() => undefined)
      return write
    }

    // a heartbeat, so Overseer can tell a slow delivery from a missing courier
    const beat = () => {
      heartbeat = Date.now()
      if (hasState) void $.state.set(heartbeatRef, heartbeat).catch(() => undefined)
      else void saveReceipts()
    }
    beat()
    $.clock.every(2000, beat)

    const queued = async (): Promise<Item[]> => (hasState ? ((await $.state.get(outbox)).value ?? []) : readJson<Item[]>('outbox.json', []))

    // An id is recorded as picked up before its send starts, so a reload mid-send
    // never sends it twice (one caught in that moment is never sent, and Overseer
    // marks it not confirmed after a minute). A send the engine rejects, or a pickup
    // that could not be recorded, is given back and tried again.
    const deliver = async (item: Item) => {
      try {
        await $.session.send({ to: { agentId: item.to }, text: item.text })
        tries.delete(item.id)
      } catch (err) {
        const n = (tries.get(item.id) ?? 0) + 1
        $.ui.log(`overseer-courier: send to ${item.to} failed (try ${n} of ${TRIES}): ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
        if (n >= TRIES) {
          tries.delete(item.id)
          return
        }
        tries.set(item.id, n)
        forget([item.id])
        await saveReceipts().catch(() => undefined)
      }
    }

    let isReading = false
    $.clock.every(250, () => {
      if (isReading) return
      isReading = true
      void (async () => {
        try {
          const box = await queued()
          const due = box.filter(item => !inFlight.has(item.id))
          if (due.length === 0) return
          const ids = due.map(item => item.id)
          remember(ids, new Set(box.map(item => item.id)))
          try {
            await saveReceipts()
          } catch {
            // not recorded: give them back for the next tick rather than skip them for good
            forget(ids)
            return
          }
          // each send runs on its own: one slow wake-up never holds the others back
          for (const item of due) void deliver(item)
        } catch {
          // the next tick reads again
        } finally {
          isReading = false
        }
      })()
    })
    return started
  })

  // a /clear goes on in this process under a new session id, with no session.start
  on('session.end', async ($, e, next) => {
    // no heartbeat may write the folder back once it is gone: stop writing, let the
    // last writes land, then remove it (Overseer removes it too; whichever runs last finds it gone)
    const old = dir
    dir = ''
    await writes
    if (old !== '') await $.process.run(['rm', '-rf', old]).catch(() => undefined)
    const res = await next(e)
    if (e.reason !== 'clear') return res
    sent = []
    inFlight = new Set()
    tries.clear()
    if (!hasState) dir = await privateDir($).catch(() => '')
    return res
  })
}
