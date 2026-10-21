import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { LineBuffer } from '../src/codex/bridge'
import { isRawCodexExec, parseLine, parseModels, unwrapShell } from '../src/codex/protocol'
import { completed, newRecord, ordered, stepEnded, stepStarted, toHistory, toolLine, withMsg } from '../src/registry'
import { modelLabel, resolveModel } from '../src/models'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const paneProps = (bodyColumns = 64) =>
  ({ title: 'Agents', isFocused: false, bodyColumns, placement: 'dock', bodyRows: 40 }) as never

// the world beneath the plugin: everything it calls, answered plainly
const world = (on: On, extra: { onSpawn?: (prompt: string) => void; isPlaced?: boolean } = {}) => {
  const clock = mock.clock(on, { now: Date.now() })
  mock.store(on)
  mock.env(on, { HOME: '/tmp', PATH: '/usr/bin:/bin', TMPDIR: '/tmp' })
  // what Claude is told: rows appended to the conversation where the build has
  // $.session.append (and its kit mock.session), else the next prompt as it arrives
  const rows = typeof mock.session === 'function' ? mock.session(on) : undefined
  const prompts: string[] = []
  on('prompt.submit', ($, e) => (prompts.push(e.text), { text: e.text }))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const heard = async ($: any): Promise<string> => {
    if (rows !== undefined) return JSON.stringify(rows.appended())
    await $.prompt.submit({ text: 'next' })
    return prompts.join('\n')
  }
  const session = { heard }
  let invalidates = 0
  const seen = { get invalidates() { return invalidates }, steps: [] as { model: string; effort: unknown; agentId?: string }[], toasts: [] as string[], copied: [] as string[], status: [] as (string | undefined)[], sends: [] as string[] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__overseer__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', ($, e) => (seen.status.push(e.text), { value: undefined }))
  on('ui.toast', ($, e) => (seen.toasts.push(e.text), { value: undefined }))
  on('ui.open', () => ({ value: extra.isPlaced === false ? { isPlaced: false, reason: 'narrow' } : { isPlaced: true } }) as never)
  // the engine's own band, when no plugin draws one: an empty box
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e) as unknown as { Box: never }
    return h(Box, {}) as never
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.invalidate', ($, e, next) => (invalidates++, next(e)))
  on('ui.copy', ($, e) => (seen.copied.push(e.text), { value: { isCopied: true } }) as never)
  on('agent.list', () => ({ value: [] }))
  on('fs.write', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'test-session' }))
  // `sleep` is how the plugin waits without spending its hook budget: hold
  // each one until the test lets it go, so waits are deterministic here
  const sleeps: (() => void)[] = []
  on('process.run', async ($, e) => {
    if (e.argv[0] === 'sleep') await new Promise<void>(resolve => sleeps.push(resolve))
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const tick = async (rounds = 1) => {
    for (let i = 0; i < rounds; i++) {
      await clock.settle()
      for (const go of sleeps.splice(0)) go()
      await clock.settle()
    }
  }
  on('model.complete', () => ({ value: { isAnswered: true, text: 'OK', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) as never)
  on('agent.spawn', ($, e) => (extra.onSpawn?.(e.prompt), { model: e.model ?? 'claude-haiku-5-5', agentId: e.tool_use_id === 'tu1' || e.tool_use_id === '' ? 'a1' : e.tool_use_id === 'tu2' ? 'a2' : `a-${e.tool_use_id}` }))
  on('session.send', ($, e) => (seen.sends.push(e.text), { isDelivered: true }))
  on('turn.step', async function* ($, e) {
    seen.steps.push({ model: e.model, effort: e.effort, agentId: e.agentId })
    return { turnId: e.turnId, index: e.index, answer: 'working', toolUses: [{ name: 'Bash', input: { command: 'echo one' } }], stopReason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: e.model } } as never
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return { clock, session, seen, tick, sleeps }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const start = ($: any): Promise<unknown> => $.session.start({ cwd: '/tmp/proj', surface: 'desktop', isInteractive: true })

const SPAWN = {
  tool_use_id: 'tu1',
  prompt: 'Run echo one, then reply DONE.',
  description: 'probe worker',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-haiku-5-5',
  background: false,
  fork: false,
} as never

const step = (index: number, agentId = 'a1') => ({ turnId: 't1', index, model: 'claude-haiku-5-5', effort: 'medium', messageCount: 3, agentId }) as never

const drain = async (stream: AsyncIterable<unknown>) => {
  for await (const _ of stream) void _
}

describe('pane', () => {
  test('empty pane draws on every surface', async ($, on) => {
    world(on)
    await start($)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'overseer', surface, component: 'Pane', requestId: 'overseer', props: paneProps() })
      expect(await ui.find({ text: /No subagents yet/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a spawned agent shows with its model, on every surface, at narrow and wide widths', async ($, on) => {
    world(on)
    await start($)
    await $.agent.spawn(SPAWN)
    await drain($.turn.step(step(0)))
    for (const surface of SURFACES)
      for (const width of [30, 64, 120]) {
        const ui = await $.ui.mount({ plugin: 'overseer', surface, component: 'Pane', requestId: 'overseer', props: paneProps(width) })
        // collapsed: the summary only
        expect(await ui.find({ key: 'msg-a1-0' })).toBeUndefined()
        await ui.press({ key: 'row-a1' })
        for (const want of [/probe worker/, /working/])
          expect([surface, width, String(want), (await ui.find({ text: want })) !== undefined]).toEqual([surface, width, String(want), true])
        // the live model: the dropdown's value where there are fields, plain text on mobile
        if (surface === 'mobile') expect(await ui.find({ text: /Haiku 5\.5/ })).toBeDefined()
        else expect((await ui.find({ key: 'model-a1' }))?.props.value).toBe('claude-haiku-5-5')
        const field = surface === 'mobile' ? await ui.find({ text: /need the desktop app/ }) : await ui.find({ type: 'Input', key: 'msg-a1-0' })
        expect([surface, width, 'field', field !== undefined]).toEqual([surface, width, 'field', true])
        // closed cards: every summary line is a full-width press target where a pointer clicks
        if (surface !== 'terminal') {
          await ui.press({ key: 'toggle-a1' })
          const line = await ui.find({ key: 'status-line-a1' })
          // padded out to fill its column (short of overflowing)
          expect(line?.text.length ?? 0).toBeGreaterThanOrEqual(Math.min(14, width - 16))
          await ui.press({ key: 'status-line-a1' })
        }
        // no empty placeholder boxes anywhere: every field the surface lacks is left out
        expect(JSON.stringify(await ui.drawn()).includes('"children":[]}')).toBe(false)
        // a press on the open card's text leaves it open; the Close button closes it
        expect(await ui.find({ key: 'row-a1' })).toBeUndefined()
        await ui.press({ key: 'toggle-a1' })
        expect(await ui.find({ text: /Run echo one/ })).toBeUndefined()
        // closed, any line of the summary opens it where a pointer clicks
        if (surface !== 'terminal') {
          await ui.press({ key: 'status-line-a1' })
          expect(await ui.find({ key: 'msg-a1-0' }) ?? (await ui.find({ text: /need the desktop app/ }))).toBeDefined()
          await ui.press({ key: 'toggle-a1' })
        }
        await ui.unmount()
      }
  })
})

describe('control', () => {
  test('picking a model and effort overrides the next request', async ($, on) => {
    const { seen } = world(on)
    await start($)
    await $.agent.spawn(SPAWN)
    await drain($.turn.step(step(0)))
    const ui = await $.ui.mount({ plugin: 'overseer', surface: 'desktop', component: 'Pane', requestId: 'overseer', props: paneProps() })
    await ui.press({ key: 'row-a1' })
    await ui.select({ key: 'model-a1', value: 'claude-sonnet-5-5' })
    await ui.select({ key: 'effort-a1', value: 'low' })
    expect(await ui.find({ text: /→ Sonnet 5\.5 · low from the next request/ })).toBeDefined()
    await drain($.turn.step(step(1)))
    expect(seen.steps.at(-1)).toEqual({ model: 'claude-sonnet-5-5', effort: 'low', agentId: 'a1' })
    // picking what it runs on now clears the override: the engine's own choice again
    await ui.select({ key: 'model-a1', value: 'claude-sonnet-5-5' })
    await ui.select({ key: 'effort-a1', value: 'low' })
    expect(await ui.find({ text: /from the next request/ })).toBeUndefined()
    await drain($.turn.step(step(2)))
    expect(seen.steps.at(-1)).toEqual({ model: 'claude-haiku-5-5', effort: 'medium', agentId: 'a1' })
  })

  test('main-loop steps are never touched', async ($, on) => {
    const { seen } = world(on)
    await start($)
    await drain($.turn.step({ turnId: 'm', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 } as never))
    expect(seen.steps.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high', agentId: undefined })
  })

  test('a message queues for the courier, tells the parent, and tracks delivery', async ($, on) => {
    const { session } = world(on)
    await start($)
    await $.agent.spawn(SPAWN)
    const ui = await $.ui.mount({ plugin: 'overseer', surface: 'terminal', component: 'Pane', requestId: 'overseer', props: paneProps() })
    await ui.press({ key: 'row-a1' })
    await ui.input({ key: 'msg-a1-0', text: 'include BANANA' })
    expect(await ui.find({ text: /queued/ })).toBeDefined()
    // Claude hears about it only once it's delivered
    expect((await session.heard($)).includes('include BANANA')).toBe(false)
    // the courier's send, as the engine raises it
    await $.session.send({ to: 'a1', text: '[Message from the user, sent through the Overseer panel]\ninclude BANANA', origin: { kind: 'plugin', name: 'overseer-courier' } } as never)
    expect(await ui.find({ text: /delivered/ })).toBeDefined()
    expect((await session.heard($)).includes('include BANANA')).toBe(true)
    // the agent's next request means it has read it
    await drain($.turn.step(step(1)))
    expect(await ui.find({ text: /read/ })).toBeDefined()
  })

  test('completion, resume under the same id keeps history', async ($, on) => {
    world(on)
    await start($)
    await $.agent.spawn(SPAWN)
    await drain($.turn.step(step(0)))
    await $.turn.complete({ turnId: 't1', answer: 'DONE', durationMs: 10, isAborted: false, agentId: 'a1', reason: 'answer' } as never)
    const ui = await $.ui.mount({ plugin: 'overseer', surface: 'desktop', component: 'Pane', requestId: 'overseer', props: paneProps() })
    await ui.press({ key: 'row-a1' })
    expect(await ui.find({ type: 'Text', text: /✓ Done$/ })).toBeDefined()
    expect(await ui.find({ type: 'Input', key: 'msg-a1-0' })).toMatchObject({ props: { submitLabel: 'Send' } })
    // the engine resumes it with a second spawn under the same id
    await $.agent.spawn({ ...(SPAWN as object), prompt: '[Message from the user, sent through the Overseer panel]\nMANGO' } as never)
    expect(await ui.find({ type: 'Text', text: /● Running$/ })).toBeDefined()
    expect(await ui.find({ text: /^DONE$/ })).toBeDefined()
    // the full transcript keeps everything, the parent's prompt first
    await ui.press({ key: 'transcript-a1' })
    expect(await ui.find({ text: /Run echo one/ })).toBeDefined()
    expect(await ui.find({ key: 'msg-a1-0' })).toBeDefined()
    await ui.press({ key: 'transcript-back' })
    expect(await ui.find({ key: 'transcript-a1' })).toBeDefined()
  })

  test('pause holds the next request until resumed', async ($, on) => {
    const { seen, tick } = world(on)
    await start($)
    await $.agent.spawn(SPAWN)
    await drain($.turn.step(step(0)))
    const ui = await $.ui.mount({ plugin: 'overseer', surface: 'desktop', component: 'Pane', requestId: 'overseer', props: paneProps() })
    await ui.press({ key: 'row-a1' })
    await ui.press({ key: 'pause-a1' })
    let isDone = false
    const pending = drain($.turn.step(step(1))).then(() => (isDone = true))
    await tick(3)
    expect(isDone).toBe(false)
    expect(seen.steps).toHaveLength(1)
    expect(await ui.find({ type: 'Text', text: /Paused$/ })).toBeDefined()
    await ui.press({ key: 'resume-a1' })
    await tick(2)
    await pending
    expect(seen.steps).toHaveLength(2)
  })

  test('/overseer off makes every hook pass straight through', async ($, on) => {
    const { seen } = world(on)
    await start($)
    await $.agent.spawn(SPAWN)
    const ui = await $.ui.mount({ plugin: 'overseer', surface: 'desktop', component: 'Pane', requestId: 'overseer', props: paneProps() })
    await ui.press({ key: 'row-a1' })
    await ui.select({ key: 'model-a1', value: 'claude-sonnet-5-5' })
    await $.command.run({ command: 'overseer', args: 'off', origin: { kind: 'user' }, presentation: {} } as never)
    await drain($.turn.step(step(1)))
    expect(seen.steps.at(-1)?.model).toBe('claude-haiku-5-5')
    expect(await ui.find({ text: /Overseer is off/ })).toBeDefined()
    await ui.press({ key: 'enable' })
    await drain($.turn.step(step(2)))
    expect(seen.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
  })

  test('raw codex exec in Bash is redirected to the Overseer tool', async ($, on) => {
    world(on)
    on('tool.call', () => ({ result: 'ran' }) as never)
    await start($)
    const denied = await $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'cd x && codex exec "fix it"' } as never)
    expect((denied as { deny?: string }).deny).toContain('mcp__overseer__codex')
    const allowed = await $.tool.call({ tool: 'Bash', tool_use_id: 'b2', command: 'echo codex is great' } as never)
    expect((allowed as { deny?: string }).deny).toBeUndefined()
  })
})

describe('more actions', () => {
  test('parent SendMessage, broadcast, clear finished, and history', async ($, on) => {
    const { seen } = world(on)
    await start($)
    await $.agent.spawn(SPAWN)
    await $.agent.spawn({ ...(SPAWN as object), tool_use_id: 'tu2', description: 'second worker' } as never)
    const ui = await $.ui.mount({ plugin: 'overseer', surface: 'desktop', component: 'Pane', requestId: 'overseer', props: paneProps() })
    // the parent model messaging its child shows in the child's thread
    await $.session.send({ to: 'a1', text: 'also check the logs', origin: { kind: 'model' } } as never)
    await ui.press({ key: 'row-a1' })
    expect(await ui.find({ text: /also check the logs/ })).toBeDefined()
    // broadcast queues one message per running agent
    await ui.press({ key: 'broadcast' })
    await ui.input({ key: 'broadcast-input', text: 'wrap up now' })
    expect(seen.toasts.some(t => /Sent to 2 agents/.test(t))).toBe(true)
    // finish it, clear it, find it in history
    await $.turn.complete({ turnId: 't1', answer: 'ALL DONE', durationMs: 10, isAborted: false, agentId: 'a1', reason: 'answer' } as never)
    await ui.press({ key: 'clear' })
    expect(await ui.find({ key: 'row-a1' })).toBeUndefined()
    await ui.press({ key: 'history' })
    expect(await ui.find({ text: /ALL DONE/ })).toBeDefined()
    await ui.press({ key: 'history' })
    expect(await ui.find({ key: 'row-a1' })).toBeUndefined()
  })

  test('a long thread: the card shows the latest 3, the transcript pages', async ($, on) => {
    world(on)
    await start($)
    await $.agent.spawn(SPAWN)
    for (let i = 0; i < 40; i++) await drain($.turn.step(step(i)))
    const ui = await $.ui.mount({ plugin: 'overseer', surface: 'desktop', component: 'Pane', requestId: 'overseer', props: paneProps() })
    await ui.press({ key: 'row-a1' })
    // thread tool lines, not the live activity line in the summary
    const tools = async () => (await ui.findAll({ type: 'Text' })).filter(t => /^  ▸ Bash: echo one/.test(t.text)).length
    expect(await tools()).toBeLessThanOrEqual(3)
    expect(await ui.find({ text: /earlier entries · open transcript/ })).toBeDefined()
    await ui.press({ key: 'transcript-a1' })
    const page = await tools()
    expect(page).toBeGreaterThan(3)
    await ui.press({ key: 'earlier-a1' })
    expect(await tools()).toBeGreaterThan(page)
  })

  test('a big session still draws fast and stays within limits', async ($, on) => {
    world(on)
    await start($)
    for (let i = 0; i < 40; i++) {
      await $.agent.spawn({ ...(SPAWN as object), tool_use_id: `t${i}`, description: `worker ${i}` } as never)
    }
    for (let i = 0; i < 200; i++) await drain($.turn.step(step(i)))
    const began = Date.now()
    const ui = await $.ui.mount({ plugin: 'overseer', surface: 'desktop', component: 'Pane', requestId: 'overseer', props: paneProps(80) })
    await ui.drawn()
    expect(Date.now() - began).toBeLessThan(1000)
    // the engine draws the first 100,000 characters of a tree's texts: stay well under
    const texts = (await ui.findAll({ type: 'Text' })).reduce((n, t) => n + t.text.length, 0)
    expect(texts).toBeLessThan(60_000)
  }, )
})

describe('message box and stop', () => {
  test('sending clears the box and shows a live status line', async ($, on) => {
    world(on)
    await start($)
    await $.agent.spawn(SPAWN)
    const ui = await $.ui.mount({ plugin: 'overseer', surface: 'desktop', component: 'Pane', requestId: 'overseer', props: paneProps() })
    await ui.press({ key: 'row-a1' })
    await ui.input({ key: 'msg-a1-0', text: 'hello there' })
    // a fresh, empty box under a new key
    expect(await ui.find({ key: 'msg-a1-0' })).toBeUndefined()
    expect(await ui.find({ type: 'Input', key: 'msg-a1-1' })).toBeDefined()
    expect(await ui.find({ text: /^Sending…$/ })).toBeDefined()
    await $.session.send({ to: 'a1', text: '[Message from the user, sent through the Overseer panel]\nhello there', origin: { kind: 'plugin', name: 'overseer-courier' } } as never)
    expect(await ui.find({ text: /^✓ Delivered/ })).toBeDefined()
    await drain($.turn.step(step(1)))
    expect(await ui.find({ text: /^✓✓ Read by the agent/ })).toBeDefined()
  })

  test('a long draft shows wrapped under the one-line box, and clears on send', async ($, on) => {
    const { clock } = world(on)
    await start($)
    await $.agent.spawn(SPAWN)
    const ui = await $.ui.mount({ plugin: 'overseer', surface: 'desktop', component: 'Pane', requestId: 'overseer', props: paneProps() })
    await ui.press({ key: 'row-a1' })
    const long = 'Please also check the courier watchdog and tell me whether messages can be lost on reload.'
    await ui.input({ key: 'msg-a1-0', text: 'short', kind: 'change' })
    await clock.advance(200)
    expect(await ui.find({ key: 'preview-a1' })).toBeUndefined()
    await ui.input({ key: 'msg-a1-0', text: long, kind: 'change' })
    // nothing yet: drafts land once typing pauses
    expect(await ui.find({ text: long })).toBeUndefined()
    await clock.advance(200)
    expect(await ui.find({ text: long })).toBeDefined()
    // a very long draft: capped to about five lines, the end in view
    const huge = `${'start of a very long message '.repeat(30)}THE END`
    await ui.input({ key: 'msg-a1-0', text: huge, kind: 'change' })
    await clock.advance(200)
    const shown = await ui.find({ type: 'Text', text: /THE END$/ })
    expect(shown?.text.startsWith('…')).toBe(true)
    expect((shown?.text.length ?? 0)).toBeLessThan(huge.length)
    expect(await ui.find({ text: /end shown/ })).toBeDefined()
    await ui.input({ key: 'msg-a1-0', text: long })
    expect(await ui.find({ key: 'preview-a1' })).toBeUndefined()
    expect(await ui.find({ text: /^Sending…$/ })).toBeDefined()
  })

  test('a slow delivery is not reported lost: a late receipt still marks it delivered', async ($, on) => {
    const { clock } = world(on)
    await start($)
    await $.agent.spawn(SPAWN)
    const ui = await $.ui.mount({ plugin: 'overseer', surface: 'desktop', component: 'Pane', requestId: 'overseer', props: paneProps() })
    await ui.press({ key: 'row-a1' })
    await ui.input({ key: 'msg-a1-0', text: 'slow one' })
    // no courier in this test: after the 8 s watchdog it reads as not delivered
    await clock.advance(10_000)
    expect(await ui.find({ text: /^✗ Not delivered/ })).toBeDefined()
    // the receipt arrives late anyway: it still lands on the message
    await $.session.send({ to: 'a1', text: '[Message from the user, sent through the Overseer panel]\nslow one', origin: { kind: 'plugin', name: 'overseer-courier' } } as never)
    expect(await ui.find({ text: /^✓ Delivered/ })).toBeDefined()
  })

  test('Stop ends a Claude agent at its next request without sending it', async ($, on) => {
    const { seen } = world(on)
    await start($)
    await $.agent.spawn(SPAWN)
    await drain($.turn.step(step(0)))
    const ui = await $.ui.mount({ plugin: 'overseer', surface: 'desktop', component: 'Pane', requestId: 'overseer', props: paneProps() })
    await ui.press({ key: 'row-a1' })
    await ui.press({ key: 'stop-a1' })
    expect(await ui.find({ key: 'stop-a1' })).toBeUndefined()
    const stream = $.turn.step(step(1))
    let result: unknown
    for (;;) {
      const r = await stream[Symbol.asyncIterator]().next()
      if (r.done === true) { result = r.value; break }
    }
    expect(seen.steps).toHaveLength(1)
    expect(result).toMatchObject({ stopReason: 'end_turn', answer: 'Stopped by the user from Overseer.' })
    expect(await ui.find({ text: /Stopped from Overseer/ })).toBeDefined()
  })
})

describe('smoothness', () => {
  test('running clocks tick on the surface, not by redrawing the pane', async ($, on) => {
    const { seen, clock } = world(on)
    await start($)
    await $.agent.spawn(SPAWN)
    const ui = await $.ui.mount({ plugin: 'overseer', surface: 'desktop', component: 'Pane', requestId: 'overseer', props: paneProps() })
    expect(await ui.find({ type: 'Client', key: 'clock-a1' })).toBeDefined()
    const before = seen.invalidates
    await clock.advance(5000)
    expect(seen.invalidates - before).toBe(0)
    await ui.unmount()
    // a surface without client modules still gets its once-a-second redraw
    const phone = await $.ui.mount({ plugin: 'overseer', surface: 'mobile', component: 'Pane', requestId: 'overseer', props: paneProps() })
    expect(await phone.find({ type: 'Client' })).toBeUndefined()
    const mid = seen.invalidates
    await clock.advance(3000)
    expect(seen.invalidates - mid).toBeGreaterThanOrEqual(2)
  })
})

describe('getting back to the pane', () => {
  test('a band above the prompt offers the pane while it is not showing', async ($, on) => {
    world(on, { isPlaced: false })
    await start($)
    const band = () => $.ui.mount({ plugin: 'overseer', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false } as never })
    // no agents: no band
    let ui = await band()
    expect(await ui.find({ key: 'open-agents' })).toBeUndefined()
    await ui.unmount()
    // an agent, and the window had no room to place the pane: the band offers it
    await $.agent.spawn(SPAWN)
    ui = await band()
    expect(await ui.find({ text: /1/ })).toBeDefined()
    expect(await ui.find({ key: 'open-agents' })).toBeDefined()
    await ui.press({ key: 'open-agents' })
    await ui.unmount()
  })

  test('the band stays away while the pane is open', async ($, on) => {
    world(on)
    await start($)
    await $.agent.spawn(SPAWN)
    const ui = await $.ui.mount({ plugin: 'overseer', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } as never })
    expect(await ui.find({ key: 'open-agents' })).toBeUndefined()
  })
})

describe('the remaining controls', () => {
  test('Active only, Show full prompt and Copy ID', async ($, on) => {
    const { seen } = world(on)
    await start($)
    const longPrompt = `${'Explain the plan in detail. '.repeat(20)}END OF PROMPT`
    await $.agent.spawn({ ...(SPAWN as object), prompt: longPrompt } as never)
    await $.agent.spawn({ ...(SPAWN as object), tool_use_id: 'tu2', description: 'second worker' } as never)
    await $.turn.complete({ turnId: 't1', answer: 'DONE', durationMs: 10, isAborted: false, agentId: 'a2', reason: 'answer' } as never)
    const ui = await $.ui.mount({ plugin: 'overseer', surface: 'desktop', component: 'Pane', requestId: 'overseer', props: paneProps() })
    // Active only hides the finished agent
    expect(await ui.find({ key: 'row-a2' })).toBeDefined()
    await ui.press({ key: 'filter' })
    expect(await ui.find({ key: 'row-a2' })).toBeUndefined()
    await ui.press({ key: 'filter' })
    expect(await ui.find({ key: 'row-a2' })).toBeDefined()
    // the full prompt in the transcript view
    await ui.press({ key: 'row-a1' })
    await ui.press({ key: 'transcript-a1' })
    expect(await ui.find({ type: 'Text', text: /END OF PROMPT/ })).toBeUndefined()
    await ui.press({ key: 'prompt-toggle-a1' })
    expect(await ui.find({ type: 'Text', text: /END OF PROMPT/ })).toBeDefined()
    await ui.press({ key: 'transcript-back' })
    // Copy ID
    await ui.press({ key: 'copy-a1' })
    expect(seen.copied).toEqual(['a1'])
    expect(seen.toasts.some(t => t.includes('Copied a1'))).toBe(true)
  })
})

// 2.1.280's kit ignores a test's `options`, so spawnReview can't be switched on
// there; that kit has no mock.session either, which is how this file tells them apart
const hasTestOptions = typeof mock.session === 'function'

describe('spawn review', () => {
  if (hasTestOptions) test('approve with an edited prompt, and deny', { options: { spawnReview: true, spawnReviewTimeoutSec: 60 }, timeoutMs: 20000 }, async ($, on) => {
    let spawnedWith = ''
    const { tick } = world(on, { onSpawn: p => (spawnedWith = p) })
    await start($)
    const ui = await $.ui.mount({ plugin: 'overseer', surface: 'desktop', component: 'Pane', requestId: 'overseer', props: paneProps() })
    const first = $.agent.spawn(SPAWN)
    for (let i = 0; i < 20 && (await ui.find({ key: 'review-ok-tu1' })) === undefined; i++) await tick()
    await ui.press({ key: 'review-edit-btn-tu1' })
    await ui.input({ key: 'review-edit-tu1', text: 'EDITED PROMPT' })
    await tick(2)
    expect((await first).agentId).toBe('a1')
    expect(spawnedWith).toBe('EDITED PROMPT')

    // Cancel edit, then plain Approve
    const third = $.agent.spawn({ ...(SPAWN as object), tool_use_id: 'tu3' } as never)
    for (let i = 0; i < 20 && (await ui.find({ key: 'review-ok-tu3' })) === undefined; i++) await tick()
    await ui.press({ key: 'review-edit-btn-tu3' })
    expect(await ui.find({ key: 'review-ok-tu3' })).toBeUndefined()
    await ui.press({ key: 'review-cancel-tu3' })
    await ui.press({ key: 'review-ok-tu3' })
    await tick(2)
    expect((await third).agentId).toBeDefined()
    expect(spawnedWith).toBe('Run echo one, then reply DONE.')

    const second = $.agent.spawn({ ...(SPAWN as object), tool_use_id: 'tu2' } as never)
    for (let i = 0; i < 20 && (await ui.find({ key: 'review-deny-tu2' })) === undefined; i++) await tick()
    await ui.press({ key: 'review-deny-tu2' })
    await tick(2)
    expect((await second).deny).toContain('declined')
  })
})

describe('pure logic', () => {
  test('codex protocol lines', () => {
    expect(parseLine('{"id":3,"result":{"turn":{"id":"T"}}}')).toEqual({ kind: 'response', id: 3, result: { turn: { id: 'T' } }, error: undefined })
    expect(parseLine('{"method":"turn/started","params":{"turn":{"id":"T"}}}')).toEqual({ kind: 'turnStarted', turnId: 'T' })
    expect(parseLine('{"method":"item/completed","params":{"item":{"type":"commandExecution","command":"/bin/zsh -lc \'echo A\'","exitCode":0}}}')).toEqual({ kind: 'tool', text: '$ echo A' })
    expect(parseLine('{"method":"item/completed","params":{"item":{"type":"commandExecution","command":"false","exitCode":1}}}')).toEqual({ kind: 'tool', text: '$ false  (exit 1)' })
    expect(parseLine('{"method":"item/completed","params":{"item":{"type":"agentMessage","text":"PONG"}}}')).toEqual({ kind: 'message', text: 'PONG' })
    expect(parseLine('{"method":"turn/completed","params":{"turn":{"id":"T","status":"interrupted"}}}')).toEqual({ kind: 'turnCompleted', turnId: 'T', status: 'interrupted', error: undefined })
    expect(parseLine('not json')).toEqual({ kind: 'ignore' })
    expect(parseLine('{"id":7,"method":"mcpServer/elicitation/request","params":{}}')).toEqual({ kind: 'serverRequest', id: 7, method: 'mcpServer/elicitation/request' })
    expect(parseLine('{"method":"item/completed","params":{"item":{"type":"mcpToolCall","server":"s","tool":"t","status":"failed"}}}')).toEqual({ kind: 'tool', text: 's:t  (failed)' })
    expect(unwrapShell(`/bin/bash -lc 'ls -la'`)).toBe('ls -la')
    expect(parseModels({ data: [{ id: 'm1', displayName: 'M1', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], isDefault: true }, { id: 'h', hidden: true }] })).toEqual([
      { id: 'm1', label: 'M1', efforts: ['low'], isDefault: true },
    ])
  })

  test('line buffer survives split chunks and CRLF', () => {
    const lines = new LineBuffer()
    expect(lines.push('{"a":1}\r\n{"b"')).toEqual(['{"a":1}'])
    expect(lines.push(':2}\n\n')).toEqual(['{"b":2}'])
    expect(lines.flush()).toEqual([])
  })

  test('raw codex detection', () => {
    expect(isRawCodexExec('codex exec "x"')).toBe(true)
    expect(isRawCodexExec('/usr/local/bin/codex exec fix')).toBe(true)
    expect(isRawCodexExec('codex -m gpt-6 exec fix')).toBe(true)
    expect(isRawCodexExec('codex --model gpt-6 exec fix')).toBe(true)
    expect(isRawCodexExec('npx codex e hi')).toBe(true)
    expect(isRawCodexExec('FOO=1 codex exec hi')).toBe(true)
    expect(isRawCodexExec('codex login')).toBe(false)
    expect(isRawCodexExec('echo "codex exec"')).toBe(false)
    expect(isRawCodexExec("grep -rn 'codex exec' src")).toBe(false)
    expect(isRawCodexExec('cd a; codex e --json hi')).toBe(true)
    expect(isRawCodexExec('codex --version')).toBe(false)
    expect(isRawCodexExec('echo mycodex exec')).toBe(false)
  })

  test('models and registry', () => {
    expect(resolveModel('sonnet')).toBe('claude-sonnet-5-5')
    expect(modelLabel('claude-haiku-5-5')).toBe('Haiku 5.5')
    expect(modelLabel('claude-mystery-9-1-2027')).toBe('Mystery 9.1')
    let r = newRecord({ id: 'x', kind: 'claude', name: 'n', type: 't', description: '', spawnPrompt: 'p' })
    r = stepStarted(r, 'claude-haiku-5-5', 'low')
    r = stepEnded(r, { usage: { input_tokens: 5, output_tokens: 2, model: 'claude-haiku-5-5' }, toolLines: [toolLine('Bash', { command: 'echo  hi\nthere' })], text: 'looking', hasFailed: false })
    expect(r.thread.map(m => m.by)).toEqual(['parent', 'agent', 'tool'])
    expect(r.thread[2]?.text).toBe('Bash: echo hi there')
    r = completed(r, 'answer', 'DONE')
    expect(r.status).toBe('completed')
    r = { ...r, isPaused: true }
    r = completed(r, 'error', '')
    expect(r.isPaused).toBe(false)
    expect(toHistory(r).answer).toContain('error')
    r = withMsg(r, 'user', 'keep me', 'sent', 'keep')
    for (let i = 0; i < 300; i++) r = withMsg(r, 'tool', `t${i}`)
    expect(r.thread.some(m => m.id === 'keep')).toBe(true)
    r = { ...r, thread: r.thread.map(m => (m.id === 'keep' ? { ...m, state: 'read' as const } : m)) }
    for (let i = 0; i < 300; i++) r = withMsg(r, 'tool', `u${i}`)
    expect(r.thread.length).toBe(160)
    expect(r.thread[0]?.by).toBe('parent')
    const child = { ...newRecord({ id: 'c', kind: 'codex', name: 'c', type: 'codex', description: '', spawnPrompt: 'q', parentId: 'x' }) }
    expect(ordered({ x: r, c: child }, false).map(o => [o.rec.id, o.depth])).toEqual([['x', 0], ['c', 1]])
  })
})
