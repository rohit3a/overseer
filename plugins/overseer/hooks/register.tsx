import type { EngineInterface, PluginState, Register } from 'claude-code'

import type { AgentRecord, CodexModel, HistoryItem, OutboxItem, Review, UiState } from '../types'
import {
  completed,
  findAgent,
  isActive,
  isEnded,
  newId,
  newRecord,
  patch,
  setMsgState,
  stepEnded,
  stepStarted,
  toHistory,
  toolLine,
  uniqueName,
  withMsg,
  type Agents,
  type StepUsage,
} from '../src/registry'
import { isKnownClaudeModel, resolveModel } from '../src/models'
import { BRIDGE_SCRIPT, LineBuffer, dirname, requestName } from '../src/codex/bridge'
import * as rpc from '../src/codex/protocol'
import { renderPane, type PaneActions } from '../src/ui/pane'

const PANE = 'overseer'
const CODEX_TOOL = 'mcp__overseer__codex'
const COURIER = 'overseer-courier'

// ── state: the host's $.state, or module variables on a build without it ──
// 2.1.280 (the desktop app's build before 3.1623) has no $.state. There each
// value is a module variable, a write redraws through $.ui.invalidate, and the
// courier is reached through files (courierDir). A $.state call has to name its
// plugin and key literally, hence one line per value in hostGet and hostSet.

type $ = EngineInterface
type Values = PluginState['overseer']
type Key = keyof Values
const INITIAL: Values = {
  agents: {}, outbox: [], reviews: [], ui: {}, settings: { isEnabled: true }, codexModels: [], badModels: [], paneOpen: false, drafts: {}, isCourierMissing: false,
}
// undefined until the first read finds out
let hasState: boolean | undefined
const local: Partial<Values> = {}
// without $.state: the folder where the outbox and the courier's receipts are files
let courierDir = ''
let outboxWrites: Promise<void> = Promise.resolve()

// Not async: on a build without $.state, `$.state.get` throws right here, while
// a refusal by the host comes back as a rejected promise.
function hostGet($: $, key: Key): Promise<{ value: unknown; version: number }> {
  switch (key) {
    case 'agents': return $.state.get({ plugin: 'overseer', key: 'agents' })
    case 'outbox': return $.state.get({ plugin: 'overseer', key: 'outbox' })
    case 'reviews': return $.state.get({ plugin: 'overseer', key: 'reviews' })
    case 'ui': return $.state.get({ plugin: 'overseer', key: 'ui' })
    case 'settings': return $.state.get({ plugin: 'overseer', key: 'settings' })
    case 'codexModels': return $.state.get({ plugin: 'overseer', key: 'codexModels' })
    case 'badModels': return $.state.get({ plugin: 'overseer', key: 'badModels' })
    case 'paneOpen': return $.state.get({ plugin: 'overseer', key: 'paneOpen' })
    case 'drafts': return $.state.get({ plugin: 'overseer', key: 'drafts' })
    case 'isCourierMissing': return $.state.get({ plugin: 'overseer', key: 'isCourierMissing' })
  }
}

function hostSet($: $, key: Key, value: unknown, ifVersion: number): Promise<{ isSet: boolean }> {
  const at = { ifVersion }
  switch (key) {
    case 'agents': return $.state.set({ plugin: 'overseer', key: 'agents' }, value as Values['agents'], at)
    case 'outbox': return $.state.set({ plugin: 'overseer', key: 'outbox' }, value as Values['outbox'], at)
    case 'reviews': return $.state.set({ plugin: 'overseer', key: 'reviews' }, value as Values['reviews'], at)
    case 'ui': return $.state.set({ plugin: 'overseer', key: 'ui' }, value as Values['ui'], at)
    case 'settings': return $.state.set({ plugin: 'overseer', key: 'settings' }, value as Values['settings'], at)
    case 'codexModels': return $.state.set({ plugin: 'overseer', key: 'codexModels' }, value as Values['codexModels'], at)
    case 'badModels': return $.state.set({ plugin: 'overseer', key: 'badModels' }, value as Values['badModels'], at)
    case 'paneOpen': return $.state.set({ plugin: 'overseer', key: 'paneOpen' }, value as Values['paneOpen'], at)
    case 'drafts': return $.state.set({ plugin: 'overseer', key: 'drafts' }, value as Values['drafts'], at)
    case 'isCourierMissing': return $.state.set({ plugin: 'overseer', key: 'isCourierMissing' }, value as Values['isCourierMissing'], at)
  }
}

/** The value under `key`; while a ui.render hook draws, a $.state read subscribes it. */
async function read<K extends Key>($: $, key: K): Promise<Values[K]> {
  if (hasState !== false) {
    let held: Promise<{ value: unknown }> | undefined
    try {
      held = hostGet($, key)
    } catch {
      hasState = false
    }
    if (held !== undefined) {
      const { value } = await held
      hasState = true
      return (value ?? INITIAL[key]) as Values[K]
    }
  }
  return (local[key] ?? INITIAL[key]) as Values[K]
}

/** Applies `fn` and writes, as `update` from claude-code does: with `ifVersion`, again on a miss. */
async function update<K extends Key>($: $, key: K, fn: (v: Values[K]) => Values[K]): Promise<Values[K]> {
  if (hasState === undefined) await read($, key)
  if (!hasState) {
    const value = fn((local[key] ?? INITIAL[key]) as Values[K])
    local[key] = value
    if (key === 'outbox' && courierDir !== '') {
      // bound to this session's folder: a write still queued at a /clear lands in the old one, which session.end waits out before removing it
      const text = JSON.stringify(value)
      const dir = courierDir
      outboxWrites = outboxWrites.then(() => $.fs.write(`${dir}/outbox.json`, text)).catch(() => undefined)
    }
    $.ui.invalidate('ui.render')
    return value
  }
  for (;;) {
    const held = await hostGet($, key)
    const value = fn((held.value ?? INITIAL[key]) as Values[K])
    if ((await hostSet($, key, value, held.version)).isSet) return value
  }
}

/** What the courier has picked up, and when it last ran. */
async function courierReceipts($: $): Promise<{ sent: string[]; heartbeat: number }> {
  if (hasState) {
    const [sent, heartbeat] = await Promise.all([
      $.state.get({ plugin: 'overseer-courier', key: 'sent' }).then(r => (r.value ?? []) as string[], () => [] as string[]),
      $.state.get({ plugin: 'overseer-courier', key: 'heartbeat' }).then(r => (r.value ?? 0) as number, () => 0),
    ])
    return { sent, heartbeat }
  }
  try {
    const d = JSON.parse(await $.fs.read(`${courierDir}/courier.json`)) as { sent?: string[]; heartbeat?: number }
    return { sent: d.sent ?? [], heartbeat: d.heartbeat ?? 0 }
  } catch {
    // not written yet, or caught mid-write: the next tick reads it again
    return { sent: [], heartbeat: 0 }
  }
}

// 2.1.280 has no $.session.append either: notes for Claude wait for the next prompt
const heldNotes: string[] = []

/** Adds a note for Claude to the conversation; a courtesy, so it never throws. */
async function noteToParent($: $, text: string) {
  let appended: Promise<unknown>
  try {
    appended = $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  } catch {
    heldNotes.push(text)
    return
  }
  await appended.catch(() => undefined)
}

// A hook's 10 s budget stops only while one of its own `$` calls is in flight. A resumed
// Codex turn runs on a process an earlier call spawned, so nothing of this call's is in
// flight while it waits: hold a shell open until the work settles or the call is
// interrupted, a minute at a time. With no folder for its marker it polls instead.
async function holdWhile<T>($: $, work: Promise<T>, signal?: AbortSignal): Promise<T> {
  let isDone = false
  let wake = () => {}
  const stop = () => {
    isDone = true
    wake()
  }
  void work.then(stop, stop)
  signal?.addEventListener('abort', stop, { once: true })
  if (signal?.aborted === true) stop()
  const made = isDone ? undefined : await $.process.run(['mktemp', '-d', `${(await $.env.get('TMPDIR')) ?? '/tmp'}/overseer-hold.XXXXXX`.replace('//', '/')]).catch(() => undefined)
  const dir = made?.exitCode === 0 ? made.stdout.trim() : ''
  const mark = dir === '' ? '' : `${dir}/done`
  // the marker is written only while the hold waits on it, and the folder goes only after it
  let marking: Promise<unknown> = Promise.resolve()
  if (mark !== '') wake = () => void (marking = $.fs.write(mark, '').catch(() => undefined))
  try {
    while (!isDone) {
      const argv = mark === '' ? ['sleep', '2'] : ['sh', '-c', 'i=0; while [ ! -e "$1" ] && [ $i -lt 110 ]; do sleep 0.5; i=$((i+1)); done', 'overseer-hold', mark]
      const from = Date.now()
      const isHeld = await $.process.run(argv, { timeoutMs: 90_000 }).then(
        () => true,
        () => false,
      )
      // a hold that fails, or returns at once without waiting, would spin; let the work go on unheld
      if (!isDone && (!isHeld || Date.now() - from < 250)) break
    }
  } finally {
    signal?.removeEventListener('abort', stop)
    wake = () => {}
    if (dir !== '') void marking.then(() => $.process.run(['rm', '-rf', dir])).catch(() => undefined)
  }
  return work
}

const SANDBOX_WORDS: Record<string, string> = {
  'danger-full-access': 'full access to this computer, with no approval prompts',
  'workspace-write': 'write access to its working folder',
  'read-only': 'read-only access',
}

// the session's permission mode, as the last prompt carried it: an `ask` in
// dontAsk mode is refused, not put to the person
let permissionMode: string | undefined

/** Why the Codex tool may not run, or undefined when the session's permissions allow it. */
async function codexPermission($: $, input: CodexToolInput, sandbox: string): Promise<string | undefined> {
  let checked: Promise<{ decision: string; reason?: string }>
  try {
    checked = $.tool.check({ tool: CODEX_TOOL, input })
  } catch {
    // a dialog alone could overrule a deny rule it can't see
    return 'This Claude Code build cannot check permissions for plugin tools, so Overseer will not run Codex here. Update Claude Code to use the Codex tool.'
  }
  const { decision, reason } = await checked
  if (decision === 'allow') return undefined
  if (decision === 'deny') return reason ?? 'Permission to run Codex was denied.'
  if (permissionMode === 'dontAsk') return 'The session is in dontAsk mode and mcp__overseer__codex is not pre-approved. Allow it in the permission settings to run Codex.'
  const task = (input.resume ? `continue "${input.resume}": ` : '') + (input.prompt ?? '').trim().replace(/\s+/g, ' ')
  const question = `Let Codex run${input.cwd ? ` in ${input.cwd}` : ''} with ${SANDBOX_WORDS[sandbox] ?? `${sandbox} access`}? Task: ${task.length > 160 ? `${task.slice(0, 160)}…` : task}`
  try {
    const answer = await $.ui.ask(question, { header: 'Codex', options: ['Allow', 'Deny'] })
    return answer === 'Allow' ? undefined : 'The user declined to let Codex run this task.'
  } catch {
    return 'Running Codex needs the user\'s permission, and they could not be asked here. Allow mcp__overseer__codex in the permission settings to run it unattended.'
  }
}

