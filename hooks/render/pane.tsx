import type { WatchCall, WatchConfig, WatchPeer, WatchSnapshot, WatchTab, WatchUi } from '../../types'
import { CHOICES, getPath } from '../config'
import { estimateMs, median } from '../estimate'
import { ago, basename, pct, seconds, time, truncate } from '../format'
import { resolve, type Semantic } from './colors'
import { Bar, Card, Donut, Gantt, inner, Mark, Pill, Pulse, Row, Sparkline, type GanttLane, type Kit } from './widgets'

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

// 'turn' is the adaptive dashboard; the others are detail views reached by /watch <tab>.
export const TABS: readonly WatchTab[] = ['turn', 'plan', 'agents', 'sessions', 'health', 'config']

const COMPACT_BELOW = 60

const PHASE_LABEL: Record<WatchSnapshot['phase'], string> = {
  idle: 'Idle',
  thinking: 'Thinking',
  tool: 'Running',
  waiting_permission: 'Needs you',
  waiting_question: 'Needs you',
  subagent: 'Agents working',
  error: 'Error',
  done: 'Done',
}

export function phaseSem(phase: WatchSnapshot['phase']): Semantic {
  if (phase === 'error') return 'attention'
  if (phase === 'waiting_permission' || phase === 'waiting_question') return 'warn'
  if (phase === 'done') return 'ok'
  if (phase === 'idle') return 'dim'
  return 'accent'
}

export const isActive = (s: WatchSnapshot) => s.turnStartedAt !== null && s.turnEndedAt === null

export function turnElapsed(s: WatchSnapshot, now: number): number {
  if (s.turnStartedAt === null) return 0
  return (s.turnEndedAt ?? now) - s.turnStartedAt
}

export function currentEta(s: WatchSnapshot, history: Record<string, number[]>, cfg: WatchConfig, now: number) {
  const c = s.current
  if (!c || !cfg.estimate.enabled) return undefined
  const m = /timeout=(\d+)/.exec(c.note ?? '')
  return estimateMs(history[c.key], now - c.startedAt, cfg.estimate.minSamples, m ? Number(m[1]) : undefined)
}

export function etaText(eta: ReturnType<typeof currentEta>, cfg: WatchConfig): string | undefined {
  if (!eta) return undefined
  if (eta.confidence === 'max') return `up to ${time(eta.remainingMs, cfg.timeFormat)}`
  if (eta.remainingMs === 0) return 'overdue'
  return `${eta.confidence}${time(eta.remainingMs, cfg.timeFormat)} left`
}

export function planEta(s: WatchSnapshot): { done: number; total: number; remainingMs?: number } {
  const total = s.tasks.length
  const done = s.tasks.filter(t => t.status === 'done').length
  const durations = s.tasks.filter(t => t.status === 'done' && t.endedAt && t.startedAt).map(t => t.endedAt! - t.startedAt!)
  if (durations.length === 0 || done === total) return { done, total }
  return { done, total, remainingMs: (total - done) * median(durations) }
}

