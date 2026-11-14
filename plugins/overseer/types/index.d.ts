export type AgentKind = 'claude' | 'codex'

export type AgentStatus =
  | 'starting'
  | 'review'
  | 'running'
  | 'paused'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'killed'

export type MsgBy = 'parent' | 'user' | 'agent' | 'tool' | 'system'

export type MsgState = 'queued' | 'sent' | 'read' | 'failed'

export type Msg = {
  id: string
  at: number
  by: MsgBy
  text: string
  state?: MsgState
}

export type Override = {
  model?: string
  effort?: string
}

export type CodexInfo = {
  threadId?: string
  turnId?: string
  path?: string
  version?: string
  sandbox: string
  cwd: string
  isAlive: boolean
  efforts?: string[]
  // the speed tier asked for: true fast, false standard, undefined Codex's own default
  isFast?: boolean
}

export type AgentRecord = {
  id: string
  kind: AgentKind
  name: string
  type: string
  description: string
  parentId?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  spawnPrompt: string
  model?: string
  effort?: string
  override?: Override
  isPaused?: boolean
  // set by Stop: the next request is answered with an end instead of being sent
  isStopping?: boolean
  // how many messages the person has sent it: a new one clears the message box
  sent?: number
  steps: number
  tokensIn: number
  tokensOut: number
  activity: string
  thread: Msg[]
  error?: string
  codex?: CodexInfo
}

export type OutboxItem = {
  id: string
  to: string
  text: string
  at: number
}

export type Review = {
  id: string
  prompt: string
  type: string
  description: string
  deadline: number
  decision?: 'approve' | 'deny'
  editedPrompt?: string
}

export type HistoryItem = {
  name: string
  type: string
  kind: AgentKind
  model?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  answer: string
  // a Codex agent's thread, so a later session can resume it
  threadId?: string
  cwd?: string
}

export type CodexModel = {
  id: string
  label: string
  efforts: string[]
  isDefault: boolean
  // the id of the model's fast service tier, where it has one
  fastTier?: string
}

export type UiState = {
  selected?: string
  isPromptOpen?: boolean
  transcriptFor?: string
  transcriptCount?: number
  isActiveOnly?: boolean
  isBroadcastOpen?: boolean
  isHistoryOpen?: boolean
  editingReview?: string
  history?: HistoryItem[]
}

export type Settings = {
  isEnabled: boolean
  // the person closed the Agents pane this session: new agents don't open it again
  isPaneDismissed?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    overseer: {
      agents: Record<string, AgentRecord>
      outbox: OutboxItem[]
      reviews: Review[]
      ui: UiState
      settings: Settings
      codexModels: CodexModel[]
      badModels: string[]
      paneOpen: boolean
      drafts: Record<string, string>
      // the courier's heartbeat stopped (or never started): messaging can't work
      isCourierMissing: boolean
      // streaming activity by agent, for panes that can't ask for their own line (VS Code, mobile)
      streaming: Record<string, string>
    }
    // owned by overseer-courier; repeated here (same shape) so Overseer type-checks without it
    'overseer-courier': {
      sent: string[]
      heartbeat: number
    }
  }
}
