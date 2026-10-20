export type WatchPhase =
  | 'idle'
  | 'thinking'
  | 'tool'
  | 'waiting_permission'
  | 'waiting_question'
  | 'subagent'
  | 'error'
  | 'done'

export type WatchTab = 'turn' | 'plan' | 'agents' | 'calls' | 'history' | 'sessions' | 'health' | 'config'

export type WatchCall = {
  id: string
  tool: string
  label: string
  key: string
  // History key for the kind of step (tests, build, edit…), used when the exact command is new.
  kindKey?: string
  startedAt: number
  durationMs?: number
  ok?: boolean
  note?: string
  agentId?: string
}

export type WatchAgent = {
  id: string
  type: string
  phase: 'running' | 'done' | 'failed' | 'idle'
  startedAt: number
  endedAt?: number
  current?: string
  toolCalls: number
}

export type WatchNeedsYou = { kind: 'permission' | 'question' | 'elicitation' | 'idle'; since: number; text?: string }

export type WatchTestResult = {
  runner: string
  passed: number
  failed: number
  ok: boolean
  at: number
  command: string
  snippet?: string
}

export type WatchChange = { path: string; added: number; removed: number; binary: boolean; lastTurn?: number; byClaude: boolean }

export type WatchCheckRun = { ok: boolean; at: number; passed?: number; failed?: number; snippet?: string; turn: number }
export type WatchCheck = { command: string; kind: 'test' | 'lint' | 'build'; runs: WatchCheckRun[] }

export type WatchHealth = {
  contextPct?: number
  contextTokens?: number
  costUsd?: number
  rateLimitPct?: number
  compactions: number
  lastCompactAt?: number
  lastError?: { kind: string; text?: string; at: number }
  lastTest?: WatchTestResult
  lastLint?: { ok: boolean; at: number; command: string }
  lastBuild?: { ok: boolean; at: number; command: string }
  editedFiles: string[]
  dirtyFiles?: number
  needsYou: WatchNeedsYou | null
  // Context % at each turn end, oldest first, last 20.
  contextHistory: number[]
  // Commit the session started from, and what changed since.
  gitBase?: string
  changes: WatchChange[]
  changesAt?: number
  // Each test/lint/build command's recent runs, by check key.
  checks: Record<string, WatchCheck>
}

export type WatchPlanStep = {
  id: string
  title: string
  status: 'pending' | 'running' | 'done' | 'failed'
  startedAt?: number
  endedAt?: number
  substeps?: { title: string; done: boolean }[]
  calls: number
  editedFiles: string[]
  lastTest?: WatchTestResult
  agentIds: string[]
}

export type WatchPlan = {
  source: 'file' | 'planmode' | 'todo' | 'task' | 'prompt'
  title: string
  ticket?: string
  path?: string
  steps: WatchPlanStep[]
  startedAt: number
  endedAt?: number
}

export type WatchHistoryCall = { label: string; ok?: boolean; durationMs?: number; note?: string }

export type WatchHistoryTurn = {
  kind: 'turn'
  id: string
  at: number
  title: string
  durationMs?: number
  ended: boolean
  // Ended by the next turn starting, not by a turn-complete event (interrupted, or reloaded mid-turn).
  interrupted?: boolean
  failed: boolean
  calls: WatchHistoryCall[]
  moreCalls: number
  files: string[]
  tests?: { ok: boolean; passed: number; failed: number; command: string; snippet?: string }
  steps: { title: string; status: string }[]
  agents: { label: string; ok: boolean; durationMs: number }[]
  waitMs: number
}

export type WatchHistoryEvent = {
  kind: 'event'
  id: string
  at: number
  icon: 'compact' | 'model' | 'error' | 'plan'
  text: string
}

export type WatchHistoryEntry = WatchHistoryTurn | WatchHistoryEvent

export type WatchSnapshot = {
  sessionId: string
  cwd: string
  branch?: string
  model?: string
  effort?: string
  phase: WatchPhase
  // What the turn is for: the prompt's first line.
  goal?: string
  // Last tool start or end, for stall detection.
  lastEventAt?: number
  turnStartedAt: number | null
  turnEndedAt: number | null
  current: WatchCall | null
  toolCalls: number
  recent: WatchCall[]
  agents: WatchAgent[]
  health: WatchHealth
  plan: WatchPlan | null
  // Turns and session events, oldest first.
  history: WatchHistoryEntry[]
}

export type WatchPeer = {
  sessionId: string
  project: string
  cwd: string
  branch?: string
  phase: WatchPhase
  label?: string
  turnStartedAt: number | null
  tasksDone: number
  tasksTotal: number
  needsYou?: string
  beatAt: number
  endedAt?: number
}

export type WatchUi = {
  tab: WatchTab
  // History rows the person opened, by entry id.
  expanded: string[]
  historyFilter: 'all' | 'turns' | 'problems'
  scope: 'this' | 'all'
  mutedUntil: number
  tick: number
}

export type WatchConfig = {
  autoOpen: 'always' | 'onLongTurn' | 'never'
  longTurnSeconds: number
  defaultTab: Exclude<WatchTab, 'config'>
  spinnerSuffix: boolean
  spinnerMaxChars: number
  theme: 'default' | 'minimal' | 'dense'
  compact: boolean
  barWidth: number
  barStyle: 'blocks' | 'dots' | 'ascii'
  useSvg: boolean
  useRaster: boolean
  animations: boolean
  visuals: {
    cards: boolean
    pills: boolean
    gantt: boolean
    sparkline: boolean
    contextDonut: boolean
    heatStrip: boolean
    failedTestSnippet: boolean
    ganttWindowMinutes: number
  }
  showRecentCalls: number
  timeFormat: 'mmss' | 'human'
  colors: { ok: string; warn: string; attention: string; accent: string; dim: string }
  estimate: {
    enabled: boolean
    historySize: number
    minSamples: number
    perProject: boolean
    ignorePatterns: string[]
  }
  attention: {
    band: boolean
    toast: boolean
    desktopNotify: 'always' | 'whenUnfocused' | 'never'
    notifyOnTurnEndAfterSeconds: number
    delaySeconds: number
    sound: boolean
  }
  sessions: {
    shareState: boolean
    heartbeatMs: number
    staleAfterSeconds: number
    hideEndedAfterMinutes: number
    showCwd: 'full' | 'basename' | 'hidden'
  }
  health: {
    contextWarnPct: number
    parseTestOutput: boolean
    gitStatus: boolean
    showCost: boolean
    // Context % at which compaction is expected, for the forecast.
    compactAtPct: number
  }
  showToolBadge: boolean
  redactCommands: boolean
  maxCommandChars: number
  idleTimer: boolean
}

declare module 'claude-code' {
  interface PluginState {
    watcher: {
      snap: WatchSnapshot
      config: WatchConfig
      ui: WatchUi
      peers: WatchPeer[]
      estimates: Record<string, number[]>
    }
  }
}