// One-line summary for the spinner suffix and the sessions board.
// `short` drops the command and elapsed time, which Claude Code's own spinner already shows.
export function summary(v: Pick<View, 's' | 'history' | 'now'> & { cfg: WatchConfig; short?: boolean }): string {
  const { s, cfg, now } = v
  const parts: string[] = []
  if (s.current && !v.short) parts.push(s.current.label, time(now - s.current.startedAt, cfg.timeFormat))
  const eta = etaText(currentEta(s, v.history, cfg, now), cfg)
  if (eta) parts.push(eta)
  const p = planEta(s)
  if (p.total > 0) parts.push(`${p.done}/${p.total} tasks`)
  if (s.health.needsYou) parts.push('needs you')
  return truncate(parts.join(' · '), cfg.spinnerMaxChars)
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

export function Pane(v: View) {
  const { Box, Button, Text } = v.k.els
  const gap = v.k.cfg.theme === 'dense' ? 0 : 1
  if (v.ui.tab === 'turn') {
    return (
      <Box flexDirection="column" gap={gap}>
        {Dashboard(v)}
      </Box>
    )
  }
  const detail =
    v.ui.tab === 'plan'
      ? PlanDetail(v)
      : v.ui.tab === 'agents'
        ? AgentsDetail(v)
        : v.ui.tab === 'sessions'
          ? SessionsDetail(v)
          : v.ui.tab === 'health'
            ? HealthDetail(v)
            : ConfigDetail(v)
  return (
    <Box flexDirection="column" gap={gap}>
      <Box flexDirection="row" gap={1}>
        <Button key="back" label="← dashboard" hotkey="b" onPress={() => v.actions.tab('turn')} />
        <Text dimColor>{v.ui.tab}</Text>
      </Box>
      {detail}
    </Box>
  )
}

// ── Dashboard: sections appear only when they have something to say ──

function Dashboard(v: View) {
  const compact = v.k.cfg.compact || v.k.columns < COMPACT_BELOW
  const sections = [
    NeedsYouCard(v),
    NowCard(v),
    compact ? null : FailureCard(v),
    compact ? null : PlanCard(v),
    compact ? null : AgentsCard(v),
    compact ? null : RecentCard(v),
    StatusPills(v),
    compact ? null : OtherSessions(v),
  ]
  return sections.filter(Boolean)
}

function NeedsYouCard(v: View) {
  const { s, now, k } = v
  if (!s.health.needsYou) return null
  const { Text } = k.els
  const hint = s.health.needsYou.kind === 'permission' ? 'Review the prompt below to continue.' : 'Answer in the prompt below.'
  return Card(k, 'needs-you', <Text bold>{needsYouText(s, now)}</Text>, undefined, [<Text dimColor>{hint}</Text>], 'warn')
}

function NowCard(v: View) {
  const { s, now, k } = v
  const { Box, Text } = k.els
  const cfg = k.cfg
  const sem = phaseSem(s.phase)
  const active = isActive(s)

  if (s.turnStartedAt === null) {
    return Card(k, 'now', 'Watcher', undefined, [<Text dimColor>Waiting for a prompt.</Text>])
  }

  const title = (
    <Box flexDirection="row" gap={1}>
      {active ? Pulse(k, sem) : Mark(k, s.phase === 'error' ? '✗' : '✓', sem)}
      <Text bold>{PHASE_LABEL[s.phase]}</Text>
    </Box>
  )
  const p = planEta(s)
  const right = [time(turnElapsed(s, now), cfg.timeFormat), p.remainingMs ? `~${time(p.remainingMs, cfg.timeFormat)} left` : undefined].filter(Boolean).join(' · ')

  if (!active) {
    const failed = s.recent.filter(c => c.ok === false).length
    const line = `${s.toolCalls} tool calls${failed ? ` · ${failed} failed` : ''}${s.tasks.length ? ` · ${p.done}/${p.total} tasks` : ''}`
    return Card(k, 'now', title, right, [<Text dimColor>{line}</Text>], sem)
  }

  const body: unknown[] = []
  if (s.current) {
    const eta = currentEta(s, v.history, cfg, now)
    body.push(Row(k, <Text wrap="truncate-end">{truncate(s.current.label, inner(k) - 9)}</Text>, time(now - s.current.startedAt, cfg.timeFormat)))
    if (eta) body.push(Bar(k, 'now-bar', eta.fraction, eta.remainingMs === 0 ? 'warn' : 'accent', etaText(eta, cfg) ?? ''))
  } else {
    const last = s.recent[s.recent.length - 1]
    if (last && last.durationMs !== undefined) {
      body.push(<Text dimColor wrap="truncate-end">{`last: ${truncate(last.label, inner(k) - 20)} · ${ago(now - (last.startedAt + last.durationMs))}`}</Text>)
    } else if (s.toolCalls) {
      body.push(<Text dimColor>{`${s.toolCalls} tool calls so far`}</Text>)
    }
  }
  return Card(k, 'now', title, right, body, sem)
}

function FailureCard(v: View) {
  const { s, k, now } = v
  const t = s.health.lastTest
  if (!t || t.ok || !k.cfg.visuals.failedTestSnippet) return null
  if (s.turnStartedAt !== null && t.at < s.turnStartedAt) return null
  const { Text, Code } = k.els
  const body: unknown[] = [<Text dimColor>{truncate(t.command, inner(k))}</Text>]
  if (t.snippet) body.push(Code ? <Code source={t.snippet} /> : <Text>{t.snippet}</Text>)
  return Card(k, 'failure', `Tests failed · ${t.failed} of ${t.passed + t.failed}`, ago(now - t.at), body, 'attention')
}

function taskRow(v: View, t: WatchSnapshot['tasks'][number]) {
  const { k, now } = v
  const { Text } = k.els
  const glyph = t.status === 'done' ? '✓' : t.status === 'running' ? '▶' : '○'
  const sem: Semantic = t.status === 'done' ? 'ok' : t.status === 'running' ? 'accent' : 'dim'
  const dur = t.startedAt ? time((t.endedAt ?? now) - t.startedAt, k.cfg.timeFormat) : ''
  return Row(
    k,
    <Text wrap="truncate-end">
      {Mark(k, glyph, sem)} {t.status === 'pending' ? <Text dimColor>{t.title}</Text> : t.title}
    </Text>,
    dur,
  )
}

function PlanCard(v: View) {
  const { s, k } = v
  if (s.tasks.length === 0) return null
  const p = planEta(s)
  // The running task with one before and up to three after; the rest is in /watch plan.
  const idx = Math.max(0, s.tasks.findIndex(t => t.status !== 'done'))
  const from = Math.max(0, idx - 1)
  const shown = s.tasks.slice(from, from + 5)
  const { Text } = k.els
  const more = s.tasks.length - shown.length
  return Card(k, 'plan', 'Plan', `${p.done}/${p.total}`, [
    Bar(k, 'plan-bar', p.total ? p.done / p.total : 0, p.done === p.total ? 'ok' : 'accent', `${Math.round((p.done / Math.max(1, p.total)) * 100)}%`),
    ...shown.map(t => taskRow(v, t)),
    more > 0 ? <Text dimColor>{`+${more} more · /watch plan`}</Text> : null,
  ])
}

function agentSem(a: WatchSnapshot['agents'][number]): Semantic {
  return a.phase === 'running' ? 'accent' : a.phase === 'done' ? 'ok' : a.phase === 'failed' ? 'attention' : 'dim'
}

function agentRow(v: View, a: WatchSnapshot['agents'][number]) {
  const { k, now } = v
  const { Text } = k.els
  const glyph = a.phase === 'running' ? '▶' : a.phase === 'done' ? '✓' : a.phase === 'failed' ? '✗' : '○'
  return Row(
    k,
    <Text wrap="truncate-end">
      {Mark(k, glyph, agentSem(a))} {a.type}
      <Text dimColor>{a.current ? `  ${truncate(a.current, 30)}` : ''}</Text>
    </Text>,
    time((a.endedAt ?? now) - a.startedAt, k.cfg.timeFormat),
  )
}

function lanes(v: View): GanttLane[] {
  const { s, now } = v
  return [
    ...(s.turnStartedAt !== null ? [{ label: 'main', start: s.turnStartedAt, end: s.turnEndedAt ?? now, sem: phaseSem(s.phase) }] : []),
    ...s.agents.map(a => ({ label: a.type, start: a.startedAt, end: a.endedAt ?? now, sem: agentSem(a), failed: a.phase === 'failed' })),
  ]
}

function ganttFrom(v: View): number {
  const { s, now, k } = v
  return Math.max(now - k.cfg.visuals.ganttWindowMinutes * 60_000, Math.min(s.turnStartedAt ?? now, ...s.agents.map(a => a.startedAt)))
}

function AgentsCard(v: View) {
  const { s, k, now } = v
  if (s.agents.length === 0) return null
  const running = s.agents.filter(a => a.phase === 'running').length
  return Card(k, 'agents', 'Agents', running ? `${running} running` : `${s.agents.length} done`, [
    ...s.agents.slice(-4).map(a => agentRow(v, a)),
    Gantt(k, 'agents-gantt', lanes(v), ganttFrom(v), now),
  ])
}

function callRow(v: View, c: WatchCall) {
  const { k, now } = v
  const { Text } = k.els
  const glyph = c.ok === undefined ? '▶' : c.ok ? '✓' : '✗'
  const sem: Semantic = c.ok === undefined ? 'accent' : c.ok ? 'ok' : 'attention'
  const note = c.note && !c.note.startsWith('timeout=') ? c.note : undefined
  return Row(
    k,
    <Text wrap="truncate-end">
      {Mark(k, glyph, sem)} {truncate(c.label, inner(k) - (note ? note.length + 12 : 10))}
      {note ? <Text color={resolve('attention', k.cfg)}>{`  ${note}`}</Text> : null}
    </Text>,
    seconds(c.durationMs ?? now - c.startedAt),
  )
}

function RecentCard(v: View) {
  const { s, k } = v
  const done = s.recent.filter(c => c.durationMs !== undefined)
  if (done.length === 0) return null
  const count = Math.min(k.cfg.showRecentCalls, 6)
  return Card(k, 'recent', 'Recent', `${s.toolCalls} calls`, [
    ...done.slice(-count).map(c => callRow(v, c)),
    Sparkline(
      k,
      'recent-spark',
      done.slice(-40).map(c => c.durationMs ?? 0),
    ),
  ])
}

function StatusPills(v: View) {
  const { s, k } = v
  const { Box } = k.els
  const hl = s.health
  const ctxSem: Semantic | undefined =
    hl.contextPct === undefined ? undefined : hl.contextPct >= 90 ? 'attention' : hl.contextPct >= k.cfg.health.contextWarnPct ? 'warn' : undefined
  const t = hl.lastTest
  const pills = [
    s.branch ? Pill(k, `${s.branch}${hl.dirtyFiles ? ` · ${hl.dirtyFiles} dirty` : ''}`, undefined) : null,
    hl.contextPct !== undefined ? Pill(k, `ctx ${pct(hl.contextPct)}`, ctxSem) : null,
    t ? Pill(k, t.ok ? (t.passed ? `${t.passed} tests ✓` : 'tests ✓') : `${t.failed} failed ✗`, t.ok ? 'ok' : 'attention') : null,
    hl.lastLint && !hl.lastLint.ok ? Pill(k, 'lint ✗', 'attention') : null,
    hl.lastBuild && !hl.lastBuild.ok ? Pill(k, 'build ✗', 'attention') : null,
    hl.lastError ? Pill(k, hl.lastError.kind, 'attention') : null,
    s.model ? Pill(k, shortModel(s.model), undefined) : null,
    k.cfg.health.showCost && hl.costUsd !== undefined ? Pill(k, `$${hl.costUsd.toFixed(2)}`, undefined) : null,
  ].filter(Boolean)
  if (pills.length === 0) return null
  return (
    <Box key="pills" flexDirection="row" columnGap={2} flexWrap="wrap">
      {pills.slice(0, 6)}
    </Box>
  )
}

// "claude-opus-5-5" → "opus 5.5"; other ids pass through.
export function shortModel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id)
  return m ? `${m[1]} ${m[2]}.${m[3]}` : id.replace(/^claude-/, '')
}

