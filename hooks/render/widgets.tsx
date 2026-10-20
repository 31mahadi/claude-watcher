import type { WatchConfig } from '../../types'
import { css, hex, resolve, TRACK_CSS, TRACK_HEX, type Semantic } from './colors'
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
}

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
    bar = <Svg source={svg.bar(fraction, css(sem, k.cfg), TRACK_CSS, width * 7, 6)} alt={textBar(fraction, width, 'ascii')} />
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
    const tick = mark !== undefined ? `<rect x="${Math.round(mark * w)}" y="0" width="1" height="8" fill="#8b949e"/>` : ''
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="8" viewBox="0 0 ${w} 8"><rect y="2" width="${w}" height="4" rx="2" fill="${TRACK_CSS}"/><rect y="2" width="${Math.round(f * w)}" height="4" rx="2" fill="${css(sem, k.cfg)}"/>${tick}</svg>`
    return <Svg source={source} alt={`${Math.round(f * 100)}%`} />
  }
  if (hasRaster(k)) {
    const g = raster.bar(f, cells, hex(sem, k.cfg), TRACK_HEX)
    return <Raster key={key} columns={g.columns} rows={1} cells={g.cells} />
  }
  return <Text color={resolve(sem, k.cfg)}>{textBar(f, cells, k.cfg.barStyle)}</Text>
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