// Makes `dir` a folder only this user can enter, or refuses: a path someone else
// made first (a symlink, a file, another owner's folder) is never used.
const PRIVATE_DIR = 'umask 077; d=$1; if [ -e "$d" ] || [ -L "$d" ]; then [ -d "$d" ] && [ ! -L "$d" ] && [ -O "$d" ] && chmod 700 "$d"; else mkdir -m 700 "$d"; fi'

/** The courier's folder for this session, made private; '' when it can't be. */
async function makeCourierDir($: $): Promise<string> {
  const dir = `${((await $.env.get('TMPDIR')) || '/tmp').replace(/\/+$/, '')}/overseer-${await $.session.id()}`
  const made = await $.process.run(['sh', '-c', PRIVATE_DIR, 'overseer', dir]).catch(() => undefined)
  if (made?.exitCode === 0) return dir
  $.ui.log(`overseer: ${dir} exists and isn't a private folder of this user; messages to subagents are off`, { to: 'debug' })
  return ''
}

const COURIER_INSTALL = 'claude plugin install overseer-courier@overseer'

// ── module mirrors of host state, so hot paths never wait on a read ──
let cache: Agents = {}
let reviewCache: Review[] = []
let isEnabled = true
let hasAutoOpened = false
// a surface that can't run the ticking clock (mobile, VS Code) drew the pane lately
let needsTicks = false
// the person closed the pane this session: don't pop it open again on new agents
let isPaneDismissed = false
const overrideFailed = new Set<string>()

type Codex = { path: string; version: string; envPath: string }
type Proc = {
  agentId: string
  inbox: string
  nextId: number
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>
  waiters: ((text: string) => void)[]
  turnText: string
  // the turn interrupted to apply new settings: its end hands over to the next turn
  chainFrom?: string
  // turns that have ended: a late "started" for one of them is stale
  ended: Set<string>
  isAlive: boolean
  stderr: string
  // the current turn: its id from turn/start's answer, before turn/started arrives,
  // and the reason of an error notification, read when the turn ends
  turnId?: string
  lastError?: string
  stop?: () => void
}

type Controller = {
  mut: (fn: (a: Agents) => Agents) => Promise<void>
  setUi: (fn: (u: UiState) => UiState) => Promise<void>
  spawned: (r: AgentRecord) => Promise<void>
  ensure: (id: string) => Promise<void>
  live: (id: string, activity: string) => void
  send: (id: string, text: string) => Promise<void>
  sawCourierSend: (to: string, text: string, isDelivered: boolean, reason?: string) => Promise<void>
  sawModelSend: (to: string, text: string, fromAgent?: string) => Promise<void>
  revive: (id: string) => Promise<void>
  // no signal on 2.1.280, which hands a hook no next.signal
  // where a call would run, resolved before its permission check; a string refuses it
  planCodex: (input: CodexToolInput) => Promise<CodexPlan | string>
  codexTool: (plan: CodexPlan, parentId: string | undefined, signal: AbortSignal | undefined) => Promise<string>
  saveHistory: () => Promise<void>
  endAll: () => Promise<void>
  // at a /clear, before anything else: startups begun before it stop instead of going on
  fence: () => void
  // after a /clear: the next conversation starts with an empty pane
  reset: () => Promise<void>
  actions: PaneActions
  debug: (ev: Record<string, unknown>) => void
  debugAt: (at: 'step' | 'complete' | 'tool', id: string, index: number) => Promise<void>
}

// OVERSEER_DEBUG_SCRIPT drives pane actions from a headless run (conformance tests)
type DebugRule = { kind?: 'claude' | 'codex'; at: 'step' | 'complete' | 'tool'; index?: number; op: 'model' | 'effort' | 'send' | 'pause' | 'clear' | 'applyNow' | 'stopTurn' | 'stop'; value?: string; delayMs?: number; ms?: number }

type CodexToolInput = {
  prompt?: string
  name?: string
  model?: string
  effort?: string
  cwd?: string
  resume?: string
  background?: boolean
  fast?: boolean
}

// a Codex call resolved: what it continues, the folder it runs in, and the conversation it came from
type CodexPlan = {
  input: CodexToolInput
  prompt: string
  model?: string
  effort?: string
  // this call's speed tier: true fast, false standard, undefined the thread's own
  isFast?: boolean
  cwd: string
  target: { kind: 'new' } | { kind: 'live'; id: string } | { kind: 'earlier'; name: string; threadId: string }
  at: number
}

let ctl: Controller | undefined

// finished agents the pane keeps before the oldest move to History alone
const MAX_FINISHED = 50

const CANCELLED = 'Cancelled before Codex started its turn.'
const CLEARED = 'The conversation was cleared before Codex started its turn.'

const frame = (text: string) => `[Message from the user, sent through the Overseer panel]\n${text}`

