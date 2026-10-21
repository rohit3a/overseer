// Claude models offered for overrides. Overrides must be full ids: the
// engine does not resolve aliases at turn.step, and a bad id fails the request.
export const CLAUDE_MODELS: readonly { id: string; label: string }[] = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
]

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

const ALIASES: Record<string, string> = {
  fable: 'claude-fable-5-1',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
}

export const resolveModel = (name: string): string => ALIASES[name.toLowerCase()] ?? name

export const isKnownClaudeModel = (id: string) => CLAUDE_MODELS.some(m => m.id === id)

// "claude-sonnet-5-5" → "Sonnet 5.5"; unknown ids pass through
export const modelLabel = (id: string | undefined): string => {
  if (id === undefined || id === '') return '—'
  const known = CLAUDE_MODELS.find(m => m.id === id)
  if (known !== undefined) return known.label
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id)
  if (m !== null) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`
  return id
}

export const isEffort = (value: string) => (EFFORTS as readonly string[]).includes(value)
