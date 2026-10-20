// The session's history: one entry per turn, plus session events between turns. Pure; no `$`.

import type { WatchCall, WatchHistoryEntry, WatchHistoryEvent, WatchHistoryTurn, WatchTestResult } from '../types'

export const MAX_TURNS = 20
export const MAX_CALLS = 40

type History = readonly WatchHistoryEntry[]

// Keep the last MAX_TURNS turns and the events from the oldest kept turn on.
function cap(h: WatchHistoryEntry[]): WatchHistoryEntry[] {
  const turns = h.filter(e => e.kind === 'turn')
  if (turns.length <= MAX_TURNS) return h
  const firstKept = turns[turns.length - MAX_TURNS]!
  return h.slice(h.indexOf(firstKept))
}

// Apply `fn` to the latest turn while it is still running.
function onOpenTurn(h: History, fn: (t: WatchHistoryTurn) => WatchHistoryTurn): WatchHistoryEntry[] {
  for (let i = h.length - 1; i >= 0; i--) {
    const e = h[i]!
    if (e.kind !== 'turn') continue
    if (e.ended) return [...h]
    const out = [...h]
    out[i] = fn(e)
    return out
  }
  return [...h]
}

export function startTurnEntry(h: History, id: string, at: number, prompt: string): WatchHistoryEntry[] {
  const line = (prompt.split('\n').find(l => l.trim()) ?? '').trim()
  const title = line.length > 80 ? `${line.slice(0, 79)}…` : line
  const turn: WatchHistoryTurn = { kind: 'turn', id, at, title, ended: false, failed: false, calls: [], moreCalls: 0, files: [], steps: [], agents: [], waitMs: 0 }
  // A turn that never saw its end (interrupted, or the mod reloaded) is closed now.
  const closed = h.map(e => {
    if (e.kind !== 'turn' || e.ended) return e
    return { ...e, ended: true, interrupted: true, durationMs: undefined }
  })
  return cap([...closed, turn])
}

export function addCall(h: History, call: WatchCall): WatchHistoryEntry[] {
  return onOpenTurn(h, t => {
    const calls = [...t.calls, { label: call.label, ok: call.ok, durationMs: call.durationMs, note: call.note }]
    const over = Math.max(0, calls.length - MAX_CALLS)
    return { ...t, calls: calls.slice(over), moreCalls: t.moreCalls + over }
  })
}

export function addFile(h: History, file: string): WatchHistoryEntry[] {
  return onOpenTurn(h, t => (t.files.includes(file) ? t : { ...t, files: [...t.files, file] }))
}

export function setTest(h: History, r: WatchTestResult): WatchHistoryEntry[] {
  return onOpenTurn(h, t => ({ ...t, tests: { ok: r.ok, passed: r.passed, failed: r.failed, command: r.command, snippet: r.snippet } }))
}

export function addWait(h: History, ms: number): WatchHistoryEntry[] {
  return onOpenTurn(h, t => ({ ...t, waitMs: t.waitMs + Math.max(0, ms) }))
}

export function noteSteps(h: History, steps: readonly { title: string; status: string }[]): WatchHistoryEntry[] {
  return onOpenTurn(h, t => ({ ...t, steps: steps.map(s => ({ title: s.title, status: s.status })) }))
}

export function addAgent(h: History, label: string, ok: boolean, durationMs: number): WatchHistoryEntry[] {
  return onOpenTurn(h, t => ({ ...t, agents: [...t.agents.filter(a => a.label !== label), { label, ok, durationMs }] }))
}

export function endTurnEntry(h: History, at: number, failed: boolean): WatchHistoryEntry[] {
  return onOpenTurn(h, t => ({ ...t, ended: true, failed, durationMs: at - t.at }))
}

export function addEvent(h: History, at: number, icon: WatchHistoryEvent['icon'], text: string): WatchHistoryEntry[] {
  return cap([...h, { kind: 'event', id: `ev-${at}-${icon}`, at, icon, text }])
}

export function isProblem(e: WatchHistoryEntry): boolean {
  if (e.kind === 'event') return e.icon === 'error'
  return e.failed || e.waitMs > 0 || (e.tests !== undefined && !e.tests.ok) || e.calls.some(c => c.ok === false) || e.agents.some(a => !a.ok)
}

export function filterHistory(h: History, filter: 'all' | 'turns' | 'problems'): WatchHistoryEntry[] {
  if (filter === 'turns') return h.filter(e => e.kind === 'turn')
  if (filter === 'problems') return h.filter(isProblem)
  return [...h]
}
