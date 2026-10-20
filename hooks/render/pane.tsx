import type { WatchCall, WatchConfig, WatchPeer, WatchSnapshot, WatchTab, WatchUi } from '../../types'
import { CHOICES, getPath } from '../config'
import { estimateMs, median } from '../estimate'
import { ago, basename, pct, seconds, time, truncate } from '../format'
import type { Semantic } from './colors'
import { resolve } from './colors'
import { Bar, Card, Donut, Gantt, HeatStrip, Pill, Sparkline, spinGlyph, type GanttLane, type Kit } from './widgets'

export type View = {
  k: Kit
  s: WatchSnapshot
  ui: WatchUi
  peers: WatchPeer[]
  history: Record<string, number[]>
  now: number
  actions: {
    tab: (tab: WatchTab) => void
    scope: (scope: 'this' | 'all') => void
    set: (path: string, value: unknown) => void
    copy: (text: string) => void
  }
}

export const TABS: readonly WatchTab[] = ['turn', 'plan', 'agents', 'sessions', 'health', 'config']

const PHASE_LABEL: Record<WatchSnapshot['phase'], string> = {
  idle: 'Idle',
  thinking: 'Thinking',
  tool: 'Running',
  waiting_permission: 'Needs permission',
  waiting_question: 'Waiting for answer',
  subagent: 'Subagents',
  error: 'Error',
  done: 'Done',
}

export function phaseSem(phase: WatchSnapshot['phase']): Semantic {
  if (phase === 'error') return 'attention'
  if (phase === 'waiting_permission' || phase === 'waiting_question') return 'warn'
  if (phase === 'done') return 'ok'
  if (phase === 'idle') return 'dim'
  return 'running'
}

export const isActive = (s: WatchSnapshot) => s.turnStartedAt !== null && s.turnEndedAt === null

export function turnElapsed(s: WatchSnapshot, now: number): number {
  if (s.turnStartedAt === null) return 0
  return (s.turnEndedAt ?? now) - s.turnStartedAt
}

export function currentEta(s: WatchSnapshot, history: Record<string, number[]>, cfg: WatchConfig, now: number) {
  const c = s.current
  if (!c || !cfg.estimate.enabled) return undefined
  return estimateMs(history[c.key], now - c.startedAt, cfg.estimate.minSamples, timeoutOf(c))
}

function timeoutOf(c: WatchCall): number | undefined {
  const m = /timeout=(\d+)/.exec(c.note ?? '')
  return m ? Number(m[1]) : undefined
}

export function etaText(eta: ReturnType<typeof currentEta>, cfg: WatchConfig): string | undefined {
  if (!eta) return undefined
  if (eta.confidence === 'max') return `up to ${time(eta.remainingMs, cfg.timeFormat)}`
  if (eta.remainingMs === 0) return `overdue (${eta.confidence})`
  return `${eta.confidence === '~' ? '~' : '?'}${time(eta.remainingMs, cfg.timeFormat)} left`
}

export function planEta(s: WatchSnapshot): { done: number; total: number; remainingMs?: number } {
  const total = s.tasks.length
  const done = s.tasks.filter(t => t.status === 'done').length
  const durations = s.tasks
    .filter(t => t.status === 'done' && t.endedAt && t.startedAt)
    .map(t => t.endedAt! - t.startedAt!)
  if (durations.length === 0 || done === total) return { done, total }
  return { done, total, remainingMs: (total - done) * median(durations) }
}

// One-line summary used by the spinner suffix and the sessions board.
export function summary(v: Pick<View, 's' | 'history' | 'now'> & { cfg: WatchConfig }): string {
  const { s, cfg, now } = v
  const parts: string[] = []
  if (s.current) parts.push(s.current.label)
  if (s.current) parts.push(time(now - s.current.startedAt, cfg.timeFormat))
  const eta = etaText(currentEta(s, v.history, cfg, now), cfg)
  if (eta) parts.push(eta)
  const p = planEta(s)
  if (p.total > 0) parts.push(`${p.done}/${p.total} tasks`)
  if (s.health.needsYou) parts.push('needs you')
  return truncate(parts.join(' · '), cfg.spinnerMaxChars)
}

