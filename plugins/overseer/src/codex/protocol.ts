import type { CodexModel } from '../../types'

// JSON-RPC requests for `codex app-server` (protocol v2)

export type Rpc = { jsonrpc: '2.0'; id?: number; method: string; params?: unknown }

const req = (id: number, method: string, params: unknown): Rpc => ({ jsonrpc: '2.0', id, method, params })

// high-volume notifications Overseer never reads: Codex doesn't send them at all
export const QUIET_METHODS = [
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'command/exec/outputDelta',
  'process/outputDelta',
  'item/reasoning/textDelta',
  'item/plan/delta',
  'turn/diff/updated',
  'remoteControl/status/changed',
  'account/updated',
]

export const VERSION = '0.4.0'

export const initialize = (id: number): Rpc =>
  req(id, 'initialize', {
    clientInfo: { name: 'overseer', title: 'Overseer', version: VERSION },
    // experimentalApi: turn/settings/update changes a running turn's model and effort in place
    capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: QUIET_METHODS },
  })

export const initialized = (): Rpc => ({ jsonrpc: '2.0', method: 'initialized' })

export const threadStart = (id: number, o: { cwd: string; sandbox: string; model?: string }): Rpc =>
  req(id, 'thread/start', { cwd: o.cwd, sandbox: o.sandbox, approvalPolicy: 'never', model: o.model ?? null })

export const threadResume = (id: number, o: { threadId: string; cwd: string; sandbox: string; model?: string }): Rpc =>
  req(id, 'thread/resume', {
    threadId: o.threadId,
    cwd: o.cwd,
    sandbox: o.sandbox,
    approvalPolicy: 'never',
    model: o.model ?? null,
    // the pane keeps its own history: don't send the whole thread back
    excludeTurns: true,
  })

const textInput = (text: string) => [{ type: 'text', text, text_elements: [] }]

// isFast: true asks for the model's fast tier (its id from model/list, `priority` today),
// false for standard speed, this turn only; undefined keeps the thread's tier (the user's Codex config)
export const turnStart = (id: number, o: { threadId: string; text: string; model?: string; effort?: string; isFast?: boolean; fastTier?: string }): Rpc =>
  req(id, 'turn/start', {
    threadId: o.threadId,
    input: textInput(o.text),
    model: o.model ?? null,
    effort: o.effort ?? null,
    serviceTierForTurn: o.isFast === undefined ? null : o.isFast ? (o.fastTier ?? 'priority') : 'default',
    // a short summary of its reasoning streams as it thinks: the pane shows it live
    summary: 'concise',
  })

export const turnSteer = (id: number, o: { threadId: string; turnId: string; text: string }): Rpc =>
  req(id, 'turn/steer', { threadId: o.threadId, expectedTurnId: o.turnId, input: textInput(o.text) })

export const turnInterrupt = (id: number, o: { threadId: string; turnId: string }): Rpc =>
  req(id, 'turn/interrupt', { threadId: o.threadId, turnId: o.turnId })

// changes the running turn's model and effort without stopping it; `applied` or `targetUnavailable`
export const turnSettingsUpdate = (id: number, o: { threadId: string; turnId: string; model?: string; effort?: string }): Rpc =>
  req(id, 'turn/settings/update', { threadId: o.threadId, turnId: o.turnId, model: o.model ?? null, effort: o.effort ?? null })

export const isApplied = (result: unknown) => str(obj(result).status) === 'applied'

// the thread stops streaming here; once no client holds it, the app-server unloads it
export const threadUnsubscribe = (id: number, o: { threadId: string }): Rpc => req(id, 'thread/unsubscribe', { threadId: o.threadId })

export const modelList = (id: number): Rpc => req(id, 'model/list', {})

// what one line from app-server means for the agent's record
// threadId: the thread a notification is about, when it names one (a Codex sub-agent's differ)
export type CodexEvent = { threadId?: string } & (
  | { kind: 'response'; id: number; result?: unknown; error?: string }
  | { kind: 'serverRequest'; id: number | string; method: string }
  | { kind: 'turnStarted'; turnId: string }
  | { kind: 'turnCompleted'; turnId: string; status: string; error?: string }
  | { kind: 'delta'; text: string; itemId: string }
  | { kind: 'thinking'; text: string; itemId: string }
  | { kind: 'activity'; text: string }
  | { kind: 'message'; text: string; isFinal: boolean }
  | { kind: 'tool'; text: string }
  | { kind: 'usage'; input: number; output: number }
  | { kind: 'model'; model: string }
  | { kind: 'error'; text: string; willRetry: boolean }
  | { kind: 'ignore' }
)

