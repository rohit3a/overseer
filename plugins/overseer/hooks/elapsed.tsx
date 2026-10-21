import type { ClientModule } from 'claude-code'

// An elapsed-time label that ticks on the surface itself, so the pane never
// redraws once a second just to move a clock (a redraw mid-click drops it).

type Props = { from: number; to?: number; color?: string }
type State = { now: number }

const format = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

const Elapsed: ClientModule<Props, State> = (props, surface) => {
  const { Text } = surface.elements
  if (surface.state === undefined && props.to === undefined) {
    surface.setState({ now: Date.now() })
    surface.every(1000, () => surface.setState({ now: Date.now() }))
  }
  const now = props.to ?? surface.state?.now ?? Date.now()
  return <Text dimColor={props.color === undefined} color={props.color}>{format(now - props.from)}</Text>
}

export default Elapsed