export function Pane(v: View) {
  const { els, cfg } = v.k
  const { Box, Text, Button } = els
  const tab = v.ui.tab
  const tabs = (
    <Box flexDirection="row" gap={1} flexWrap="wrap">
      {TABS.map((t, i) => (
        <Button
          key={`tab-${t}`}
          label={t}
          hotkey={String(i + 1)}
          variant={t === tab ? 'primary' : 'secondary'}
          onPress={() => v.actions.tab(t)}
        />
      ))}
    </Box>
  )
  const body =
    tab === 'plan'
      ? PlanTab(v)
      : tab === 'agents'
        ? AgentsTab(v)
        : tab === 'sessions'
          ? SessionsTab(v)
          : tab === 'health'
            ? HealthTab(v)
            : tab === 'config'
              ? ConfigTab(v)
              : TurnTab(v)
  return (
    <Box flexDirection="column" gap={cfg.theme === 'dense' || cfg.compact ? 0 : 1}>
      {tabs}
      {v.s.health.needsYou ? <Text color={resolve('attention', cfg)}>⏸ {needsYouText(v.s, v.now)}</Text> : null}
      {body}
    </Box>
  )
}

export function needsYouText(s: WatchSnapshot, now: number): string {
  const n = s.health.needsYou
  if (!n) return ''
  const what =
    n.kind === 'permission'
      ? 'Claude is waiting for your permission'
      : n.kind === 'question'
        ? 'Claude asked you a question'
        : n.kind === 'elicitation'
          ? 'An MCP server needs your input'
          : 'Claude is waiting for your input'
  return `${what} (${time(now - n.since)})`
}

function callRow(v: View, c: WatchCall) {
  const { Box, Text } = v.k.els
  const cfg = v.k.cfg
  const mark = c.ok === undefined ? '▶' : c.ok ? '✓' : '✗'
  const sem: Semantic = c.ok === undefined ? 'running' : c.ok ? 'ok' : 'attention'
  const width = Math.max(10, v.k.columns - 16)
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Text wrap="truncate-end">
        <Text color={resolve(sem, cfg)}>{mark}</Text> {truncate(c.label, width)}
      </Text>
      <Text dimColor>
        {seconds(c.durationMs ?? v.now - c.startedAt)}
        {c.note && !c.note.startsWith('timeout=') ? `  ${c.note}` : ''}
      </Text>
    </Box>
  )
}

function TurnTab(v: View) {
  const { k, s, now } = v
  const { Box, Text } = k.els
  const cfg = k.cfg
  const eta = currentEta(s, v.history, cfg, now)
  const glyph = isActive(s) ? spinGlyph(cfg, v.ui.tick) : s.phase === 'error' ? '✗' : s.phase === 'done' ? '✓' : '○'
  const headline = s.current ? `${PHASE_LABEL[s.phase]}: ${s.current.label}` : PHASE_LABEL[s.phase]
  const right = [s.current ? time(now - s.current.startedAt, cfg.timeFormat) : undefined, etaText(eta, cfg)].filter(Boolean).join(' · ')
  const running = s.agents.filter(a => a.phase === 'running').length
  const stats = [
    `Turn ${time(turnElapsed(s, now), cfg.timeFormat)}`,
    `tools ${s.toolCalls}`,
    `agents ${running}`,
    s.health.contextPct !== undefined ? `ctx ${pct(s.health.contextPct)}` : undefined,
  ].filter(Boolean)
  const recent = s.recent.slice(-cfg.showRecentCalls)
  const done = s.recent.filter(c => c.durationMs !== undefined)
  return Card(k, `${glyph} ${truncate(headline, Math.max(10, k.columns - right.length - 6))}`, right || undefined, [
    s.current && eta ? Bar(k, 'turn-bar', eta.fraction, 'accent') : null,
    <Text dimColor>{stats.join(' · ')}</Text>,
    HeatStrip(
      k,
      'turn-heat',
      done.slice(-30).map(c => (c.ok ? 'ok' : 'attention')),
    ),
    Sparkline(
      k,
      'turn-spark',
      done.slice(-30).map(c => c.durationMs ?? 0),
    ),
    recent.length ? <Text dimColor>── recent ──</Text> : <Text dimColor>No tool calls yet.</Text>,
    <Box flexDirection="column">{recent.map(c => callRow(v, c))}</Box>,
  ])
}

