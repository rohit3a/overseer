import type { AgentRecord, AgentStatus, HistoryItem, Msg, MsgBy, MsgState } from '../types'

export type Agents = Record<string, AgentRecord>

const THREAD_CAP = 160
// engine plumbing, not the agent's work
const HIDDEN_TOOLS = /^(SubagentHandback|SyntheticOutput)\b/
const TEXT_CAP = 12_000

let counter = 0

export const newId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`

export const isActive = (status: AgentStatus) =>
  status === 'starting' || status === 'review' || status === 'running' || status === 'paused'

export const isEnded = (status: AgentStatus) =>
  status === 'completed' || status === 'failed' || status === 'killed' || status === 'idle'

const clip = (text: string) =>
  text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}\n… (${text.length - TEXT_CAP} more characters)` : text

export const newRecord = (fields: {
  id: string
  kind: AgentRecord['kind']
  name: string
  type: string
  description: string
  parentId?: string
  spawnPrompt: string
  status?: AgentStatus
  model?: string
  codex?: AgentRecord['codex']
}): AgentRecord => ({
  id: fields.id,
  kind: fields.kind,
  name: fields.name,
  type: fields.type,
  description: fields.description,
  parentId: fields.parentId,
  status: fields.status ?? 'running',
  startedAt: Date.now(),
  spawnPrompt: fields.spawnPrompt,
  model: fields.model,
  steps: 0,
  tokensIn: 0,
  tokensOut: 0,
  activity: '',
  thread: [{ id: newId('m'), at: Date.now(), by: 'parent', text: clip(fields.spawnPrompt) }],
  codex: fields.codex,
})

export const patch = (agents: Agents, id: string, change: (rec: AgentRecord) => AgentRecord): Agents => {
  const rec = agents[id]
  if (rec === undefined) return agents
  return { ...agents, [id]: change(rec) }
}

export const withMsg = (rec: AgentRecord, by: MsgBy, text: string, state?: MsgState, id = newId('m')): AgentRecord => {
  const msg: Msg = { id, at: Date.now(), by, text: clip(text), state }
  const thread = [...rec.thread, msg]
  if (thread.length <= THREAD_CAP) return { ...rec, thread }
  // keep the spawn prompt first, and never drop a message of yours still in flight
  const isKept = (m: Msg) => m.by === 'user' && (m.state === 'queued' || m.state === 'sent')
  const head = thread[0]!
  const kept: Msg[] = []
  let room = THREAD_CAP - 1
  for (let i = thread.length - 1; i >= 1; i--) {
    const m = thread[i]!
    if (room > 0 || isKept(m)) {
      kept.push(m)
      room--
    }
  }
  return { ...rec, thread: [head, ...kept.reverse()] }
}

export const setMsgState = (rec: AgentRecord, msgId: string, state: MsgState): AgentRecord => ({
  ...rec,
  thread: rec.thread.map(m => (m.id === msgId ? { ...m, state } : m)),
})

// marks every user message still in flight as read: the agent has taken a step since
export const markRead = (rec: AgentRecord): AgentRecord =>
  rec.thread.some(m => m.by === 'user' && m.state === 'sent')
    ? { ...rec, thread: rec.thread.map(m => (m.by === 'user' && m.state === 'sent' ? { ...m, state: 'read' } : m)) }
    : rec

export const stepStarted = (rec: AgentRecord, model: string, effort: string | undefined): AgentRecord => {
  const wasEnded = isEnded(rec.status) || rec.status === 'starting'
  return markRead({
    ...rec,
    status: rec.isPaused ? 'paused' : 'running',
    endedAt: wasEnded ? undefined : rec.endedAt,
    model,
    effort,
    activity: rec.isPaused ? 'Paused before its next request' : 'Thinking…',
    error: undefined,
  })
}

export type StepUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; model?: string }

