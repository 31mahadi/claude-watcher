import type { WatchConfig } from '../types'

export function time(ms: number, style: WatchConfig['timeFormat'] = 'mmss'): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (style === 'human') {
    if (h > 0) return `${h}h ${m}m`
    if (m > 0) return `${m}m ${s}s`
    return `${s}s`
  }
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`
}

export function truncate(text: string, max: number): string {
  if (max <= 0) return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`
}

export function basename(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}

export function pct(value: number): string {
  return `${Math.round(value)}%`
}

export function ago(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s ago`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  return `${Math.round(ms / 3_600_000)}h ago`
}

// "30m", "2h", "90s", "45" (minutes) → ms
export function parseDuration(raw: string): number | undefined {
  const m = /^(\d+)\s*(s|m|h)?$/.exec(raw.trim())
  if (!m) return undefined
  const n = Number(m[1])
  const unit = m[2] ?? 'm'
  return n * (unit === 's' ? 1000 : unit === 'h' ? 3_600_000 : 60_000)
}

// Text label for a tool call, honouring redaction and length limits.
export function toolLabel(tool: string, input: Record<string, unknown>, cfg: WatchConfig): string {
  if (cfg.redactCommands) return tool
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  // A Bash call's own description reads better than a raw shell line.
  const detail =
    (tool === 'Bash' ? pick('description') : undefined) ??
    pick('command') ??
    pick('description') ??
    (pick('file_path') ? basename(pick('file_path')!) : undefined) ??
    pick('pattern') ??
    pick('url') ??
    pick('subject') ??
    pick('prompt')
  const text = detail ? (tool === 'Bash' ? detail : `${tool} ${detail}`) : tool
  return truncate(text, cfg.maxCommandChars)
}
