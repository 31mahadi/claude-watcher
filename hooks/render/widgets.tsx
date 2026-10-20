import type { WatchConfig } from '../../types'
import { css, hex, resolve, TINT, TRACK_CSS, TRACK_HEX, type Semantic, type Tint } from './colors'
import * as raster from './raster'
import * as svg from './svg'

// Element constructors differ per surface; widgets check what exists and fall back to text.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Els = Record<string, any>

export type Kit = {
  els: Els
  surface: string
  cfg: WatchConfig
  columns: number
  // Pane body height in rows, when the surface says; the blocks fill it.
  rows?: number
}

// One bar thickness everywhere: progress, gauge and agent lanes.
export const BAR_PX = 4

export const hasSvg = (k: Kit) => k.cfg.useSvg && 'Svg' in k.els
export const hasRaster = (k: Kit) => k.cfg.useRaster && 'Raster' in k.els

// Width available inside a card (border + padding take 4 columns).
export const inner = (k: Kit) => Math.max(10, k.columns - (cardsOn(k) ? 4 : 0))
const cardsOn = (k: Kit) => k.cfg.visuals.cards && k.cfg.theme !== 'minimal' && !k.cfg.compact

const GLYPHS: Record<WatchConfig['barStyle'], [string, string]> = {
  blocks: ['━', '─'],
  dots: ['●', '○'],
  ascii: ['#', '-'],
}

export function textBar(fraction: number, width: number, style: WatchConfig['barStyle']): string {
  const [on, off] = GLYPHS[style]
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width)
  return on.repeat(filled) + off.repeat(Math.max(0, width - filled))
}

// Progress bar that fills the card, with a right-aligned dim label.
export function Bar(k: Kit, key: string, fraction: number, sem: Semantic, label: string) {
  const { Box, Text, Svg, Raster } = k.els
  const width = Math.max(6, inner(k) - label.length - 1)
  let bar
  if (hasSvg(k)) {
    bar = <Svg source={svg.bar(fraction, css(sem, k.cfg), TRACK_CSS, width * 7, BAR_PX)} alt={textBar(fraction, width, 'ascii')} />
  } else if (hasRaster(k)) {
    const g = raster.bar(fraction, width, hex(sem, k.cfg), TRACK_HEX)
    bar = <Raster key={key} columns={g.columns} rows={1} cells={g.cells} />
  } else {
    bar = <Text color={resolve(sem, k.cfg)}>{textBar(fraction, width, k.cfg.barStyle)}</Text>
  }
  return (
    <Box flexDirection="row" gap={1}>
      {bar}
      <Text dimColor>{label}</Text>
    </Box>
  )
}

// Short bold chip. Colour only when it carries state.
export function Pill(k: Kit, text: string, sem: Semantic | undefined) {
  const { Text } = k.els
  if (!sem || sem === 'dim') return <Text dimColor>{text}</Text>
  if (!k.cfg.visuals.pills) return <Text color={resolve(sem, k.cfg)}>{text}</Text>
  return (
    <Text bold inverse color={resolve(sem, k.cfg)}>
      {` ${text} `}
    </Text>
  )
}

// Same card everywhere: rounded border, 1-cell padding, bold header, body. No gaps inside.
export function Card(k: Kit, key: string, title: unknown, right: string | undefined, body: unknown[], sem?: Semantic) {
  const { Box, Text } = k.els
  const header = (
    <Box flexDirection="row" justifyContent="space-between">
      {typeof title === 'string' ? <Text bold>{title}</Text> : title}
      {right ? <Text dimColor>{right}</Text> : null}
    </Box>
  )
  if (!cardsOn(k)) {
    return (
      <Box key={key} flexDirection="column">
        {header}
        {body}
      </Box>
    )
  }
  return (
    <Box key={key} flexDirection="column" borderStyle="round" borderColor={resolve(sem ?? 'dim', k.cfg)} paddingX={1}>
      {header}
      {body}
    </Box>
  )
}

// A label on the left, a fixed-width right-aligned value column.
export function Row(k: Kit, left: unknown, right: string, valueWidth = 7) {
  const { Box, Text } = k.els
  return (
    <Box flexDirection="row">
      <Box flexGrow={1} flexShrink={1}>
        {left}
      </Box>
      <Box width={valueWidth} justifyContent="flex-end">
        <Text dimColor>{right}</Text>
      </Box>
    </Box>
  )
}

