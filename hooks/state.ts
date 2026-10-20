import type { WatchCall, WatchSnapshot } from '../types'
import { isPersistent } from './plan'

export const PANE = 'watcher'

export const EMPTY_SNAP: WatchSnapshot = {
  sessionId: '',
  cwd: '',
  phase: 'idle',
  turnStartedAt: null,
  turnEndedAt: null,
  current: null,
  toolCalls: 0,
  recent: [],
  agents: [],
  health: { compactions: 0, editedFiles: [], needsYou: null, contextHistory: [] },
  plan: null,
}

// Reducers: pure, (snapshot, …) → snapshot.

export function resetTurn(s: WatchSnapshot): WatchSnapshot {
  return {
    ...s,
    phase: 'idle',
    turnStartedAt: null,
    turnEndedAt: null,
    current: null,
    toolCalls: 0,
    recent: [],
    agents: [],
    health: { ...s.health, editedFiles: [], needsYou: null, lastError: undefined },
    // A plan from a file outlives /clear; a todo or prompt plan does not.
    plan: isPersistent(s.plan) ? s.plan : null,
  }
}

export function startTurn(s: WatchSnapshot, now: number, goal?: string): WatchSnapshot {
  return {
    ...s,
    goal,
    lastEventAt: now,
    phase: 'thinking',
    turnStartedAt: now,
    turnEndedAt: null,
    current: null,
    toolCalls: 0,
    agents: s.agents.filter(a => a.phase === 'running'),
    health: { ...s.health, editedFiles: [], needsYou: null },
  }
}

export function endTurn(s: WatchSnapshot, now: number, failed: boolean): WatchSnapshot {
  return {
    ...s,
    phase: failed ? 'error' : 'done',
    turnEndedAt: now,
    current: null,
    health: { ...s.health, needsYou: null },
  }
}

export function startCall(s: WatchSnapshot, call: WatchCall): WatchSnapshot {
  const isQuestion = call.tool === 'AskUserQuestion'
  const agents = call.agentId
    ? s.agents.map(a => (a.id === call.agentId ? { ...a, current: call.label, toolCalls: a.toolCalls + 1 } : a))
    : s.agents
  return {
    ...s,
    phase: isQuestion ? 'waiting_question' : call.agentId ? s.phase : 'tool',
    current: call.agentId ? s.current : call,
    toolCalls: s.toolCalls + 1,
    lastEventAt: call.startedAt,
    agents,
    health: isQuestion
      ? { ...s.health, needsYou: { kind: 'question', since: call.startedAt } }
      : s.health,
  }
}

export function endCall(s: WatchSnapshot, call: WatchCall, keep: number): WatchSnapshot {
  const agents = call.agentId
    ? s.agents.map(a => (a.id === call.agentId ? { ...a, current: undefined } : a))
    : s.agents
  const isMine = s.current?.id === call.id
  const stillWaiting = s.health.needsYou && s.health.needsYou.kind !== 'question' && s.health.needsYou.kind !== 'permission'
  return {
    ...s,
    phase: isMine ? 'thinking' : s.phase,
    current: isMine ? null : s.current,
    recent: [...s.recent, call].slice(-Math.max(keep, 50)),
    lastEventAt: call.startedAt + (call.durationMs ?? 0),
    agents,
    health: { ...s.health, needsYou: stillWaiting ? s.health.needsYou : null },
  }
}

export function agentStart(s: WatchSnapshot, id: string, type: string, now: number): WatchSnapshot {
  const rest = s.agents.filter(a => a.id !== id)
  return { ...s, agents: [...rest, { id, type, phase: 'running' as const, startedAt: now, toolCalls: 0 }].slice(-20) }
}

export type AgentSeen = { id: string; label: string; status: string }

// Merge the engine's agent list (polled each tick). Classic Subagent events can be
// passed by before this mod's hooks run, so the list is the reliable source.
export function syncAgents(s: WatchSnapshot, seen: readonly AgentSeen[], now: number): WatchSnapshot {
  const phaseOf = (status: string): WatchSnapshot['agents'][number]['phase'] =>
    status === 'completed' ? 'done' : status === 'failed' || status === 'killed' ? 'failed' : status === 'idle' ? 'idle' : 'running'
  let agents = s.agents
  let changed = false
  for (const a of seen) {
    const phase = phaseOf(a.status)
    const known = agents.find(x => x.id === a.id)
    if (!known) {
      if (phase !== 'running') continue // finished before we saw it run; nothing to show
      agents = [...agents, { id: a.id, type: a.label, phase, startedAt: now, toolCalls: 0 }]
      changed = true
    } else if (known.phase !== phase || known.type !== a.label) {
      const ended = phase === 'running' ? undefined : (known.endedAt ?? now)
      agents = agents.map(x => (x.id === a.id ? { ...x, type: a.label, phase, endedAt: ended, current: ended ? undefined : x.current } : x))
      changed = true
    }
  }
  return changed ? { ...s, agents: agents.slice(-20) } : s
}

export function agentStop(s: WatchSnapshot, id: string, phase: 'done' | 'failed' | 'idle', now: number): WatchSnapshot {
  return { ...s, agents: s.agents.map(a => (a.id === id ? { ...a, phase, endedAt: now, current: undefined } : a)) }
}
