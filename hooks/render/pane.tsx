import type { WatchCall, WatchConfig, WatchHistoryEvent, WatchHistoryTurn, WatchPeer, WatchPlan, WatchPlanStep, WatchSnapshot, WatchTab, WatchUi } from '../../types'
import { filterHistory, isProblem } from '../history'
import { CHOICES, getPath } from '../config'
import { estimateMs } from '../estimate'
import { planProgress } from '../plan'
import { ago, basename, pct, seconds, time, truncate } from '../format'
import { resolve, type Semantic } from './colors'
import { Bar, Card, Donut, Gantt, inner, Mark, MiniBar, Pulse, Row, SectionLabel, Sparkline, type GanttLane, type Kit } from './widgets'

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
    toggle: (id: string) => void
    cycleFilter: () => void
    clearHistory: () => void
    dismissPlan: () => void
    pick: (value: string) => void
    filter: (value: string) => void
  }
}

// 'turn' is the adaptive dashboard; the others are detail views reached by /watch <tab>.
export const TABS: readonly WatchTab[] = ['turn', 'plan', 'agents', 'calls', 'history', 'sessions', 'health', 'config']

// The VS Code side panel is ~45-55 columns; only truly tiny panes go compact.
const COMPACT_BELOW = 36

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
  const exact = history[c.key]
  const samples = exact && exact.length > 0 ? exact : c.kindKey ? history[c.kindKey] : undefined
  return estimateMs(samples, now - c.startedAt, cfg.estimate.minSamples, m ? Number(m[1]) : undefined)
}

export function etaText(eta: ReturnType<typeof currentEta>, cfg: WatchConfig): string | undefined {
  if (!eta) return undefined
  if (eta.confidence === 'max') return `up to ${time(eta.remainingMs, cfg.timeFormat)}`
  if (eta.remainingMs === 0) return 'overdue'
  return `${eta.confidence}${time(eta.remainingMs, cfg.timeFormat)} left`
}

// One-line summary for the spinner suffix and the sessions board.
// `short` drops the command and elapsed time, which Claude Code's own spinner already shows.
export function summary(v: Pick<View, 's' | 'history' | 'now'> & { cfg: WatchConfig; short?: boolean }): string {
  const { s, cfg, now } = v
  const parts: string[] = []
  if (s.current && !v.short) parts.push(s.current.label, time(now - s.current.startedAt, cfg.timeFormat))
  const eta = etaText(currentEta(s, v.history, cfg, now), cfg)
  if (eta) parts.push(eta)
  const p = s.plan ? planProgress(s.plan) : undefined
  if (p && p.total > 0) parts.push(`${p.done}/${p.total} tasks`)
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
    const compact = v.k.cfg.compact || (v.k.surface === 'terminal' && v.k.columns < COMPACT_BELOW)
    // Live state on top; history pinned below it, pushed to the bottom by a spacer.
    return (
      <Box flexDirection="column" gap={gap} flexGrow={1}>
        {Dashboard(v)}
        <Box key="spacer" flexGrow={1} />
        {HistorySection(v, compact ? 'line' : 'dashboard')}
      </Box>
    )
  }
  const detail =
    v.ui.tab === 'plan'
      ? PlanDetail(v)
      : v.ui.tab === 'agents'
        ? AgentsDetail(v)
        : v.ui.tab === 'calls'
          ? CallsDetail(v)
          : v.ui.tab === 'history'
          ? HistorySection(v, 'full')
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

// ── Dashboard: does anything need me, which step is it on, is it stuck ──

const STALL_MS = 90_000
const DONE_SHOWN = 6
const PENDING_SHOWN = 2

function Dashboard(v: View) {
  const compact = v.k.cfg.compact || (v.k.surface === 'terminal' && v.k.columns < COMPACT_BELOW)
  return [AttentionCard(v), PlanCard(v, compact), compact ? null : TimelineCard(v), HealthLine(v)].filter(Boolean)
}