// the answer a server request gets: a typed decline where Codex defines one, else an error
export const declineFor = (method: string): { result: unknown } | undefined => {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { result: { decision: 'decline' } }
    // the v1 approvals, still in the schema
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { result: { decision: { denied: { rejection: 'Overseer runs Codex without approvals.' } } } }
    case 'mcpServer/elicitation/request':
      return { result: { action: 'decline', content: null, _meta: null } }
    case 'item/tool/requestUserInput':
      return { result: { answers: {} } }
    case 'item/permissions/requestApproval':
      return { result: { permissions: {}, scope: 'turn' } }
    default:
      return undefined
  }
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v !== null && typeof v === 'object' ? (v as Obj) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)

const oneLine = (s: string, max = 140) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

// `/bin/zsh -lc 'echo A'` → `echo A`
export const unwrapShell = (command: string) => {
  const m = /^\S*(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command.trim())
  return m?.[2] ?? command
}

// a finished item that did not succeed
const failedMark = (item: Obj) => {
  const status = str(item.status)
  return status === 'failed' || status === 'declined' || item.success === false || (item.error !== undefined && item.error !== null) ? '  (failed)' : ''
}

const itemLine = (item: Obj, isDone: boolean): { kind: 'tool' | 'activity'; text: string } | undefined => {
  const line = baseLine(item, isDone)
  return line !== undefined && isDone && line.kind === 'tool' && !line.text.includes('(exit ') ? { ...line, text: line.text + failedMark(item) } : line
}

const baseLine = (item: Obj, isDone: boolean): { kind: 'tool' | 'activity'; text: string } | undefined => {
  switch (str(item.type)) {
    case 'commandExecution': {
      const cmd = oneLine(unwrapShell(str(item.command)))
      if (!isDone) return { kind: 'activity', text: `$ ${cmd}` }
      const code = item.exitCode
      return { kind: 'tool', text: `$ ${cmd}${typeof code === 'number' && code !== 0 ? `  (exit ${code})` : ''}` }
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes.map(c => str(obj(c).path)).filter(p => p !== '') : []
      const text = `Edit: ${oneLine(changes.join(', ') || 'files')}`
      return isDone ? { kind: 'tool', text } : { kind: 'activity', text }
    }
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const text = `${str(item.server) || str(item.namespace) || 'tool'}:${str(item.tool)}`
      return isDone ? { kind: 'tool', text } : { kind: 'activity', text }
    }
    case 'webSearch': {
      const action = obj(item.action)
      const queries = Array.isArray(action.queries) ? action.queries.map(str).filter(q => q !== '') : []
      const what = str(item.query) || str(action.query) || queries.join(' · ') || str(action.url)
      const text = what === '' ? 'Searching the web…' : `Search: ${oneLine(what)}`
      return isDone ? (what === '' ? undefined : { kind: 'tool', text }) : { kind: 'activity', text }
    }
    case 'contextCompaction':
      return isDone ? { kind: 'tool', text: 'Compacted its context' } : { kind: 'activity', text: 'Compacting its context…' }
    case 'reasoning':
      return isDone ? undefined : { kind: 'activity', text: 'Thinking…' }
    case 'plan':
      return isDone ? { kind: 'tool', text: `Plan: ${oneLine(str(item.text))}` } : undefined
    case 'subAgentActivity':
    case 'collabAgentToolCall':
      return isDone ? undefined : { kind: 'activity', text: 'Delegating to a Codex sub-agent…' }
    default:
      return undefined
  }
}

export const parseLine = (line: string): CodexEvent => {
  let m: Obj
  try {
    m = obj(JSON.parse(line))
  } catch {
    return { kind: 'ignore' }
  }
  // a request from the server (an approval, an elicitation): it waits for an answer
  if ((typeof m.id === 'number' || typeof m.id === 'string') && typeof m.method === 'string') {
    const threadId = str(obj(m.params).threadId) || undefined
    return { kind: 'serverRequest', id: m.id, method: m.method, ...(threadId === undefined ? {} : { threadId }) }
  }
  if (typeof m.id === 'number' && m.method === undefined) {
    const err = obj(m.error)
    return { kind: 'response', id: m.id, result: m.result, error: m.error === undefined ? undefined : str(err.message) || 'error' }
  }
  const p = obj(m.params)
  const threadId = str(p.threadId) || undefined
  const ev = parseNotification(str(m.method), p)
  return threadId === undefined || ev.kind === 'ignore' ? ev : { ...ev, threadId }
}