function PlanTab(v: View) {
  const { k, s, now } = v
  const { Box, Text } = k.els
  const cfg = k.cfg
  if (s.tasks.length === 0) {
    return Card(k, 'Plan', undefined, [
      <Text dimColor>No task list this turn. Claude creates one with the task tool for multi-step work.</Text>,
    ])
  }
  const p = planEta(s)
  const right = [`${p.done}/${p.total}`, time(turnElapsed(s, now), cfg.timeFormat), p.remainingMs ? `~${time(p.remainingMs, cfg.timeFormat)} left` : undefined]
    .filter(Boolean)
    .join(' · ')
  return Card(k, 'Plan', right, [
    Bar(k, 'plan-bar', p.total ? p.done / p.total : 0, 'ok'),
    <Box flexDirection="column">
      {s.tasks.map(t => {
        const mark = t.status === 'done' ? '✓' : t.status === 'running' ? '▶' : '○'
        const sem: Semantic = t.status === 'done' ? 'ok' : t.status === 'running' ? 'running' : 'queued'
        const dur = t.startedAt ? time((t.endedAt ?? now) - t.startedAt, cfg.timeFormat) : ''
        const extra = t.status === 'running' && s.current ? `  (${truncate(s.current.label, 24)})` : ''
        return (
          <Box flexDirection="row" justifyContent="space-between">
            <Text wrap="truncate-end">
              <Text color={resolve(sem, cfg)}>{mark}</Text> {t.title}
              <Text dimColor>{extra}</Text>
            </Text>
            <Text dimColor>{dur}</Text>
          </Box>
        )
      })}
    </Box>,
  ])
}

function AgentsTab(v: View) {
  const { k, s, now } = v
  const { Box, Text } = k.els
  const cfg = k.cfg
  const rows = s.agents
  const mainLabel = s.current ? s.current.label : PHASE_LABEL[s.phase]
  const windowMs = cfg.visuals.ganttWindowMinutes * 60_000
  const from = Math.max(now - windowMs, Math.min(s.turnStartedAt ?? now, ...rows.map(a => a.startedAt)))
  const lanes: GanttLane[] = [
    ...(s.turnStartedAt !== null
      ? [{ label: 'main', start: s.turnStartedAt, end: s.turnEndedAt ?? now, sem: phaseSem(s.phase) }]
      : []),
    ...rows.map(a => ({
      label: a.type,
      start: a.startedAt,
      end: a.endedAt ?? now,
      sem: (a.phase === 'failed' ? 'attention' : a.phase === 'done' ? 'ok' : a.phase === 'idle' ? 'dim' : 'running') as Semantic,
      failed: a.phase === 'failed',
    })),
  ]
  return Card(k, 'Agents', `${rows.filter(a => a.phase === 'running').length} running`, [
    <Box flexDirection="row" justifyContent="space-between">
      <Text>
        <Text bold>main</Text> <Text color={resolve(phaseSem(s.phase), cfg)}>{isActive(s) ? '▶' : '○'}</Text> {truncate(mainLabel, k.columns - 20)}
      </Text>
      <Text dimColor>{time(turnElapsed(s, now), cfg.timeFormat)}</Text>
    </Box>,
    <Box flexDirection="column">
      {rows.map((a, i) => {
        const branch = i === rows.length - 1 ? '└' : '├'
        const mark = a.phase === 'running' ? '▶' : a.phase === 'done' ? '✓' : a.phase === 'failed' ? '✗' : '○'
        const sem: Semantic = a.phase === 'running' ? 'running' : a.phase === 'done' ? 'ok' : a.phase === 'failed' ? 'attention' : 'dim'
        return (
          <Box flexDirection="row" justifyContent="space-between">
            <Text wrap="truncate-end">
              {' '}
              {branch} {a.type} <Text color={resolve(sem, cfg)}>{mark}</Text> {a.current ? truncate(a.current, 40) : ''}
              <Text dimColor> {a.toolCalls} tools</Text>
            </Text>
            <Text dimColor>{time((a.endedAt ?? now) - a.startedAt, cfg.timeFormat)}</Text>
          </Box>
        )
      })}
    </Box>,
    rows.length === 0 ? <Text dimColor>No subagents this session.</Text> : null,
    Gantt(k, 'agents-gantt', lanes, from, now),
  ])
}

export function visiblePeers(peers: readonly WatchPeer[], cfg: WatchConfig, now: number): WatchPeer[] {
  const hideAfter = cfg.sessions.hideEndedAfterMinutes * 60_000
  return peers.filter(p => !(p.endedAt && now - p.endedAt > hideAfter) && now - p.beatAt < Math.max(hideAfter, 3_600_000))
}

