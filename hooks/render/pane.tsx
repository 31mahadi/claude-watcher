import type { WatchCall, WatchChange, WatchConfig, WatchHistoryEvent, WatchHistoryTurn, WatchPeer, WatchPlan, WatchPlanStep, WatchSnapshot, WatchTab, WatchUi } from '../../types'
import { changesTotal } from '../changes'
import { checkRows } from '../checks'
import { forecast, forecastText } from '../forecast'
import { filterHistory, isProblem, lastCompactIndex } from '../history'
import { failingLocation, openOptions } from '../openmenu'
import { CHOICES, getPath } from '../config'
import { estimateMs } from '../estimate'
import { isPersistent, planProgress } from '../plan'
import { ago, basename, pct, seconds, time, truncate } from '../format'
import { resolve, STATE_HEX, TINT, type Semantic, type Tint } from './colors'
import { Bar, Card, Donut, Gantt, inner, Mark, MiniBar, Pulse, Row, Badge, Section, Segments, TurnStrip, type GanttLane, type Kit } from './widgets'

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
export const TABS: readonly WatchTab[] = ['turn', 'plan', 'agents', 'calls', 'history', 'checks', 'changes', 'sessions', 'health', 'config']

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
  const { Box } = v.k.els
  const gap = v.k.cfg.theme === 'dense' ? 0 : 1
  if (v.ui.tab === 'turn') {
    // Two blocks: what is happening now on top, history pinned to the bottom with the
    // controls as its last row. The spacer between them takes the pane's spare height.
    const compact = v.k.cfg.compact || (v.k.surface === 'terminal' && v.k.columns < COMPACT_BELOW)
    return (
      <Box flexDirection="column" height={v.k.rows}>
        <Box key="now" flexDirection="column" gap={gap} borderStyle="round" borderColor={STATE_HEX[nowSem(v)]} paddingX={1}>
          {NowBlock(v, compact)}
        </Box>
        <Box key="spacer" flexGrow={1} />
        <Box key="history-block" flexDirection="column" gap={gap} borderStyle="round" borderColor={resolve('dim', v.k.cfg)} paddingX={1}>
          {compact ? null : HistoryGlance(v)}
          {Footer(v)}
        </Box>
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
            : v.ui.tab === 'checks'
              ? ChecksDetail(v)
              : v.ui.tab === 'changes'
                ? ChangesDetail(v)
                : v.ui.tab === 'sessions'
                  ? SessionsDetail(v)
                  : v.ui.tab === 'health'
                    ? HealthDetail(v)
                    : ConfigDetail(v)
  return (
    <Box flexDirection="column" gap={gap}>
      {detail}
      {Footer(v)}
    </Box>
  )
}

// Only the terminal measures real cells; elsewhere the surface cuts text itself.
function fit(k: Kit, text: string, width: number): string {
  return k.surface === 'terminal' ? truncate(text, width) : text
}

const VIEWS: readonly { value: WatchTab; label: string }[] = [
  { value: 'turn', label: 'dashboard' },
  { value: 'plan', label: 'plan' },
  { value: 'history', label: 'history' },
  { value: 'changes', label: 'changes' },
  { value: 'checks', label: 'checks' },
  { value: 'calls', label: 'calls' },
  { value: 'agents', label: 'agents' },
  { value: 'sessions', label: 'sessions' },
  { value: 'health', label: 'health' },
  { value: 'config', label: 'settings' },
]

// The one row of controls: view, history filter, open….
function Footer(v: View) {
  const { k, s } = v
  const { Box, Text, Select } = k.els
  const rule = <Text dimColor wrap="truncate-end">{'─'.repeat(k.surface === 'terminal' ? k.columns : 200)}</Text>
  if (!Select) {
    return (
      <Box key="footer" flexDirection="column">
        {rule}
        <Text dimColor>/watch history · changes · checks · plan · clear</Text>
      </Box>
    )
  }
  const cwd = s.cwd
  const failing = failingLocation(s.health.lastTest && !s.health.lastTest.ok ? s.health.lastTest.snippet : undefined, cwd)
  const open = openOptions({ planPath: s.plan?.path, failing, changes: s.health.changes ?? [], sessionId: s.sessionId })
  const actions = [
    ...open.map(o => ({ value: o.value, label: o.label })),
    ...(s.plan && s.plan.source !== 'prompt' ? [{ value: 'clear-plan', label: 'clear plan' }] : []),
    ...((s.history ?? []).length ? [{ value: 'clear-history', label: 'clear history' }] : []),
  ]
  return (
    <Box key="footer" flexDirection="column">
      {rule}
      <Box flexDirection="row" gap={2} flexWrap="wrap">
        <Select key="view" label="view" value={v.ui.tab} options={VIEWS.map(x => ({ value: x.value, label: x.label }))} onSelect={(value: string) => v.actions.tab(value as WatchTab)} />
        <Select
          key="filter"
          label="history"
          value={v.ui.historyFilter ?? 'all'}
          options={[
            { value: 'all', label: 'all' },
            { value: 'turns', label: 'turns' },
            { value: 'problems', label: 'problems' },
          ]}
          onSelect={(value: string) => v.actions.filter(value)}
        />
        {actions.length ? (
          // A blank first choice: a Select shows its value, and re-picking the shown one fires nothing.
          <Select
            key="open"
            label="actions…"
            value=""
            options={[{ value: '', label: 'choose…' }, ...actions]}
            onSelect={(value: string) => (value ? v.actions.pick(value) : undefined)}
          />
        ) : null}
      </Box>
    </Box>
  )
}

// ── Visual dashboard: picture first, one line of text per idea ──

function stepSem(st: WatchPlanStep['status']): Semantic {
  return st === 'done' ? 'ok' : st === 'failed' ? 'attention' : st === 'running' ? 'accent' : 'dim'
}

// The NOW block's border colour: the state at a glance.
function nowSem(v: View): Semantic {
  const s = v.s
  if (s.health.needsYou) return 'warn'
  const since = s.turnStartedAt ?? Number.POSITIVE_INFINITY
  if ((s.health.lastTest && !s.health.lastTest.ok && s.health.lastTest.at >= since) || (s.health.lastError && s.health.lastError.at >= since)) return 'attention'
  if (isActive(s)) return 'accent'
  if (s.plan?.endedAt) return 'ok'
  return 'dim'
}

// "41s", "21m", "2h 5m": a length of time that never reads like a clock.
function span(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// The NOW block: attention, then labelled rows — PLAN (goal, step progress) and NOW (live line, agents, signals).
function NowBlock(v: View, compact: boolean): unknown[] {
  const { k, s, now } = v
  const { Box, Text } = k.els
  const cfg = k.cfg
  const out: unknown[] = []
  const attention = AttentionCard(v)
  if (attention) out.push(attention)
  const plan = s.plan
  const active = isActive(s)

  // A prompt-only plan says nothing the idle line doesn't; show it while a turn runs.
  if (plan && (plan.steps.length > 0 || active)) {
    const p = planProgress(plan)
    const ticket = plan.ticket && !plan.title.includes(plan.ticket) ? `${plan.ticket} · ` : ''
    const elapsed = `${span((plan.endedAt ?? (active ? now : (s.turnEndedAt ?? now))) - plan.startedAt)} elapsed`
    const position = p.total ? (p.done === p.total ? `all ${p.total} steps done` : `step ${Math.min(p.total, p.done + 1)} of ${p.total}`) : undefined
    const rows: unknown[] = [
      <Box key="goal" flexDirection="row" justifyContent="space-between" gap={1}>
        <Box flexDirection="row" gap={1} flexShrink={1}>
          {active ? Pulse(k, 'accent') : Mark(k, plan.endedAt ? '✓' : '○', plan.endedAt ? 'ok' : 'dim')}
          <Text bold wrap="truncate-end">
            {`${ticket}${plan.title || 'Working'}`}
          </Text>
        </Box>
        <Text dimColor>{[position, elapsed].filter(Boolean).join(' · ')}</Text>
      </Box>,
    ]
    if (p.total) {
      const left = p.done === p.total ? '' : p.remainingMs ? ` · ~${span(p.remainingMs)} left` : ''
      rows.push(
        <Box key="progress" flexDirection="row" justifyContent="space-between" gap={1} alignItems="center">
          {Segments(k, 'plan-segments', plan.steps.map(x => stepSem(x.status)))}
          <Text dimColor>{`${p.done} done${left}`}</Text>
        </Box>,
      )
    }
    out.push(Section(k, 'plan', 'PLAN', rows))
  }
  if (compact) {
    out.push(SignalChips(v))
    return out.filter(Boolean)
  }

  const nowRows: unknown[] = []
  if (active) {
    const step = plan ? planProgress(plan).current : undefined
    const call = s.current ? `${s.current.label} ${span(now - s.current.startedAt)}` : 'thinking'
    nowRows.push(
      <Text key="now-line" wrap="truncate-end">
        {Mark(k, '▶', 'accent')}
        {step ? <Text bold>{` ${step.title}`}</Text> : null}
        <Text color={TINT.teal.fg}>{`  ${call}`}</Text>
      </Text>,
    )
  } else {
    nowRows.push(IdleLine(v))
  }
  if (s.agents.length) {
    const chart = Gantt(k, 'timeline', lanes(v), ganttFrom(v), now)
    nowRows.push(chart ?? <Box key="agents" flexDirection="column">{s.agents.slice(-4).map(a => agentRow(v, a))}</Box>)
  }
  const chips = SignalChips(v)
  if (chips) nowRows.push(chips)
  out.push(Section(k, 'now-rows', 'NOW', nowRows))
  return out.filter(Boolean)
}

// tests ✗✗✓   changes +63 −8   ctx ◔ 57% ~6t — tinted badges.
function SignalChips(v: View) {
  const { k, s } = v
  const { Box, Text } = k.els
  const cfg = k.cfg
  const hl = s.health
  const chips: unknown[] = []
  const checks = checkRows(hl.checks ?? {})
  const test = checks.find(c => c.kind === 'test') ?? checks[0]
  if (test) {
    const last = test.runs[test.runs.length - 1]!
    const tint: Tint = last.ok ? 'ok' : 'attention'
    chips.push(Badge(k, tint, 'tests', test.runs.slice(-5).map(r => (
      <Text color={r.ok ? TINT.ok.fg : TINT.attention.fg}>{r.ok ? '✓' : '✗'}</Text>
    ))))
  }
  if (hl.gitBase) {
    const t = changesTotal(hl.changes ?? [])
    chips.push(Badge(k, t.files ? 'violet' : 'slate', 'files changed', t.files ? `+${t.added} −${t.removed}` : 'none'))
  }
  if (hl.contextPct !== undefined) {
    const tint: Tint = hl.contextPct >= 90 ? 'attention' : hl.contextPct >= cfg.health.contextWarnPct ? 'warn' : 'teal'
    const ring = '○◔◑◕●'[Math.min(4, Math.round((hl.contextPct / 100) * 4))]
    const f = forecast(hl.contextHistory ?? [], lastCompactIndex(s.history ?? []), hl.contextPct, cfg.health.compactAtPct ?? 85)
    const tail = f.kind === 'turns' ? ` · ~${f.turns} turns left` : f.kind === 'next' ? ' · compacts next turn' : ''
    chips.push(Badge(k, tint, 'context', `${ring} ${pct(hl.contextPct)}${tail}`))
  }
  if (chips.length === 0) return null
  return (
    <Box key="signals" flexDirection="row" columnGap={1} rowGap={0} flexWrap="wrap">
      {chips}
    </Box>
  )
}

// HISTORY block glance: a turn strip and the last three turns.
function HistoryGlance(v: View) {
  const { k, s } = v
  const { Box, Text } = k.els
  const cfg = k.cfg
  const turns = (s.history ?? []).filter((e): e is WatchHistoryTurn => e.kind === 'turn')
  if (turns.length === 0) return null
  const ended = turns.filter(t => t.ended).slice(-30)
  const strip = TurnStrip(
    k,
    'turn-strip',
    ended.map(t => ({ ms: t.durationMs ?? 0, sem: isProblem(t) ? 'attention' : 'ok' })),
  )
  const rows = turns.slice(-3).reverse().map(t => (
    <Box key={`row-${t.id}`} flexDirection="row" gap={1}>
      <Text dimColor>{clock(t.at)}</Text>
      {Mark(k, !t.ended ? '▶' : isProblem(t) ? '✗' : '✓', !t.ended ? 'accent' : isProblem(t) ? 'attention' : 'ok')}
      <Text wrap="truncate-end">{fit(k, t.title || '(no prompt)', inner(k) - 18)}</Text>
      <Text dimColor>{t.interrupted ? 'interrupted' : t.ended ? time(t.durationMs ?? 0, 'human') : 'running'}</Text>
    </Box>
  ))
  return (
    <Box key="history" flexDirection="column">
      <Box flexDirection="row" gap={2} alignItems="center">
        <Text dimColor bold>TURNS</Text>
        {strip}
        <Text dimColor>bar height = turn length · red = problem</Text>
      </Box>
      {rows}
    </Box>
  )
}

// ── Dashboard: does anything need me, which step is it on, is it stuck ──

const STALL_MS = 90_000
const DONE_SHOWN = 6
const PENDING_SHOWN = 2

function Dashboard(v: View) {
  const compact = v.k.cfg.compact || (v.k.surface === 'terminal' && v.k.columns < COMPACT_BELOW)
  const attention = AttentionCard(v)
  // Idle: nothing running and nothing to act on → one line, then history.
  if (!isActive(v.s) && !attention && !compact) {
    // What changed and how checks fared matter most right after a turn ends.
    return [IdleLine(v), IdlePlan(v), ChangesSection(v), ChecksSection(v)].filter(Boolean)
  }
  if (compact) return [attention, PlanSection(v, true), ContextSection(v)].filter(Boolean)
  return [attention, PlanSection(v, false), ChangesSection(v), ChecksSection(v), ContextSection(v), TimelineSection(v)].filter(Boolean)
}

// "Idle · last turn 2:11 · 16 calls · tests ✓ · 2 files"  …  "main · ctx 57%"
function IdleLine(v: View) {
  const { k, s } = v
  const { Box, Text } = k.els
  const cfg = k.cfg
  const turns = (s.history ?? []).filter((e): e is WatchHistoryTurn => e.kind === 'turn')
  const last = turns[turns.length - 1]
  const left = last
    ? [
        `Idle · last turn ${last.interrupted ? 'interrupted' : time(last.durationMs ?? 0, cfg.timeFormat)}`,
        `${last.calls.length + last.moreCalls} calls`,
        last.tests ? (last.tests.ok ? 'tests ✓' : 'tests ✗') : undefined,
        last.files.length ? `${last.files.length} file${last.files.length === 1 ? '' : 's'}` : undefined,
      ]
        .filter(Boolean)
        .join(' · ')
    : 'Idle · waiting for a prompt'
  const right = [s.branch, s.health.contextPct !== undefined ? `ctx ${pct(s.health.contextPct)}` : undefined].filter(Boolean).join(' · ')
  return (
    <Box key="idle" flexDirection="row" justifyContent="space-between">
      <Text wrap="truncate-end">{left}</Text>
      {right ? <Text dimColor>{right}</Text> : null}
    </Box>
  )
}

// A file plan that is not finished stays visible while idle: header and bar only.
function IdlePlan(v: View) {
  const plan = v.s.plan
  if (!plan || !isPersistent(plan) || plan.steps.length === 0) return null
  const { Text } = v.k.els
  const p = planProgress(plan)
  if (plan.endedAt) return Section(v.k, 'plan', 'PLAN', [<Text>{Mark(v.k, '✓', 'ok')}{` ${plan.title} · all ${p.total} steps done`}</Text>])
  return Section(v.k, 'plan', 'PLAN', [planHeaderRow(v, plan), Bar(v.k, 'plan-bar', p.done / p.total, 'accent', `${p.done} / ${p.total}`)])
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

// "CAM-77 · Migrate auth"                        "3 / 13 · ~8m   12:40"
function planHeaderRow(v: View, plan: WatchPlan) {
  const { k, s, now } = v
  const { Box, Text } = k.els
  const cfg = k.cfg
  const active = isActive(s)
  const ticket = plan.ticket && !plan.title.includes(plan.ticket) ? plan.ticket : undefined
  const p = planProgress(plan)
  const end = plan.endedAt ?? (active ? now : (s.turnEndedAt ?? now))
  const right = [p.total ? `${p.done} / ${p.total}${p.remainingMs ? ` · ~${time(p.remainingMs, 'human')}` : ''}` : undefined, time(end - plan.startedAt, cfg.timeFormat)]
    .filter(Boolean)
    .join('   ')
  return (
    <Box key="plan-head" flexDirection="row" justifyContent="space-between" gap={1}>
      <Box flexDirection="row" gap={1} flexShrink={1}>
        {active && !plan.endedAt ? Pulse(k, 'accent') : Mark(k, plan.endedAt ? '✓' : '○', plan.endedAt ? 'ok' : 'dim')}
        <Text wrap="truncate-end">
          {ticket ? <Text color={resolve('accent', cfg)}>{`${ticket} · `}</Text> : null}
          <Text bold>{plan.title || 'Working'}</Text>
        </Text>
      </Box>
      <Text dimColor>{right}</Text>
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

// A labelled detail row under a step: "  running   npm test · 0:41 · usually ~1:30".
function detailRow(k: Kit, label: string, value: unknown, sem?: Semantic) {
  const { Box, Text } = k.els
  return (
    <Box flexDirection="row">
      <Text dimColor>{`  ${label.padEnd(9)}`}</Text>
      {typeof value === 'string' ? <Text wrap="truncate-end" color={sem ? resolve(sem, k.cfg) : undefined}>{value}</Text> : value}
    </Box>
  )
}

// The running step's detail: live call, next sub-step, tests, files.
function stepDetail(v: View, step: WatchPlanStep, full: boolean): unknown[] {
  const { k, s } = v
  const { Text, Code } = k.els
  const cfg = k.cfg
  const lines: unknown[] = []
  if (step.status === 'running' && isActive(s)) {
    const timing = callTiming(v)
    if (s.current && timing) {
      const usual = timing.usual ? `usually ~${time(timing.usual, cfg.timeFormat)}` : 'first run'
      lines.push(detailRow(k, 'running', `${s.current.label} · ${time(timing.elapsed, cfg.timeFormat)} · ${usual}`))
    } else {
      lines.push(detailRow(k, 'running', 'thinking'))
    }
  }
  if (step.substeps?.length) {
    const done = step.substeps.filter(x => x.done).length
    if (full) for (const x of step.substeps) lines.push(detailRow(k, '', `${x.done ? '✓' : '○'} ${x.title}`))
    else {
      const next = step.substeps.find(x => !x.done)
      lines.push(detailRow(k, 'next', next ? `${next.title} · ${done} of ${step.substeps.length} done` : `all ${step.substeps.length} done`))
    }
  }
  if (step.lastTest) {
    const t = step.lastTest
    lines.push(detailRow(k, 'tests', t.ok ? `✓${t.passed ? ` ${t.passed} passed` : ''}` : `✗ ${t.failed} failed`, t.ok ? undefined : 'attention'))
    if (full && !t.ok && t.snippet && Code) lines.push(<Code source={t.snippet} />)
  }
  if (step.editedFiles.length || step.calls) {
    const files = step.editedFiles.length ? `${step.editedFiles.map(basename).join(', ')} · ` : ''
    lines.push(detailRow(k, 'files', `${files}${step.calls} calls`))
  }
  return lines
}

// PLAN: header, bar, done steps (collapsed past six), the running step in detail, two pending.
function PlanSection(v: View, compact: boolean) {
  const { s, k, now } = v
  const { Text } = k.els
  const cfg = k.cfg
  const plan = s.plan
  if (!plan) return null
  if (compact) return Section(k, 'plan', 'PLAN', [planHeaderRow(v, plan)])
  const rows: unknown[] = [planHeaderRow(v, plan)]
  const p = planProgress(plan)
  if (p.total === 0) {
    rows.push(liveLine(v, ''))
    return Section(k, 'plan', 'PLAN', rows)
  }
  rows.push(Bar(k, 'plan-bar', p.done / p.total, p.done === p.total ? 'ok' : 'accent', p.done === p.total ? 'all done' : `${Math.round((p.done / p.total) * 100)}%`))
  const finished = plan.steps.filter(x => x.status === 'done' || x.status === 'failed')
  const doneOnly = finished.filter(x => x.status === 'done')
  const collapsed = doneOnly.length > DONE_SHOWN ? new Set(doneOnly.slice(0, -2).map(x => x.id)) : new Set<string>()
  let collapsedShown = false
  for (const step of plan.steps) {
    if (step.status === 'pending') continue
    if (collapsed.has(step.id)) {
      if (!collapsedShown) {
        const sum = doneOnly.slice(0, -2).reduce((t, x) => t + ((x.endedAt ?? 0) - (x.startedAt ?? x.endedAt ?? 0)), 0)
        rows.push(Row(k, <Text>{Mark(k, '✓', 'ok')}{` ${collapsed.size} steps done`}</Text>, time(sum, cfg.timeFormat)))
        collapsedShown = true
      }
      continue
    }
    rows.push(stepRow(v, step))
    if (step.status === 'running') rows.push(...stepDetail(v, step, false))
  }
  if (!p.current) rows.push(liveLine(v, ''))
  const pending = plan.steps.filter(x => x.status === 'pending')
  for (const step of pending.slice(0, PENDING_SHOWN)) rows.push(stepRow(v, step))
  if (pending.length > PENDING_SHOWN) rows.push(<Text dimColor>{`+${pending.length - PENDING_SHOWN} more`}</Text>)
  void now
  return Section(k, 'plan', 'PLAN', rows)
}

// CHANGES: Claude's edits with +N −M and the turn; yours dim below; a total.
function ChangesSection(v: View) {
  const { k, s } = v
  const { Text } = k.els
  const rows0 = s.health.changes ?? []
  if (rows0.length === 0) return null
  const mine = rows0.filter(r => r.byClaude)
  const yours = rows0.filter(r => !r.byClaude)
  const rows: unknown[] = []
  for (const r of mine.slice(0, 6)) rows.push(changeRow(k, r, false))
  if (mine.length > 6) rows.push(<Text dimColor>{`+${mine.length - 6} more`}</Text>)
  if (yours.length) rows.push(<Text dimColor>{`also changed (yours): ${yours.length} file${yours.length === 1 ? '' : 's'}`}</Text>)
  const t = changesTotal(rows0)
  if (t.files) rows.push(<Text dimColor>{`${t.files} files · +${t.added} −${t.removed}`}</Text>)
  return Section(k, 'changes', 'CHANGES', rows)
}

function changeRow(k: Kit, r: WatchChange, dim: boolean) {
  const { Box, Text } = k.els
  const counts = r.binary ? 'bin' : r.added < 0 ? 'new' : `+${r.added} −${r.removed}`
  return (
    <Box flexDirection="row">
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="truncate-end" dimColor={dim}>{fit(k, r.path, inner(k) - 20)}</Text>
      </Box>
      <Box width={11} justifyContent="flex-end">
        <Text dimColor={dim}>{counts}</Text>
      </Box>
      <Box width={8} justifyContent="flex-end">
        <Text dimColor>{r.lastTurn ? `turn ${r.lastTurn}` : ''}</Text>
      </Box>
    </Box>
  )
}

// CHECKS: each test/lint/build command, its last five outcomes, when and how.
function ChecksSection(v: View, all = false) {
  const { k, s, now } = v
  const { Box, Text, Code } = k.els
  const list = checkRows(s.health.checks ?? {})
  if (list.length === 0) return null
  const rows = (all ? list : list.slice(0, 4)).flatMap(c => {
    const last = c.runs[c.runs.length - 1]!
    const outcome = last.failed ? `${last.failed} failed` : last.passed ? `${last.passed} passed` : last.ok ? 'passed' : 'failed'
    const row = (
      <Box flexDirection="row" gap={1}>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">{fit(k, c.command, inner(k) - 30)}</Text>
        </Box>
        <Text wrap="truncate-end">
          {c.runs.slice(-5).map((r, i) => (
            <Text color={resolve(r.ok ? 'ok' : 'attention', k.cfg)}>{`${i ? ' ' : ''}${r.ok ? '✓' : '✗'}`}</Text>
          ))}
        </Text>
        <Box width={18} justifyContent="flex-end">
          <Text dimColor>{`${ago(now - last.at)} · ${outcome}`}</Text>
        </Box>
      </Box>
    )
    return all && !last.ok && last.snippet && Code ? [row, <Code source={last.snippet} />] : [row]
  })
  return Section(k, 'checks', 'CHECKS', rows)
}

// CONTEXT: % with a gauge, and turns left before compaction at the current burn.
function ContextSection(v: View) {
  const { k, s } = v
  const { Box, Text } = k.els
  const hl = s.health
  if (hl.contextPct === undefined) return null
  const sem: Semantic | undefined = hl.contextPct >= 90 ? 'attention' : hl.contextPct >= k.cfg.health.contextWarnPct ? 'warn' : undefined
  const f = forecast(hl.contextHistory ?? [], lastCompactIndex(s.history ?? []), hl.contextPct, k.cfg.health.compactAtPct ?? 85)
  const row = (
    <Box flexDirection="row" gap={1} alignItems="center">
      <Text color={sem ? resolve(sem, k.cfg) : undefined}>{pct(hl.contextPct)}</Text>
      {MiniBar(k, 'ctx-bar', hl.contextPct / 100, sem ?? 'accent', k.cfg.health.contextWarnPct / 100, 12)}
      {(hl.contextHistory ?? []).length >= 1 ? <Text dimColor>{forecastText(f)}</Text> : null}
    </Box>
  )
  return Section(k, 'context', 'CONTEXT', [row])
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

// AGENTS: one swimlane chart for main and every agent; rows for running and failed ones.
function TimelineSection(v: View) {
  const { s, k, now } = v
  if (s.agents.length === 0) return null
  const running = s.agents.filter(a => a.phase === 'running')
  const failed = s.agents.filter(a => a.phase === 'failed')
  const chart = Gantt(k, 'timeline', lanes(v), ganttFrom(v), now)
  const rows = chart ? [chart, ...[...running, ...failed].slice(0, 4).map(a => agentRow(v, a))] : s.agents.slice(-4).map(a => agentRow(v, a))
  return Section(k, 'agents', 'AGENTS', rows)
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
  const { Box, Text } = k.els
  const cfg = k.cfg
  const all = s.history ?? []
  const turns = all.filter((e): e is WatchHistoryTurn => e.kind === 'turn')
  if (all.length === 0) return null
  if (mode === 'line') return <Text key="history" dimColor>{`History · ${turns.length} turn${turns.length === 1 ? '' : 's'} · /watch history`}</Text>
  const filter = v.ui.historyFilter ?? 'all'
  const shown = filterHistory(all, filter).reverse()
  const rows = mode === 'full' ? shown : shown.slice(0, HISTORY_ROWS)
  const number = new Map(turns.map((t, i) => [t.id, i + 1]))
  const body: unknown[] = []
  for (const e of rows) {
    if (e.kind === 'event') {
      body.push(
        <Text key={`hist-${e.id}`} wrap="truncate-end" dimColor>
          {`${clock(e.at)}  `}
          {Mark(k, EVENT_ICON[e.icon], e.icon === 'error' ? 'attention' : 'dim')}
          {` ${e.text}`}
        </Text>,
      )
      continue
    }
    const problem = isProblem(e)
    const live = !e.ended
    body.push(
      <Box key={`row-${e.id}`} flexDirection="row" gap={1}>
        <Text dimColor>{clock(e.at)}</Text>
        {Mark(k, live ? '▶' : problem ? '✗' : '✓', live ? 'accent' : problem ? 'attention' : 'ok')}
        <Text wrap="truncate-end">{fit(k, turnSummary(e, number.get(e.id) ?? 0, cfg), inner(k) - 9)}</Text>
      </Box>,
    )
    if (mode === 'full') body.push(...turnDetail(v, e, true))
  }
  if (shown.length > rows.length) body.push(<Text dimColor>{`+${shown.length - rows.length} older`}</Text>)
  if (rows.length === 0) body.push(<Text dimColor>{filter === 'problems' ? 'No problems so far.' : 'Nothing yet.'}</Text>)
  return Section(k, 'history', 'HISTORY', body)
}

function ChangesDetail(v: View) {
  const { k, s } = v
  const { Text } = k.els
  const rows0 = s.health.changes ?? []
  if (rows0.length === 0) return Section(k, 'changes', 'CHANGES', [<Text dimColor>{s.health.gitBase ? 'No changes since the session started.' : 'Not a git repository.'}</Text>])
  const mine = rows0.filter(r => r.byClaude)
  const yours = rows0.filter(r => !r.byClaude)
  const rows: unknown[] = mine.map(r => changeRow(k, r, false))
  const t = changesTotal(rows0)
  rows.push(<Text dimColor>{`${t.files} files · +${t.added} −${t.removed}`}</Text>)
  if (yours.length) {
    rows.push(<Text dimColor>also changed (yours)</Text>)
    rows.push(...yours.map(r => changeRow(k, r, true)))
  }
  return Section(k, 'changes', 'CHANGES', rows)
}

function ChecksDetail(v: View) {
  const { Text } = v.k.els
  return ChecksSection(v, true) ?? Section(v.k, 'checks', 'CHECKS', [<Text dimColor>No test, lint or build runs yet.</Text>])
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
  void right
  return Section(k, 'plan', 'PLAN', [planHeaderRow(v, plan), ...body])
}

function AgentsDetail(v: View) {
  const { s, k, now } = v
  const { Text } = k.els
  if (s.agents.length === 0) return Section(k, 'agents', 'AGENTS', [<Text dimColor>No subagents this session.</Text>])
  return Section(k, 'agents', 'AGENTS', [Gantt(k, 'agents-gantt', lanes(v), ganttFrom(v), now), ...s.agents.map(a => agentRow(v, a))])
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
