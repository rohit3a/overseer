import type { AgentStatus } from '../types'

export const elapsed = (from: number, to: number = Date.now()) => {
  const s = Math.max(0, Math.round((to - from) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export const tokens = (n: number) =>
  n < 1000 ? `${n}` : n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : `${(n / 1_000_000).toFixed(1)}M`

export const ago = (at: number, now: number = Date.now()) => {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 5) return 'now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

export const STATUS: Record<AgentStatus, { glyph: string; color: string; label: string }> = {
  starting: { glyph: '◌', color: 'subtle', label: 'starting' },
  review: { glyph: '◆', color: 'warning', label: 'awaiting review' },
  running: { glyph: '●', color: 'suggestion', label: 'running' },
  paused: { glyph: '‖', color: 'warning', label: 'paused' },
  idle: { glyph: '○', color: 'suggestion', label: 'idle' },
  completed: { glyph: '✓', color: 'success', label: 'done' },
  failed: { glyph: '✕', color: 'error', label: 'failed' },
  killed: { glyph: '■', color: 'inactive', label: 'stopped' },
}

export const truncate = (text: string, width: number) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= width ? one : `${one.slice(0, Math.max(1, width - 1))}…`
}

export const firstLines = (text: string, lines: number) => {
  const all = text.split('\n')
  return all.length <= lines ? text : `${all.slice(0, lines).join('\n')}\n…`
}