// Usual duration of the running call and how far past it we are.
function callTiming(v: View): { elapsed: number; usual?: number } | undefined {
  const { s, now, history, k } = v
  if (!s.current) return undefined
  const elapsed = now - s.current.startedAt
  const eta = currentEta(s, history, k.cfg, now)
  const usual = eta && eta.confidence !== 'max' ? Math.max(eta.remainingMs + elapsed, 1000) : undefined
  return { elapsed, usual }
}

function stallText(v: View): string | undefined {
  const { s, now, k } = v
  if (!isActive(s)) return undefined
  const t = callTiming(v)
  if (t?.usual && t.elapsed > 2 * t.usual && t.elapsed > 10_000) return `⏳ ${truncate(s.current!.label, 40)} running ${(t.elapsed / t.usual).toFixed(1)}× its usual time`
  const quiet = s.lastEventAt ? now - s.lastEventAt : 0
  if (!s.current && quiet > STALL_MS) return `⏳ no activity for ${time(quiet, k.cfg.timeFormat)}`
  return undefined
}

// The only red/amber card: needs-you, failing tests, stop errors, stalls.
function AttentionCard(v: View) {
  const { s, k, now } = v
  const { Text, Code } = k.els
  if (s.health.needsYou) {
    const hint = s.health.needsYou.kind === 'permission' ? 'Review the prompt below to continue.' : 'Answer in the prompt below.'
    return Card(k, 'attention', <Text bold>{`⏸ ${needsYouText(s, now)}`}</Text>, undefined, [<Text dimColor>{hint}</Text>], 'warn')
  }
  const t = s.health.lastTest
  if (t && !t.ok && (s.turnStartedAt === null || t.at >= s.turnStartedAt)) {
    const step = s.plan?.steps.find(x => x.lastTest === t || (x.lastTest && x.lastTest.at === t.at))
    const body: unknown[] = [<Text dimColor>{truncate(`${step ? `${step.title} · ` : ''}${t.command}`, inner(k))}</Text>]
    if (t.snippet && k.cfg.visuals.failedTestSnippet) body.push(Code ? <Code source={t.snippet} /> : <Text>{t.snippet}</Text>)
    return Card(k, 'attention', <Text bold>{`✗ ${t.failed} test${t.failed === 1 ? '' : 's'} failing`}</Text>, ago(now - t.at), body, 'attention')
  }
  const err = s.health.lastError
  if (err && s.turnStartedAt !== null && err.at >= s.turnStartedAt) {
    return Card(k, 'attention', <Text bold>{`✗ Claude stopped: ${err.kind}`}</Text>, ago(now - err.at), err.text ? [<Text dimColor>{truncate(err.text, inner(k) * 2)}</Text>] : [], 'attention')
  }
  const stall = stallText(v)
  if (stall) return Card(k, 'attention', <Text bold>{stall}</Text>, undefined, [], 'warn')
  return null
}

function planSem(v: View, plan: WatchPlan): Semantic {
  if (v.s.health.needsYou) return 'warn'
  if (plan.steps.some(x => x.status === 'failed')) return 'attention'
  if (plan.endedAt) return 'ok'
  return isActive(v.s) ? 'accent' : 'dim'
}

function planHeader(v: View, plan: WatchPlan) {
  const { k } = v
  const { Box, Text, Button } = k.els
  const active = isActive(v.s)
  const sem = planSem(v, plan)
  const ticket = plan.ticket && !plan.title.includes(plan.ticket) ? plan.ticket : undefined
  return (
    <Box flexDirection="row" gap={1}>
      {active && !plan.endedAt ? Pulse(k, 'accent') : Mark(k, plan.endedAt ? '✓' : '○', plan.endedAt ? 'ok' : sem === 'attention' ? 'attention' : 'dim')}
      <Text wrap="truncate-end">
        {ticket ? <Text color={resolve('accent', k.cfg)}>{`${ticket} · `}</Text> : null}
        <Text bold>{plan.title || 'Working'}</Text>
      </Text>
      <Button key="plan-dismiss" plain label="✕" onPress={() => v.actions.dismissPlan()} />
    </Box>
  )
}

