import type { ClientModule } from 'claude-code'

// The one animation in the pane: a soft pulse beside the running call.
// Runs on the surface's own frame clock; the hooks module only passes the colour.
type Props = { color: string }

const FRAMES = ['●', '◉', '○', '◉']

const Pulse: ClientModule<Props, number> = (props, surface) => {
  if (surface.state === undefined) {
    surface.setState(0)
    surface.every(300, () => surface.setState(((surface.state ?? 0) + 1) % FRAMES.length))
  }
  return surface.elements.Text({ color: props.color, children: FRAMES[surface.state ?? 0] })
}

export default Pulse
