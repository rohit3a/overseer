import type { AgentRecord, CodexModel, Msg, Review, UiState } from '../../types'
import { CLAUDE_MODELS, EFFORTS, modelLabel } from '../models'
import { isActive, ordered, type Agents } from '../registry'
import { STATUS, ago, elapsed, firstLines, tokens, truncate } from '../format'

// the element table of whichever surface draws; mobile has no Input/Select
type Els = Record<string, (props: Record<string, unknown>, ...children: unknown[]) => unknown>

export type PaneActions = {
  select: (id: string) => void
  open: (id: string) => void
  close: (id: string) => void
  openTranscript: (id: string) => void
  closeTranscript: () => void
  loadEarlier: () => void
  togglePrompt: () => void
  toggleActiveOnly: () => void
  toggleBroadcast: () => void
  toggleHistory: () => void
  clearDone: () => void
  setModel: (id: string, value: string) => void
  setEffort: (id: string, value: string) => void
  send: (id: string, text: string) => void
  draft: (id: string, text: string) => void
  broadcast: (text: string) => void
  pause: (id: string) => void
  resume: (id: string) => void
  applyNow: (id: string) => void
  stopTurn: (id: string) => void
  stop: (id: string) => void
  endCodex: (id: string) => void
  copyId: (id: string) => void
  review: (id: string, decision: 'approve' | 'deny') => void
  editReview: (id: string) => void
  submitReview: (id: string, text: string) => void
  enable: () => void
}

export type PaneData = {
  // what the person is typing to each agent, for the wrapped preview
  drafts: Record<string, string>
  isCourierMissing?: boolean
  // a self-ticking elapsed label where the surface runs client modules
  clock?: (key: string, from: number, to?: number, color?: string) => unknown
  agents: Agents
  ui: UiState
  reviews: Review[]
  codexModels: CodexModel[]
  badModels: string[]
  isEnabled: boolean
  now: number
  columns: number
  surface: string
  // the build draws a Button from its label alone (2.1.280), not from styled children
  isPlainButtons?: boolean
}

const AUTO = '__auto__'

const roleColor: Record<Msg['by'], string> = {
  parent: 'text',
  user: 'suggestion',
  agent: 'text',
  tool: 'subtle',
  system: 'warning',
}

const stateChip: Record<string, { text: string; color: string }> = {
  queued: { text: 'queued', color: 'subtle' },
  sent: { text: 'delivered', color: 'suggestion' },
  read: { text: 'read', color: 'success' },
  failed: { text: 'not delivered', color: 'error' },
}

export const renderPane = (el: Els, d: PaneData, act: PaneActions) => {
  const { Box, Text, Button } = el as Record<string, any>
  // mobile draws no fields: its table answers Input/Select with an empty box
  const hasFields = d.surface !== 'mobile' && typeof el.Input === 'function' && typeof el.Select === 'function'
  const width = Math.max(24, d.columns)

  if (!d.isEnabled) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="warning">Overseer is off for this session. Every hook passes straight through.</Text>
        <Button key="enable" variant="primary" onPress={act.enable}>Turn Overseer on</Button>
      </Box>
    )
  }

  const all = Object.values(d.agents)
  const running = all.filter(a => isActive(a.status)).length
  const done = all.length - running

  return (
    <Box flexDirection="column" gap={1}>
      {header(el, d, act, running, done, width, hasFields)}
      {d.isCourierMissing === true && Object.values(d.agents).some(a => a.kind === 'claude') && (
        <Box key="courier-missing" flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
          <Text color="warning" bold>Messages to Claude subagents need overseer-courier</Text>
          <Text dimColor>Install it in a terminal, then run /reload-plugins:</Text>
          <Text>claude plugin install overseer-courier@overseer</Text>
        </Box>
      )}
      {d.ui.isBroadcastOpen === true && hasFields && broadcastBox(el, act, running)}
      {d.reviews.map(r => reviewCard(el, d, act, r, width, hasFields))}
      {d.ui.transcriptFor !== undefined && d.agents[d.ui.transcriptFor] !== undefined
        ? transcriptView(el, d, act, d.agents[d.ui.transcriptFor]!, width, hasFields)
        : d.ui.isHistoryOpen === true
          ? historyList(el, d, width)
          : agentList(el, d, act, width, hasFields)}
    </Box>
  )
}