function SessionsTab(v: View) {
  const { k, now } = v
  const { Box, Text, Button } = k.els
  const cfg = k.cfg
  const list = visiblePeers(v.peers, cfg, now).filter(p => v.ui.scope === 'all' || p.sessionId === v.s.sessionId)
  const staleMs = cfg.sessions.staleAfterSeconds * 1000
  const scope = (
    <Box flexDirection="row" gap={1}>
      <Button key="scope-this" label="this" variant={v.ui.scope === 'this' ? 'primary' : 'secondary'} onPress={() => v.actions.scope('this')} />
      <Button key="scope-all" label="all" variant={v.ui.scope === 'all' ? 'primary' : 'secondary'} onPress={() => v.actions.scope('all')} />
    </Box>
  )
  if (!cfg.sessions.shareState) {
    return Card(k, 'Sessions', undefined, [<Text dimColor>Session sharing is off (sessions.shareState).</Text>])
  }
  return Card(k, `Sessions (${list.length})`, undefined, [
    scope,
    <Box flexDirection="column">
      {list.map(p => {
        const busy = p.phase !== 'done' && p.phase !== 'idle'
        const stale = !p.endedAt && busy && now - p.beatAt > staleMs
        const name = cfg.sessions.showCwd === 'hidden' ? p.sessionId.slice(0, 8) : cfg.sessions.showCwd === 'full' ? p.cwd : p.project
        const state = p.needsYou
          ? '⏸ NEEDS YOU'
          : p.endedAt
            ? `✓ ended ${ago(now - p.endedAt)}`
            : p.phase === 'done' || p.phase === 'idle'
              ? `✓ idle`
              : `▶ ${truncate(p.label ?? p.phase, 24)}`
        const sem: Semantic = p.needsYou ? 'warn' : stale || p.endedAt ? 'dim' : p.phase === 'error' ? 'attention' : 'running'
        const elapsed = p.turnStartedAt && !p.endedAt && p.phase !== 'done' && p.phase !== 'idle' ? time(now - p.turnStartedAt, cfg.timeFormat) : ''
        const tasks = p.tasksTotal ? `${p.tasksDone}/${p.tasksTotal}` : ''
        const mine = p.sessionId === v.s.sessionId
        return (
          <Button key={`peer-${p.sessionId}`} plain onPress={() => v.actions.copy(`claude --resume ${p.sessionId}`)}>
            <Text color={resolve(sem, cfg)}>{stale ? '○' : '●'}</Text> {truncate(name, 16)}
            <Text dimColor> {truncate(p.branch ?? '', 14)}</Text> <Text color={resolve(sem, cfg)}>{state}</Text>
            <Text dimColor>
              {' '}
              {elapsed} {tasks} {p.needsYou ?? ''}
              {mine ? ' (this)' : ''}
            </Text>
          </Button>
        )
      })}
    </Box>,
    list.length === 0 ? <Text dimColor>No sessions yet.</Text> : null,
    <Text dimColor>Press a session to copy its resume command.</Text>,
  ])
}