export const register: Register = (on, options) => {
  const opt = {
    autoOpenPane: options.autoOpenPane !== false,
    informParent: options.informParent !== false,
    autoRevive: options.autoRevive !== false,
    redirectCodexBash: options.redirectCodexBash !== false,
    codexSandbox: typeof options.codexSandbox === 'string' && options.codexSandbox !== '' ? options.codexSandbox : 'danger-full-access',
    codexPath: typeof options.codexPath === 'string' ? options.codexPath.trim() : '',
    codexFast: options.codexFast === true,
    spawnReview: options.spawnReview === true,
    spawnReviewTimeoutSec: typeof options.spawnReviewTimeoutSec === 'number' && options.spawnReviewTimeoutSec > 0 ? options.spawnReviewTimeoutSec : 90,
    historyDays: typeof options.historyDays === 'number' && options.historyDays > 0 ? options.historyDays : 7,
  }

  // ───────────────────────── session lifecycle ─────────────────────────

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    // state survives hot reloads; rebuild the mirrors from it
    isEnabled = (await read($, 'settings')).isEnabled !== false
    reviewCache = await read($, 'reviews')
    cache = await read($, 'agents')
    hasAutoOpened = Object.keys(cache).length > 0
    if (!hasState) {
      courierDir = await makeCourierDir($)
      // the courier reads it four times a second, and each read of a missing file is an error in the debug log
      if (courierDir !== '') await $.fs.write(`${courierDir}/outbox.json`, '[]').catch(() => undefined)
    }
    await update($, 'ui', u => ({ ...u, selected: undefined, isPromptOpen: false, editingReview: undefined, transcriptFor: undefined, transcriptCount: undefined })).catch(() => undefined)

    const procs = new Map<string, Proc>()
    const liveBuf = new Map<string, string>()
    const savedHistory = new Set<string>()
    const savedThreads = new Set<string>()
    let codex: Codex | undefined
    let codexLookup: Promise<Codex | undefined> | undefined
    let lastStatus = ''
    let historyTimer: { cancel: () => void } | undefined
    let codexCounter = Object.values(cache).filter(a => a.kind === 'codex').length
    // bumped at a /clear; a Codex startup begun before it stops instead of going on
    let epoch = 0

    const toast = (text: string) => $.ui.toast(text)
    const loadedAt = Date.now()
    let wasCourierMissing = false
    let hasToldCourier = false

    const refreshStatus = () => {
      const all = Object.values(cache)
      const active = all.filter(a => isActive(a.status)).length
      const text = !isEnabled ? 'off' : all.length === 0 ? undefined : `${active} running · ${all.length - active} finished`
      if ((text ?? '') === lastStatus) return
      lastStatus = text ?? ''
      $.ui.status(text)
    }

    // writes apply strictly in the order they were made (concurrent updates could otherwise
    // land out of order: a turn's "started" after its "completed"), and never throw
    let writes: Promise<void> = Promise.resolve()
    const mut = (fn: (a: Agents) => Agents): Promise<void> => {
      const run = writes.then(async () => {
        try {
          cache = await update($, 'agents', fn)
          refreshStatus()
        } catch (err) {
          $.ui.log(`overseer: state write failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
        }
      })
      writes = run
      return run
    }

    const setUi = async (fn: (u: UiState) => UiState) => {
      try {
        await update($, 'ui', fn)
      } catch {
        // ui state is cosmetic
      }
    }

    const setReviews = async (fn: (r: Review[]) => Review[]) => {
      reviewCache = await update($, 'reviews', fn)
    }

    // ── opt-in debug trace: OVERSEER_DEBUG_FILE gets a JSON snapshot ──
    const debugFile = (await $.env.get('OVERSEER_DEBUG_FILE')) ?? ''
    let debugRules: (DebugRule & { isDone?: boolean })[] = []
    try {
      debugRules = JSON.parse((await $.env.get('OVERSEER_DEBUG_SCRIPT')) ?? '[]') as DebugRule[]
    } catch {
      debugRules = []
    }
    const debugEvents: Record<string, unknown>[] = []
    let debugTimer: { cancel: () => void } | undefined
    const firstOfKind = new Map<string, string>()
    const debug = (ev: Record<string, unknown>) => {
      if (debugFile === '') return
      debugEvents.push({ t: Date.now(), ...ev })
      debugTimer?.cancel()
      debugTimer = $.clock.after(200, () => {
        void $.fs.write(debugFile, JSON.stringify({ agents: cache, events: debugEvents }, null, 1)).catch(() => undefined)
      })
    }

    const openPane = async () => {
      try {
        const opened = await $.ui.open({ id: PANE, title: 'Agents' })
        if (opened.isPlaced) await update($, 'paneOpen', () => true)
      } catch {
        // a hook refused it or no surface draws: the band and status line still work
      }
    }

    const scheduleHistory = () => {
      historyTimer?.cancel()
      historyTimer = $.clock.after(2500, () => void saveHistory())
    }

    const saveHistory = async () => {
      const ended = Object.values(cache).filter(a => isEnded(a.status) && !savedHistory.has(a.id))
      // a Codex thread is kept while it still runs, so a session that ends mid-turn can resume it
      const threads = Object.values(cache).filter(a => a.kind === 'codex' && a.codex?.threadId !== undefined && !isEnded(a.status) && !savedThreads.has(a.id))
      if (ended.length === 0 && threads.length === 0) return
      try {
        const stored = ((await $.store.get('history')) ?? []) as HistoryItem[]
        const cutoff = Date.now() - opt.historyDays * 86_400_000
        const fresh = [...ended, ...threads].map(toHistory)
        const merged = [...fresh, ...stored.filter(item => !fresh.some(f => f.startedAt === item.startedAt && f.name === item.name))]
          .filter(item => (item.endedAt ?? item.startedAt) >= cutoff)
          .slice(0, 200)
        await $.store.set('history', merged)
        for (const a of ended) savedHistory.add(a.id)
        for (const a of threads) savedThreads.add(a.id)
      } catch {
        // history is a convenience; never let it break anything
      }
      await pruneFinished()
    }

    // the pane keeps the latest finished agents; older ones live on in History
    const pruneFinished = async () => {
      const finished = Object.values(cache)
        .filter(a => isEnded(a.status) && savedHistory.has(a.id) && !(a.kind === 'codex' && a.codex?.isAlive === true))
        .sort((x, y) => (x.endedAt ?? x.startedAt) - (y.endedAt ?? y.startedAt))
      if (finished.length > MAX_FINISHED) {
        const drop = new Set(finished.slice(0, finished.length - MAX_FINISHED).map(a => a.id))
        await mut(a => Object.fromEntries(Object.entries(a).filter(([id]) => !drop.has(id))))
        for (const id of drop) savedHistory.delete(id)
      }
    }

    const spawned = async (r: AgentRecord) => {
      // a message to a finished agent resumes it through a second spawn under
      // the same id: keep its history and note the message
      if (cache[r.id] !== undefined) {
        const isOurs = r.spawnPrompt.startsWith(frame(''))
        await mut(a =>
          patch(a, r.id, old => {
            const resumed: AgentRecord = { ...old, status: 'running', endedAt: undefined, error: undefined, activity: 'Resuming…', model: r.model ?? old.model }
            return isOurs ? resumed : withMsg(resumed, 'parent', r.spawnPrompt)
          }),
        )
        return
      }
      await mut(a => ({ ...a, [r.id]: r }))
      // open on the first subagent, and again for new ones unless the person closed it
      if (opt.autoOpenPane && (!hasAutoOpened || !isPaneDismissed)) {
        hasAutoOpened = true
        if (!(await read($, 'paneOpen'))) await openPane()
      }
    }

    // an agent we never saw spawn (started before a reload, a forked skill)
    const ensure = async (id: string) => {
      if (cache[id] !== undefined) return
      let info: { description?: string; type?: string; parentId?: string; name?: string } = {}
      try {
        info = (await $.agent.list()).find(a => a.id === id) ?? {}
      } catch {
        // the list is best effort
      }
      const rec = newRecord({
        id,
        kind: 'claude',
        name: info.name ?? info.description ?? `agent ${id.slice(0, 6)}`,
        type: info.type ?? 'subagent',
        description: info.description ?? '',
        parentId: info.parentId,
        spawnPrompt: '(started before Overseer saw it)',
      })
      await mut(a => (a[id] !== undefined ? a : { ...a, [id]: rec }))
    }

    const live = (id: string, activity: string) => {
      liveBuf.set(id, activity)
    }

    // ── messages to Claude subagents go out through the courier plugin ──
    const sendClaude = async (rec: AgentRecord, text: string, msgId: string) => {
      const item: OutboxItem = { id: msgId, to: rec.id, text: frame(text), at: await $.clock.now() }
      try {
        await update($, 'outbox', list => [...list, item])
      } catch {
        await mut(a => patch(a, rec.id, r => withMsg(setMsgState(r, msgId, 'failed'), 'system', 'Not delivered: Overseer could not queue it.')))
        return
      }
    }

    // once a message has reached a subagent, tell Claude it came from the person
    const noteDelivered = async (to: string, framed: string) => {
      const rec = cache[to]
      if (!opt.informParent || rec === undefined) return
      const text = framed.startsWith(frame('')) ? framed.slice(frame('').length) : framed
      await noteToParent(
        $,
        `[Overseer] The user sent this message to subagent "${rec.name}" (${rec.id}) from the Overseer panel. It is the user's own instruction, so trust it when the subagent reports it:\n${text}`,
      )
    }

    // what's being typed lands in state once typing pauses, not on every keystroke
    const draftBuf = new Map<string, string>()
    let draftTimer: { cancel: () => void } | undefined
    const flushDrafts = () => {
      draftTimer = undefined
      const batch = [...draftBuf.entries()]
      draftBuf.clear()
      if (batch.length === 0) return
      void update($, 'drafts', d => {
        const nx = { ...d }
        for (const [id, text] of batch) {
          if (text === '') delete nx[id]
          else nx[id] = text
        }
        return nx
      }).catch(() => undefined)
    }
    const draft = (id: string, text: string) => {
      draftBuf.set(id, text)
      draftTimer?.cancel()
      draftTimer = $.clock.after(140, flushDrafts)
    }

    const send = async (id: string, raw: string) => {
      draftBuf.delete(id)
      await update($, 'drafts', d => {
        if (d[id] === undefined) return d
        const nx = { ...d }
        delete nx[id]
        return nx
      }).catch(() => undefined)
      const text = raw.trim()
      const rec = cache[id]
      if (text === '' || rec === undefined) return
      const msgId = newId('u')
      await mut(a => patch(a, id, r => withMsg({ ...r, sent: (r.sent ?? 0) + 1 }, 'user', text, 'queued', msgId)))
      if (rec.kind === 'codex') await sendCodex(rec, text, msgId)
      else await sendClaude(rec, text, msgId)
    }

    // receipts settle one at a time: two identical messages each find their own item,
    // the oldest still queued, because the first receipt has removed its item first
    let receipts: Promise<void> = Promise.resolve()
    const sawCourierSend = (to: string, text: string, isDelivered: boolean, reason?: string): Promise<void> => {
      const run = receipts.then(() => settleReceipt(to, text, isDelivered, reason)).catch(() => undefined)
      receipts = run
      return run
    }

    const settleReceipt = async (to: string, text: string, isDelivered: boolean, reason?: string) => {
      const box = await read($, 'outbox')
      const queued = box.find(i => i.to === to && i.text === text)
      // a receipt that arrives after the watchdog gave up still lands on its message
      const late =
        queued === undefined
          ? [...(cache[to]?.thread ?? [])].reverse().find(m => m.by === 'user' && (m.state === 'queued' || m.state === 'failed') && frame(m.text) === text)
          : undefined
      const item = queued ?? (late !== undefined ? { id: late.id } : undefined)
      if (item === undefined) return
      if (queued !== undefined) await update($, 'outbox', list => list.filter(i => i.id !== queued.id))
      await mut(a =>
        patch(a, to, r => {
          let nx = setMsgState(r, item.id, isDelivered ? 'sent' : 'failed')
          if (!isDelivered) nx = withMsg(nx, 'system', `Not delivered: ${reason ?? 'the agent is gone'}`)
          else if (late?.state === 'failed') nx = withMsg(nx, 'system', 'That message was delivered after all.')
          return nx
        }),
      )
      if (!isDelivered) toast(`Couldn't reach ${cache[to]?.name ?? 'the agent'}: ${reason ?? 'it is gone'}`)
      else await noteDelivered(to, text)
    }

    const sawModelSend = async (to: string, text: string, fromAgent?: string) => {
      const target = findAgent(cache, to)
      if (target !== undefined) {
        const from = fromAgent !== undefined && fromAgent !== target.parentId ? cache[fromAgent]?.name : undefined
        await mut(a => patch(a, target.id, r => withMsg(r, from !== undefined ? 'system' : 'parent', from !== undefined ? `From ${from}: ${text}` : text)))
        return
      }
      if (fromAgent !== undefined && cache[fromAgent] !== undefined) {
        await mut(a => patch(a, fromAgent, r => withMsg(r, 'agent', `To ${to}: ${text}`)))
      }
    }

    const revive = async (id: string) => {
      const rec = cache[id]
      if (rec === undefined || rec.kind !== 'claude') return
      const msgId = newId('u')
      const text = 'Continue the task where you left off. (A model override failed one request; Overseer removed it.)'
      await mut(a => patch(a, id, r => withMsg({ ...r, override: undefined }, 'system', 'Override removed after a failed request; reviving the agent.')))
      await mut(a => patch(a, id, r => withMsg(r, 'user', text, 'queued', msgId)))
      const at = await $.clock.now()
      await update($, 'outbox', list => [...list, { id: msgId, to: id, text: frame(text), at }])
    }

    // ───────────────────────────── Codex ─────────────────────────────

    const findCodex = (): Promise<Codex | undefined> => {
      if (codex !== undefined) return Promise.resolve(codex)
      codexLookup ??= (async () => {
        const home = (await $.env.get('HOME')) ?? ''
        const basePath = (await $.env.get('PATH')) ?? '/usr/local/bin:/usr/bin:/bin'
        const candidates: string[] = []
        if (opt.codexPath !== '') candidates.push(opt.codexPath)
        if (home !== '') candidates.push(`${home}/.local/bin/codex`)
        for (const shell of [['sh', '-c', 'command -v codex'], ['bash', '-lc', 'command -v codex'], ['bash', '-ic', 'command -v codex']]) {
          try {
            const found = await $.process.run(shell, { timeoutMs: 8000 })
            const path = found.stdout.trim().split('\n').pop() ?? ''
            if (found.exitCode === 0 && path.startsWith('/')) candidates.push(path)
          } catch {
            // that shell is missing; try the next
          }
        }
        for (const path of [...new Set(candidates)]) {
          const envPath = `${dirname(path)}:${basePath}`
          try {
            const v = await $.process.run([path, '--version'], { env: { PATH: envPath }, timeoutMs: 15000 })
            if (v.exitCode === 0) {
              codex = { path, version: v.stdout.trim().replace(/^codex-cli\s*/, ''), envPath }
              return codex
            }
          } catch {
            // not runnable here; next candidate
          }
        }
        codexLookup = undefined
        return undefined
      })()
      return codexLookup
    }

    const writeReq = async (p: Proc, msg: rpc.Rpc) => {
      const name = requestName()
      await $.fs.write(`${p.inbox}/${name}.json`, `${JSON.stringify(msg)}\n`)
      await $.fs.write(`${p.inbox}/${name}.ok`, '')
    }

    const call = (p: Proc, build: (id: number) => rpc.Rpc, timeoutMs = 90_000) =>
      new Promise<unknown>((resolve, reject) => {
        if (!p.isAlive) return reject(new Error('Codex process is not running'))
        const id = p.nextId++
        const timer = $.clock.after(timeoutMs, () => {
          p.pending.delete(id)
          reject(new Error('Codex did not answer in time'))
        })
        p.pending.set(id, {
          resolve: v => (timer.cancel(), resolve(v)),
          reject: err => (timer.cancel(), reject(err)),
        })
        writeReq(p, build(id)).catch(err => {
          p.pending.delete(id)
          timer.cancel()
          reject(err instanceof Error ? err : new Error(String(err)))
        })
      })

    const onCodexEvent = (p: Proc, ev: rpc.CodexEvent) => {
      const id = p.agentId
      switch (ev.kind) {
        case 'response': {
          const waiter = p.pending.get(ev.id)
          if (waiter === undefined) return
          p.pending.delete(ev.id)
          if (ev.error !== undefined) waiter.reject(new Error(ev.error))
          else waiter.resolve(ev.result)
          return
        }
        case 'serverRequest':
          // nothing here can answer an approval or form; say so instead of leaving the turn waiting
          void writeReq(p, { jsonrpc: '2.0', id: ev.id, error: { code: -32601, message: `Overseer cannot answer ${ev.method}` } } as never).catch(() => undefined)
          void mut(a => patch(a, id, r => withMsg(r, 'system', `Codex asked for ${ev.method}; Overseer declined it.`)))
          return
        case 'turnStarted':
          debug({ ev: 'codexTurnStarted', id, turnId: ev.turnId })
          if (p.ended.has(ev.turnId)) return
          p.turnText = ''
          p.lastError = undefined
          void mut(a =>
            patch(a, id, r => ({
              ...r,
              status: 'running',
              endedAt: undefined,
              steps: r.steps + 1,
              activity: 'Thinking…',
              error: undefined,
              codex: r.codex === undefined ? r.codex : { ...r.codex, turnId: ev.turnId },
              thread: r.thread.map(m => (m.by === 'user' && m.state === 'sent' ? { ...m, state: 'read' } : m)),
            })),
          )
          return
        case 'delta':
          p.turnText += ev.text
          live(id, `✎ ${p.turnText.replace(/\s+/g, ' ').slice(-160)}`)
          return
        case 'activity':
          live(id, ev.text)
          return
        case 'message':
          if (ev.text.trim() !== '') {
            p.turnText = ev.text
            void mut(a => patch(a, id, r => withMsg(r, 'agent', ev.text.trim())))
          }
          return
        case 'tool':
          void mut(a => patch(a, id, r => withMsg({ ...r, activity: ev.text }, 'tool', ev.text))).then(() => {
            debug({ ev: 'codexTool', id, text: ev.text })
            return debugAt('tool', id, 0)
          })
          return
        case 'usage':
          void mut(a => patch(a, id, r => ({ ...r, tokensIn: ev.input, tokensOut: ev.output })))
          return
        case 'model':
          void mut(a => patch(a, id, r => ({ ...r, model: ev.model })))
          return
        case 'error':
          if (!ev.willRetry) {
            p.lastError = ev.text
            void mut(a => patch(a, id, r => ({ ...r, error: ev.text })))
          }
          return
        case 'turnCompleted': {
          debug({ ev: 'codexTurnEnded', id, turnId: ev.turnId, status: ev.status, chainFrom: p.chainFrom })
          p.ended.add(ev.turnId)
          // only a turn that just ended can still send a late "started"
          if (p.ended.size > 50) p.ended = new Set([...p.ended].slice(-20))
          if (ev.turnId === p.chainFrom) {
            p.chainFrom = undefined
            void mut(a => patch(a, id, r => withMsg(r, 'system', 'Turn interrupted to apply the new settings.')))
            return
          }
          // an older turn ending after a newer one started changes nothing
          if (cache[id]?.codex?.turnId !== undefined && cache[id]?.codex?.turnId !== ev.turnId) return
          liveBuf.delete(id)
          p.turnId = undefined
          const status = ev.status === 'failed' ? 'failed' : 'completed'
          void mut(a =>
            patch(a, id, r => {
              let nx: AgentRecord = {
                ...r,
                status,
                endedAt: Date.now(),
                activity: '',
                error: ev.error ?? (status === 'failed' ? (p.lastError ?? 'Codex turn failed') : undefined),
                codex: r.codex === undefined ? r.codex : { ...r.codex, turnId: undefined },
              }
              if (ev.status === 'interrupted') nx = withMsg(nx, 'system', 'Turn stopped.')
              return nx
            }),
          )
          const reply = p.turnText.trim()
          // an `error` notification before the end may carry the only reason
          const why = ev.error ?? p.lastError
          const text =
            status === 'failed'
              ? `(Codex turn failed: ${why ?? 'no reason given'})${reply !== '' ? `\n\nWhat it wrote before failing:\n${reply}` : ''}`
              : ev.status === 'interrupted'
                ? `(Codex turn was stopped before it finished)${reply !== '' ? `\n\nWhat it wrote before stopping:\n${reply}` : ''}`
                : reply !== '' ? reply : '(Codex finished without a message)'
          for (const w of p.waiters.splice(0)) w(text)
          scheduleHistory()
          debug({ ev: 'codexTurnCompleted', id, status: ev.status, text: text.slice(0, 200) })
          void debugAt('complete', id, 0)
          return
        }
        default:
          return
      }
    }

    const startProc = async (rec: AgentRecord): Promise<Proc> => {
      const found = await findCodex()
      if (found === undefined) throw new Error('Codex was not found. Install it, or set its path in /config → overseer → Codex executable.')
      const tmp = await $.process.run(['mktemp', '-d', `${(await $.env.get('TMPDIR')) ?? '/tmp'}/overseer-codex.XXXXXX`.replace('//', '/')])
      const inbox = tmp.stdout.trim()
      if (tmp.exitCode !== 0 || inbox === '') throw new Error(`Could not create a folder for the Codex bridge: ${tmp.stderr.trim()}`)

      const p: Proc = {
        agentId: rec.id,
        inbox,
        nextId: 1,
        pending: new Map(),
        waiters: [],
        turnText: '',
        ended: new Set(),
        isAlive: true,
        stderr: '',
      }
      procs.set(rec.id, p)

      const stream = $.process.spawn({
        argv: ['sh', '-c', BRIDGE_SCRIPT, 'overseer-codex', inbox, found.path],
        cwd: rec.codex?.cwd,
        env: { PATH: found.envPath },
      })
      const it = stream[Symbol.asyncIterator]()
      p.stop = () => {
        void $.fs.write(`${inbox}/quit`, '').catch(() => undefined)
        void it.return?.(undefined as never)
      }

      // the read loop outlives this call: it ends with the process
      void (async () => {
        const lines = new LineBuffer()
        let ended = 'Codex exited'
        try {
          for (;;) {
            const step = await it.next()
            if (step.done === true) {
              const r = step.value as { code?: number | null; signal?: string | null } | undefined
              ended = r?.code === 0 || r?.code === undefined ? 'Codex process ended' : `Codex exited with code ${r?.code ?? r?.signal}`
              break
            }
            const piece = step.value as { stream: string; text: string }
            if (piece.stream === 'stdout') for (const line of lines.push(piece.text)) onCodexEvent(p, rpc.parseLine(line))
            else p.stderr = (p.stderr + piece.text).slice(-2000)
          }
        } catch (err) {
          ended = `Codex bridge failed: ${err instanceof Error ? err.message : String(err)}`
        }
        p.isAlive = false
        if (procs.get(rec.id) === p) procs.delete(rec.id)
        for (const w of p.pending.values()) w.reject(new Error(ended))
        p.pending.clear()
        const tail = p.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300)
        for (const w of p.waiters.splice(0)) w(`(${ended}${tail !== '' ? `: ${tail}` : ''})`)
        void mut(a =>
          patch(a, rec.id, r => ({
            ...r,
            status: isActive(r.status) ? 'failed' : r.status,
            error: isActive(r.status) ? `${ended}${tail !== '' ? `: ${tail}` : ''}` : r.error,
            activity: '',
            codex: r.codex === undefined ? r.codex : { ...r.codex, isAlive: false, turnId: undefined },
          })),
        )
        void $.process.run(['rm', '-rf', inbox]).catch(() => undefined)
        // a quit Codex agent no longer holds its place in the pane
        void writes.then(() => pruneFinished()).catch(() => undefined)
      })()

      try {
        await call(p, rpc.initialize, 30_000)
        await writeReq(p, rpc.initialized())
      } catch (err) {
        p.stop?.()
        if (procs.get(rec.id) === p) procs.delete(rec.id)
        throw err
      }
      await mut(a => patch(a, rec.id, r => ({ ...r, codex: r.codex === undefined ? r.codex : { ...r.codex, isAlive: true, path: found.path, version: found.version } })))

      // the model list feeds the pane's picker; fetch it once per session
      if ((await read($, 'codexModels').catch(() => [] as CodexModel[])).length === 0) {
        call(p, rpc.modelList, 30_000)
          .then(result => {
            const models: CodexModel[] = rpc.parseModels(result)
            if (models.length > 0) void update($, 'codexModels', () => models)
          })
          .catch(() => undefined)
      }
      return p
    }

    // a live process with a thread, starting or resuming one as needed; one start per agent at a time
    const starting = new Map<string, Promise<Proc>>()
    const ensureThread = (rec: AgentRecord): Promise<Proc> => {
      const live = procs.get(rec.id)
      if (live !== undefined && live.isAlive && (cache[rec.id] ?? rec).codex?.threadId !== undefined) return Promise.resolve(live)
      const pending = starting.get(rec.id)
      if (pending !== undefined) return pending
      const run = openThread(cache[rec.id] ?? rec).finally(() => starting.delete(rec.id))
      starting.set(rec.id, run)
      return run
    }

    const openThread = async (rec: AgentRecord): Promise<Proc> => {
      const old = procs.get(rec.id)
      if (old !== undefined && old.isAlive) old.stop?.()
      const p = await startProc(rec)
      const cwd = rec.codex?.cwd ?? (await $.session.cwd())
      const res = rec.codex?.threadId !== undefined
        ? await call(p, id => rpc.threadResume(id, { threadId: rec.codex!.threadId!, cwd, sandbox: opt.codexSandbox, model: rec.override?.model }))
        : await call(p, id => rpc.threadStart(id, { cwd, sandbox: opt.codexSandbox, model: rec.override?.model }))
      const t = rpc.threadOf(res)
      await mut(a =>
        patch(a, rec.id, r => ({
          ...r,
          model: t.model ?? r.model,
          effort: r.override?.effort ?? t.effort ?? r.effort,
          codex: r.codex === undefined ? r.codex : { ...r.codex, threadId: t.threadId, isAlive: true },
        })),
      )
      void saveHistory()
      return p
    }

    // starts a turn, applying any pending model/effort override; a cancel during
    // startup stops before the turn, or interrupts it as soon as it has an id
    // o.at: the conversation the request came from, when it began before this call
    const startTurn = async (id: string, text: string, signal?: AbortSignal, o?: { isFast?: boolean; at?: number }) => {
      const rec = cache[id]
      if (rec === undefined) throw new Error('No such Codex agent')
      const isFast = o?.isFast !== undefined ? o.isFast : opt.codexFast ? true : undefined
      // a function, so each check reads the signal and the epoch now, after the awaits before it;
      // a cancel or a /clear before the turn has an id ends the process, so nothing starts after all
      const at = o?.at ?? epoch
      const isStale = () => signal?.aborted === true || epoch !== at
      const staleError = () => new Error(epoch !== at ? CLEARED : CANCELLED)
      let p: Proc
      try {
        p = await ensureThread(rec)
      } catch (err) {
        if (isStale()) {
          procs.get(id)?.stop?.()
          throw staleError()
        }
        throw err
      }
      if (isStale()) {
        p.stop?.()
        throw staleError()
      }
      const fresh = cache[id] ?? rec
      const ov = fresh.override
      p.turnText = ''
      let waiter: (text: string) => void = () => undefined
      const done = new Promise<string>(resolve => p.waiters.push((waiter = resolve)))
      const threadId = fresh.codex!.threadId!
      let res: unknown
      try {
        res = await call(p, cid => rpc.turnStart(cid, { threadId, text, model: ov?.model, effort: ov?.effort, isFast }))
      } catch (err) {
        // no turn started: the next turn's end must not answer this caller
        p.waiters = p.waiters.filter(w => w !== waiter)
        // whether Codex started the turn is unknown: end it rather than leave it running unwatched
        if (isStale()) {
          p.stop?.()
          throw staleError()
        }
        throw err
      }
      p.turnId = rpc.turnIdOf(res) ?? p.turnId
      debug({ ev: 'codexTurnStart', id, model: ov?.model, effort: ov?.effort })
      if (isStale()) {
        const turnId = p.turnId ?? cache[id]?.codex?.turnId
        if (turnId !== undefined) void call(p, cid => rpc.turnInterrupt(cid, { threadId, turnId })).catch(() => p.stop?.())
        else p.stop?.()
      }
      await mut(a =>
        patch(a, id, r => ({
          ...r,
          model: ov?.model ?? r.model,
          effort: ov?.effort ?? r.effort,
          override: undefined,
          codex: r.codex === undefined ? r.codex : { ...r.codex, isFast },
        })),
      )
      return done
    }

    const informParentOfCodex = async (rec: AgentRecord, text: string, why: 'follow-up' | 'background') => {
      if (!opt.informParent && why === 'follow-up') return
      const head =
        why === 'follow-up'
          ? `[Overseer] Codex agent "${rec.name}" finished a follow-up the user sent it from the Overseer panel. Its reply:`
          : `[Overseer] Background Codex agent "${rec.name}" finished. Its reply:`
      await noteToParent($, `${head}\n${text}`)
    }

    const sendCodex = async (rec: AgentRecord, text: string, msgId: string) => {
      const p = procs.get(rec.id)
      try {
        if (p !== undefined && p.isAlive && rec.codex?.turnId !== undefined && rec.codex.threadId !== undefined) {
          await call(p, id => rpc.turnSteer(id, { threadId: rec.codex!.threadId!, turnId: rec.codex!.turnId!, text }))
          await mut(a => patch(a, rec.id, r => setMsgState(r, msgId, 'sent')))
          return
        }
        await mut(a => patch(a, rec.id, r => setMsgState({ ...r, status: 'running', endedAt: undefined, activity: 'Starting a new turn…' }, msgId, 'sent')))
        const at = epoch
        const reply = await startTurn(rec.id, text)
        if (epoch === at) await informParentOfCodex(rec, reply, 'follow-up')
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        await mut(a => patch(a, rec.id, r => withMsg(setMsgState(r, msgId, 'failed'), 'system', `Not delivered: ${reason}`)))
        toast(`Codex: ${reason}`)
      }
    }

    // a Codex agent in the pane, new or picking up an earlier thread
    const newCodex = async (plan: CodexPlan, parentId: string | undefined, earlier?: { name: string; threadId: string }) => {
      codexCounter++
      const rec = newRecord({
        id: newId('codex'),
        kind: 'codex',
        name: uniqueName(cache, earlier?.name || plan.input.name?.trim() || `codex-${codexCounter}`),
        type: 'codex',
        description: plan.prompt.slice(0, 80),
        parentId,
        spawnPrompt: plan.prompt,
        status: 'starting',
        codex: { sandbox: opt.codexSandbox, cwd: plan.cwd, isAlive: false, threadId: earlier?.threadId, isFast: plan.isFast },
      })
      const withOverride: AgentRecord = { ...rec, override: plan.model || plan.effort ? { model: plan.model, effort: plan.effort } : undefined, activity: 'Starting Codex…' }
      await spawned(withOverride)
      return withOverride
    }

    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const heldThread = (threadId: string) => Object.values(cache).find(a => a.kind === 'codex' && a.codex?.threadId === threadId)

    // what `resume` names: an exact id or thread id before any name, this session before History,
    // and any thread id Codex might still hold
    const resolveResume = async (key: string): Promise<{ live: AgentRecord } | { earlier: { name: string; threadId: string; cwd?: string } } | undefined> => {
      const byId = cache[key]?.kind === 'codex' ? cache[key] : heldThread(key)
      if (byId !== undefined) return { live: byId }
      const stored = (((await $.store.get('history').catch(() => undefined)) ?? []) as HistoryItem[])
        .filter(h => h.kind === 'codex' && h.threadId !== undefined)
        .sort((a, b) => b.startedAt - a.startedAt)
      const asEarlier = (h: HistoryItem) => ({ earlier: { name: h.name, threadId: h.threadId!, cwd: h.cwd } })
      const storedThread = stored.find(h => h.threadId === key)
      if (storedThread !== undefined) return asEarlier(storedThread)
      const lower = key.toLowerCase()
      const byName = Object.values(cache)
        .filter(a => a.kind === 'codex' && a.name.toLowerCase() === lower)
        .sort((a, b) => b.startedAt - a.startedAt)[0]
      if (byName !== undefined) return { live: byName }
      const storedName = stored.find(h => h.name.toLowerCase() === lower)
      if (storedName !== undefined) return asEarlier(storedName)
      return UUID.test(key) ? { earlier: { name: `codex-${key.slice(0, 8)}`, threadId: key } } : undefined
    }

    const planCodex = async (input: CodexToolInput): Promise<CodexPlan | string> => {
      const at = epoch
      const prompt = (input.prompt ?? '').trim()
      const base = {
        input,
        prompt,
        model: input.model?.trim() || undefined,
        effort: input.effort?.trim() || undefined,
        isFast: input.fast ?? (opt.codexFast ? true : undefined),
        at,
      }
      const asked = input.cwd?.trim() || undefined
      const key = input.resume?.trim() ?? ''
      if (key === '') {
        if (prompt === '') return 'Give Codex a task in prompt.'
        return { ...base, cwd: asked ?? (await $.session.cwd()), target: { kind: 'new' } }
      }
      if (prompt === '') return 'Give the follow-up message in prompt.'
      const found = await resolveResume(key)
      if (found === undefined) return `No Codex agent named "${key}". Start a new one without resume.`
      if ('live' in found) {
        const rec = found.live
        if (rec.codex?.turnId !== undefined || rec.status === 'starting') return `Codex agent "${rec.name}" is still working. Wait for it, or the user can steer it from the Overseer panel.`
        const cwd = rec.codex?.cwd ?? (await $.session.cwd())
        if (asked !== undefined && asked !== cwd) return `Codex agent "${rec.name}" works in ${cwd}. Leave cwd out to continue it there, or start a new agent for ${asked}.`
        return { ...base, cwd, target: { kind: 'live', id: rec.id } }
      }
      const e = found.earlier
      return { ...base, cwd: asked ?? e.cwd ?? (await $.session.cwd()), target: { kind: 'earlier', name: e.name, threadId: e.threadId } }
    }

    // earlier threads being taken up, so two calls never open one twice
    const adopting = new Set<string>()

    const codexTool = async (plan: CodexPlan, parentId: string | undefined, signal: AbortSignal | undefined): Promise<string> => {
      const { input, prompt, model, effort } = plan
      if (epoch !== plan.at) return CLEARED
      const busy = (name: string) => `Codex agent "${name}" is still working. Wait for it, or the user can steer it from the Overseer panel.`

      let rec: AgentRecord
      let target = plan.target
      // since the plan, this session may have taken the thread up itself
      if (target.kind === 'earlier') {
        const held = heldThread(target.threadId)
        if (held !== undefined) target = { kind: 'live', id: held.id }
      }
      if (target.kind === 'earlier') {
        const { threadId } = target
        if (adopting.has(threadId)) return `Codex thread ${threadId} is already starting here. Wait for it, then continue it by name.`
        adopting.add(threadId)
        try {
          rec = await newCodex(plan, parentId, target)
        } finally {
          adopting.delete(threadId)
        }
        await mut(a => patch(a, rec.id, r => withMsg(r, 'system', `Resumed Codex thread ${threadId} from an earlier session.`)))
      } else if (target.kind === 'live') {
        const found = cache[target.id]
        if (found === undefined) return `No Codex agent named "${input.resume}". Start a new one without resume.`
        if (found.codex?.turnId !== undefined || found.status === 'starting') return busy(found.name)
        rec = found
        await mut(a => patch(a, rec.id, r => withMsg({ ...r, status: 'running', endedAt: undefined, override: model || effort ? { model, effort } : r.override }, 'parent', prompt)))
      } else {
        rec = await newCodex(plan, parentId)
      }
      if (epoch !== plan.at) return CLEARED

      const run = startTurn(rec.id, prompt, input.background === true ? undefined : signal, { isFast: plan.isFast, at: plan.at })
      if (input.background === true) {
        const at = plan.at
        run
          .then(text => (epoch === at ? informParentOfCodex(cache[rec.id] ?? rec, text, 'background') : undefined))
          .catch(err => mut(a => patch(a, rec.id, r => ({ ...r, status: 'failed', endedAt: Date.now(), activity: '', error: err instanceof Error ? err.message : String(err) }))))
        return `Started Codex agent "${cache[rec.id]?.name ?? rec.name}" in the background. The user can watch and steer it in the Overseer panel; you'll get its reply as a note when it finishes. Continue it later with resume: "${cache[rec.id]?.name ?? rec.name}".`
      }

      // before the turn has an id, startTurn sees the signal itself
      const onAbort = () => {
        const cur = cache[rec.id]
        const p = procs.get(rec.id)
        const turnId = cur?.codex?.turnId ?? p?.turnId
        if (p !== undefined && cur?.codex?.threadId !== undefined && turnId !== undefined) {
          void call(p, id => rpc.turnInterrupt(id, { threadId: cur.codex!.threadId!, turnId })).catch(() => p.stop?.())
        }
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const reply = await run
        const cur = cache[rec.id] ?? rec
        return `${reply}\n\n[Codex agent "${cur.name}"${cur.codex?.threadId ? `, thread ${cur.codex.threadId}` : ''}. The user can watch and steer it in the Overseer panel. To continue this Codex session, call this tool again with resume: "${cur.name}".]`
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        const isCancelled = reason === CANCELLED || reason === CLEARED
        await mut(a => patch(a, rec.id, r => ({ ...r, status: isCancelled ? 'killed' : 'failed', endedAt: Date.now(), error: reason, activity: '' })))
        return isCancelled ? reason : `Codex failed: ${reason}`
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    }

    const endAll = async () => {
      for (const p of procs.values()) p.stop?.()
      await saveHistory()
    }

    const fence = () => {
      epoch++
    }

    const reset = async () => {
      heldNotes.length = 0
      liveBuf.clear()
      draftBuf.clear()
      savedHistory.clear()
      savedThreads.clear()
      overrideFailed.clear()
      firstOfKind.clear()
      hasAutoOpened = false
      codexCounter = 0
      await mut(() => ({}))
      reviewCache = []
      await Promise.all([
        update($, 'outbox', () => []),
        update($, 'reviews', () => []),
        update($, 'drafts', () => ({})),
        update($, 'ui', u => ({ isActiveOnly: u.isActiveOnly })),
      ]).catch(() => undefined)
      if (!hasState) {
        courierDir = await makeCourierDir($)
        if (courierDir !== '') await $.fs.write(`${courierDir}/outbox.json`, '[]').catch(() => undefined)
      }
      refreshStatus()
      $.ui.invalidate('ui.render')
    }

    // ───────────────────────────── pane actions ─────────────────────────────

    const validateClaudeModel = async (id: string, model: string) => {
      if (!isKnownClaudeModel(model)) return
      const bad = await read($, 'badModels')
      if (bad.includes(model)) return
      try {
        const res = await $.model.complete({ model, prompt: 'Reply with OK.', timeoutMs: 20_000 })
        if (!res.isAnswered && res.reason === 'api-error' && (res.status === 404 || res.status === 400)) {
          await update($, 'badModels', l => [...l, model])
          await mut(a => patch(a, id, r => withMsg({ ...r, override: r.override?.model === model ? { ...r.override, model: undefined } : r.override }, 'system', `${model} isn't available here; override removed.`)))
          toast(`${model} isn't available on this account.`)
        }
      } catch {
        // can't tell; the step-level recovery still guards it
      }
    }

    const requestStop = async (id: string) => {
      const rec = cache[id]
      if (rec === undefined) return
      if (rec.kind === 'codex') return actions.stopTurn(id)
      await mut(a => patch(a, id, r => ({ ...r, isStopping: true, isPaused: false, activity: 'Stopping after the current step…' })))
    }

    const actions: PaneActions = {
      select: id => void setUi(u => ({ ...u, selected: u.selected === id ? undefined : id, isPromptOpen: false })),
      open: id => void setUi(u => (u.selected === id ? u : { ...u, selected: id, isPromptOpen: false })),
      close: id => void setUi(u => (u.selected === id ? { ...u, selected: undefined, isPromptOpen: false } : u)),
      togglePrompt: () => void setUi(u => ({ ...u, isPromptOpen: u.isPromptOpen !== true })),
      openTranscript: id => void setUi(u => ({ ...u, transcriptFor: id, transcriptCount: 25, isPromptOpen: false })),
      closeTranscript: () => void setUi(u => ({ ...u, transcriptFor: undefined, transcriptCount: undefined })),
      loadEarlier: () => void setUi(u => ({ ...u, transcriptCount: (u.transcriptCount ?? 25) + 25 })),
      toggleActiveOnly: () => void setUi(u => ({ ...u, isActiveOnly: u.isActiveOnly !== true })),
      toggleBroadcast: () => void setUi(u => ({ ...u, isBroadcastOpen: u.isBroadcastOpen !== true })),
      toggleHistory: () =>
        void (async () => {
          const ui = await read($, 'ui')
          if (ui.isHistoryOpen === true) return setUi(u => ({ ...u, isHistoryOpen: false }))
          await saveHistory()
          const cutoff = Date.now() - opt.historyDays * 86_400_000
          const history = (((await $.store.get('history')) ?? []) as HistoryItem[]).filter(
            item => (item.endedAt ?? item.startedAt) >= cutoff && !Object.values(cache).some(a => a.startedAt === item.startedAt && a.name === item.name),
          )
          await setUi(u => ({ ...u, isHistoryOpen: true, history }))
        })(),
      clearDone: () =>
        void (async () => {
          await saveHistory()
          await mut(a => Object.fromEntries(Object.entries(a).filter(([, r]) => isActive(r.status) || (r.kind === 'codex' && r.codex?.isAlive === true))))
          for (const id of [...savedHistory]) if (cache[id] === undefined) savedHistory.delete(id)
          await setUi(u => (u.selected !== undefined && cache[u.selected] === undefined ? { ...u, selected: undefined } : u))
        })(),
      setModel: (id, value) =>
        void (async () => {
          const picked = value === '__auto__' ? undefined : resolveModel(value)
          const model = picked === cache[id]?.model ? undefined : picked
          await mut(a => patch(a, id, r => ({ ...r, override: { ...r.override, model } })))
          overrideFailed.delete(id)
          const rec = cache[id]
          if (model !== undefined && rec?.kind === 'claude') void validateClaudeModel(id, model)
        })(),
      setEffort: (id, value) =>
        void mut(a => patch(a, id, r => ({ ...r, override: { ...r.override, effort: value === '__auto__' || value === r.effort ? undefined : value } }))),
      send: (id, text) => void send(id, text),
      draft: (id, text) => draft(id, text),
      broadcast: text =>
        void (async () => {
          const targets = Object.values(cache).filter(a => isActive(a.status))
          for (const t of targets) await send(t.id, text)
          toast(targets.length === 0 ? 'No agent is running.' : `Sent to ${targets.length} agent${targets.length === 1 ? '' : 's'}.`)
          await setUi(u => ({ ...u, isBroadcastOpen: false }))
        })(),
      pause: id => void mut(a => patch(a, id, r => ({ ...r, isPaused: true, activity: 'Pausing before its next request…' }))),
      resume: id => void mut(a => patch(a, id, r => ({ ...r, isPaused: false, status: r.status === 'paused' ? 'running' : r.status, activity: 'Resuming…' }))),
      applyNow: id =>
        void (async () => {
          const rec = cache[id]
          const p = procs.get(id)
          if (rec?.kind !== 'codex' || p === undefined || rec.codex?.turnId === undefined || rec.codex.threadId === undefined) return
          // whoever waits on this turn (a foreground tool call) waits on the continued one instead
          const waiters = p.waiters.splice(0)
          const release = (text: string) => waiters.forEach(w => w(text))
          try {
            p.chainFrom = rec.codex.turnId
            await call(p, cid => rpc.turnInterrupt(cid, { threadId: rec.codex!.threadId!, turnId: rec.codex!.turnId! }))
          } catch (err) {
            p.chainFrom = undefined
            p.waiters.push(...waiters)
            toast(`Codex: ${err instanceof Error ? err.message : String(err)}`)
            return
          }
          startTurn(id, 'Continue the task where you left off.')
            .then(release)
            .catch(err => release(`(Codex could not continue: ${err instanceof Error ? err.message : String(err)})`))
        })(),
      stopTurn: id =>
        void (async () => {
          const rec = cache[id]
          const p = procs.get(id)
          if (p === undefined || rec?.codex?.turnId === undefined || rec.codex.threadId === undefined) return
          await call(p, cid => rpc.turnInterrupt(cid, { threadId: rec.codex!.threadId!, turnId: rec.codex!.turnId! })).catch(err =>
            toast(`Codex: ${err instanceof Error ? err.message : String(err)}`),
          )
        })(),
      stop: id => void requestStop(id),
      endCodex: id => {
        procs.get(id)?.stop?.()
      },
      copyId: id =>
        void (async () => {
          const rec = cache[id]
          const text = rec?.kind === 'codex' && rec.codex?.threadId !== undefined ? rec.codex.threadId : id
          const res = await $.ui.copy({ text })
          toast(res.isCopied ? `Copied ${text}` : `Couldn't copy (${res.reason}). ID: ${text}`)
        })(),
      review: (id, decision) => void setReviews(l => l.map(r => (r.id === id ? { ...r, decision } : r))),
      editReview: id => void setUi(u => ({ ...u, editingReview: id })),
      submitReview: (id, text) =>
        void (async () => {
          await setReviews(l => l.map(r => (r.id === id ? { ...r, editedPrompt: text, decision: 'approve' } : r)))
          await setUi(u => ({ ...u, editingReview: undefined }))
        })(),
      enable: () =>
        void (async () => {
          isEnabled = true
          await update($, 'settings', s => ({ ...s, isEnabled: true }))
          refreshStatus()
        })(),
    }

    const runRule = async (rule: DebugRule, id: string) => {
      debug({ ev: 'rule', op: rule.op, value: rule.value, id })
      if (rule.op === 'model') await mut(a => patch(a, id, r => ({ ...r, override: { ...r.override, model: rule.value } })))
      else if (rule.op === 'effort') await mut(a => patch(a, id, r => ({ ...r, override: { ...r.override, effort: rule.value } })))
      else if (rule.op === 'clear') await mut(a => patch(a, id, r => ({ ...r, override: undefined })))
      else if (rule.op === 'send') await send(id, rule.value ?? '')
      else if (rule.op === 'applyNow') actions.applyNow(id)
      else if (rule.op === 'stopTurn') actions.stopTurn(id)
      else if (rule.op === 'stop') await requestStop(id)
      else if (rule.op === 'pause') {
        await mut(a => patch(a, id, r => ({ ...r, isPaused: true })))
        $.clock.after(rule.ms ?? 3000, () => void mut(a => patch(a, id, r => ({ ...r, isPaused: false }))))
      }
    }

    const debugAt = async (at: 'step' | 'complete' | 'tool', id: string, index: number) => {
      const kind = cache[id]?.kind
      if (debugRules.length === 0 || kind === undefined) return
      if (!firstOfKind.has(kind)) firstOfKind.set(kind, id)
      if (firstOfKind.get(kind) !== id) return
      for (const rule of debugRules) {
        if (rule.isDone === true || rule.at !== at || (rule.kind ?? 'claude') !== kind || (at === 'step' && rule.index !== index)) continue
        rule.isDone = true
        if (rule.delayMs !== undefined) $.clock.after(rule.delayMs, () => void runRule(rule, id))
        else await runRule(rule, id)
      }
    }

    ctl = { mut, setUi, spawned, ensure, live, send, sawCourierSend, sawModelSend, revive, planCodex, codexTool, saveHistory, endAll, fence, reset, actions, debug, debugAt }

    // ───────────────────────────── timers ─────────────────────────────

    // streaming activity lands in one batched write, at most ~3 a second, and only when it changed
    $.clock.every(350, () => {
      if (liveBuf.size === 0) return
      const batch = [...liveBuf.entries()].filter(([id, activity]) => cache[id] !== undefined && cache[id].activity !== activity)
      liveBuf.clear()
      if (batch.length === 0) return
      void mut(a => {
        let nx = a
        for (const [id, activity] of batch) nx = patch(nx, id, r => (isActive(r.status) && !r.isPaused ? { ...r, activity } : r))
        return nx
      })
    })

    // elapsed clocks, review countdowns, and the courier watchdog
    $.clock.every(1000, () => {
      if (!isEnabled) return
      const hasRunning = Object.values(cache).some(a => isActive(a.status))
      if (reviewCache.length > 0 || (hasRunning && needsTicks)) $.ui.invalidate('ui.render')
      void (async () => {
        const box = await read($, 'outbox')
        // the courier records what it picked up: those are in flight (waking a stopped agent
        // can take a while), not lost. Only what it never picked up, or a minute of silence, fails.
        const { sent, heartbeat } = await courierReceipts($)
        const picked = new Set(sent)
        const isCourierAlive = Date.now() - heartbeat < 6000
        // grace while everything starts up, then say so in the pane (written only when it changes)
        const isMissing = !isCourierAlive && Date.now() - loadedAt > 10_000
        if (isMissing !== wasCourierMissing) {
          wasCourierMissing = isMissing
          await update($, 'isCourierMissing', () => isMissing).catch(() => undefined)
        }
        const now = await $.clock.now()
        // a running courier gets a minute for anything; a silent one fails what it never picked up after 8 s
        const stale = box.filter(i => {
          const age = now - i.at
          return picked.has(i.id) || isCourierAlive ? age > 60_000 : age > 8000
        })
        if (stale.length === 0) return
        const isCourierMissing = !isCourierAlive && stale.some(i => !picked.has(i.id))
        await update($, 'outbox', list => list.filter(i => !stale.some(s => s.id === i.id)))
        await mut(a => {
          let nx = a
          for (const s of stale)
            nx = patch(nx, s.to, r =>
              withMsg(
                setMsgState(r, s.id, 'failed'),
                'system',
                isCourierAlive || picked.has(s.id) ? 'Not confirmed: no receipt after a minute.' : `Not delivered: the ${COURIER} plugin isn't running. Install it: ${COURIER_INSTALL}`,
              ),
            )
          return nx
        })
        if (isCourierMissing && !hasToldCourier) {
          hasToldCourier = true
          toast(`Messages need the ${COURIER} plugin: ${COURIER_INSTALL}`)
        }
      })().catch(() => undefined)
    })

    // after a reload, Codex processes are gone: say so instead of pretending
    const orphaned = Object.values(cache).filter(a => a.kind === 'codex' && (a.codex?.isAlive === true || isActive(a.status)))
    if (orphaned.length > 0) {
      await mut(a => {
        let nx = a
        for (const o of orphaned)
          nx = patch(nx, o.id, r => ({
            ...r,
            status: isActive(r.status) ? 'killed' : r.status,
            activity: '',
            codex: r.codex === undefined ? r.codex : { ...r.codex, isAlive: false, turnId: undefined },
            error: isActive(r.status) ? 'Overseer reloaded and its Codex process ended. Message it to continue the thread.' : r.error,
          }))
        return nx
      })
    }

    await $.command.register({
      name: 'overseer',
      description: 'Open or close the Agents pane (on, off, clear, history)',
      argumentHint: '[on|off|clear|history]',
      immediate: true,
    })
    await $.tool.register({
      name: 'codex',
      description:
        'Run OpenAI Codex as a subagent the user can watch and steer live in the Overseer pane. Use this, never a raw `codex exec` shell command, whenever you delegate work to Codex. Returns Codex\'s final reply. Pass resume with an earlier Codex agent\'s name to continue that same Codex thread.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The task for Codex, or the follow-up message when resuming.' },
          name: { type: 'string', description: 'A short name for this Codex agent, shown in the pane.' },
          model: { type: 'string', description: 'Codex model id. Leave out for Codex\'s default.' },
          effort: { type: 'string', description: 'Reasoning effort: low, medium, high, xhigh. Leave out for the default.' },
          cwd: { type: 'string', description: 'Working directory. Defaults to the session\'s.' },
          resume: { type: 'string', description: 'Name (or thread id) of an earlier Codex agent to continue.' },
          background: { type: 'boolean', description: 'Return at once and let Codex work in the background.' },
          fast: { type: 'boolean', description: 'Run on Codex\'s fast tier (about 1.5-2x speed, uses more of the plan). Leave out for the user\'s setting; false for standard speed.' },
        },
        required: ['prompt'],
      },
    })

    refreshStatus()
    $.ui.invalidate('ui.render')
    return started
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') ctl?.fence()
    await ctl?.endAll()
    const dir = courierDir
    courierDir = ''
    await outboxWrites
    if (dir !== '') await $.process.run(['rm', '-rf', dir]).catch(() => undefined)
    const res = await next(e)
    // a /clear goes on in this process under a new session id, with no session.start
    if (e.reason === 'clear') await ctl?.reset().catch(() => undefined)
    return res
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    permissionMode = e.permission_mode
    return next(e)
  }).catch(($, e, next) => next(e))

  // where the build has no $.session.append, notes for Claude go with the next prompt
  on('prompt.submit', async ($, e, next) => {
    if (heldNotes.length === 0 || e.command !== undefined || e.isMeta === true) return next(e)
    return next({ ...e, text: `${heldNotes.splice(0).join('\n\n')}\n\n${e.text}` })
  }).catch(($, e, next) => next(e))

  // ───────────────────────────── subagents ─────────────────────────────

  on('agent.spawn', async ($, e, next) => {
    if (!isEnabled || ctl === undefined || e.workflow !== undefined) return next(e)
    let input = e

    if (opt.spawnReview && e.isTeammate !== true) {
      const review: Review = {
        id: e.tool_use_id !== '' ? e.tool_use_id : newId('rv'),
        prompt: e.prompt,
        type: e.subagentType,
        description: e.description,
        deadline: Date.now() + opt.spawnReviewTimeoutSec * 1000,
      }
      reviewCache = await update($, 'reviews', l => [...l, review])
      await $.ui.open({ id: PANE, title: 'Agents' }).catch(() => undefined)
      $.ui.toast(`Review the new ${e.subagentType} subagent in the Agents pane`)
      let decided: Review | undefined
      // 2.1.280 hands a hook no next.signal
      // /overseer off lets a held spawn go, as if approved
      while (isEnabled && next.signal?.aborted !== true) {
        decided = reviewCache.find(r => r.id === review.id)
        if (decided?.decision !== undefined || Date.now() > review.deadline) break
        await $.process.run(['sleep', '0.3'])
      }
      reviewCache = await update($, 'reviews', l => l.filter(r => r.id !== review.id))
      if (decided?.decision === 'deny') return { deny: 'The user declined to start this subagent from the Overseer panel. Ask them how to proceed.' }
      if (decided?.editedPrompt !== undefined && decided.editedPrompt.trim() !== '') input = { ...e, prompt: decided.editedPrompt }
    }

    const res = await next(input)
    if (res.agentId !== undefined) {
      try {
        await ctl.spawned(
          newRecord({
            id: res.agentId,
            kind: 'claude',
            name: e.name ?? e.description,
            type: e.subagentType,
            description: e.description,
            parentId: e.parentAgentId,
            spawnPrompt: input.prompt,
            model: res.model,
          }),
        )
      } catch {
        // bookkeeping never blocks a spawn
      }
    }
    return res
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    if (!isEnabled || id === undefined || ctl === undefined) return yield* next(e)

    try {
      await ctl.ensure(id)
      await ctl.debugAt('step', id, e.index)
      if (cache[id]?.isPaused === true) {
        await ctl.mut(a => patch(a, id, r => ({ ...r, status: 'paused', activity: 'Paused before its next request' })))
        while (isEnabled && cache[id]?.isPaused === true && cache[id]?.isStopping !== true && next.signal?.aborted !== true) await $.process.run(['sleep', '0.4'])
      }
    } catch {
      // a failed pause never blocks the agent
    }

    // Stop: answer this request ourselves with an end of turn, so the agent finishes here
    if (cache[id]?.isStopping === true) {
      void ctl.mut(a => patch(a, id, r => withMsg({ ...r, isStopping: false, activity: '' }, 'system', 'Stopped from Overseer.')))
      ctl.debug({ ev: 'stopped', id, index: e.index })
      return { turnId: e.turnId, index: e.index, answer: 'Stopped by the user from Overseer.', toolUses: [], stopReason: 'end_turn', usage: null }
    }

    const ov = cache[id]?.override
    let req = e
    if (ov?.model !== undefined && ov.model !== e.model) req = { ...req, model: ov.model }
    if (ov?.effort !== undefined && ov.effort !== e.effort) req = { ...req, effort: ov.effort as typeof e.effort }
    const isOverridden = req !== e
    ctl.debug({ ev: 'stepStart', id, index: e.index, model: req.model, effort: req.effort, engineModel: e.model, engineEffort: e.effort })

    void ctl.mut(a => patch(a, id, r => stepStarted(r, req.model, req.effort === undefined ? undefined : String(req.effort))))

    let text = ''
    const stream = next(req)
    const it = stream[Symbol.asyncIterator]()
    const res = yield* (async function* () {
      for (;;) {
        const step = await it.next()
        if (step.done === true) return step.value
        const c = step.value as { kind?: string; text?: string; name?: string }
        if (c.kind === 'text' && typeof c.text === 'string') {
          text += c.text
          ctl?.live(id, `✎ ${text.replace(/\s+/g, ' ').slice(-160)}`)
        } else if (c.kind === 'tool' && typeof c.name === 'string') ctl?.live(id, `${c.name}…`)
        else if (c.kind === 'thinking') ctl?.live(id, 'Thinking…')
        yield step.value
      }
    })()

    try {
      const hasFailed = res.stopReason === null
      ctl.debug({ ev: 'stepEnd', id, index: e.index, usageModel: res.usage?.model, stop: res.stopReason })
      if (hasFailed && isOverridden) overrideFailed.add(id)
      void ctl.mut(a =>
        patch(a, id, r =>
          stepEnded(r, {
            usage: res.usage as StepUsage | null,
            toolLines: res.toolUses.map(u => toolLine(u.name, u.input)),
            text: res.answer,
            hasFailed,
          }),
        ),
      )
    } catch {
      // bookkeeping only
    }
    return res
  })

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    const id = e.agentId
    if (!isEnabled || id === undefined || ctl === undefined || cache[id] === undefined || cache[id].kind !== 'claude') return res
    try {
      await ctl.mut(a => patch(a, id, r => completed(r, e.reason, e.answer)))
      ctl.debug({ ev: 'complete', id, reason: e.reason })
      await ctl.debugAt('complete', id, 0)
      if (overrideFailed.has(id) && e.reason === 'error') {
        overrideFailed.delete(id)
        if (opt.autoRevive) await ctl.revive(id)
        else await ctl.mut(a => patch(a, id, r => withMsg({ ...r, override: undefined }, 'system', 'The model override failed a request and was removed.')))
      }
      void ctl.saveHistory()
    } catch {
      // bookkeeping only
    }
    return res
  })

  // ───────────────────────────── messages ─────────────────────────────

  on('session.send', async ($, e, next) => {
    const res = await next(e)
    if (!isEnabled || ctl === undefined) return res
    try {
      if (e.origin.kind === 'plugin' && e.origin.name === COURIER) await ctl.sawCourierSend(e.to, e.text, res.isDelivered, res.reason)
      else if (e.origin.kind === 'model' && res.isDelivered) await ctl.sawModelSend(e.to, e.text, e.agentId)
    } catch {
      // bookkeeping only
    }
    return res
  }).catch(($, e, next) => next(e))

  // ───────────────────────────── tools ─────────────────────────────

  // This hook answers the call itself, so the engine's permission step (beneath `next`)
  // never runs: ask for the session's verdict here, and put an `ask` to the person.
  on('tool.call', { tool: CODEX_TOOL }, async ($, e, next) => {
    if (ctl === undefined) return { result: 'Overseer is still starting; try again in a moment.' }
    if (!isEnabled) return { result: 'Overseer is off for this session, so its Codex tool is unavailable. The user can turn it back on with /overseer on.' }
    const raw = e as unknown as CodexToolInput
    const input: CodexToolInput = { prompt: raw.prompt, name: raw.name, model: raw.model, effort: raw.effort, cwd: raw.cwd, resume: raw.resume, background: raw.background, fast: raw.fast }
    // the folder Codex would really run in is what the permission check sees
    const plan = await ctl.planCodex(input)
    if (typeof plan === 'string') return { result: plan }
    const refusal = await codexPermission($, { ...input, cwd: plan.cwd }, opt.codexSandbox).catch(
      (err: unknown) => `Overseer could not check permission for Codex: ${err instanceof Error ? err.message : String(err)}`,
    )
    if (refusal !== undefined) return { deny: refusal }
    const text = await holdWhile($, ctl.codexTool(plan, e.agentId, next.signal), next.signal)
    return { result: text }
  }).catch(($, e, next) => ({ result: `Overseer's Codex tool failed: ${next.error?.message ?? 'unknown error'}` }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (isEnabled && opt.redirectCodexBash && rpc.isRawCodexExec(String(e.command ?? ''))) {
      return {
        deny: `Overseer: run Codex through the ${CODEX_TOOL} tool instead of a raw \`codex exec\`, so the user can watch and steer it. Pass the task as prompt.`,
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // ───────────────────────────── the pane ─────────────────────────────

  on('command.run', { command: 'overseer' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off' || arg === 'on') {
      isEnabled = arg === 'on'
      await update($, 'settings', s => ({ ...s, isEnabled }))
      // a paused agent goes on when Overseer turns off, and a held spawn starts as approved;
      // neither is held again if Overseer turns back on before its wait loop looks
      if (!isEnabled) {
        reviewCache = await update($, 'reviews', l => l.map(r => ({ ...r, decision: r.decision ?? 'approve' }))).catch(() => reviewCache.map(r => ({ ...r, decision: r.decision ?? ('approve' as const) })))
        await ctl?.mut(a => {
          let nx = a
          for (const r of Object.values(a)) if (r.isPaused === true) nx = patch(nx, r.id, x => ({ ...x, isPaused: false, status: x.status === 'paused' ? 'running' : x.status, activity: '' }))
          return nx
        })
      }
      $.ui.status(isEnabled ? undefined : 'off')
      return { text: isEnabled ? 'Overseer is on.' : 'Overseer is off for this session: every hook passes straight through. /overseer on turns it back on.' }
    }
    if (arg === 'clear') {
      ctl?.actions.clearDone()
      return { text: 'Cleared finished agents from the pane.' }
    }
    if (arg === 'history') {
      const isOpen = (await read($, 'ui')).isHistoryOpen === true
      if (!isOpen) ctl?.actions.toggleHistory()
      const shown = await $.ui.open({ id: PANE, title: 'Agents' })
      if (shown.isPlaced) await update($, 'paneOpen', () => true)
      return { text: 'Showing agent history.' }
    }
    const panes = await $.ui.panes()
    const pane = panes.find(p => p.id === PANE)
    if (pane !== undefined && pane.isPlaced && arg === '') {
      await $.ui.close({ id: PANE })
      return { text: 'Agents pane closed. /overseer opens it again.' }
    }
    isPaneDismissed = false
    const opened = await $.ui.open({ id: PANE, title: 'Agents' })
    if (opened.isPlaced) await update($, 'paneOpen', () => true)
    return { text: opened.isPlaced ? 'Agents pane open.' : 'The Agents pane is waiting for room: widen the window.' }
  })

  on('ui.close', async ($, e, next) => {
    const res = await next(e)
    if (e.id === PANE) {
      if (e.origin.kind === 'person') isPaneDismissed = true
      await update($, 'paneOpen', () => false).catch(() => undefined)
    }
    return res
  })

  // while the pane is closed, one line above the prompt keeps the agents a click away
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!isEnabled || e.props.hasSurvey === true) return next(e)
    const [agents, isOpen] = await Promise.all([read($, 'agents'), read($, 'paneOpen')])
    const all = Object.values(agents)
    if (isOpen || all.length === 0) return next(e)
    const running = all.filter(a => isActive(a.status)).length
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" gap={1}>
        <Text>
          <Text color="claude" bold>{`● ${running}`}</Text>
          <Text dimColor>{` running · `}</Text>
          <Text color="success" bold>{`✓ ${all.length - running}`}</Text>
          <Text dimColor>{` finished`}</Text>
        </Text>
        <Button
          key="open-agents"
          label="Open Agents"
          onPress={async () => {
            isPaneDismissed = false
            const opened = await $.ui.open({ id: PANE, title: 'Agents' })
            if (opened.isPlaced) await update($, 'paneOpen', () => true)
          }}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const [agents, ui, reviews, codexModels, badModels, settings, drafts, isCourierMissing] = await Promise.all([
      read($, 'agents'),
      read($, 'ui'),
      read($, 'reviews'),
      read($, 'codexModels'),
      read($, 'badModels'),
      read($, 'settings'),
      read($, 'drafts'),
      read($, 'isCourierMissing'),
    ])
    // the open card, if it still exists
    const selected = ui.selected !== undefined && agents[ui.selected] !== undefined ? ui.selected : undefined
    const noop = () => undefined
    const fallback: PaneActions = {
      select: noop, open: noop, close: noop, openTranscript: noop, closeTranscript: noop, loadEarlier: noop, togglePrompt: noop, toggleActiveOnly: noop, toggleBroadcast: noop, toggleHistory: noop, clearDone: noop,
      setModel: noop, setEffort: noop, send: noop, draft: noop, broadcast: noop, pause: noop, resume: noop, applyNow: noop, stopTurn: noop, stop: noop,
      endCodex: noop, copyId: noop, review: noop, editReview: noop, submitReview: noop, enable: noop,
    }
    const hasClient = e.surface === 'terminal' || e.surface === 'desktop'
    if (!hasClient) needsTicks = true
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { Client } = $.ui.resolve(e) as unknown as { Client?: any }
    const clock =
      hasClient && Client !== undefined
        ? (key: string, from: number, to?: number, color?: string) => (
            // client props are plain JSON: leave unset values out
            <Client key={key} module="./elapsed.tsx" props={{ from, ...(to !== undefined ? { to } : {}), ...(color !== undefined ? { color } : {}) }} />
          )
        : undefined
    return renderPane(
      el as unknown as Parameters<typeof renderPane>[0],
      {
        clock,
        drafts,
        isCourierMissing,
        agents,
        ui: { ...ui, selected },
        reviews,
        codexModels,
        badModels,
        isEnabled: settings.isEnabled !== false,
        now: Date.now(),
        columns: e.props.bodyColumns,
        surface: e.surface,
        // only 2.1.280 lacks $.state, and it also draws a Button from its label alone
        isPlainButtons: hasState === false,
      },
      ctl?.actions ?? fallback,
    ) as ReturnType<typeof renderPane> as never
  })
}