const header = (el: Els, d: PaneData, act: PaneActions, running: number, done: number, width: number, hasFields: boolean) => {
  const { Box, Text, Button } = el as Record<string, any>
  const reviews = d.reviews.length
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap">
        <Text>
          <Text color="suggestion" bold>● {running}</Text>
          <Text dimColor> running  </Text>
          <Text color="success" bold>✓ {done}</Text>
          <Text dimColor> finished</Text>
          {reviews > 0 && <Text color="warning" bold>{`  ◆ ${reviews}`}</Text>}
          {reviews > 0 && <Text dimColor> to review</Text>}
        </Text>
      </Box>
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Button key="filter" plain dimColor onPress={act.toggleActiveOnly}>
          {d.ui.isActiveOnly === true ? 'Show all' : 'Active only'}
        </Button>
        {hasFields && width >= 40 && <Text dimColor>·</Text>}
        {hasFields && (
          <Button key="broadcast" plain dimColor onPress={act.toggleBroadcast}>
            {d.ui.isBroadcastOpen === true ? 'Close broadcast' : 'Broadcast'}
          </Button>
        )}
        {width >= 40 && <Text dimColor>·</Text>}
        <Button key="history" plain dimColor onPress={act.toggleHistory}>
          {d.ui.isHistoryOpen === true ? 'Back to agents' : 'History'}
        </Button>
        {done > 0 && width >= 40 && <Text dimColor>·</Text>}
        {done > 0 && (
          <Button key="clear" plain dimColor onPress={act.clearDone}>
            Clear finished
          </Button>
        )}
      </Box>
    </Box>
  )
}

const broadcastBox = (el: Els, act: PaneActions, running: number) => {
  const { Box, Input, Text } = el as Record<string, any>
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
      <Text dimColor>{running === 0 ? 'No agent is running right now.' : running === 1 ? 'Message the 1 running agent' : `Message all ${running} running agents`}</Text>
      {running > 0 && <Input key="broadcast-input" placeholder="Message every running agent…" submitLabel="send all" onSubmit={(text: string) => act.broadcast(text)} />}
    </Box>
  )
}

const reviewCard = (el: Els, d: PaneData, act: PaneActions, r: Review, width: number, hasFields: boolean) => {
  const { Box, Text, Button, Input } = el as Record<string, any>
  const left = Math.max(0, Math.ceil((r.deadline - d.now) / 1000))
  const isEditing = d.ui.editingReview === r.id && hasFields
  return (
    <Box key={`review-${r.id}`} flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
      <Text>
        <Text color="warning" bold>{`◆ New ${r.type} subagent`}</Text>
        <Text dimColor>{`  · auto-approves in ${left}s`}</Text>
      </Text>
      <Text dimColor>{truncate(r.description, width - 4)}</Text>
      {isEditing ? (
        <Input key={`review-edit-${r.id}`} value={r.editedPrompt ?? r.prompt} submitLabel="approve edited" autoFocus onSubmit={(text: string) => act.submitReview(r.id, text)} />
      ) : (
        <Text>{firstLines(r.editedPrompt ?? r.prompt, 8)}</Text>
      )}
      {isEditing ? (
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Text dimColor>Enter approves the edited prompt.</Text>
          <Button key={`review-cancel-${r.id}`} onPress={() => act.editReview('')}>Cancel edit</Button>
        </Box>
      ) : (
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key={`review-ok-${r.id}`} variant="primary" onPress={() => act.review(r.id, 'approve')}>Approve</Button>
          {hasFields && <Button key={`review-edit-btn-${r.id}`} onPress={() => act.editReview(r.id)}>Edit</Button>}
          <Button key={`review-deny-${r.id}`} onPress={() => act.review(r.id, 'deny')}>Deny</Button>
        </Box>
      )}
    </Box>
  )
}

