import type { WatchConfig } from '../../types'

// Five semantic tokens. Render code uses these names only, never raw colours.
//   accent    running / in progress (blue)
//   ok        done / passing (green)
//   warn      needs you / near a limit (amber)
//   attention failed / error (red)
//   dim       queued / stale / secondary (grey)
export type Semantic = 'accent' | 'ok' | 'warn' | 'attention' | 'dim'

// Text colours are theme keys so they follow the person's light/dark theme.
const THEME_KEY: Record<Semantic, string> = {
  accent: 'suggestion',
  ok: 'success',
  warn: 'warning',
  attention: 'error',
  dim: 'inactive',
}

// Fixed hex is used only inside Svg and Raster, where the background is ours.
const HEX: Record<Semantic, number> = {
  accent: 0x58a6ff,
  ok: 0x3fb950,
  warn: 0xd29922,
  attention: 0xf85149,
  dim: 0x8b949e,
}

const NAMED_HEX: Record<string, number> = {
  green: 0x3fb950,
  yellow: 0xd29922,
  amber: 0xd29922,
  red: 0xf85149,
  blue: 0x58a6ff,
  cyan: 0x39c5cf,
  magenta: 0xbc8cff,
  gray: 0x8b949e,
  grey: 0x8b949e,
}

export const TRACK_HEX = 0x30363d

// A user override in config.colors wins; empty string means "use the theme".
function override(sem: Semantic, cfg: WatchConfig): string | undefined {
  const v = cfg.colors[sem]
  return v ? v : undefined
}

export function resolve(sem: Semantic, cfg: WatchConfig): string {
  return override(sem, cfg) ?? THEME_KEY[sem]
}

export function hex(sem: Semantic, cfg: WatchConfig): number {
  const o = override(sem, cfg)?.toLowerCase()
  if (o?.startsWith('#') && o.length === 7) return parseInt(o.slice(1), 16)
  return (o && NAMED_HEX[o]) || HEX[sem]
}

export function css(sem: Semantic, cfg: WatchConfig): string {
  return `#${hex(sem, cfg).toString(16).padStart(6, '0')}`
}

export const TRACK_CSS = `#${TRACK_HEX.toString(16)}`
