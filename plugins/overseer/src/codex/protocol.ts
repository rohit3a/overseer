import type { CodexModel } from '../../types'

// JSON-RPC requests for `codex app-server` (protocol v2)

export type Rpc = { jsonrpc: '2.0'; id?: number; method: string; params?: unknown }

const req = (id: number, method: string, params: unknown): Rpc => ({ jsonrpc: '2.0', id, method, params })

export const initialize = (id: number): Rpc =>
  req(id, 'initialize', { clientInfo: { name: 'overseer', title: 'Overseer', version: '0.1.0' } })

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
  })

const textInput = (text: string) => [{ type: 'text', text, text_elements: [] }]

// isFast: true asks for Codex's fast tier, false for standard speed, this turn only;
// undefined keeps the thread's tier (the user's Codex config)
export const turnStart = (id: number, o: { threadId: string; text: string; model?: string; effort?: string; isFast?: boolean }): Rpc =>
  req(id, 'turn/start', {
    threadId: o.threadId,
    input: textInput(o.text),
    model: o.model ?? null,
    effort: o.effort ?? null,
    serviceTierForTurn: o.isFast === undefined ? null : o.isFast ? 'fast' : 'default',
  })

export const turnSteer = (id: number, o: { threadId: string; turnId: string; text: string }): Rpc =>
  req(id, 'turn/steer', { threadId: o.threadId, expectedTurnId: o.turnId, input: textInput(o.text) })

export const turnInterrupt = (id: number, o: { threadId: string; turnId: string }): Rpc =>
  req(id, 'turn/interrupt', { threadId: o.threadId, turnId: o.turnId })

export const modelList = (id: number): Rpc => req(id, 'model/list', {})

// what one line from app-server means for the agent's record
export type CodexEvent =
  | { kind: 'response'; id: number; result?: unknown; error?: string }
  | { kind: 'serverRequest'; id: number | string; method: string }
  | { kind: 'turnStarted'; turnId: string }
  | { kind: 'turnCompleted'; turnId: string; status: string; error?: string }
  | { kind: 'delta'; text: string }
  | { kind: 'activity'; text: string }
  | { kind: 'message'; text: string }
  | { kind: 'tool'; text: string }
  | { kind: 'usage'; input: number; output: number }
  | { kind: 'model'; model: string }
  | { kind: 'error'; text: string; willRetry: boolean }
  | { kind: 'ignore' }

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
  return m === null ? command : m[2]
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
      const text = `Search: ${oneLine(str(item.query))}`
      return isDone ? { kind: 'tool', text } : { kind: 'activity', text }
    }
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
  if ((typeof m.id === 'number' || typeof m.id === 'string') && typeof m.method === 'string') return { kind: 'serverRequest', id: m.id, method: m.method }
  if (typeof m.id === 'number' && m.method === undefined) {
    const err = obj(m.error)
    return { kind: 'response', id: m.id, result: m.result, error: m.error === undefined ? undefined : str(err.message) || 'error' }
  }
  const p = obj(m.params)
  switch (m.method) {
    case 'turn/started':
      return { kind: 'turnStarted', turnId: str(obj(p.turn).id) }
    case 'turn/completed': {
      const turn = obj(p.turn)
      const err = obj(turn.error)
      return { kind: 'turnCompleted', turnId: str(turn.id), status: str(turn.status), error: str(err.message) || undefined }
    }
    case 'item/agentMessage/delta':
      return { kind: 'delta', text: str(p.delta) }
    case 'item/started': {
      const line = itemLine(obj(p.item), false)
      return line === undefined ? { kind: 'ignore' } : line
    }
    case 'item/completed': {
      const item = obj(p.item)
      if (str(item.type) === 'agentMessage') return { kind: 'message', text: str(item.text) }
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