const agentList = (el: Els, d: PaneData, act: PaneActions, width: number, hasFields: boolean) => {
  const { Box, Text } = el as Record<string, any>
  const rows = ordered(d.agents, d.ui.isActiveOnly === true)
  if (rows.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{d.ui.isActiveOnly === true ? 'Nothing is running right now.' : 'No subagents yet.'}</Text>
        <Text dimColor>They show up here the moment Claude starts one. Ask Claude to use Codex and it shows up here too.</Text>
      </Box>
    )
  }
  return <Box flexDirection="column" gap={1}>{rows.map(({ rec, depth }) => card(el, d, act, rec, depth, width, hasFields))}</Box>
}

const since = (el: Els, d: PaneData, key: string, from: number, to?: number) => {
  const { Text } = el as Record<string, any>
  return d.clock !== undefined ? d.clock(key, from, to) : <Text dimColor>{elapsed(from, to ?? d.now)}</Text>
}

const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

// one agent: a summary that is always there, and its controls and thread when open
const card = (el: Els, d: PaneData, act: PaneActions, rec: AgentRecord, depth: number, width: number, hasFields: boolean) => {
  const { Box, Text, Button } = el as Record<string, any>
  const s = STATUS[rec.status]
  const isOpen = d.ui.selected === rec.id
  const isLive = isActive(rec.status)
  const inner = Math.max(16, width - 4 - depth * 2)
  const kind = rec.kind === 'codex' ? 'Codex' : rec.type
  const total = rec.tokensIn + rec.tokensOut
  const usage = [
    modelLabel(rec.model),
    rec.effort,
    total > 0 ? `${tokens(total)} tokens` : undefined,
    rec.steps > 0 ? `${rec.steps} ${rec.kind === 'codex' ? (rec.steps === 1 ? 'turn' : 'turns') : rec.steps === 1 ? 'step' : 'steps'}` : undefined,
  ]
    .filter((x): x is string => x !== undefined && x !== '—')
    .join(' · ')
  // running cards stand out: a solid blue border; finished ones stay quiet grey
  const border = isOpen || isLive ? 'suggestion' : 'subtle'

  // the summary's lines; while closed every one of them opens the card
  const room = Math.max(10, inner - 12)
  const lines: { key: string; text: string; parts: unknown[] }[] = [
    { key: 'row', text: rec.name, parts: [<Text bold>{truncate(rec.name, room)}</Text>] },
    { key: 'status', text: kind, parts: [<Text dimColor>{truncate(kind, room)}</Text>] },
  ]
  if (usage !== '' && !isOpen) lines.push({ key: 'usage', text: usage, parts: [<Text dimColor>{truncate(usage, room)}</Text>] })
  if (isLive && rec.activity !== '') {
    const activity = `▸ ${rec.activity.replace(/^▸\s*/, '')}`
    lines.push({ key: 'activity', text: activity, parts: [<Text color={rec.isPaused || rec.isStopping ? 'warning' : 'suggestion'}>{truncate(activity, room)}</Text>] })
  }
  if (!isLive && rec.error !== undefined) lines.push({ key: 'error', text: rec.error, parts: [<Text color="error">{truncate(rec.error, room)}</Text>] })

  // one press target per line where a pointer clicks; the terminal keeps one tab stop per card.
  // A borderless button is only as wide as its text, so where a pointer clicks each line is
  // padded with no-break spaces past the card's edge (clipped) to make the whole width clickable.
  const isPointer = d.surface !== 'terminal'
  // fill what the line leaves of the left column, short of overflowing (which would draw "…")
  const pad = (text: string) => (isPointer ? <Text>{'\u00a0'.repeat(Math.max(0, Math.floor((room - Math.min(text.length, room)) * 1.2)))}</Text> : null)
  const summary = lines.map((line, i) =>
    !isOpen && (i === 0 || isPointer) ? (
      d.isPlainButtons === true ? (
        <Button key={`${line.key === 'row' ? 'row' : `${line.key}-line`}-${rec.id}`} plain dimColor={line.key !== 'row'} label={truncate(line.text, room)} onPress={() => act.open(rec.id)} />
      ) : (
        <Button key={`${line.key === 'row' ? 'row' : `${line.key}-line`}-${rec.id}`} plain onPress={() => act.open(rec.id)}>
          {line.parts}
          {pad(line.text)}
        </Button>
      )
    ) : (
      <Text key={`${line.key}-${rec.id}`}>{line.parts}</Text>
    ),
  )

  return (
    <Box
      key={`card-${rec.id}`}
      flexDirection="column"
      borderStyle="round"
      borderColor={border}
      borderDimColor={!isOpen && !isLive}
      paddingX={1}
      marginLeft={depth * 2}
      gap={isOpen ? 1 : 0}
    >
      <Box flexDirection="row" justifyContent="space-between" alignItems="flex-start">
        <Box flexDirection="column" flexShrink={1} flexGrow={1} overflow="hidden">
          {summary}
        </Box>
        <Box flexDirection="column" alignItems="flex-end" flexShrink={0}>
          {isOpen ? (
            <Button key={`toggle-${rec.id}`} label="▲ Close" onPress={() => act.close(rec.id)} />
          ) : (
            <Button key={`toggle-${rec.id}`} label="▼" dimColor onPress={() => act.open(rec.id)} />
          )}
          <Text key={`state-${rec.id}`} color={s.color} bold={isLive}>{`${s.glyph} ${cap(s.label)}`}</Text>
          {since(el, d, `clock-${rec.id}`, rec.startedAt, rec.endedAt)}
        </Box>
      </Box>
      {isOpen && body(el, d, act, rec, inner, hasFields)}
    </Box>
  )
}