// What the turn is doing right now, or its receipt once it ended.
function liveLine(v: View, indent: string) {
  const { s, k } = v
  const { Text } = k.els
  const cfg = k.cfg
  if (!isActive(s)) {
    // No turn since /clear: nothing to account for.
    if (s.turnStartedAt === null) return null
    const turnStart = s.turnStartedAt
    const steps = s.plan?.steps.filter(x => (x.status === 'done' || x.status === 'failed') && (x.endedAt ?? 0) >= turnStart).length ?? 0
    const t = s.health.lastTest && s.health.lastTest.at >= turnStart ? s.health.lastTest : undefined
    const facts = [`turn done · ${s.toolCalls} calls`, steps ? `${steps} steps` : undefined, t ? (t.ok ? 'tests ✓' : 'tests ✗') : undefined, s.health.editedFiles.length ? `${s.health.editedFiles.length} files` : undefined]
    return <Text dimColor>{`${indent}${facts.filter(Boolean).join(' · ')}`}</Text>
  }
  const timing = callTiming(v)
  if (s.current && timing) {
    const usual = timing.usual ? `usually ~${time(timing.usual, cfg.timeFormat)}` : 'first run'
    return Row(
      k,
      <Text wrap="truncate-end">
        {indent}
        {Mark(k, '▶', 'accent')} {truncate(s.current.label, inner(k) - indent.length - 22)}
        <Text dimColor>{`  ${usual}`}</Text>
      </Text>,
      time(timing.elapsed, cfg.timeFormat),
    )
  }
  return <Text dimColor>{`${indent}thinking${s.toolCalls ? ` · ${s.toolCalls} tool calls` : ''}`}</Text>
}

function stepGlyph(step: WatchPlanStep): [string, Semantic] {
  switch (step.status) {
    case 'done':
      return ['✓', 'ok']
    case 'failed':
      return ['✗', 'attention']
    case 'running':
      return ['▶', 'accent']
    default:
      return ['○', 'dim']
  }
}

function stepRow(v: View, step: WatchPlanStep) {
  const { k, now } = v
  const { Text } = k.els
  const [glyph, sem] = stepGlyph(step)
  const dur = step.startedAt !== undefined ? time((step.endedAt ?? now) - step.startedAt, k.cfg.timeFormat) : ''
  return Row(
    k,
    <Text wrap="truncate-end">
      {Mark(k, glyph, sem)} {step.status === 'pending' ? <Text dimColor>{step.title}</Text> : step.title}
    </Text>,
    dur,
  )
}

// The running step's detail: live call, files and calls, tests, substeps.
function stepDetail(v: View, step: WatchPlanStep, full: boolean): unknown[] {
  const { k } = v
  const { Text } = k.els
  const pad = '    '
  const lines: unknown[] = []
  if (step.status === 'running') lines.push(liveLine(v, pad))
  if (step.editedFiles.length || step.calls) {
    const files = step.editedFiles.length ? `edited ${step.editedFiles.map(basename).join(', ')} · ` : ''
    lines.push(<Text dimColor wrap="truncate-end">{`${pad}${files}${step.calls} calls`}</Text>)
  }
  if (step.lastTest) {
    const t = step.lastTest
    lines.push(t.ok ? <Text dimColor>{`${pad}tests ✓${t.passed ? ` ${t.passed}` : ''}`}</Text> : <Text color={resolve('attention', k.cfg)}>{`${pad}tests ✗ ${t.failed} failed`}</Text>)
    if (full && !t.ok && t.snippet && k.els.Code) {
      const { Code } = k.els
      lines.push(<Code source={t.snippet} />)
    }
  }
  if (step.substeps?.length) {
    const subs = step.substeps.map(x => `${x.done ? '[x]' : '[ ]'} ${x.title}`)
    if (full) for (const x of subs) lines.push(<Text dimColor>{`${pad}${x}`}</Text>)
    else {
      const done = step.substeps.filter(x => x.done).length
      const next = step.substeps.find(x => !x.done)
      const text = next ? `○ next: ${next.title} · ${done} of ${step.substeps.length} done` : `✓ all ${step.substeps.length} sub-steps done`
      lines.push(<Text dimColor wrap="truncate-end">{`${pad}${truncate(text, inner(k) - pad.length)}`}</Text>)
    }
  }
  return lines
}