function OtherSessions(v: View) {
  const { k, s, peers } = v
  const waiting = peers.filter(p => p.sessionId !== s.sessionId && p.needsYou && !p.endedAt)
  if (waiting.length === 0) return null
  const { Button, Text } = k.els
  const n = waiting.length
  return (
    <Button key="other-sessions" plain onPress={() => v.actions.tab('sessions')}>
      <Text color={resolve('warn', k.cfg)}>⏸</Text>
      {` ${n} other session${n > 1 ? 's need' : ' needs'} you: ${waiting.map(p => p.project).join(', ')}`}
    </Button>
  )
}

// ── Detail views (/watch <tab>) ──

function PlanDetail(v: View) {
  const { s, k, now } = v
  const { Text } = k.els
  if (s.tasks.length === 0) return Card(k, 'plan', 'Plan', undefined, [<Text dimColor>No task list this turn.</Text>])
  const p = planEta(s)
  const right = [`${p.done}/${p.total}`, time(turnElapsed(s, now), k.cfg.timeFormat), p.remainingMs ? `~${time(p.remainingMs, k.cfg.timeFormat)} left` : undefined]
    .filter(Boolean)
    .join(' · ')
  return Card(k, 'plan', 'Plan', right, [
    Bar(k, 'plan-bar', p.done / Math.max(1, p.total), 'accent', `${Math.round((p.done / Math.max(1, p.total)) * 100)}%`),
    ...s.tasks.map(t => taskRow(v, t)),
  ])
}