const historyList = (el: Els, d: PaneData, width: number) => {
  const { Box, Text } = el as Record<string, any>
  const items = d.ui.history ?? []
  if (items.length === 0) return <Text dimColor>No finished agents from earlier sessions yet.</Text>
  return (
    <Box flexDirection="column">
      <Text dimColor>Finished agents from earlier sessions (read only)</Text>
      {items.length > 60 && <Text dimColor>{`Showing the newest 60 of ${items.length}.`}</Text>}
      {items.slice(0, 60).map((item, i) => {
        const s = STATUS[item.status]
        return (
          <Box key={`hist-${i}`} flexDirection="column">
            <Text>
              <Text color={s.color}>{s.glyph} </Text>
              <Text bold>{truncate(item.name, Math.max(10, width - 4))}</Text>
            </Text>
            <Text dimColor>{`  ${truncate(`${item.kind === 'codex' ? 'codex · ' : ''}${modelLabel(item.model)} · ${ago(item.endedAt ?? item.startedAt, d.now)}`, width - 2)}`}</Text>
            {item.answer !== '' && <Text dimColor wrap="truncate-end">{`   ${truncate(item.answer, width - 4)}`}</Text>}
          </Box>
        )
      })}
    </Box>
  )
}

const modelOptions = (rec: AgentRecord, d: PaneData) => {
  const list =
    rec.kind === 'codex'
      ? d.codexModels.map(m => ({ value: m.id, label: m.label }))
      : CLAUDE_MODELS.filter(m => !d.badModels.includes(m.id)).map(m => ({ value: m.id, label: m.label }))
  if (rec.model !== undefined && !list.some(o => o.value === rec.model)) list.unshift({ value: rec.model, label: modelLabel(rec.model) })
  if (rec.model === undefined) list.unshift({ value: AUTO, label: 'Default' })
  return list.map(o => (o.value === rec.model ? { ...o, label: `${o.label} · now` } : o))
}

const effortOptions = (rec: AgentRecord, d: PaneData) => {
  let efforts: readonly string[] = EFFORTS
  if (rec.kind === 'codex') {
    const model = d.codexModels.find(m => m.id === (rec.override?.model ?? rec.model))
    efforts = model?.efforts.length ? model.efforts : rec.codex?.efforts?.length ? rec.codex.efforts : ['low', 'medium', 'high', 'xhigh']
  }
  const list = efforts.map(e => ({ value: e, label: e }))
  if (rec.effort !== undefined && !list.some(o => o.value === rec.effort)) list.unshift({ value: rec.effort, label: rec.effort })
  if (rec.effort === undefined) list.unshift({ value: AUTO, label: 'Default' })
  return list.map(o => (o.value === rec.effort ? { ...o, label: `${o.label} · now` } : o))
}

