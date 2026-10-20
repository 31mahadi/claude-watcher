// Options for the footer's Open… menu. Pure; the engine side runs them.

import type { WatchChange } from '../types'
import { basename } from './format'

export type OpenOption = {
  value: string
  label: string
  action: { kind: 'file'; path: string; line?: number } | { kind: 'copy'; text: string }
}

const SOURCE = /((?:[\w.@-]+\/)*[\w.@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|php|cs|md))(?::|\()(\d+)/g

// First source file:line in a failure snippet, skipping URLs and node_modules.
export function failingLocation(snippet: string | undefined, cwd: string): { path: string; line: number } | undefined {
  if (!snippet) return undefined
  for (const m of snippet.matchAll(SOURCE)) {
    const path = m[1]!
    const before = snippet.slice(Math.max(0, (m.index ?? 0) - 3), m.index)
    if (before.endsWith('://') || /\/\/$/.test(before) || path.includes('node_modules/')) continue
    const abs = path.startsWith('/') ? path : `${cwd.replace(/\/+$/, '')}/${path}`
    return { path: abs, line: Number(m[2]) }
  }
  return undefined
}

export function openOptions(args: { planPath?: string; failing?: { path: string; line: number }; changes: readonly WatchChange[]; sessionId: string }): OpenOption[] {
  const out: OpenOption[] = []
  if (args.planPath) out.push({ value: 'plan', label: 'plan file', action: { kind: 'file', path: args.planPath } })
  if (args.failing) out.push({ value: 'fail', label: `failing test: ${basename(args.failing.path)}:${args.failing.line}`, action: { kind: 'file', ...args.failing } })
  for (const c of args.changes.filter(x => x.byClaude).slice(0, 10)) out.push({ value: `file:${c.path}`, label: c.path, action: { kind: 'file', path: c.path } })
  if (args.sessionId) out.push({ value: 'resume', label: 'copy resume command', action: { kind: 'copy', text: `claude --resume ${args.sessionId}` } })
  return out
}