function PlanCard(v: View, compact: boolean) {
  const { s, k, now } = v
  const { Text } = k.els
  const cfg = k.cfg
  const plan = s.plan
  if (!plan) return Card(k, 'plan', 'Watcher', undefined, [<Text dimColor>Waiting for a prompt.</Text>])
  const end = plan.endedAt ?? (isActive(s) ? now : (s.turnEndedAt ?? now))
  const right = time(end - plan.startedAt, cfg.timeFormat)
  if (compact) return Card(k, 'plan', planHeader(v, plan), right, [], planSem(v, plan))

  const body: unknown[] = []
  const p = planProgress(plan)
  if (p.total === 0) {
    body.push(liveLine(v, ''))
    return Card(k, 'plan', planHeader(v, plan), right, body, planSem(v, plan))
  }
  const label = p.done === p.total ? 'all steps done' : `${p.done} / ${p.total}${p.remainingMs ? ` · ~${time(p.remainingMs, cfg.timeFormat)} left` : ''}`
  body.push(Bar(k, 'plan-bar', p.done / p.total, p.done === p.total ? 'ok' : 'accent', label))

  // Finished steps: failed always shown; beyond DONE_SHOWN done, collapse all but the last two.
  const finished = plan.steps.filter(x => x.status === 'done' || x.status === 'failed')
  const doneOnly = finished.filter(x => x.status === 'done')
  const collapsed = doneOnly.length > DONE_SHOWN ? new Set(doneOnly.slice(0, -2).map(x => x.id)) : new Set<string>()
  let collapsedShown = false
  for (const step of plan.steps) {
    if (step.status === 'pending') continue
    if (collapsed.has(step.id)) {
      if (!collapsedShown) {
        const sum = doneOnly.slice(0, -2).reduce((t, x) => t + ((x.endedAt ?? 0) - (x.startedAt ?? x.endedAt ?? 0)), 0)
        body.push(Row(k, <Text>{Mark(k, '✓', 'ok')}{` ${collapsed.size} steps done`}</Text>, time(sum, cfg.timeFormat)))
        collapsedShown = true
      }
      continue
    }
    body.push(stepRow(v, step))
    if (step.status === 'running') body.push(...stepDetail(v, step, false))
  }
  if (!p.current) body.push(liveLine(v, ''))
  const pending = plan.steps.filter(x => x.status === 'pending')
  for (const step of pending.slice(0, PENDING_SHOWN)) body.push(stepRow(v, step))
  if (pending.length > PENDING_SHOWN) body.push(<Text dimColor>{`+${pending.length - PENDING_SHOWN} more · /watch plan`}</Text>)
  return Card(k, 'plan', planHeader(v, plan), right, body, planSem(v, plan))
}