const RECENT = 3

// keeps line breaks, unlike truncate
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

const body = (el: Els, d: PaneData, act: PaneActions, rec: AgentRecord, width: number, hasFields: boolean) => {
  const { Box, Text, Button, Select } = el as Record<string, any>
  const isLive = isActive(rec.status)
  const ov = rec.override
  const pendingModel = ov?.model !== undefined && ov.model !== rec.model
  const pendingEffort = ov?.effort !== undefined && ov.effort !== rec.effort
  const isCodexTurn = rec.kind === 'codex' && rec.codex?.turnId !== undefined && isLive
  const entries = rec.thread.length - 1
  const unit = rec.kind === 'codex' ? (rec.steps === 1 ? 'turn' : 'turns') : rec.steps === 1 ? 'step' : 'steps'

  return (
    <Box flexDirection="column" gap={1}>
      {/* the grid: what it runs on, and what it has cost */}
      <Box flexDirection="column">
        {hasFields ? (
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            <Select key={`model-${rec.id}`} label="Model" options={modelOptions(rec, d)} value={ov?.model ?? rec.model ?? AUTO} onSelect={(v: string) => act.setModel(rec.id, v)} />
            <Select key={`effort-${rec.id}`} label="Effort" options={effortOptions(rec, d)} value={ov?.effort ?? rec.effort ?? AUTO} onSelect={(v: string) => act.setEffort(rec.id, v)} />
          </Box>
        ) : (
          <Text>
            <Text dimColor>Model </Text>
            <Text bold>{modelLabel(rec.model)}</Text>
            <Text dimColor>   Effort </Text>
            <Text bold>{rec.effort ?? '—'}</Text>
          </Text>
        )}
        <Box flexDirection="row" columnGap={2} flexWrap="wrap">
          <Text dimColor>{`${tokens(rec.tokensIn)} in · ${tokens(rec.tokensOut)} out`}</Text>
          <Text dimColor>{`${rec.steps} ${unit}`}</Text>
        </Box>
        {(pendingModel || pendingEffort) && (
          <Text color="warning">
            {`→ ${[pendingModel ? modelLabel(ov?.model) : undefined, pendingEffort ? ov?.effort : undefined].filter(Boolean).join(' · ')} from the ${rec.kind === 'codex' ? 'next turn' : 'next request'}`}
          </Text>
        )}
        {isLive && rec.error !== undefined && <Text color="error">{truncate(rec.error, width * 3)}</Text>}
        {rec.kind === 'codex' && rec.codex !== undefined && (
          <Text dimColor wrap="truncate-end">
            {`${rec.codex.sandbox}${rec.codex.version ? ` · codex ${rec.codex.version}` : ''}`}
          </Text>
        )}
      </Box>

      {thread(el, d, act, rec, width, { count: RECENT, hasPrompt: entries === 0 })}

      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Button key={`transcript-${rec.id}`} onPress={() => act.openTranscript(rec.id)}>{`View transcript (${entries + 1})`}</Button>
        {isLive && !rec.isStopping && (rec.kind === 'claude' || isCodexTurn) && (
          <Button key={`stop-${rec.id}`} onPress={() => act.stop(rec.id)}>{rec.kind === 'codex' ? '■ Stop turn' : '■ Stop'}</Button>
        )}
        {rec.kind === 'claude' && isLive && !rec.isPaused && !rec.isStopping && <Button key={`pause-${rec.id}`} onPress={() => act.pause(rec.id)}>Pause</Button>}
        {rec.kind === 'claude' && rec.isPaused === true && <Button key={`resume-${rec.id}`} variant="primary" onPress={() => act.resume(rec.id)}>Resume</Button>}
        {isCodexTurn && (pendingModel || pendingEffort) && <Button key={`apply-${rec.id}`} variant="primary" onPress={() => act.applyNow(rec.id)}>Apply now</Button>}
        {rec.kind === 'codex' && rec.codex?.isAlive === true && <Button key={`end-${rec.id}`} dimColor onPress={() => act.endCodex(rec.id)}>Quit Codex</Button>}
        <Button key={`copy-${rec.id}`} dimColor onPress={() => act.copyId(rec.id)}>Copy ID</Button>
      </Box>

      {messageBox(el, act, rec, hasFields, d.now, d.drafts[rec.id] ?? '', width - 4)}
    </Box>
  )
}