function AgentsDetail(v: View) {
  const { s, k, now } = v
  const { Text } = k.els
  if (s.agents.length === 0) return Card(k, 'agents', 'Agents', undefined, [<Text dimColor>No subagents this session.</Text>])
  return Card(k, 'agents', 'Agents', `${s.agents.filter(a => a.phase === 'running').length} running`, [
    ...s.agents.map(a => agentRow(v, a)),
    Gantt(k, 'agents-gantt', lanes(v), ganttFrom(v), now),
  ])
}

export function visiblePeers(peers: readonly WatchPeer[], cfg: WatchConfig, now: number): WatchPeer[] {
  const hideAfter = cfg.sessions.hideEndedAfterMinutes * 60_000
  return peers.filter(p => !(p.endedAt && now - p.endedAt > hideAfter) && now - p.beatAt < Math.max(hideAfter, 3_600_000))
}

function SessionsDetail(v: View) {
  const { k, now } = v
  const { Box, Text, Button } = k.els
  const cfg = k.cfg
  if (!cfg.sessions.shareState) return Card(k, 'sessions', 'Sessions', undefined, [<Text dimColor>Session sharing is off.</Text>])
  const list = visiblePeers(v.peers, cfg, now).filter(p => v.ui.scope === 'all' || p.sessionId === v.s.sessionId)
  const staleMs = cfg.sessions.staleAfterSeconds * 1000
  const rows = list.map(p => {
    const busy = p.phase !== 'done' && p.phase !== 'idle'
    const stale = !p.endedAt && busy && now - p.beatAt > staleMs
    const name = cfg.sessions.showCwd === 'hidden' ? p.sessionId.slice(0, 8) : cfg.sessions.showCwd === 'full' ? p.cwd : p.project
    const sem: Semantic = p.needsYou ? 'warn' : stale || p.endedAt || !busy ? 'dim' : p.phase === 'error' ? 'attention' : 'accent'
    const state = p.needsYou ? 'NEEDS YOU' : p.endedAt ? `ended ${ago(now - p.endedAt)}` : busy ? truncate(p.label ?? p.phase, 28) : 'idle'
    const elapsed = busy && p.turnStartedAt && !p.endedAt ? time(now - p.turnStartedAt, cfg.timeFormat) : ''
    return (
      <Button key={`peer-${p.sessionId}`} plain onPress={() => v.actions.copy(`claude --resume ${p.sessionId}`)}>
        <Text color={resolve(sem, cfg)}>{stale || !busy ? '○' : '●'}</Text> {truncate(name, 16)}
        <Text dimColor>{p.branch ? ` ${truncate(p.branch, 14)}` : ''}</Text> {p.needsYou ? <Text color={resolve('warn', cfg)}>{state}</Text> : <Text dimColor>{state}</Text>}
        <Text dimColor>{` ${elapsed}${p.tasksTotal ? ` ${p.tasksDone}/${p.tasksTotal}` : ''}${p.sessionId === v.s.sessionId ? ' (this)' : ''}`}</Text>
      </Button>
    )
  })
  return Card(k, 'sessions', `Sessions (${list.length})`, undefined, [
    <Box flexDirection="row" gap={1}>
      <Button key="scope-this" label="this" variant={v.ui.scope === 'this' ? 'primary' : 'secondary'} onPress={() => v.actions.scope('this')} />
      <Button key="scope-all" label="all" variant={v.ui.scope === 'all' ? 'primary' : 'secondary'} onPress={() => v.actions.scope('all')} />
    </Box>,
    ...rows,
    list.length === 0 ? <Text dimColor>No sessions yet.</Text> : <Text dimColor>Press a session to copy its resume command.</Text>,
  ])
}

