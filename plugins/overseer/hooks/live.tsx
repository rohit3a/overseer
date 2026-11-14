import type { ClientModule } from 'claude-code'

// An agent's live activity line, kept current by the surface itself: it asks the
// hooks module for the latest text a few times a second and gets it back as new
// props, so streaming output never redraws the pane (a redraw mid-click drops it).

type Props = { id: string; text: string; color: string; room: number }
type State = { isAsking: true }

const Live: ClientModule<Props, State> = (props, surface) => {
  const { Text } = surface.elements
  if (surface.state === undefined) {
    surface.setState({ isAsking: true })
    // the hook answers with this instance's next props, or nothing while the line stands
    const id = props.id
    surface.every(400, () => surface.post({ id }))
  }
  const room = Math.max(4, props.room)
  const text = props.text.length > room ? `${props.text.slice(0, room - 1)}…` : props.text
  return <Text color={props.color}>{text}</Text>
}

export default Live