// the field is one line; past this many characters the whole draft shows wrapped underneath
const PREVIEW_AFTER = 30
const PREVIEW_LINES = 5

// at most about five lines, pinned to the end where the typing is (no nested scrolling exists)
const preview = (el: Els, id: string, draft: string, width: number) => {
  const { Box, Text } = el as Record<string, any>
  const room = Math.max(120, (width - 4) * PREVIEW_LINES)
  const isCut = draft.length > room
  const shown = isCut ? `…${draft.slice(draft.length - room + 1).replace(/^\S*\s/, '')}` : draft
  return (
    <Box key={`preview-${id}`} flexDirection="column" borderStyle="round" borderDimColor borderColor="subtle" paddingX={1}>
      <Text dimColor>{`Draft · ${draft.length} chars${isCut ? ' · end shown' : ''}`}</Text>
      <Text>{shown}</Text>
    </Box>
  )
}

const messageBox = (el: Els, act: PaneActions, rec: AgentRecord, hasFields: boolean, now: number, draft: string, width: number) => {
  const { Box, Text, Input } = el as Record<string, any>
  if (!hasFields) return <Text dimColor>Messaging and model changes need the desktop app or the terminal.</Text>
  const last = [...rec.thread].reverse().find(m => m.by === 'user')
  const status =
    last === undefined
      ? undefined
      : last.state === 'queued'
        ? { color: 'subtle', text: 'Sending…' }
        : last.state === 'sent'
          ? { color: 'success', text: isActive(rec.status) ? `✓ Delivered · ${ago(last.at, now)}` : '✓ Delivered · waking it' }
          : last.state === 'read'
            ? { color: 'success', text: `✓✓ Read by the agent · ${ago(last.at, now)}` }
            : last.state === 'failed'
              ? { color: 'error', text: '✗ Not delivered (see the thread)' }
              : undefined
  return (
    <Box flexDirection="column">
      {/* a new key after each send draws a fresh, empty box */}
      <Input
        key={`msg-${rec.id}-${rec.sent ?? 0}`}
        placeholder={isActive(rec.status) ? 'Message…' : 'Message to continue…'}
        submitLabel="Send"
        onInput={(text: string) => act.draft(rec.id, text)}
        onSubmit={(text: string) => act.send(rec.id, text)}
      />
      {draft.length > PREVIEW_AFTER && preview(el, rec.id, draft, width)}
      {status !== undefined && draft === '' && <Text color={status.color}>{status.text}</Text>}
    </Box>
  )
}

const PAGE = 25

// one agent's whole thread, newest at the bottom, a page at a time
const transcriptView = (el: Els, d: PaneData, act: PaneActions, rec: AgentRecord, width: number, hasFields: boolean) => {
  const { Box, Text, Button } = el as Record<string, any>
  const s = STATUS[rec.status]
  const count = d.ui.transcriptCount ?? PAGE
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1} gap={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="flex-start">
        <Box flexDirection="column" flexShrink={1}>
          <Text bold wrap="truncate-end">
            <Text color={s.color}>{`${s.glyph} `}</Text>
            {rec.name}
          </Text>
          <Text wrap="truncate-end">
            <Text dimColor>{`${rec.kind === 'codex' ? 'Codex' : rec.type}  `}</Text>
            <Text color={s.color}>{cap(s.label)}</Text>
            <Text dimColor>{'  · transcript'}</Text>
          </Text>
          {since(el, d, `tclock-${rec.id}`, rec.startedAt, rec.endedAt)}
        </Box>
        <Button key="transcript-back" label="◀ Back" onPress={act.closeTranscript} />
      </Box>
      {thread(el, d, act, rec, width - 4, { count, hasPrompt: true, onEarlier: act.loadEarlier })}
      {messageBox(el, act, rec, hasFields, d.now, d.drafts[rec.id] ?? '', width)}
    </Box>
  )
}

