import type { WatchConfig } from '../types'

export const DEFAULTS: WatchConfig = {
  autoOpen: 'onLongTurn',
  longTurnSeconds: 20,
  defaultTab: 'turn',
  spinnerSuffix: true,
  spinnerMaxChars: 80,
  theme: 'default',
  compact: false,
  barWidth: 20,
  barStyle: 'blocks',
  useSvg: true,
  useRaster: true,
  animations: true,
  visuals: {
    cards: true,
    pills: true,
    gantt: true,
    sparkline: true,
    contextDonut: true,
    heatStrip: true,
    failedTestSnippet: true,
    ganttWindowMinutes: 10,
  },
  showRecentCalls: 8,
  timeFormat: 'mmss',
  colors: { ok: 'green', warn: 'yellow', attention: 'red', accent: 'cyan', dim: 'gray' },
  estimate: {
    enabled: true,
    historySize: 10,
    minSamples: 3,
    perProject: true,
    ignorePatterns: ['sleep *', 'echo *'],
  },
  attention: {
    band: true,
    toast: true,
    desktopNotify: 'whenUnfocused',
    notifyOnTurnEndAfterSeconds: 300,
    sound: false,
  },
  sessions: {
    shareState: true,
    heartbeatMs: 1000,
    staleAfterSeconds: 10,
    hideEndedAfterMinutes: 5,
    showCwd: 'basename',
  },
  health: {
    contextWarnPct: 70,
    parseTestOutput: true,
    gitStatus: true,
    showCost: true,
  },
  showToolBadge: false,
  redactCommands: false,
  maxCommandChars: 120,
  idleTimer: false,
}

// Enum settings: path → allowed values. Used by validation and the config tab.
export const CHOICES: Record<string, readonly string[]> = {
  autoOpen: ['always', 'onLongTurn', 'never'],
  defaultTab: ['turn', 'plan', 'agents', 'sessions', 'health'],
  theme: ['default', 'minimal', 'dense'],
  barStyle: ['blocks', 'dots', 'ascii'],
  timeFormat: ['mmss', 'human'],
  'attention.desktopNotify': ['always', 'whenUnfocused', 'never'],
  'sessions.showCwd': ['full', 'basename', 'hidden'],
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// Deep merge `over` onto `base`, keeping only keys and value types `base` knows.
function mergeKnown(base: unknown, over: unknown, path: string): unknown {
  if (isObject(base)) {
    if (!isObject(over)) return base
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(base)) {
      const child = path ? `${path}.${key}` : key
      out[key] = key in over ? mergeKnown(base[key], over[key], child) : base[key]
    }
    return out
  }
  if (Array.isArray(base)) {
    return Array.isArray(over) && over.every(x => typeof x === 'string') ? over : base
  }
  if (typeof over !== typeof base) return base
  if (typeof over === 'number' && !Number.isFinite(over)) return base
  const allowed = CHOICES[path]
  if (allowed && !allowed.includes(over as string)) return base
  return over
}

// Precedence: defaults < project file < user store.
export function mergeConfig(...layers: unknown[]): WatchConfig {
  let out: unknown = DEFAULTS
  for (const layer of layers) out = mergeKnown(out, layer, '')
  return out as WatchConfig
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (!isObject(cur)) return undefined
    cur = cur[part]
  }
  return cur
}

// Returns a sparse override object holding only `path = value`.
export function patchFor(path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.')
  const root: Record<string, unknown> = {}
  let cur = root
  parts.forEach((part, i) => {
    if (i === parts.length - 1) cur[part] = value
    else cur = cur[part] = {} as Record<string, unknown>
  })
  return root
}

export function deepMergeRaw(a: unknown, b: unknown): unknown {
  if (!isObject(a) || !isObject(b)) return b
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = deepMergeRaw(a[k], v)
  return out
}

// Parse a `/watch config set <path> <value>` value string.
export function parseValue(raw: string): unknown {
  const t = raw.trim()
  if (t === 'true') return true
  if (t === 'false') return false
  if (t !== '' && !Number.isNaN(Number(t))) return Number(t)
  try {
    return JSON.parse(t)
  } catch {
    return t
  }
}
