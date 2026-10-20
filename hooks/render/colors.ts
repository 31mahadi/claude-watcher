import type { WatchConfig } from '../../types'

export type Semantic = 'ok' | 'warn' | 'attention' | 'accent' | 'dim' | 'running' | 'queued'

const NAMED_HEX: Record<string, number> = {
  green: 0x3fb950,
  yellow: 0xd29922,
  red: 0xf85149,
  cyan: 0x39c5cf,
  blue: 0x58a6ff,
  magenta: 0xbc8cff,
  gray: 0x8b949e,
  grey: 0x8b949e,
  white: 0xe6edf3,
  black: 0x0d1117,
}

function name(sem: Semantic, cfg: WatchConfig): string {
  const c = cfg.colors
  switch (sem) {
    case 'ok':
      return c.ok
    case 'warn':
      return c.warn
    case 'attention':
      return c.attention
    case 'accent':
    case 'running':
      return c.accent
    case 'dim':
    case 'queued':
      return c.dim
  }
}

// Color for a Text/Box prop: a plain colour name or hex, which every surface takes.
export function resolve(sem: Semantic, cfg: WatchConfig): string {
  return name(sem, cfg)
}

// 0xRRGGBB for Raster cells and Svg fills.
export function hex(sem: Semantic, cfg: WatchConfig): number {
  const n = name(sem, cfg).toLowerCase()
  if (n.startsWith('#') && n.length === 7) return parseInt(n.slice(1), 16)
  return NAMED_HEX[n] ?? 0x8b949e
}

export function css(sem: Semantic, cfg: WatchConfig): string {
  return `#${hex(sem, cfg).toString(16).padStart(6, '0')}`
}
