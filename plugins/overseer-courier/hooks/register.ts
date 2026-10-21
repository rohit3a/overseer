import type { Register } from 'claude-code'

// Overseer queues messages for subagents in its `outbox`. A plugin never sees
// the requests of an agent its own call resumed, so Overseer can't send them
// itself without going blind to that agent. This plugin sends them instead,
// from its own timer, so Overseer keeps watching (and steering) the agent.
//
// 2.1.280 (the desktop app's build before 3.1623) has no $.state. There the
// outbox is a file Overseer writes, and this plugin writes its receipts (what
// it picked up, and when it last ran) to a file beside it.

const outbox = { plugin: 'overseer', key: 'outbox' } as const
const sentRef = { plugin: 'overseer-courier', key: 'sent' } as const
const heartbeatRef = { plugin: 'overseer-courier', key: 'heartbeat' } as const

type Item = { id: string; to: string; text: string }

// ids sent this load; `sent` carries them across reloads
const inFlight = new Set<string>()

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
    const hasState = held !== undefined
    const dir = hasState ? '' : `${((await $.env.get('TMPDIR')) || '/tmp').replace(/\/+$/, '')}/overseer-${await $.session.id()}`
    const readJson = async <T>(name: string, empty: T): Promise<T> => {
      try {
        return JSON.parse(await $.fs.read(`${dir}/${name}`)) as T
      } catch {
        // not written yet, or caught mid-write: read again next time
        return empty
      }
    }

    let sent = hasState ? ((await held!.catch(() => ({ value: [] }))).value ?? []) : (await readJson<{ sent?: string[] }>('courier.json', {})).sent ?? []
    for (const id of sent) inFlight.add(id)

    let heartbeat = 0
    let writes: Promise<void> = Promise.resolve()
    const saveReceipts = () => {
      const text = JSON.stringify({ sent, heartbeat })
      writes = writes.then(() => $.fs.write(`${dir}/courier.json`, text)).catch(() => undefined)
      return writes
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

    let isReading = false
    $.clock.every(250, () => {
      if (isReading) return
      isReading = true
      void (async () => {
        try {
          const due = (await queued()).filter(item => !inFlight.has(item.id))
          if (due.length === 0) return
          for (const item of due) inFlight.add(item.id)
          sent = [...sent, ...due.map(item => item.id)].slice(-500)
          if (hasState) await $.state.set(sentRef, sent)
          else await saveReceipts()
          // each send runs on its own: one slow wake-up never holds the others back
          for (const item of due) {
            void $.session.send({ to: { agentId: item.to }, text: item.text }).catch(() => undefined)
          }
        } finally {
          isReading = false
        }
      })()
    })
    return started
  })
}
