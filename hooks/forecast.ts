// How many turns until context compaction, from the per-turn burn since the last one. Pure.

export type Forecast = { kind: 'stable' } | { kind: 'turns'; turns: number; slope: number } | { kind: 'next'; slope: number }

export function forecast(history: readonly number[], sinceIndex: number, current: number, compactAt: number): Forecast {
  const series = [...history.slice(Math.max(0, sinceIndex)), current]
  const deltas: number[] = []
  for (let i = 1; i < series.length; i++) {
    const d = series[i]! - series[i - 1]!
    if (d > 0) deltas.push(d)
  }
  const recent = deltas.slice(-5)
  if (series.length < 2 || recent.length === 0) return { kind: 'stable' }
  const slope = Math.round((recent.reduce((t, d) => t + d, 0) / recent.length) * 10) / 10
  if (slope <= 0.5) return { kind: 'stable' }
  const turns = Math.ceil((compactAt - current) / slope)
  return turns <= 1 ? { kind: 'next', slope } : { kind: 'turns', turns, slope }
}

export function forecastText(f: Forecast): string {
  if (f.kind === 'stable') return 'stable'
  if (f.kind === 'next') return `compaction next turn · +${f.slope}%/turn`
  return `~${f.turns} turns to compaction · +${f.slope}%/turn`
}