// A labelled section: dim uppercase label column, rows in the value column. No border.
export function Section(k: Kit, key: string, label: string, rows: unknown[]) {
  const { Box, Text } = k.els
  return (
    <Box key={key} flexDirection="row">
      <Box width={9} flexShrink={0}>
        <Text dimColor bold>
          {label}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {rows}
      </Box>
    </Box>
  )
}

// Small section heading: uppercase, dim, bold.
export function SectionLabel(k: Kit, text: string) {
  const { Text } = k.els
  return (
    <Text dimColor bold>
      {text.toUpperCase()}
    </Text>
  )
}

// A fixed-width gauge with an optional tick at `mark` (0..1), e.g. a warning level.
export function MiniBar(k: Kit, key: string, fraction: number, sem: Semantic, mark?: number, cells = 10) {
  const { Text, Svg, Raster } = k.els
  const f = Math.max(0, Math.min(1, fraction))
  if (hasSvg(k)) {
    const w = cells * 7
    const tick = mark !== undefined ? `<line x1="${Math.round(mark * w)}" y1="0" x2="${Math.round(mark * w)}" y2="${BAR_PX}" stroke="#8b949e" stroke-width="1"/>` : ''
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${BAR_PX}" viewBox="0 0 ${w} ${BAR_PX}"><rect width="${w}" height="${BAR_PX}" rx="${BAR_PX / 2}" fill="${TRACK_CSS}"/><rect width="${Math.round(f * w)}" height="${BAR_PX}" rx="${BAR_PX / 2}" fill="${css(sem, k.cfg)}"/>${tick}</svg>`
    return <Svg source={source} alt={`${Math.round(f * 100)}%`} />
  }
  if (hasRaster(k)) {
    const g = raster.bar(f, cells, hex(sem, k.cfg), TRACK_HEX)
    return <Raster key={key} columns={g.columns} rows={1} cells={g.cells} />
  }
  return <Text color={resolve(sem, k.cfg)}>{textBar(f, cells, k.cfg.barStyle)}</Text>
}

// One block per step, coloured by status; 4px like every bar.
export function Segments(k: Kit, key: string, sems: readonly Semantic[]) {
  const { Box, Text, Svg, Raster } = k.els
  const n = Math.max(1, sems.length)
  if (hasSvg(k)) {
    const total = Math.max(120, Math.min(inner(k) * 7, 420))
    const gap = n > 40 ? 1 : 2
    const w = (total - gap * (n - 1)) / n
    const fill = (s: Semantic) => (s === 'dim' ? '#2f3a4a' : css(s, k.cfg))
    const rects = sems.map((s, i) => `<rect x="${(i * (w + gap)).toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${BAR_PX}" rx="1" fill="${fill(s)}"/>`)
    return (
      <Box key={key}>
        <Svg source={`<svg xmlns="http://www.w3.org/2000/svg" data-kind="segments" width="${total}" height="${BAR_PX}" viewBox="0 0 ${total} ${BAR_PX}">${rects.join('')}</svg>`} alt={sems.map(s => (s === 'ok' ? '▰' : '▱')).join('')} />
      </Box>
    )
  }
  if (hasRaster(k)) {
    const cells = raster.cellsOf(sems.map(s => ({ ch: '▬', fg: hex(s, k.cfg) })))
    return (
      <Box key={key}>
        <Raster key={`${key}-r`} columns={n} rows={1} cells={cells} />
      </Box>
    )
  }
  return (
    <Box key={key}>
      <Text>
        {sems.map(s => (
          <Text color={resolve(s, k.cfg)}>{s === 'dim' ? '▱' : '▰'}</Text>
        ))}
      </Text>
    </Box>
  )
}

// One bar per turn: height = duration, colour = outcome.
export function TurnStrip(k: Kit, key: string, turns: readonly { ms: number; sem: Semantic }[]) {
  const { Box, Text, Svg } = k.els
  if (turns.length === 0) return null
  const max = Math.max(...turns.map(t => t.ms), 1)
  if (hasSvg(k)) {
    const tall = 14
    const rects = turns.map((t, i) => {
      const bh = Math.max(2, Math.round((t.ms / max) * tall))
      return `<rect x="${i * (BAR_PX + 2)}" y="${tall - bh}" width="${BAR_PX}" height="${bh}" rx="1" fill="${css(t.sem, k.cfg)}"/>`
    })
    const w = turns.length * (BAR_PX + 2)
    return (
      <Box key={key}>
        <Svg source={`<svg xmlns="http://www.w3.org/2000/svg" data-kind="turns" width="${w}" height="${tall}" viewBox="0 0 ${w} ${tall}">${rects.join('')}</svg>`} alt={`${turns.length} turns`} />
      </Box>
    )
  }
  const SPARK = '▁▂▃▄▅▆▇█'
  return (
    <Box key={key}>
      <Text>
        {turns.map(t => (
          <Text color={resolve(t.sem, k.cfg)}>{SPARK[Math.min(7, Math.floor((t.ms / max) * 7.999))]}</Text>
        ))}
      </Text>
    </Box>
  )
}

