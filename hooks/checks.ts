// How each test, lint and build command fared across turns. Pure; no `$`.

import type { WatchCheck, WatchCheckRun } from '../types'
import { DEFAULTS } from './config'
import { normalizeKey } from './estimate'
import { classifyCommand } from './health'

const MAX_RUNS = 10
const KEY_CFG = { ...DEFAULTS, estimate: { ...DEFAULTS.estimate, perProject: false, ignorePatterns: [] } }

// One key per command shape: `npm test -- --shard=1` and `=2` are the same check.
export function checkKey(command: string, cwd: string): string {
  const kind = classifyCommand(command)
  if (!kind) return ''
  return `${kind}:${normalizeKey('Bash', { command }, cwd, KEY_CFG) ?? command}`
}

export function recordCheck(checks: Record<string, WatchCheck>, key: string, command: string, run: WatchCheckRun): Record<string, WatchCheck> {
  const kind = (key.split(':')[0] as WatchCheck['kind']) || 'test'
  const prev = checks[key]
  const runs = [...(prev?.runs ?? []), run].slice(-MAX_RUNS)
  return { ...checks, [key]: { command, kind, runs } }
}

const last = (c: WatchCheck) => c.runs[c.runs.length - 1]

// Failing first, then most recent.
export function checkRows(checks: Record<string, WatchCheck>): WatchCheck[] {
  return Object.values(checks)
    .filter(c => c.runs.length > 0)
    .sort((a, b) => Number(last(a)!.ok) - Number(last(b)!.ok) || last(b)!.at - last(a)!.at)
}

export function trendGlyphs(c: WatchCheck): string {
  return c.runs
    .slice(-5)
    .map(r => (r.ok ? '✓' : '✗'))
    .join(' ')
}