// One plain line: context with its trend, git, tests, other sessions waiting.
function HealthLine(v: View) {
  const { s, k, peers } = v
  const { Box, Text, Button } = k.els
  const hl = s.health
  const items: unknown[] = []
  if (hl.contextPct !== undefined) {
    const sem: Semantic | undefined = hl.contextPct >= 90 ? 'attention' : hl.contextPct >= k.cfg.health.contextWarnPct ? 'warn' : undefined
    const trend = [...hl.contextHistory, Math.round(hl.contextPct)]
    items.push(
      <Box key="ctx" flexDirection="row" gap={1} alignItems="center">
        {sem ? <Text color={resolve(sem, k.cfg)}>{`ctx ${pct(hl.contextPct)}`}</Text> : <Text dimColor>{`ctx ${pct(hl.contextPct)}`}</Text>}
        {MiniBar(k, 'ctx-bar', hl.contextPct / 100, sem ?? 'dim', k.cfg.health.contextWarnPct / 100)}
        {trend.length >= 3 ? Sparkline(k, 'ctx-trend', trend, { sem: sem ?? 'dim', cells: 20, max: 100, alt: 'context per turn' }) : null}
      </Box>,
    )
  }
  if (s.branch) items.push(<Text dimColor>{`${s.branch}${hl.dirtyFiles ? ` · ${hl.dirtyFiles} dirty` : ''}`}</Text>)
  const t = hl.lastTest
  if (t) items.push(<Text dimColor>{t.ok ? `tests ✓${t.passed ? ` ${t.passed}` : ''}` : `tests ✗ ${t.failed}`}</Text>)
  const waiting = peers.filter(x => x.sessionId !== s.sessionId && x.needsYou && !x.endedAt)
  if (waiting.length) {
    const n = waiting.length
    items.push(
      <Button key="other-sessions" plain onPress={() => v.actions.tab('sessions')}>
        <Text color={resolve('warn', k.cfg)}>{`⏸ ${n} other session${n > 1 ? 's need' : ' needs'} you`}</Text>
      </Button>,
    )
  }
  if (items.length === 0) return null
  return (
    <Box key="health" flexDirection="row" columnGap={2} flexWrap="wrap">
      {items}
    </Box>
  )
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

// One timeline for main and every agent: parallelism, slow lanes, failures at once.
function TimelineCard(v: View) {
  const { s, k, now } = v
  if (s.agents.length === 0) return null
  const running = s.agents.filter(a => a.phase === 'running')
  const failed = s.agents.filter(a => a.phase === 'failed')
  const right = [running.length ? `${running.length} running` : undefined, failed.length ? `${failed.length} failed` : undefined].filter(Boolean).join(' · ') || `${s.agents.length} done`
  const chart = Gantt(k, 'timeline', lanes(v), ganttFrom(v), now)
  // Under the chart, only the lanes worth a line: running (what they do) and failed.
  const rows = [...running, ...failed].slice(0, 4).map(a => agentRow(v, a))
  return Card(k, 'timeline', 'Timeline', right, [chart ?? s.agents.slice(-4).map(a => agentRow(v, a)), ...(chart ? rows : [])])
}

// "claude-opus-5-5" → "opus 5.5"; other ids pass through.
export function shortModel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id)
  return m ? `${m[1]} ${m[2]}.${m[3]}` : id.replace(/^claude-/, '')
}

// ── History: every turn and session event, collapsed rows that expand on press ──

const HISTORY_ROWS = 12
const CALLS_SHOWN = 10
const EVENT_ICON: Record<WatchHistoryEvent['icon'], string> = { compact: '⇣', model: '⚙', error: '✗', plan: '☰' }