// A tinted badge: " label value ".
export function Badge(k: Kit, tint: Tint, label: string, value: unknown) {
  const { Text } = k.els
  const t = TINT[tint]
  return (
    <Text backgroundColor={t.bg} color={t.fg}>
      {` ${label} `}
      {value}
      {' '}
    </Text>
  )
}

export function Mark(k: Kit, glyph: string, sem: Semantic) {
  const { Text } = k.els
  return <Text color={resolve(sem, k.cfg)}>{glyph}</Text>
}

// The one motion: a Client pulse where the surface has Client, a still dot elsewhere.
export function Pulse(k: Kit, sem: Semantic) {
  const { Client, Text } = k.els
  // Client runs on the terminal and Desktop only; VS Code gets a still dot.
  if (k.cfg.animations && Client && (k.surface === 'terminal' || k.surface === 'desktop')) return <Client key="pulse" module="../client/pulse.ts" props={{ color: resolve(sem, k.cfg) }} width={1} />
  return <Text color={resolve(sem, k.cfg)}>●</Text>
}

// A small trend line. `cells` bounds its width; `max` fixes the scale (100 for a percentage).
export function Sparkline(k: Kit, key: string, values: readonly number[], opts: { sem?: Semantic; cells?: number; max?: number; alt?: string } = {}) {
  const { Text, Svg, Raster } = k.els
  if (!k.cfg.visuals.sparkline || values.length < 2) return null
  const sem = opts.sem ?? 'accent'
  const cells = Math.min(inner(k), opts.cells ?? 40)
  const shown = values.slice(-cells)
  if (hasSvg(k)) return <Svg source={svg.sparkline(shown, css(sem, k.cfg), Math.max(24, shown.length * 5), 12, opts.max)} alt={opts.alt ?? 'trend'} />
  if (hasRaster(k)) {
    const g = raster.sparkline(shown, hex(sem, k.cfg), opts.max)
    return <Raster key={key} columns={g.columns} rows={1} cells={g.cells} />
  }
  const max = opts.max ?? Math.max(...shown, 1)
  return <Text dimColor>{shown.map(v => '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor((v / max) * 7.999))]).join('')}</Text>
}

export function Donut(k: Kit, fraction: number, sem: Semantic) {
  const { Text, Svg } = k.els
  if (k.cfg.visuals.contextDonut && hasSvg(k)) {
    return <Svg source={svg.donut(fraction, css(sem, k.cfg), TRACK_CSS)} alt={`${Math.round(fraction * 100)}%`} />
  }
  return <Text color={resolve(sem, k.cfg)}>{textBar(fraction, 10, k.cfg.barStyle)}</Text>
}

export type GanttLane = { label: string; start: number; end: number; sem: Semantic; failed?: boolean }

export function Gantt(k: Kit, key: string, lanes: readonly GanttLane[], from: number, to: number) {
  const { Box, Text, Svg, Raster } = k.els
  if (!k.cfg.visuals.gantt || lanes.length < 2) return null
  const width = inner(k)
  if (hasSvg(k)) {
    const source = svg.gantt(
      lanes.map(l => ({ label: l.label, start: l.start, end: l.end, color: css(l.sem, k.cfg), outline: l.failed ? css('attention', k.cfg) : undefined })),
      from,
      to,
      width * 7,
      96,
    )
    return <Svg source={source} alt={lanes.map(l => l.label).join(', ')} />
  }
  if (hasRaster(k)) {
    const labelW = 10
    const g = raster.swimlanes(
      lanes.map(l => ({ start: l.start, end: l.end, fg: hex(l.sem, k.cfg) })),
      from,
      to,
      Math.max(10, width - labelW - 1),
      TRACK_HEX,
    )
    return (
      <Box flexDirection="row" gap={1}>
        <Box flexDirection="column" width={labelW}>
          {lanes.map(l => (
            <Text dimColor wrap="truncate-end">
              {l.label}
            </Text>
          ))}
        </Box>
        <Raster key={key} columns={g.columns} rows={g.rows} cells={g.cells} />
      </Box>
    )
  }
  return null
}