export const stepEnded = (
  rec: AgentRecord,
  step: { usage: StepUsage | null; toolLines: string[]; text: string; hasFailed: boolean },
): AgentRecord => {
  let out: AgentRecord = {
    ...rec,
    steps: rec.steps + 1,
    tokensIn: rec.tokensIn + (step.usage?.input_tokens ?? 0) + (step.usage?.cache_read_input_tokens ?? 0),
    tokensOut: rec.tokensOut + (step.usage?.output_tokens ?? 0),
    model: step.usage?.model ?? rec.model,
    activity: step.toolLines.filter(l => !HIDDEN_TOOLS.test(l)).at(-1) ?? (step.hasFailed ? 'Request failed' : ''),
  }
  if (step.text.trim() !== '' && step.toolLines.length > 0) out = withMsg(out, 'agent', step.text.trim())
  for (const line of step.toolLines) if (!HIDDEN_TOOLS.test(line)) out = withMsg(out, 'tool', line)
  return out
}

export const completed = (rec: AgentRecord, reason: string, answer: string): AgentRecord => {
  const status: AgentStatus = reason === 'answer' ? 'completed' : reason === 'aborted' ? 'killed' : 'failed'
  const base: AgentRecord = {
    ...rec,
    status,
    isPaused: false,
    isStopping: false,
    endedAt: Date.now(),
    activity: '',
    error: status === 'failed' ? `Ended with ${reason}` : undefined,
  }
  return answer.trim() === '' ? base : withMsg(base, 'agent', answer.trim())
}

export const toHistory = (rec: AgentRecord): HistoryItem => ({
  name: rec.name,
  type: rec.type,
  kind: rec.kind,
  model: rec.model,
  status: rec.status,
  startedAt: rec.startedAt,
  endedAt: rec.endedAt,
  answer: (rec.status === 'completed' ? ([...rec.thread].reverse().find(m => m.by === 'agent')?.text ?? '') : (rec.error ?? `Ended: ${rec.status}`)).slice(0, 600),
})

// finds an agent by id first, then by name, newest first
export const findAgent = (agents: Agents, key: string): AgentRecord | undefined => {
  if (agents[key] !== undefined) return agents[key]
  const lower = key.toLowerCase()
  return Object.values(agents)
    .filter(a => a.name.toLowerCase() === lower || a.codex?.threadId === key)
    .sort((a, b) => b.startedAt - a.startedAt)[0]
}

export const uniqueName = (agents: Agents, base: string) => {
  const taken = new Set(Object.values(agents).map(a => a.name))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

// one line per tool call, for the thread and the activity line
export const toolLine = (name: string, input: unknown): string => {
  const args = (input ?? {}) as Record<string, unknown>
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof args[k] === 'string' && args[k] !== '') return args[k] as string
    return ''
  }
  const short = name.startsWith('mcp__') ? name.split('__').slice(1).join(':') : name
  const detail = pick('command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill')
  const oneLine = detail.replace(/\s+/g, ' ').trim()
  return oneLine === '' ? short : `${short}: ${oneLine.length > 140 ? `${oneLine.slice(0, 139)}…` : oneLine}`
}

// ordered for the list: parents before children, newest roots first
export const ordered = (agents: Agents, isActiveOnly: boolean): { rec: AgentRecord; depth: number }[] => {
  const all = Object.values(agents)
  const visible = isActiveOnly ? all.filter(a => isActive(a.status)) : all
  const ids = new Set(visible.map(a => a.id))
  const children = new Map<string, AgentRecord[]>()
  const roots: AgentRecord[] = []
  for (const a of visible) {
    if (a.parentId !== undefined && ids.has(a.parentId)) {
      const list = children.get(a.parentId) ?? []
      list.push(a)
      children.set(a.parentId, list)
    } else roots.push(a)
  }
  const out: { rec: AgentRecord; depth: number }[] = []
  const walk = (a: AgentRecord, depth: number) => {
    out.push({ rec: a, depth })
    for (const c of (children.get(a.id) ?? []).sort((x, y) => x.startedAt - y.startedAt)) walk(c, depth + 1)
  }
  const rank = (a: AgentRecord) => (isActive(a.status) ? 1 : 0)
  for (const r of roots.sort((x, y) => rank(y) - rank(x) || y.startedAt - x.startedAt)) walk(r, 0)
  return out
}