function HealthDetail(v: View) {
  const { s, k, now } = v
  const { Box, Text } = k.els
  const cfg = k.cfg
  const hl = s.health
  const t = hl.lastTest
  const ctxSem: Semantic = (hl.contextPct ?? 0) >= 90 ? 'attention' : (hl.contextPct ?? 0) >= cfg.health.contextWarnPct ? 'warn' : 'ok'
  const line = (name: string, value: unknown) => (
    <Box flexDirection="row">
      <Text dimColor>{name.padEnd(10)}</Text>
      {value}
    </Box>
  )
  const none = <Text dimColor>—</Text>
  const status = (ok: boolean | undefined) => (ok === undefined ? none : <Text color={resolve(ok ? 'ok' : 'attention', cfg)}>{ok ? '✓' : '✗'}</Text>)
  return Card(k, 'health', 'Health', undefined, [
    line('Needs you', hl.needsYou ? <Text color={resolve('warn', cfg)}>{needsYouText(s, now)}</Text> : none),
    line(
      'Tests',
      t ? <Text color={resolve(t.ok ? 'ok' : 'attention', cfg)}>{`${t.ok ? '✓' : '✗'} ${t.failed ? `${t.failed} failed / ` : ''}${t.passed} passed · ${ago(now - t.at)}`}</Text> : none,
    ),
    line('Lint', status(hl.lastLint?.ok)),
    line('Build', status(hl.lastBuild?.ok)),
    cfg.health.gitStatus
      ? line('Git', <Text wrap="truncate-end">{`${s.branch ?? '—'} · ${hl.dirtyFiles ?? '?'} dirty${hl.editedFiles.length ? ` · edited ${hl.editedFiles.map(basename).join(', ')}` : ''}`}</Text>)
      : null,
    line(
      'Context',
      hl.contextPct !== undefined ? (
        <Box flexDirection="row" gap={1}>
          {Donut(k, hl.contextPct / 100, ctxSem)}
          <Text>{pct(hl.contextPct)}</Text>
          <Text dimColor>{hl.compactions ? `· ${hl.compactions} compactions` : ''}</Text>
        </Box>
      ) : (
        none
      ),
    ),
    hl.rateLimitPct !== undefined ? line('Limits', <Text>{`${pct(hl.rateLimitPct)} of rate limit`}</Text>) : null,
    line('Model', <Text>{`${s.model ?? '—'}${s.effort ? ` · effort ${s.effort}` : ''}`}</Text>),
    line('Errors', hl.lastError ? <Text color={resolve('attention', cfg)}>{`${hl.lastError.kind} · ${ago(now - hl.lastError.at)}`}</Text> : <Text dimColor>none</Text>),
    cfg.health.showCost && hl.costUsd !== undefined ? line('Cost', <Text>{`$${hl.costUsd.toFixed(2)} this session`}</Text>) : null,
  ])
}

const TOGGLES = [
  'spinnerSuffix',
  'compact',
  'animations',
  'useSvg',
  'useRaster',
  'visuals.cards',
  'visuals.pills',
  'visuals.gantt',
  'visuals.sparkline',
  'visuals.contextDonut',
  'visuals.failedTestSnippet',
  'estimate.enabled',
  'attention.band',
  'attention.toast',
  'sessions.shareState',
  'health.parseTestOutput',
  'health.gitStatus',
  'health.showCost',
  'redactCommands',
  'idleTimer',
]

function ConfigDetail(v: View) {
  const { k } = v
  const { Text, Button } = k.els
  const cfg = k.cfg
  const enumRows = Object.entries(CHOICES).map(([path, values]) => {
    const current = String(getPath(cfg, path))
    const next = values[(values.indexOf(current) + 1) % values.length]!
    return (
      <Button key={`cfg-${path}`} plain onPress={() => v.actions.set(path, next)}>
        {path.padEnd(26)}
        <Text color={resolve('accent', cfg)}>{current}</Text>
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
  return Card(k, 'config', 'Settings', 'press to change', [...enumRows, ...toggleRows, <Text dimColor>{'Numbers and lists: /watch config set <path> <value>'}</Text>])
}