// runs of tool calls draw as one tight block
const groupTools = (msgs: Msg[]): (Msg | Msg[])[] => {
  const out: (Msg | Msg[])[] = []
  for (const m of msgs) {
    const last = out.at(-1)
    if (m.by === 'tool' && Array.isArray(last)) last.push(m)
    else out.push(m.by === 'tool' ? [m] : m)
  }
  return out
}

const thread = (
  el: Els,
  d: PaneData,
  act: PaneActions,
  rec: AgentRecord,
  width: number,
  view: { count: number; hasPrompt: boolean; onEarlier?: () => void },
) => {
  const { Box, Text, Button, Markdown } = el as Record<string, any>
  const [first, ...rest] = rec.thread
  const prompt = view.hasPrompt ? first : undefined
  const recent = rest.slice(-view.count)
  const earlier = rest.length - recent.length
  const lastAgent = [...recent].reverse().find(m => m.by === 'agent')
  const isOpen = d.ui.isPromptOpen === true
  const promptLines = prompt?.text.split('\n').length ?? 0
  const isLong = promptLines > 4 || (prompt?.text.length ?? 0) > 280

  return (
    <Box flexDirection="column" gap={1}>
      {prompt !== undefined && (
        <Box flexDirection="column">
          <Text bold>{rec.kind === 'codex' ? 'Task from Claude' : 'Prompt from the parent'}</Text>
          <Text>{isOpen || !isLong ? prompt.text : truncate(firstLines(prompt.text, 4), 280)}</Text>
          {isLong && (
            <Button key={`prompt-toggle-${rec.id}`} plain dimColor onPress={act.togglePrompt}>
              {isOpen ? 'Show less' : 'Show full prompt'}
            </Button>
          )}
        </Box>
      )}
      {earlier > 0 &&
        (view.onEarlier !== undefined ? (
          <Button key={`earlier-${rec.id}`} plain dimColor onPress={view.onEarlier}>{`▲ Load earlier (${earlier} more)`}</Button>
        ) : (
          <Button key={`earlier-open-${rec.id}`} plain dimColor onPress={() => act.openTranscript(rec.id)}>
            {`${earlier} earlier ${earlier === 1 ? 'entry' : 'entries'} · open transcript`}
          </Button>
        ))}
      {groupTools(recent).map(m => {
        if (Array.isArray(m))
          return (
            <Box key={`tools-${m[0]!.id}`} flexDirection="column">
              {m.map(t => (
                <Text key={t.id} dimColor wrap="truncate-end">{`  ▸ ${truncate(t.text, width - 6)}`}</Text>
              ))}
            </Box>
          )
        const chip = m.state !== undefined ? stateChip[m.state] : undefined
        const who = m.by === 'parent' ? 'Parent' : m.by === 'user' ? 'You' : m.by === 'system' ? 'Overseer' : 'Reply'
        const isLastAnswer = m === lastAgent
        return (
          <Box key={m.id} flexDirection="column">
            <Text>
              <Text color={roleColor[m.by]} bold>{truncate(who, Math.max(8, width - 24))}</Text>
              {chip !== undefined && <Text color={chip.color}>{`  ${chip.text}`}</Text>}
              <Text dimColor>{`  ${ago(m.at, d.now)}`}</Text>
            </Text>
            {view.onEarlier === undefined ? (
              // in a card: a few lines, formatted; the transcript has the rest
              <Markdown key={`md-${m.id}`} text={clip(firstLines(m.text, 6), 600)} />
            ) : m.by === 'agent' && isLastAnswer ? (
              <Markdown key={`md-${m.id}`} text={m.text} />
            ) : (
              <Text>{m.by === 'agent' ? firstLines(m.text, 8) : m.text}</Text>
            )}
          </Box>
        )
      })}
    </Box>
  )
}