function HealthTab(v: View) {
  const { k, s, now } = v
  const { Box, Text, Markdown, Code } = k.els
  const cfg = k.cfg
  const hl = s.health
  const t = hl.lastTest
  const testLine = t
    ? `${t.ok ? '✓' : '✗'} ${t.failed ? `${t.failed} failed / ` : ''}${t.passed} passed (${ago(now - t.at)}, ${t.runner}, parsed)`
    : '—'
  const ctxSem: Semantic = (hl.contextPct ?? 0) >= cfg.health.contextWarnPct ? 'warn' : 'ok'
  const pills = [
    Pill(k, t ? (t.ok ? 'tests ✓' : 'tests ✗') : 'tests —', t ? (t.ok ? 'ok' : 'attention') : 'dim'),
    Pill(k, hl.lastLint ? (hl.lastLint.ok ? 'lint ✓' : 'lint ✗') : 'lint —', hl.lastLint ? (hl.lastLint.ok ? 'ok' : 'attention') : 'dim'),
    Pill(k, hl.lastBuild ? (hl.lastBuild.ok ? 'build ✓' : 'build ✗') : 'build —', hl.lastBuild ? (hl.lastBuild.ok ? 'ok' : 'attention') : 'dim'),
    Pill(k, hl.contextPct !== undefined ? `ctx ${pct(hl.contextPct)}` : 'ctx —', hl.contextPct !== undefined ? ctxSem : 'dim'),
    Pill(k, hl.lastError ? 'error' : 'no errors', hl.lastError ? 'attention' : 'ok'),
  ]
  const snippet =
    t && !t.ok && t.snippet && cfg.visuals.failedTestSnippet
      ? Markdown && v.k.surface !== 'terminal'
        ? <Markdown text={'```\n' + t.snippet + '\n```'} />
        : Code
          ? <Code source={t.snippet} />
          : <Text dimColor>{t.snippet}</Text>
      : null
  return Card(k, 'Health', undefined, [
    <Text>
      <Text bold>Needs you: </Text>
      {hl.needsYou ? <Text color={resolve('attention', cfg)}>{needsYouText(s, now)}</Text> : '—'}
    </Text>,
    <Text>
      <Text bold>Tests: </Text>
      <Text color={resolve(t ? (t.ok ? 'ok' : 'attention') : 'dim', cfg)}>{testLine}</Text>
      {'   '}
      <Text bold>Lint: </Text>
      {hl.lastLint ? (hl.lastLint.ok ? '✓' : '✗') : '—'}
      {'   '}
      <Text bold>Build: </Text>
      {hl.lastBuild ? (hl.lastBuild.ok ? '✓' : '✗') : '—'}
    </Text>,
    snippet,
    cfg.health.gitStatus ? (
      <Text wrap="truncate-end">
        <Text bold>Git: </Text>
        {s.branch ?? '—'} · {hl.dirtyFiles ?? '?'} dirty · edited: {hl.editedFiles.length ? hl.editedFiles.map(basename).join(', ') : '—'}
      </Text>
    ) : null,
    <Box flexDirection="row" gap={1} alignItems="center">
      <Text bold>Context: </Text>
      {hl.contextPct !== undefined ? Donut(k, hl.contextPct / 100, ctxSem) : <Text dimColor>—</Text>}
      <Text dimColor>
        {hl.contextPct !== undefined ? pct(hl.contextPct) : ''}
        {hl.compactions ? ` · ${hl.compactions} compactions` : ''}
        {hl.rateLimitPct !== undefined ? ` · rate limit ${pct(hl.rateLimitPct)}` : ''}
      </Text>
    </Box>,
    <Text>
      <Text bold>Model: </Text>
      {s.model ?? '—'}
      {s.effort ? ` · effort ${s.effort}` : ''}
      {'   '}
      <Text bold>Rate: </Text>
      {toolRate(s, now)}
    </Text>,
    <Text>
      <Text bold>Errors: </Text>
      {hl.lastError ? <Text color={resolve('attention', cfg)}>{`${hl.lastError.kind} ${ago(now - hl.lastError.at)}`}</Text> : 'none'}
      {cfg.health.showCost && hl.costUsd !== undefined ? `   Cost: ~$${hl.costUsd.toFixed(2)} this session` : ''}
    </Text>,
    <Box flexDirection="row" gap={1} flexWrap="wrap">
      {pills}
    </Box>,
  ])
}

function toolRate(s: WatchSnapshot, now: number): string {
  const elapsed = turnElapsed(s, now)
  if (elapsed < 1000 || s.toolCalls === 0) return '—'
  return `${(s.toolCalls / (elapsed / 60_000)).toFixed(1)} tools/min`
}

const TOGGLES = [
  'spinnerSuffix',
  'compact',
  'useSvg',
  'useRaster',
  'animations',
  'visuals.cards',
  'visuals.pills',
  'visuals.gantt',
  'visuals.sparkline',
  'visuals.contextDonut',
  'visuals.heatStrip',
  'visuals.failedTestSnippet',
  'estimate.enabled',
  'attention.band',
  'attention.toast',
  'sessions.shareState',
  'health.parseTestOutput',
  'health.gitStatus',
  'health.showCost',
  'showToolBadge',
  'redactCommands',
  'idleTimer',
]

function ConfigTab(v: View) {
  const { k } = v
  const { Box, Text, Button } = k.els
  const cfg = k.cfg
  const enumRows = Object.entries(CHOICES).map(([path, values]) => {
    const current = String(getPath(cfg, path))
    const next = values[(values.indexOf(current) + 1) % values.length]!
    return (
      <Button key={`cfg-${path}`} plain onPress={() => v.actions.set(path, next)}>
        {path}: <Text color={resolve('accent', cfg)}>{current}</Text>
      </Button>
    )
  })
  const toggleRows = TOGGLES.map(path => {
    const on = getPath(cfg, path) === true
    return (
      <Button key={`cfg-${path}`} plain onPress={() => v.actions.set(path, !on)}>
        <Text color={resolve(on ? 'ok' : 'dim', cfg)}>{on ? '[x]' : '[ ]'}</Text> {path}
      </Button>
    )
  })
  return Card(k, 'Config', 'press to change', [
    <Box flexDirection="column">{enumRows}</Box>,
    <Box flexDirection="column">{toggleRows}</Box>,
    <Text dimColor>{'Numbers and lists: /watch config set <path> <value>. Project defaults: .claude/watcher.json'}</Text>,
  ])
}
