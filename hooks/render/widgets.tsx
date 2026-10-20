import type { WatchConfig } from '../../types'
import { css, hex, resolve, type Semantic } from './colors'
import * as raster from './raster'
import * as svg from './svg'

// Element constructors differ per surface; widgets only reach for the ones they check exist.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Els = Record<string, any>

export type Kit = {
  els: Els
  surface: string
  cfg: WatchConfig
  columns: number
}

const TRACK = 0x30363d

export const hasSvg = (k: Kit) => k.cfg.useSvg && 'Svg' in k.els
export const hasRaster = (k: Kit) => k.cfg.useRaster && 'Raster' in k.els

const GLYPHS: Record<WatchConfig['barStyle'], [string, string]> = {
  blocks: ['█', '░'],
  dots: ['●', '○'],
  ascii: ['#', '-'],
}

export function textBar(fraction: number, width: number, style: WatchConfig['barStyle']): string {
  const [on, off] = GLYPHS[style]
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width)
  return on.repeat(filled) + off.repeat(Math.max(0, width - filled))
}

export function Bar(k: Kit, key: string, fraction: number, sem: Semantic = 'accent', label?: string) {
  const { Box, Text, Svg, Raster } = k.els
  const width = Math.max(4, Math.min(k.cfg.barWidth, k.columns - 8))
  const tail = label ?? `${Math.round(fraction * 100)}%`
  if (hasSvg(k)) {
    return (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Svg source={svg.bar(fraction, css(sem, k.cfg))} alt={`${textBar(fraction, width, 'ascii')} ${tail}`} width={width} height={1} />
        <Text dimColor>{tail}</Text>
      </Box>
    )
  }
  if (hasRaster(k)) {
    const g = raster.bar(fraction, width, hex(sem, k.cfg), TRACK)
    return (
      <Box flexDirection="row" gap={1}>
        <Raster key={key} columns={g.columns} rows={g.rows} cells={g.cells} />
        <Text dimColor>{tail}</Text>
      </Box>
    )
  }
  return (
    <Text>
      <Text color={resolve(sem, k.cfg)}>{textBar(fraction, width, k.cfg.barStyle)}</Text> <Text dimColor>{tail}</Text>
    </Text>
  )
}

export function Pill(k: Kit, text: string, sem: Semantic) {
  const { Text } = k.els
  if (!k.cfg.visuals.pills) return <Text color={resolve(sem, k.cfg)}>{text}</Text>
  return (
    <Text color="black" backgroundColor={resolve(sem, k.cfg)}>
      {` ${text} `}
    </Text>
  )
}

export function Card(k: Kit, title: string, right: string | undefined, children: unknown[]) {
  const { Box, Text } = k.els
  const header = (
    <Box flexDirection="row" justifyContent="space-between">
      <Text bold>{title}</Text>
      {right ? <Text dimColor>{right}</Text> : null}
    </Box>
  )
  if (!k.cfg.visuals.cards || k.cfg.theme === 'minimal' || k.cfg.compact) {
    return (
      <Box flexDirection="column">
        {header}
        {children}
      </Box>
    )
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={resolve('dim', k.cfg)} paddingX={1}>
      {header}
      {children}
    </Box>
  )
}

export function Sparkline(k: Kit, key: string, values: readonly number[]) {
  const { Text, Svg, Raster } = k.els
  if (!k.cfg.visuals.sparkline || values.length < 2) return null
  if (hasSvg(k)) return <Svg source={svg.sparkline(values, css('accent', k.cfg))} alt="tool durations" width={24} height={2} />
  if (hasRaster(k)) {
    const g = raster.sparkline(values.slice(-Math.max(2, k.columns - 4)), hex('accent', k.cfg))
    return <Raster key={key} columns={g.columns} rows={1} cells={g.cells} />
  }
  const max = Math.max(...values, 1)
  return <Text color={resolve('accent', k.cfg)}>{values.map(v => '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor((v / max) * 7.999))]).join('')}</Text>
}

export function HeatStrip(k: Kit, key: string, outcomes: readonly Semantic[]) {
  const { Text, Svg, Raster } = k.els
  if (!k.cfg.visuals.heatStrip || outcomes.length === 0) return null
  if (hasSvg(k)) return <Svg source={svg.heatStrip(outcomes.map(o => css(o, k.cfg)))} alt="recent calls" width={Math.min(40, outcomes.length * 2)} height={1} />
  if (hasRaster(k)) {
    const g = raster.heatStrip(outcomes.map(o => hex(o, k.cfg)))
    return <Raster key={key} columns={g.columns} rows={1} cells={g.cells} />
  }
  return (
    <Text>
      {outcomes.map(o => (
        <Text color={resolve(o, k.cfg)}>■</Text>
      ))}
    </Text>
  )
}

export function Donut(k: Kit, fraction: number, sem: Semantic) {
  const { Text, Svg } = k.els
  if (k.cfg.visuals.contextDonut && hasSvg(k)) {
    return <Svg source={svg.donut(fraction, css(sem, k.cfg))} alt={`${Math.round(fraction * 100)}%`} width={6} height={3} />
  }
  return <Text color={resolve(sem, k.cfg)}>{textBar(fraction, 10, 'blocks').replace(/█/g, '▓')}</Text>
}

export type GanttLane = { label: string; start: number; end: number; sem: Semantic; failed?: boolean; right?: string }

export function Gantt(k: Kit, key: string, lanes: readonly GanttLane[], from: number, to: number) {
  const { Box, Text, Svg, Raster } = k.els
  if (!k.cfg.visuals.gantt || lanes.length === 0) return null
  if (hasSvg(k)) {
    const source = svg.gantt(
      lanes.map(l => ({ label: l.label, start: l.start, end: l.end, color: css(l.sem, k.cfg), outline: l.failed ? css('attention', k.cfg) : undefined })),
      from,
      to,
    )
    return <Svg source={source} alt={lanes.map(l => l.label).join(', ')} width={Math.max(20, k.columns - 2)} height={lanes.length + 1} />
  }
  if (hasRaster(k)) {
    const labelW = 10
    const width = Math.max(10, Math.min(60, k.columns - labelW - 4))
    const g = raster.swimlanes(
      lanes.map(l => ({ start: l.start, end: l.end, fg: hex(l.sem, k.cfg) })),
      from,
      to,
      width,
      TRACK,
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

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function spinGlyph(cfg: WatchConfig, tick: number): string {
  return cfg.animations ? SPIN[tick % SPIN.length]! : '●'
}
