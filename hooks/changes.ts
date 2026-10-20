// What changed on disk this session, from git, split into Claude's edits and yours. Pure; no `$`.

import type { WatchChange } from '../types'

type Numstat = { path: string; added: number; removed: number; binary: boolean }

// "src/{a => b}.ts" and "old => new" are renames; keep the new path.
function renamed(path: string): string {
  const brace = /^(.*)\{[^}]* => ([^}]*)\}(.*)$/.exec(path)
  if (brace) return `${brace[1]}${brace[2]}${brace[3]}`.replace(/\/\//g, '/')
  const plain = /^.* => (.*)$/.exec(path)
  return plain ? plain[1]! : path
}

export function parseNumstat(text: string): Numstat[] {
  const rows: Numstat[] = []
  for (const line of text.split('\n')) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line)
    if (!m) continue
    const binary = m[1] === '-' && m[2] === '-'
    rows.push({ path: renamed(m[3]!), added: binary ? 0 : Number(m[1]), removed: binary ? 0 : Number(m[2]), binary })
  }
  return rows
}

export function parseUntracked(text: string): string[] {
  return text.split('\n').map(l => l.trim()).filter(Boolean)
}

// `edited` maps absolute path → the turn that last edited it.
export function changesFromGit(numstat: string, untracked: string, edited: Map<string, number>, cwd: string): WatchChange[] {
  const root = cwd.replace(/\/+$/, '')
  const turnOf = (path: string) => edited.get(`${root}/${path}`)
  const rows: WatchChange[] = parseNumstat(numstat).map(r => ({ ...r, lastTurn: turnOf(r.path), byClaude: turnOf(r.path) !== undefined }))
  for (const path of parseUntracked(untracked)) {
    if (rows.some(r => r.path === path)) continue
    const turn = turnOf(path)
    // A new file Claude wrote: no line counts against the base; -1 marks it "new".
    rows.push({ path, added: turn !== undefined ? -1 : 0, removed: 0, binary: false, lastTurn: turn, byClaude: turn !== undefined })
  }
  const mine = rows.filter(r => r.byClaude).sort((a, b) => (b.lastTurn ?? 0) - (a.lastTurn ?? 0) || a.path.localeCompare(b.path))
  const yours = rows.filter(r => !r.byClaude).sort((a, b) => a.path.localeCompare(b.path))
  return [...mine, ...yours]
}

// Totals over Claude's rows only; "new" files count as a file, not as lines.
export function changesTotal(rows: readonly WatchChange[]): { files: number; added: number; removed: number; created: number } {
  const mine = rows.filter(r => r.byClaude)
  return {
    files: mine.length,
    added: mine.reduce((t, r) => t + Math.max(0, r.added), 0),
    removed: mine.reduce((t, r) => t + r.removed, 0),
    created: mine.filter(r => r.added < 0).length,
  }
}
