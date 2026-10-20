import type { WatchCall, WatchSnapshot } from '../types'

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
  tasks: [],
  agents: [],
  health: { compactions: 0, editedFiles: [], needsYou: null },
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
    tasks: [],
    agents: [],
    health: { ...s.health, editedFiles: [], needsYou: null, lastError: undefined },
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
    tasks: markRunning(s.tasks, call.startedAt),
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

function markRunning(tasks: WatchSnapshot['tasks'], now: number): WatchSnapshot['tasks'] {
  if (tasks.some(t => t.status === 'running')) return tasks
  const next = tasks.find(t => t.status === 'pending')
  return next ? tasks.map(t => (t.id === next.id ? { ...t, status: 'running', startedAt: now } : t)) : tasks
}

export function addTask(s: WatchSnapshot, id: string, title: string, now: number, owner?: string): WatchSnapshot {
  if (s.tasks.some(t => t.id === id)) return s
  return { ...s, tasks: [...s.tasks, { id, title, status: 'pending', createdAt: now, owner }] }
}

// A TodoWrite call carries the whole list each time: replace the tasks, keeping
// timings for titles already known.
export type Todo = { content?: unknown; activeForm?: unknown; status?: unknown }

export function syncTodos(s: WatchSnapshot, todos: readonly Todo[], now: number): WatchSnapshot {
  const known = new Map(s.tasks.map(t => [t.title, t]))
  const tasks = todos
    .filter(t => typeof t.content === 'string')
    .map((t, i) => {
      const title = t.content as string
      const status = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'running' : 'pending'
      const prev = known.get(title)
      const startedAt = status === 'pending' ? undefined : (prev?.startedAt ?? now)
      const endedAt = status === 'done' ? (prev?.endedAt ?? now) : undefined
      return { id: prev?.id ?? `todo-${i}-${title}`, title, status, createdAt: prev?.createdAt ?? now, startedAt, endedAt } as WatchSnapshot['tasks'][number]
    })
  return { ...s, tasks }
}

export function completeTask(s: WatchSnapshot, id: string, title: string, now: number): WatchSnapshot {
  const known = s.tasks.some(t => t.id === id)
  const tasks = known
    ? s.tasks.map(t => (t.id === id ? { ...t, status: 'done' as const, endedAt: now, startedAt: t.startedAt ?? t.createdAt } : t))
    : [...s.tasks, { id, title, status: 'done' as const, createdAt: now, startedAt: now, endedAt: now }]
  return { ...s, tasks: markRunning(tasks, now) }
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
