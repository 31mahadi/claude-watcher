import type { WatchConfig } from '../types'

// Strip volatile parts (paths after flags, numbers, quoted strings) so repeat runs share a key.
export function normalizeKey(tool: string, input: Record<string, unknown>, cwd: string, cfg: WatchConfig): string | undefined {
  let body: string
  if (tool === 'Bash' && typeof input.command === 'string') {
    body = input.command
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/(["']).*?\1/g, '"…"')
      .replace(/\b\d+\b/g, 'N')
      .split(' ')
      .slice(0, 4)
      .join(' ')
    if (cfg.estimate.ignorePatterns.some(p => globMatch(p, input.command as string))) return undefined
  } else {
    body = tool
  }
  return cfg.estimate.perProject ? `${cwd}::${body}` : body
}

export function globMatch(pattern: string, text: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
  return re.test(text.trim())
}

export function record(history: number[] | undefined, durationMs: number, size: number): number[] {
  return [...(history ?? []), Math.round(durationMs)].slice(-Math.max(1, size))
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

export type Estimate = { remainingMs: number; totalMs: number; confidence: '~' | '?' | 'max'; fraction: number }

// Time-left for a running call. Confidence: `~` with ≥ minSamples, `?` with fewer,
// `max` when only a timeout bounds it. Never negative; past the median, "overdue" by
// stretching total so the bar never sits at 100% while still running.
export function estimateMs(
  history: readonly number[] | undefined,
  elapsedMs: number,
  minSamples: number,
  timeoutMs?: number,
): Estimate | undefined {
  const samples = history ?? []
  if (samples.length === 0) {
    if (!timeoutMs) return undefined
    return {
      remainingMs: Math.max(0, timeoutMs - elapsedMs),
      totalMs: timeoutMs,
      confidence: 'max',
      fraction: Math.min(0.99, elapsedMs / timeoutMs),
    }
  }
  const typical = median(samples)
  const totalMs = Math.max(typical, elapsedMs * 1.1, 1)
  return {
    remainingMs: Math.max(0, typical - elapsedMs),
    totalMs,
    confidence: samples.length >= minSamples ? '~' : '?',
    fraction: Math.min(0.99, elapsedMs / totalMs),
  }
}
