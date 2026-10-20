export type WatchPhase =
  | 'idle'
  | 'thinking'
  | 'tool'
  | 'waiting_permission'
  | 'waiting_question'
  | 'subagent'
  | 'error'
  | 'done'

export type WatchTab = 'turn' | 'plan' | 'agents' | 'sessions' | 'health' | 'config'

export type WatchCall = {
  id: string
  tool: string
  label: string
  key: string
  startedAt: number
  durationMs?: number
  ok?: boolean
  note?: string
  agentId?: string
}

export type WatchTask = {
  id: string
  title: string
  status: 'pending' | 'running' | 'done'
  createdAt: number
  startedAt?: number
  endedAt?: number
  owner?: string
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
}

export type WatchSnapshot = {
  sessionId: string
  cwd: string
  branch?: string
  model?: string
  effort?: string
  phase: WatchPhase
  turnStartedAt: number | null
  turnEndedAt: number | null
  current: WatchCall | null
  toolCalls: number
  recent: WatchCall[]
  tasks: WatchTask[]
  agents: WatchAgent[]
  health: WatchHealth
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