function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function turnSummary(t: WatchHistoryTurn, n: number, cfg: WatchConfig): string {
  return [
    `Turn ${n} · ${t.title || '(no prompt)'}`,
    t.interrupted ? 'interrupted' : t.ended ? time(t.durationMs ?? 0, cfg.timeFormat) : 'running',
    `${t.calls.length + t.moreCalls} calls`,
    t.tests ? (t.tests.ok ? 'tests ✓' : 'tests ✗') : undefined,
    t.files.length ? `${t.files.length} file${t.files.length === 1 ? '' : 's'}` : undefined,
    t.waitMs ? `waited ${time(t.waitMs, cfg.timeFormat)}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
}

function turnDetail(v: View, t: WatchHistoryTurn, full: boolean): unknown[] {
  const { k } = v
  const { Text, Code } = k.els
  const cfg = k.cfg
  const pad = '     '
  const lines: unknown[] = []
  for (const st of t.steps) {
    const [glyph, sem] = st.status === 'done' ? ['✓', 'ok'] : st.status === 'failed' ? ['✗', 'attention'] : st.status === 'running' ? ['▶', 'accent'] : ['○', 'dim']
    lines.push(<Text>{pad}{Mark(k, glyph, sem as Semantic)}{` step: ${st.title}`}</Text>)
  }
  const calls = full ? t.calls : t.calls.slice(-CALLS_SHOWN)
  const hidden = t.moreCalls + (t.calls.length - calls.length)
  if (hidden > 0) lines.push(<Text dimColor>{`${pad}+${hidden} earlier calls`}</Text>)
  for (const c of calls) {
    const ok = c.ok !== false
    lines.push(
      Row(
        k,
        <Text wrap="truncate-end">
          {pad}
          {Mark(k, ok ? '✓' : '✗', ok ? 'ok' : 'attention')} {truncate(c.label, inner(k) - 18)}
          {c.note && !c.note.startsWith('timeout=') ? <Text dimColor>{`  ${c.note}`}</Text> : null}
        </Text>,
        c.durationMs !== undefined ? seconds(c.durationMs) : '',
      ),
    )
  }
  if (t.files.length) lines.push(<Text dimColor wrap="truncate-end">{`${pad}edited ${t.files.map(basename).join(', ')}`}</Text>)
  if (t.tests) {
    lines.push(
      t.tests.ok ? <Text dimColor>{`${pad}tests ✓${t.tests.passed ? ` ${t.tests.passed}` : ''}`}</Text> : <Text color={resolve('attention', cfg)}>{`${pad}tests ✗ ${t.tests.failed} failed · ${truncate(t.tests.command, 40)}`}</Text>,
    )
    if (!t.tests.ok && t.tests.snippet && cfg.visuals.failedTestSnippet) lines.push(Code ? <Code source={t.tests.snippet} /> : <Text dimColor>{t.tests.snippet}</Text>)
  }
  if (t.waitMs) lines.push(<Text dimColor>{`${pad}⏸ waited ${time(t.waitMs, cfg.timeFormat)} for permission`}</Text>)
  for (const a of t.agents) lines.push(<Text dimColor>{`${pad}⚙ agent ${a.label} ${time(a.durationMs, cfg.timeFormat)} ${a.ok ? '✓' : '✗'}`}</Text>)
  if (lines.length === 0) lines.push(<Text dimColor>{`${pad}no tool calls`}</Text>)
  return lines
}

function HistorySection(v: View, mode: 'line' | 'dashboard' | 'full') {
  const { k, s } = v
  const { Box, Text, Button } = k.els
  const cfg = k.cfg
  const all = s.history ?? []
  const turns = all.filter((e): e is WatchHistoryTurn => e.kind === 'turn')
  if (all.length === 0) return null
  if (mode === 'line') return <Text key="history" dimColor>{`History · ${turns.length} turn${turns.length === 1 ? '' : 's'} · /watch history`}</Text>
  const filter = v.ui.historyFilter ?? 'all'
  const shown = filterHistory(all, filter).reverse()
  const rows = mode === 'full' ? shown : shown.slice(0, HISTORY_ROWS)
  const number = new Map(turns.map((t, i) => [t.id, i + 1]))
  const open = new Set(v.ui.expanded ?? [])
  const body: unknown[] = []
  for (const e of rows) {
    if (e.kind === 'event') {
      const sem: Semantic = e.icon === 'error' ? 'attention' : 'dim'
      body.push(
        <Text key={`hist-${e.id}`} wrap="truncate-end">
          <Text dimColor>{`  ${clock(e.at)}  `}</Text>
          {Mark(k, EVENT_ICON[e.icon], sem)}
          <Text dimColor>{` ${e.text}`}</Text>
        </Text>,
      )
      continue
    }
    const expanded = mode === 'full' || open.has(e.id)
    const sem: Semantic = isProblem(e) ? 'attention' : e.ended ? 'dim' : 'accent'
    body.push(
      // One line per row. Only the glyph is a control (surfaces draw Buttons as chips);
      // a problem row gets a red edge, not red text.
      <Box key={`row-${e.id}`} flexDirection="row" gap={1}>
        <Text color={sem === 'attention' ? resolve('attention', cfg) : undefined}>{sem === 'attention' ? '▌' : ' '}</Text>
        <Button key={`hist-${e.id}`} plain label={expanded ? '▾' : '▸'} onPress={() => v.actions.toggle(e.id)} />
        <Text wrap="truncate-end" color={sem === 'accent' ? resolve('accent', cfg) : undefined}>
          {truncate(`${clock(e.at)}  ${turnSummary(e, number.get(e.id) ?? 0, cfg)}`, inner(k) - 6)}
        </Text>
      </Box>,
    )
    if (expanded) body.push(...turnDetail(v, e, mode === 'full'))
  }
  if (shown.length > rows.length) body.push(<Text dimColor>{`+${shown.length - rows.length} older · /watch history`}</Text>)
  if (rows.length === 0) body.push(<Text dimColor>{filter === 'problems' ? 'No problems so far.' : 'Nothing yet.'}</Text>)
  return (
    <Box key="history" flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        {SectionLabel(k, 'HISTORY')}
        <Box flexDirection="row" gap={1}>
          <Button key="history-filter" plain onPress={() => v.actions.cycleFilter()}>
            <Text dimColor>{`[${filter}]`}</Text>
          </Button>
          <Button key="history-clear" plain onPress={() => v.actions.clearHistory()}>
            <Text dimColor>[clear]</Text>
          </Button>
        </Box>
      </Box>
      {body}
    </Box>
  )
}

// ── Detail views (/watch <tab>) ──

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

function CallsDetail(v: View) {
  const { s, k } = v
  const { Text } = k.els
  const done = s.recent.filter(c => c.durationMs !== undefined)
  if (done.length === 0) return Card(k, 'calls', 'Calls', undefined, [<Text dimColor>No tool calls yet.</Text>])
  return Card(k, 'calls', 'Calls', `${s.toolCalls} this turn`, done.slice(-Math.max(k.cfg.showRecentCalls, 20)).map(c => callRow(v, c)))
}

function PlanDetail(v: View) {
  const { s, k, now } = v
  const { Text } = k.els
  const plan = s.plan
  if (!plan || plan.steps.length === 0) return Card(k, 'plan', 'Plan', undefined, [<Text dimColor>No plan steps yet. Read a plan file, or let Claude make a todo list.</Text>])
  const p = planProgress(plan)
  const right = [`${p.done} / ${p.total}`, time((plan.endedAt ?? now) - plan.startedAt, k.cfg.timeFormat), p.remainingMs ? `~${time(p.remainingMs, k.cfg.timeFormat)} left` : undefined]
    .filter(Boolean)
    .join(' · ')
  const body: unknown[] = [Bar(k, 'plan-bar', p.done / Math.max(1, p.total), 'accent', `${Math.round((p.done / Math.max(1, p.total)) * 100)}%`)]
  if (plan.path) body.push(<Text dimColor wrap="truncate-end">{plan.path}</Text>)
  for (const step of plan.steps) {
    body.push(stepRow(v, step))
    if (step.status !== 'pending') body.push(...stepDetail(v, step, true))
  }
  return Card(k, 'plan', planHeader(v, plan), right, body, planSem(v, plan))
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
