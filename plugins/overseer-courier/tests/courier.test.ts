import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// the courier's world: Overseer's outbox and the courier's receipts in host state
const world = (on: On, outbox: { id: string; to: string; text: string }[], o: { failSends?: number; failSaves?: number } = {}) => {
  const clock = mock.clock(on, { now: Date.now() })
  const state = new Map<string, unknown>([['overseer/outbox', outbox]])
  let failSaves = o.failSaves ?? 0
  on('state.get', ($, e) => ({ value: { value: state.get(`${e.plugin}/${e.key}`), version: 1 } }) as never)
  on('state.set', ($, e) => {
    if (`${e.plugin}/${e.key}` === 'overseer-courier/sent' && failSaves > 0) {
      failSaves--
      return { deny: 'state write refused' } as never
    }
    state.set(`${e.plugin}/${e.key}`, e.value)
    return { value: { isSet: true } } as never
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.log', () => ({ value: undefined }))
  const sends: string[] = []
  let failSends = o.failSends ?? 0
  on('session.send', ($, e) => {
    if (failSends > 0) {
      failSends--
      // the engine skips a hook that throws, so the plugin's send rejects
      throw new Error('send refused')
    }
    sends.push(e.text)
    return { isDelivered: true } as never
  })
  return { clock, sends, state }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const start = ($: any): Promise<unknown> => $.session.start({ cwd: '/tmp/proj', surface: 'desktop', isInteractive: true })

describe('courier', () => {
  test('a queued message is sent once', async ($, on) => {
    const { clock, sends } = world(on, [{ id: 'm1', to: 'a1', text: 'hello' }])
    await start($)
    await clock.advance(2000)
    expect(sends).toEqual(['hello'])
  })

  test('a rejected send is tried again', async ($, on) => {
    const { clock, sends } = world(on, [{ id: 'm1', to: 'a1', text: 'hello' }], { failSends: 1 })
    await start($)
    await clock.advance(2000)
    expect(sends).toEqual(['hello'])
  })

  test('a pickup that could not be recorded is not skipped for good', async ($, on) => {
    const { clock, sends } = world(on, [{ id: 'm1', to: 'a1', text: 'hello' }], { failSaves: 1 })
    await start($)
    await clock.advance(2000)
    expect(sends).toEqual(['hello'])
  })

  test('ids still in the outbox survive the cap, so nothing is sent twice', async ($, on) => {
    const many = Array.from({ length: 520 }, (_, i) => ({ id: `m${i}`, to: 'a1', text: `t${i}` }))
    const { clock, sends } = world(on, many)
    await start($)
    await clock.advance(3000)
    expect(sends).toHaveLength(520)
    expect(new Set(sends).size).toBe(520)
  })
})
