import type { WatchPeer, WatchSnapshot } from '../types'
import { basename } from './format'

export function heartbeatOf(s: WatchSnapshot, now: number, label: string | undefined, endedAt?: number): WatchPeer {
  return {
    sessionId: s.sessionId,
    project: basename(s.cwd),
    cwd: s.cwd,
    branch: s.branch,
    phase: s.phase,
    label,
    turnStartedAt: s.turnStartedAt,
    tasksDone: s.plan?.steps.filter(t => t.status === 'done' || t.status === 'failed').length ?? 0,
    tasksTotal: s.plan?.steps.length ?? 0,
    needsYou: s.health.needsYou?.kind,
    beatAt: now,
    endedAt,
  }
}