const parseNotification = (method: string, p: Obj): CodexEvent => {
  switch (method) {
    case 'turn/started':
      return { kind: 'turnStarted', turnId: str(obj(p.turn).id) }
    case 'turn/completed': {
      const turn = obj(p.turn)
      const err = obj(turn.error)
      return { kind: 'turnCompleted', turnId: str(turn.id), status: str(turn.status), error: str(err.message) || undefined }
    }
    case 'item/agentMessage/delta':
      return { kind: 'delta', text: str(p.delta), itemId: str(p.itemId) }
    case 'item/reasoning/summaryTextDelta':
      // each summary part of a reasoning item streams on its own
      return { kind: 'thinking', text: str(p.delta), itemId: `${str(p.itemId)}:${typeof p.summaryIndex === 'number' ? p.summaryIndex : 0}` }
    case 'turn/plan/updated': {
      const plan = Array.isArray(p.plan) ? p.plan.map(s => obj(s)) : []
      const done = plan.filter(s => s.status === 'completed').length
      const now = plan.find(s => s.status === 'inProgress') ?? plan.find(s => s.status === 'pending')
      return plan.length === 0 ? { kind: 'ignore' } : { kind: 'activity', text: `Plan ${done}/${plan.length}${now !== undefined ? `: ${oneLine(str(now.step), 100)}` : ''}` }
    }
    case 'item/started': {
      const line = itemLine(obj(p.item), false)
      return line === undefined ? { kind: 'ignore' } : line
    }
    case 'item/completed': {
      const item = obj(p.item)
      if (str(item.type) === 'agentMessage') return { kind: 'message', text: str(item.text), isFinal: item.phase === 'final_answer' }
      const line = itemLine(item, true)
      return line === undefined ? { kind: 'ignore' } : line
    }
    case 'thread/tokenUsage/updated': {
      const total = obj(obj(p.tokenUsage).total)
      return { kind: 'usage', input: num(total.inputTokens), output: num(total.outputTokens) }
    }
    case 'model/rerouted':
      return { kind: 'model', model: str(p.toModel) }
    case 'error': {
      const err = obj(p.error)
      return { kind: 'error', text: str(err.message) || 'Codex reported an error', willRetry: p.willRetry === true }
    }
    default:
      return { kind: 'ignore' }
  }
}

export const parseModels = (result: unknown): CodexModel[] => {
  const data = obj(result).data
  if (!Array.isArray(data)) return []
  return data
    .map(raw => obj(raw))
    .filter(m => m.hidden !== true && str(m.id) !== '')
    .map(m => ({
      id: str(m.id),
      label: str(m.displayName) || str(m.id),
      // the tier Codex calls Fast for this model, if it has one
      fastTier: (Array.isArray(m.serviceTiers) ? m.serviceTiers.map(t => obj(t)) : []).map(t => str(t.id)).find(id => id !== '' && id !== 'default'),
      efforts: Array.isArray(m.supportedReasoningEfforts)
        ? m.supportedReasoningEfforts.map(e => str(obj(e).reasoningEffort)).filter(e => e !== '')
        : [],
      isDefault: m.isDefault === true,
    }))
}

// thread/start and thread/resume answer { thread: { id }, model, reasoningEffort }
export const threadOf = (result: unknown) => {
  const r = obj(result)
  return { threadId: str(obj(r.thread).id), model: str(r.model) || undefined, effort: str(r.reasoningEffort) || undefined }
}

// turn/start answers { turn: { id } }
export const turnIdOf = (result: unknown) => str(obj(obj(result).turn).id) || undefined

// raw `codex exec …` in a shell command, for the refusal
// codex in command position (start of a line, or after ; & | ( ` $( ), optionally
// after env assignments and launchers (env, npx, bunx, exec, command, nohup, time,
// sudo) with their flags, with any flags before the subcommand: `codex exec`,
// `/path/to/codex exec`, `codex -m x exec`, `npx codex e`, `env FOO=1 codex exec`.
// Quoted or echoed text (`echo "codex exec"`, `grep 'codex exec'`) does not count.
const RAW_CODEX = /(?:^|[;&|(`\n]|\$\()\s*(?:\w+=\S*\s+)*(?:(?:env|npx|bunx|pnpx|exec|command|nohup|time|sudo)(?:\s+-{1,2}[\w-]+)*\s+(?:\w+=\S*\s+)*)*(?:\S*\/)?codex(?:\s+-{1,2}[\w-]+(?:[= ](?!exec\b|e\b)[^\s-]\S*)?)*\s+(?:exec|e)(?:\s|$)/m

// quoted text is an argument, never a command: `printf 'a; codex exec'` stays allowed
const blankQuotes = (command: string) => command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '""')

// a whole `sh -c '…'` is unwrapped first, so the command inside its quotes still counts
export const isRawCodexExec = (command: string) => RAW_CODEX.test(blankQuotes(unwrapShell(command)))
