import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { WatchCall, WatchNeedsYou, WatchPeer, WatchPlan, WatchSnapshot, WatchTab, WatchUi } from '../types'
import { DEFAULTS, deepMergeRaw, getPath, mergeConfig, parseValue, patchFor } from './config'
import { normalizeKey, remember, stepKind } from './estimate'
import { parseDuration, time, toolLabel, truncate } from './format'
import { classifyCommand, parseGitStatus, parseTestOutput } from './health'
import { needsYouText, Pane, shortModel, summary, TABS, type View } from './render/pane'
import type { Kit } from './render/widgets'
import { heartbeatOf } from './sessions'
import { attribute, isPersistent, isPlanPath, ledgerPath, mergeTodos, parseLedger, parsePlanFile, planFromFile, promptPlan, settle, taskEvent } from './plan'
import { changesFromGit, changesTotal } from './changes'
import { checkKey, checkRows, recordCheck } from './checks'
import * as H from './history'
import { failingLocation, openOptions } from './openmenu'
import * as S from './state'

const snap = atom({ plugin: 'watcher', key: 'snap' } as const, S.EMPTY_SNAP)
const config = atom({ plugin: 'watcher', key: 'config' } as const, DEFAULTS)
const ui = atom({ plugin: 'watcher', key: 'ui' } as const, { tab: 'turn', scope: 'this', mutedUntil: 0, tick: 0, expanded: [], historyFilter: 'all' } as WatchUi)
const peers = atom({ plugin: 'watcher', key: 'peers' } as const, [] as WatchPeer[])
const estimates = atom({ plugin: 'watcher', key: 'estimates' } as const, {} as Record<string, number[]>)

type $ = EngineInterface

const TITLE = 'Watcher'

// The user's sparse overrides live in $.store under `config`; project defaults
// come from `<cwd>/.claude/watcher.json`. The merged result is mirrored in $.state.
let projectLayer: unknown = undefined

async function loadConfig($: $, cwd: string): Promise<void> {
  projectLayer = undefined
  try {
    const raw = await $.fs.read(`${cwd.replace(/\/+$/, '')}/.claude/watcher.json`)
    projectLayer = JSON.parse(raw)
  } catch {
    // No project file, or unreadable: defaults apply.
  }
  const user = await $.store.get('config')
  await update($, config, () => mergeConfig(projectLayer, user))
}

async function setConfig($: $, path: string, value: unknown): Promise<void> {
  const user = (await $.store.get('config')) ?? {}
  const next = deepMergeRaw(user, patchFor(path, value))
  await $.store.set('config', next)
  await update($, config, () => mergeConfig(projectLayer, next))
}

async function resetConfig($: $): Promise<void> {
  await $.store.delete('config')
  await update($, config, () => mergeConfig(projectLayer))
}

async function loadHistory($: $): Promise<void> {
  const stored = (await $.store.get('history')) as Record<string, number[]> | undefined
  await update($, estimates, () => stored ?? {})
}

async function saveHistory($: $): Promise<void> {
  await $.store.set('history', await read($, estimates))
}

async function resetHistory($: $): Promise<void> {
  await $.store.delete('history')
  await update($, estimates, () => ({}))
}

async function setTab($: $, tab: WatchTab): Promise<void> {
  await update($, ui, u => ({ ...u, tab }))
  if (tab === 'sessions') {
    const list = await readPeers($, await $.clock.now())
    await update($, peers, () => list)
  }
}

const PREFIX = 'session:'
const FORGET_AFTER_MS = 24 * 3_600_000

async function writeBeat($: $, peer: WatchPeer): Promise<void> {
  if (!peer.sessionId) return
  await $.store.set(PREFIX + peer.sessionId, peer)
}

// Every session writes its own key; readers tolerate missing or malformed ones
// and drop entries older than a day.
async function readPeers($: $, now: number): Promise<WatchPeer[]> {
  const keys = (await $.store.keys()).filter(k => k.startsWith(PREFIX))
  const out: WatchPeer[] = []
  for (const key of keys) {
    const value = (await $.store.get(key)) as WatchPeer | undefined
    if (!value || typeof value.beatAt !== 'number') continue
    if (now - value.beatAt > FORGET_AFTER_MS) {
      await $.store.delete(key)
      continue
    }
    out.push(value)
  }
  return out.sort((a, b) => Number(!!b.needsYou) - Number(!!a.needsYou) || b.beatAt - a.beatAt)
}

// Timers belong to this module instance; a hot reload drops them and
// session.start runs again to restart what is needed.
let stopTick: Timer | undefined
let stopBeat: Timer | undefined
// Per-module bookkeeping; a reload resets it, which at worst repeats one alert.
let notifiedFor = 0
let autoOpenedFor = 0
let lastBeatJson = ''
let lastBeatWrite = 0
const BEAT_REFRESH_MS = 5000
const HISTORY_KEYS = 300
// Calls that waited on a permission prompt: their duration is not a run time.
const waitedCalls = new Set<string>()
// When each of those calls started waiting, for the history's wait time.
const waitStarts = new Map<string, number>()

// ── Plan sources ──

// Plan file and ledger text last parsed, by plan path, so unchanged files are skipped.
const planTexts = new Map<string, string>()
// The plan mode file named by the latest plan_mode attachment.
let planModePath: string | undefined

async function readOr($: $, path: string): Promise<string> {
  try {
    return await $.fs.read(path)
  } catch {
    return ''
  }
}

// Parse a plan file (and its ledger) into the snapshot's plan. `force` re-parses unchanged text.
async function loadPlanFile($: $, path: string, source: 'file' | 'planmode', force: boolean): Promise<void> {
  const text = await readOr($, path)
  if (!text) return
  const ledger = source === 'file' ? await readOr($, ledgerPath(path)) : ''
  const key = `${text}\u0000${ledger}`
  const current = (await read($, snap)).plan
  if (!force && current?.path === path && planTexts.get(path) === key) return
  const parsed = parsePlanFile(text)
  if (!parsed) return
  planTexts.set(path, key)
  const done = ledger ? parseLedger(ledger, path) : new Set<number>()
  const now = await $.clock.now()
  const wasPath = current?.path
  await update($, snap, s => {
    const prev = s.plan && s.plan.path === path ? s.plan : undefined
    return { ...s, plan: settle(planFromFile(parsed, { path, source, done, now, prev, branch: s.branch, prompt: s.goal }), now) }
  })
  await savePlan($)
  if (wasPath !== path) await logEvent($, 'plan', `plan loaded: ${parsed.title || 'plan'} (${parsed.steps.length} steps)`)
  await notePlanFinished($)
}

async function refreshPlanFile($: $): Promise<void> {
  const s = await read($, snap)
  if (s.plan && isPersistent(s.plan) && s.plan.path) await loadPlanFile($, s.plan.path, s.plan.source as 'file' | 'planmode', false)
}

async function savePlan($: $): Promise<void> {
  const s = await read($, snap)
  if (s.sessionId && s.plan && isPersistent(s.plan)) await $.store.set(`plan:${s.sessionId}`, s.plan)
}

// ── Changes, checks, badge, open menu ──

let editsSinceRefresh = false
// The finished plan already logged, so its event is written once.
let finishedLogged = ''

async function notePlanFinished($: $): Promise<void> {
  const plan = (await read($, snap)).plan
  if (!plan || !plan.endedAt || plan.source === 'prompt' || plan.steps.length === 0) return
  const id = `${plan.path ?? plan.title}:${plan.startedAt}`
  if (finishedLogged === id) return
  finishedLogged = id
  await logEvent($, 'plan', `plan finished · ${plan.title} · ${plan.steps.length} steps · ${time(plan.endedAt - plan.startedAt, 'human')}`)
}
let lastBadge = -1

async function setGitBase($: $): Promise<void> {
  const cwd = (await read($, snap)).cwd || (await $.session.cwd())
  const run = await $.process.run(['git', 'rev-parse', '--show-toplevel', 'HEAD'], { cwd, timeoutMs: 2000 }).catch(() => undefined)
  const lines = run && run.exitCode === 0 ? run.stdout.split('\n').map(l => l.trim()).filter(Boolean) : []
  const base = lines[lines.length - 1]
  const root = lines.length > 1 ? lines[0] : cwd
  await update($, snap, s => ({ ...s, health: { ...s.health, gitBase: base || undefined, gitRoot: base ? root : undefined, changes: base ? s.health.changes : [] } }))
}

// Diff against the session's starting commit; a run over 2s is dropped and retried later.
async function refreshChanges($: $): Promise<void> {
  const s = await read($, snap)
  const base = s.health.gitBase
  if (!base) return
  const cwd = s.cwd || (await $.session.cwd())
  const numstat = await $.process.run(['git', 'diff', '--numstat', base], { cwd, timeoutMs: 2000 }).catch(() => undefined)
  const others = await $.process.run(['git', 'ls-files', '--others', '--exclude-standard', '--full-name'], { cwd, timeoutMs: 2000 }).catch(() => undefined)
  if (!numstat || numstat.exitCode !== 0) return
  const edited = new Map<string, number>()
  let turn = 0
  for (const e of s.history ?? []) {
    if (e.kind !== 'turn') continue
    turn += 1
    for (const f of e.files) edited.set(f, turn)
  }
  // numstat and --full-name paths are relative to the repo's top, not the session's cwd.
  const changes = changesFromGit(numstat.stdout, others && others.exitCode === 0 ? others.stdout : '', edited, s.health.gitRoot ?? cwd)
  const now = await $.clock.now()
  await update($, snap, x => ({ ...x, health: { ...x.health, changes, changesAt: now } }))
  editsSinceRefresh = false
}

async function saveChecks($: $): Promise<void> {
  const s = await read($, snap)
  if (s.sessionId) await $.store.set(`checks:${s.sessionId}`, s.health.checks)
}

async function restoreChecks($: $, sessionId: string): Promise<void> {
  const stored = (await $.store.get(`checks:${sessionId}`)) as WatchSnapshot['health']['checks'] | undefined
  if (!stored || typeof stored !== 'object') return
  await update($, snap, s => (Object.keys(s.health.checks ?? {}).length ? s : { ...s, health: { ...s.health, checks: stored } }))
}

// Things the attention card would show: needs-you, a failing test or a stop error this turn.
function attentionCount(s: WatchSnapshot): number {
  const since = s.turnStartedAt ?? Number.POSITIVE_INFINITY
  if (s.health.needsYou) return 1
  if (s.health.lastTest && !s.health.lastTest.ok && s.health.lastTest.at >= since) return 1
  if (s.health.lastError && s.health.lastError.at >= since) return 1
  return 0
}

// Pane tab title "Watcher · N" while something needs the person; only for an open pane, only on change.
async function updateBadge($: $): Promise<void> {
  const count = attentionCount(await read($, snap))
  if (count === lastBadge) return
  if (!(await isPaneOpen($))) return
  lastBadge = count
  await $.ui.open({ id: S.PANE, title: count ? `${TITLE} · ${count}` : TITLE })
}

async function openPick($: $, value: string, surface: string): Promise<void> {
  if (value === 'clear-plan') return dismissPlan($)
  if (value === 'clear-history') {
    await update($, snap, x => ({ ...x, history: [] }))
    return saveLog($)
  }
  const s = await read($, snap)
  const cwd = s.cwd || (await $.session.cwd())
  const failing = failingLocation(s.health.lastTest && !s.health.lastTest.ok ? s.health.lastTest.snippet : undefined, cwd)
  const option = openOptions({ planPath: s.plan?.path, failing, changes: s.health.changes, sessionId: s.sessionId }).find(o => o.value === value)
  if (!option) return
  const copy = async (text: string, what: string) => {
    const res = await $.ui.copy({ text, surface: surface as never }).catch(() => ({ isCopied: false }))
    $.ui.toast(res.isCopied ? `Copied ${what}: ${text}` : text)
  }
  if (option.action.kind === 'copy') return copy(option.action.text, 'command')
  const root = (s.health.gitRoot ?? cwd).replace(/\/+$/, '')
  const path = option.action.path.startsWith('/') ? option.action.path : `${root}/${option.action.path}`
  const target = option.action.line ? `${path}:${option.action.line}` : path
  const run = await $.process.run(['code', '-g', target], { cwd, timeoutMs: 3000 }).catch(() => undefined)
  if (!run || run.exitCode !== 0) await copy(path, 'path')
}

async function saveLog($: $): Promise<void> {
  const s = await read($, snap)
  if (s.sessionId) await $.store.set(`log:${s.sessionId}`, s.history)
}

async function restoreLog($: $, sessionId: string): Promise<void> {
  const stored = (await $.store.get(`log:${sessionId}`)) as WatchSnapshot['history'] | undefined
  if (!Array.isArray(stored)) return
  await update($, snap, s => (s.history.length ? s : { ...s, history: stored }))
}

async function logEvent($: $, icon: 'compact' | 'model' | 'error' | 'plan', text: string): Promise<void> {
  const now = await $.clock.now()
  await update($, snap, s => ({ ...s, history: H.addEvent(s.history ?? [], now, icon, text) }))
  await saveLog($)
}

// Drop the plan; reading or editing its file again brings it back.
async function dismissPlan($: $): Promise<void> {
  const s = await read($, snap)
  if (s.plan?.path) planTexts.delete(s.plan.path)
  await update($, snap, x => ({ ...x, plan: null }))
  if (s.sessionId) await $.store.delete(`plan:${s.sessionId}`)
}

async function restorePlan($: $, sessionId: string): Promise<void> {
  const stored = (await $.store.get(`plan:${sessionId}`)) as WatchPlan | undefined
  if (!stored || !Array.isArray(stored.steps)) return
  await update($, snap, s => (s.plan ? s : { ...s, plan: stored }))
}

async function guard(what: string, $: $, fn: () => Promise<unknown>) {
  try {
    await fn()
  } catch (err) {
    $.ui.log(`watcher: ${what} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function isPaneOpen($: $) {
  return (await $.ui.panes()).some(p => p.id === S.PANE)
}

async function tickOnce($: $) {
  const s = await read($, snap)
  const cfg = await read($, config)
  const open = await isPaneOpen($)
  await update($, ui, u => ({ ...u, tick: u.tick + 1 }))
  const u = await read($, ui)
  if (open && cfg.sessions.shareState && (u.tab === 'sessions' || u.tick % 5 === 0)) {
    const now = await $.clock.now()
    const list = await readPeers($, now)
    await update($, peers, () => list)
  }
  const active = s.turnStartedAt !== null && s.turnEndedAt === null
  const now = await $.clock.now()
  const listed = await $.agent.list().catch(() => [])
  const seen = listed.map(a => ({ id: a.id, label: a.description || a.name || a.type, status: a.status }))
  if (seen.length) {
    await update($, snap, x => {
      const before = new Set(x.agents.map(a => a.id))
      const y = S.syncAgents(x, seen, now)
      let plan = y.plan
      for (const a of y.agents) if (!before.has(a.id) && plan) plan = attribute(plan, { kind: 'agent', id: a.id })
      return plan === y.plan ? y : { ...y, plan }
    })
  }
  if (active && isPersistent(s.plan) && u.tick % 5 === 0) await refreshPlanFile($)
  if (active && editsSinceRefresh && u.tick % 5 === 0) await refreshChanges($)
  await updateBadge($)
  const agentsRunning = seen.some(a => a.status === 'running' || a.status === 'pending' || a.status === 'waiting')
  const waiting = s.health.needsYou
  if (waiting && notifiedFor !== waiting.since && now - waiting.since >= cfg.attention.delaySeconds * 1000) {
    notifiedFor = waiting.since
    await alert($, needsYouText(s, now), true)
  }
  if (
    active &&
    !open &&
    cfg.autoOpen === 'onLongTurn' &&
    s.turnStartedAt !== null &&
    autoOpenedFor !== s.turnStartedAt &&
    now - s.turnStartedAt >= cfg.longTurnSeconds * 1000
  ) {
    autoOpenedFor = s.turnStartedAt
    const opened = await openPane($)
    if (!opened.isPlaced && !(await $.store.get('hintedNarrow'))) {
      await $.store.set('hintedNarrow', true)
      $.ui.toast('Claude Watcher: the terminal is too narrow to dock the pane. Type /watch to open it.')
    }
  }
  if (!active && !open && !waiting && !agentsRunning && !cfg.idleTimer) stopTicker()
}

// One 1s timer, created in session.start: timers started inside a short
// dispatch (turn.start, command.run) do not reliably outlive it. While idle
// with the pane closed the timer does nothing, so no state is written.
let isTicking = false

function installTicker($: $) {
  stopTick?.cancel()
  stopTick = $.clock.every(1000, () => {
    if (isTicking) void tickOnce($).catch(() => undefined)
  })
}

function startTicker(_$: $) {
  isTicking = true
}

function stopTicker() {
  isTicking = false
}

async function beat($: $, endedAt?: number) {
  const cfg = await read($, config)
  if (!cfg.sessions.shareState) return
  const s = await read($, snap)
  const now = await $.clock.now()
  const history = await read($, estimates)
  const peer = heartbeatOf(s, now, summary({ s, cfg, history, now }) || undefined, endedAt)
  // Write on change, and every few seconds so readers can tell the session is alive.
  const { beatAt: _beatAt, ...body } = peer
  const json = JSON.stringify(body)
  if (!endedAt && json === lastBeatJson && now - lastBeatWrite < BEAT_REFRESH_MS) return
  lastBeatJson = json
  lastBeatWrite = now
  await writeBeat($, peer)
}

async function startBeat($: $) {
  const cfg = await read($, config)
  if (stopBeat || !cfg.sessions.shareState) return
  stopBeat = $.clock.every(Math.max(250, cfg.sessions.heartbeatMs), () => void beat($).catch(() => undefined))
}

function stopBeating() {
  stopBeat?.cancel()
  stopBeat = undefined
}

async function refreshGit($: $) {
  const cfg = await read($, config)
  if (!cfg.health.gitStatus) return
  const cwd = (await read($, snap)).cwd || (await $.session.cwd())
  const run = await $.process.run(['git', 'status', '--porcelain', '-b'], { cwd, timeoutMs: 5000 })
  if (run.exitCode !== 0) return
  const git = parseGitStatus(run.stdout)
  await update($, snap, s => ({ ...s, branch: git.branch, health: { ...s.health, dirtyFiles: git.dirty } }))
}

async function openPane($: $, tab?: WatchTab) {
  if (tab) await setTab($, tab)
  const opened = await $.ui.open({ id: S.PANE, title: TITLE })
  startTicker($)
  // The open just reset the tab title; put the badge back.
  lastBadge = -1
  await updateBadge($)
  return opened
}

async function setNeedsYou($: $, needsYou: WatchNeedsYou) {
  await update($, snap, s => ({
    ...s,
    phase: needsYou.kind === 'permission' ? 'waiting_permission' : needsYou.kind === 'question' ? 'waiting_question' : s.phase,
    health: { ...s.health, needsYou },
  }))
  const s = await read($, snap)
  if (needsYou.kind === 'permission' && s.current) {
    waitedCalls.add(s.current.id)
    if (!waitStarts.has(s.current.id)) waitStarts.set(s.current.id, needsYou.since)
  }
  // The band shows at once; the toast and notification wait for attention.delaySeconds (see tickOnce).
  if ((await read($, config)).attention.delaySeconds <= 0) {
    notifiedFor = needsYou.since
    await alert($, needsYouText(s, needsYou.since), true)
  }
  startTicker($)
  await beat($)
}

async function alert($: $, text: string, urgent: boolean) {
  const cfg = await read($, config)
  const u = await read($, ui)
  if ((await $.clock.now()) < u.mutedUntil) return
  if (urgent && cfg.attention.toast) $.ui.toast(text)
  // Focus is not exposed to mods, so `whenUnfocused` behaves like `always`.
  if (cfg.attention.desktopNotify !== 'never') await $.ui.notify(text, { title: 'Claude Watcher' }).catch(() => undefined)
}

async function kitFor($: $, e: { surface: string; props: { bodyColumns: number; scroll?: { bodyRows?: number } } }, els: Kit['els']): Promise<Kit> {
  const columns = e.surface === 'terminal' ? e.props.bodyColumns : Math.max(e.props.bodyColumns, 44)
  return { els, surface: e.surface, cfg: await read($, config), columns, rows: e.props.scroll?.bodyRows }
}


export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await guard('session start', $, async () => {
      const sessionId = await $.session.id()
      const model = await $.session.model().catch(() => undefined)
      await loadConfig($, e.cwd)
      await loadHistory($)
      const prev = await read($, snap)
      // A hot reload keeps $.state: carry the snapshot on for the same session.
      await update($, snap, () => (prev.sessionId === sessionId ? { ...S.normalizeSnap(prev), cwd: e.cwd, model } : { ...S.EMPTY_SNAP, sessionId, cwd: e.cwd, model }))
      await restorePlan($, sessionId)
      await restoreLog($, sessionId)
      await restoreChecks($, sessionId)
      await setGitBase($).catch(() => undefined)
      const cfg = await read($, config)
      await update($, ui, u => ({ ...u, expanded: u.expanded ?? [], historyFilter: u.historyFilter ?? 'all', tab: prev.sessionId === sessionId ? u.tab : cfg.defaultTab }))
      await $.command.register({
        name: 'watch',
        description: 'Claude Watcher: toggle the dashboard, or /watch <tab|config|reset|export|mute|sessions>',
        argumentHint: '[turn|plan|agents|calls|history|sessions|health|config|clear [history|plan|checks]|reset|export|mute <30m>]',
      })
      await refreshGit($).catch(() => undefined)
      await startBeat($)
      await beat($)
      installTicker($)
      if (await isPaneOpen($)) startTicker($)
    })
    return result
  })

  on('session.end', async ($, e, next) => {
    await guard('session end', $, async () => {
      if (e.reason === 'clear') {
        await update($, snap, s => S.resetTurn(s))
        await beat($)
      } else {
        await beat($, await $.clock.now())
        stopBeating()
        stopTicker()
      }
    })
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    await guard('classic session start', $, async () => {
      const source = (e as { source?: string }).source
      if (source === 'clear' || source === 'resume' || source === 'compact') {
        const sessionId = await $.session.id()
        await update($, snap, s => ({ ...S.resetTurn(s), sessionId }))
        if (source === 'clear') await setGitBase($).catch(() => undefined)
        await loadHistory($)
        await startBeat($)
      }
    })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId) return next(e)
    await guard('turn start', $, async () => {
      const now = await $.clock.now()
      const goal = truncate(e.text.split('\n').find(l => l.trim()) ?? '', 80) || undefined
      await update($, snap, s => {
        const started = { ...S.startTurn(s, now, goal), history: H.startTurnEntry(s.history ?? [], e.turnId, now, e.text) }
        // A finished plan gives way to the new turn; an unfinished file plan stays.
        return isPersistent(s.plan) && !s.plan?.endedAt ? started : { ...started, plan: promptPlan(e.text, now, s.branch) }
      })
      const cfg = await read($, config)
      startTicker($)
      await startBeat($)
      // `onLongTurn` is handled by the 1s ticker.
      if (cfg.autoOpen === 'always') await openPane($)
      await refreshGit($).catch(() => undefined)
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    await guard('turn complete', $, async () => {
      const now = await $.clock.now()
      const failed = e.reason === 'error'
      await update($, snap, s => {
        const ended = S.endTurn(s, now, failed)
        const pct = ended.health.contextPct
        const contextHistory = pct === undefined ? ended.health.contextHistory : [...ended.health.contextHistory, Math.round(pct)].slice(-20)
        const plan = ended.plan ? settle(ended.plan, now) : null
        const since = s.turnStartedAt ?? now
        let history = ended.history ?? []
        // Only steps this turn started or finished; a step running across turns branches once.
        if (plan) history = H.noteSteps(history, plan.steps.filter(x => (x.startedAt ?? -1) >= since || (x.endedAt ?? -1) >= since))
        for (const a of ended.agents.filter(x => x.startedAt >= since)) history = H.addAgent(history, a.type, a.phase !== 'failed', (a.endedAt ?? now) - a.startedAt)
        // Snapshot what the dashboard shows now, for replaying this turn later.
        const testRuns = checkRows(ended.health.checks ?? {}).find(c => c.kind === 'test')
        history = H.setSnapshot(history, {
          plan: plan && plan.steps.length ? { title: plan.title, ticket: plan.ticket, steps: plan.steps.map(x => ({ title: x.title, status: x.status, ms: x.startedAt !== undefined ? (x.endedAt ?? now) - x.startedAt : undefined })) } : undefined,
          contextPct: ended.health.contextPct,
          changes: ended.health.gitBase ? changesTotal(ended.health.changes ?? []) : undefined,
          tests: testRuns ? testRuns.runs.slice(-5).map(r => r.ok) : undefined,
        })
        history = H.endTurnEntry(history, now, failed)
        return { ...ended, plan, history, health: { ...ended.health, contextHistory } }
      })
      await savePlan($)
      await notePlanFinished($)
      await saveLog($)
      await refreshChanges($).catch(() => undefined)
      await updateBadge($)
      await saveHistory($)
      await beat($)
      const cfg = await read($, config)
      if (e.durationMs >= cfg.attention.notifyOnTurnEndAfterSeconds * 1000) {
        await alert($, `Claude finished after ${time(e.durationMs, cfg.timeFormat)}${failed ? ' (error)' : ''}`, false)
      }
      await refreshGit($).catch(() => undefined)
    })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    let call: WatchCall | undefined
    await guard('tool start', $, async () => {
      const cfg = await read($, config)
      const s = await read($, snap)
      const input = e as unknown as Record<string, unknown>
      const now = await $.clock.now()
      const key = normalizeKey(e.tool, input, s.cwd, cfg)
      const timeout = typeof input.timeout === 'number' ? input.timeout : undefined
      call = {
        id: e.tool_use_id,
        tool: e.tool,
        label: toolLabel(e.tool, input, cfg),
        key: key ?? '',
        kindKey: key ? `${cfg.estimate.perProject ? `${s.cwd}::` : ''}kind:${stepKind(e.tool, input)}` : undefined,
        startedAt: now,
        agentId: e.agentId,
        note: timeout ? `timeout=${timeout}` : undefined,
      }
      const started = call
      await update($, snap, x => S.startCall(x, started))
      if (e.tool === 'TodoWrite' && Array.isArray(input.todos)) {
        const todos = input.todos as { content?: unknown; status?: unknown }[]
        await update($, snap, x => ({ ...x, plan: mergeTodos(x.plan, todos, now, x.goal) }))
      }
      if (e.tool === 'AskUserQuestion' || e.tool === 'Agent') startTicker($)
    })
    const ran = await next(e)
    await guard('tool end', $, async () => {
      if (!call) return
      const cfg = await read($, config)
      const now = await $.clock.now()
      const durationMs = now - call.startedAt
      const ok = ran.deny === undefined && ran.isError !== true
      const output = outputText(ran)
      const exitCode = exitCodeOf(ran)
      let note: string | undefined = ran.deny !== undefined ? 'denied' : undefined
      const input = e as unknown as Record<string, unknown>
      const patch: Partial<WatchSnapshot['health']> = {}
      if (e.tool === 'Bash' && typeof input.command === 'string') {
        const kind = classifyCommand(input.command)
        if (kind === 'test' && cfg.health.parseTestOutput) {
          const parsed = parseTestOutput(input.command, output, exitCode ?? (ok ? 0 : 1))
          if (parsed) {
            patch.lastTest = { ...parsed, at: now, command: input.command }
            if (parsed.failed) note = `${parsed.failed} failed`
          }
        } else if (kind === 'lint') {
          patch.lastLint = { ok, at: now, command: input.command }
        } else if (kind === 'build') {
          patch.lastBuild = { ok, at: now, command: input.command }
        }
        const key = kind ? checkKey(input.command, (await read($, snap)).cwd) : ''
        if (key) {
          const label = call.label
          const t = patch.lastTest
          const turns = ((await read($, snap)).history ?? []).filter(x => x.kind === 'turn').length
          const runOk = t ? t.ok : ok
          await update($, snap, x => ({ ...x, health: { ...x.health, checks: recordCheck(x.health.checks ?? {}, key, label, { ok: runOk, at: now, passed: t?.passed, failed: t?.failed, snippet: t?.snippet, turn: turns }) } }))
          await saveChecks($)
        }
      }
      const filePath = typeof input.file_path === 'string' ? input.file_path : undefined
      const edited = ok && filePath && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(e.tool) ? filePath : undefined
      const done: WatchCall = { ...call, durationMs, ok, note: note ?? (call.note?.startsWith('timeout=') ? undefined : call.note) }
      await update($, snap, s => {
        const ended = S.endCall(s, done, cfg.showRecentCalls)
        return {
          ...ended,
          health: {
            ...ended.health,
            ...patch,
            editedFiles: edited && !ended.health.editedFiles.includes(edited) ? [...ended.health.editedFiles, edited] : ended.health.editedFiles,
          },
        }
      })
      // Credit the call, its edit and its test to the step running now, and to the turn's history.
      const testResult = patch.lastTest
      const waitedFrom = waitStarts.get(call.id)
      waitStarts.delete(call.id)
      const mainLoop = !call.agentId
      await update($, snap, s => {
        let history = s.history ?? []
        if (mainLoop) history = H.addCall(history, done)
        if (edited) history = H.addFile(history, edited)
        if (testResult) history = H.setTest(history, testResult)
        if (waitedFrom !== undefined) history = H.addWait(history, now - waitedFrom)
        return { ...s, history }
      })
      await update($, snap, s => {
        if (!s.plan) return s
        let plan = attribute(s.plan, { kind: 'call' })
        if (edited) plan = attribute(plan, { kind: 'edit', file: edited })
        if (testResult) plan = attribute(plan, { kind: 'test', result: testResult })
        return { ...s, plan: settle(plan, now) }
      })
      if (edited) editsSinceRefresh = true
      await notePlanFinished($)
      await updateBadge($)
      if (ok && filePath && /^(Read|Edit|Write|MultiEdit)$/.test(e.tool)) {
        const looksLikePlan = isPlanPath(filePath) || (e.tool === 'Read' && /Implementation Plan\s*$/m.test(output.split('\n').slice(0, 3).join('\n')))
        // Editing a plan makes it the plan. Reading one only does when no unfinished file plan is active,
        // so a plan read for reference does not replace the one being executed.
        const active = (await read($, snap)).plan
        const takeOver = e.tool !== 'Read' || !isPersistent(active) || !!active?.endedAt || active?.path === filePath
        if (looksLikePlan && takeOver) await loadPlanFile($, filePath, 'file', e.tool !== 'Read')
      }
      if (ok && e.tool === 'ExitPlanMode' && planModePath) await loadPlanFile($, planModePath, 'planmode', true)
      if (call.key && ok && cfg.estimate.enabled) {
        const key = call.key
        if (!waitedCalls.has(call.id)) {
          const kindKey = call.kindKey
          await update($, estimates, h => {
            const withKey = remember(h, key, durationMs, cfg.estimate.historySize, HISTORY_KEYS)
            return kindKey ? remember(withKey, kindKey, durationMs, cfg.estimate.historySize, HISTORY_KEYS) : withKey
          })
        }
        waitedCalls.delete(call.id)
      }
    })
    return ran
  })

  on('classic.Notification', async ($, e, next) => {
    await guard('notification', $, async () => {
      const now = await $.clock.now()
      const kind =
        e.notification_type === 'permission_prompt'
          ? 'permission'
          : e.notification_type.startsWith('elicitation')
            ? 'elicitation'
            : e.notification_type === 'idle_prompt'
              ? 'idle'
              : undefined
      if (kind) await setNeedsYou($, { kind, since: now, text: e.message })
      await updateBadge($)
      if (e.effort?.level) await update($, snap, s => ({ ...s, effort: e.effort?.level }))
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await guard('prompt submit', $, async () => {
      await update($, snap, s => (s.health.needsYou ? { ...s, health: { ...s.health, needsYou: null } } : s))
      await updateBadge($)
    })
    return next(e)
  })

  on('classic.SubagentStart', async ($, e, next) => {
    await guard('subagent start', $, async () => {
      const now = await $.clock.now()
      await update($, snap, s => S.agentStart(s, e.agent_id, e.agent_type || 'agent', now))
    })
    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    await guard('subagent stop', $, async () => {
      const now = await $.clock.now()
      await update($, snap, s => S.agentStop(s, e.agent_id, 'done', now))
    })
    return next(e)
  })

  on('classic.TeammateIdle', async ($, e, next) => {
    await guard('teammate idle', $, async () => {
      const now = await $.clock.now()
      const id = `teammate:${e.team_name}:${e.teammate_name}`
      await update($, snap, s => {
        const known = s.agents.some(a => a.id === id)
        const withLane = known ? s : S.agentStart(s, id, e.teammate_name, now)
        return S.agentStop(withLane, id, 'idle', now)
      })
    })
    return next(e)
  })

  on('classic.TaskCreated', async ($, e, next) => {
    await guard('task created', $, async () => {
      const now = await $.clock.now()
      await update($, snap, s => ({ ...s, plan: taskEvent(s.plan, { id: e.task_id, title: e.task_subject, done: false }, now) }))
    })
    return next(e)
  })

  on('classic.TaskCompleted', async ($, e, next) => {
    await guard('task completed', $, async () => {
      const now = await $.clock.now()
      await update($, snap, s => ({ ...s, plan: taskEvent(s.plan, { id: e.task_id, title: e.task_subject, done: true }, now) }))
    })
    return next(e)
  })

  // Plan mode names its plan file in an attachment; ExitPlanMode (tool end) loads it.
  on('prompt.attachment', { type: 'plan_mode' }, async ($, e, next) => {
    const path = (e as { detail?: { planFilePath?: unknown } }).detail?.planFilePath
    if (typeof path === 'string') planModePath = path
    return next(e)
  })

  on('prompt.attachment', { type: 'plan_mode_reentry' }, async ($, e, next) => {
    const path = (e as { detail?: { planFilePath?: unknown } }).detail?.planFilePath
    if (typeof path === 'string') planModePath = path
    return next(e)
  })

  on('classic.PreCompact', async ($, e, next) => {
    await guard('pre compact', $, async () => {
      const now = await $.clock.now()
      await update($, snap, s => ({ ...s, health: { ...s.health, compactions: s.health.compactions + 1, lastCompactAt: now } }))
      const pct = (await read($, snap)).health.contextPct
      await logEvent($, 'compact', `compacted context${pct !== undefined ? ` at ${Math.round(pct)}%` : ''}`)
    })
    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    await guard('stop failure', $, async () => {
      const now = await $.clock.now()
      const kind = typeof e.error === 'string' ? e.error : 'error'
      await update($, snap, s => ({ ...s, phase: 'error' as const, health: { ...s.health, lastError: { kind, text: e.error_details, at: now } } }))
      await logEvent($, 'error', `Claude stopped: ${kind}`)
      await alert($, `Claude stopped: ${kind}`, true)
    })
    return next(e)
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    await guard('model switch', $, async () => {
      await update($, snap, s => ({ ...s, model: e.to_model }))
      await logEvent($, 'model', `model → ${shortModel(e.to_model)}`)
    })
    return next(e)
  })

  on('classic.CwdChanged', async ($, e, next) => {
    await guard('cwd changed', $, async () => {
      await update($, snap, s => ({ ...s, cwd: e.new_cwd }))
      await refreshGit($)
    })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await guard('measure', $, async () => {
      const ctx = e.context
      const pct = ctx.percent ?? (ctx.tokens !== undefined && ctx.window ? (ctx.tokens / ctx.window) * 100 : undefined)
      const rate = e.rateLimits.length ? Math.max(...e.rateLimits.map(r => r.percentUsed)) : undefined
      await update($, snap, s => ({
        ...s,
        health: { ...s.health, contextPct: pct, contextTokens: ctx.tokens, costUsd: e.cost?.usd ?? s.health.costUsd, rateLimitPct: rate },
      }))
    })
    return next(e)
  })

  on('command.run', { command: 'watch' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    const arg = rest.join(' ')
    if (verb === '') {
      if (await isPaneOpen($)) {
        await $.ui.close({ id: S.PANE })
        return { text: 'Watcher closed.' }
      }
      const opened = await openPane($)
      return { text: opened.isPlaced ? 'Watcher opened.' : 'Watcher will show once there is room for the pane.' }
    }
    if ((TABS as readonly string[]).includes(verb) && !(verb === 'config' && rest.length)) {
      await openPane($, verb as WatchTab)
      return { text: `Watcher: ${verb} tab.` }
    }
    if (verb === 'config') {
      const [sub, path, ...valueParts] = rest
      if (sub === 'set' && path) {
        const before = getPath(await read($, config), path)
        if (before === undefined) return { text: `Unknown setting: ${path}` }
        await setConfig($, path, parseValue(valueParts.join(' ')))
        const after = getPath(await read($, config), path)
        return { text: JSON.stringify(after) === JSON.stringify(before) && valueParts.join(' ') !== JSON.stringify(before) ? `Rejected value for ${path}; kept ${JSON.stringify(before)}.` : `${path} = ${JSON.stringify(after)}` }
      }
      if (sub === 'get' && path) return { text: `${path} = ${JSON.stringify(getPath(await read($, config), path))}` }
      return { text: 'Usage: /watch config [set <path> <value> | get <path>]' }
    }
    if (verb === 'reset') {
      const what = arg || 'all'
      if (what === 'history' || what === 'all') await resetHistory($)
      if (what === 'config' || what === 'all') await resetConfig($)
      return { text: `Watcher: reset ${what}.` }
    }
    if (verb === 'export') {
      const s = await read($, snap)
      const json = JSON.stringify(
        { turnStartedAt: s.turnStartedAt, turnEndedAt: s.turnEndedAt, phase: s.phase, toolCalls: s.toolCalls, recent: s.recent, agents: s.agents, health: s.health, plan: s.plan },
        null,
        2,
      )
      const copied = await $.ui.copy({ text: json }).catch(() => ({ isCopied: false }))
      return { text: `${copied.isCopied ? 'Copied to clipboard.\n' : ''}\`\`\`json\n${json}\n\`\`\`` }
    }
    if (verb === 'clear') {
      const what = arg || 'all'
      if (what === 'history' || what === 'all') {
        await update($, snap, s => ({ ...s, history: [] }))
        await saveLog($)
      }
      if (what === 'plan' || what === 'all') await dismissPlan($)
      if (what === 'checks' || what === 'all') {
        await update($, snap, s => ({ ...s, health: { ...s.health, checks: {} } }))
        await saveChecks($)
      }
      return { text: `Watcher: ${what === 'all' ? 'history, plan and checks' : what} cleared.` }
    }
    if (verb === 'mute') {
      const ms = parseDuration(arg || '30m')
      if (ms === undefined) return { text: 'Usage: /watch mute 30m' }
      const until = (await $.clock.now()) + ms
      await update($, ui, u => ({ ...u, mutedUntil: until }))
      return { text: `Watcher alerts muted for ${time(ms, 'human')}.` }
    }
    if (verb === 'unmute') {
      await update($, ui, u => ({ ...u, mutedUntil: 0 }))
      return { text: 'Watcher alerts on.' }
    }
    return { text: 'Usage: /watch [turn|plan|agents|sessions|health|config|reset [history|config|all]|export|mute 30m|unmute]' }
  })

  on('ui.render', { component: 'Pane', requestId: 'watcher' }, async ($, e) => {
    const els = $.ui.resolve(e) as unknown as Kit['els']
    const k = await kitFor($, e, els)
    const view: View = {
      k,
      s: S.normalizeSnap(await read($, snap)),
      ui: await read($, ui),
      peers: await read($, peers),
      history: await read($, estimates),
      now: await $.clock.now(),
      actions: {
        tab: tab => {
          void (async () => {
            await setTab($, tab)
          })()
        },
        scope: scope => void update($, ui, u => ({ ...u, scope })),
        toggle: id =>
          void update($, ui, u => {
            const open = u.expanded ?? []
            return { ...u, expanded: open.includes(id) ? open.filter(x => x !== id) : [...open, id].slice(-50) }
          }),
        clearHistory: () =>
          void (async () => {
            await update($, snap, s => ({ ...s, history: [] }))
            await saveLog($)
          })(),
        dismissPlan: () => void dismissPlan($),
        pick: value => void openPick($, value, e.surface),
        toggleHistory: () => void update($, ui, (u): WatchUi => ({ ...u, historyCollapsed: !u.historyCollapsed })),
        turnPick: value =>
          void update($, ui, (u): WatchUi =>
            value === 'more'
              ? { ...u, historyLimit: (u.historyLimit ?? 10) + 10 }
              : value === 'collapse' || value === 'expand'
                ? { ...u, historyCollapsed: value === 'collapse' }
                : value
                  ? { ...u, replay: value, tab: 'replay' }
                  : u,
          ),
        filter: value => void update($, ui, (u): WatchUi => ({ ...u, historyFilter: value === 'turns' || value === 'problems' ? value : 'all' })),
        cycleFilter: () =>
          void update($, ui, (u): WatchUi => ({ ...u, historyFilter: u.historyFilter === 'all' ? 'turns' : u.historyFilter === 'turns' ? 'problems' : 'all' })),
        set: (path, value) => void setConfig($, path, value),
        copy: text => {
          void (async () => {
            const res = await $.ui.copy({ text, surface: e.surface }).catch(() => ({ isCopied: false }))
            $.ui.toast(res.isCopied ? `Copied: ${text}` : text)
          })()
        },
      },
    }
    return Pane(view)
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const cfg = await read($, config)
    if (!cfg.spinnerSuffix) return next(e)
    const s = await read($, snap)
    // Subscribe to the tick so elapsed time advances.
    await read($, ui)
    const now = await $.clock.now()
    const line = summary({ s, cfg, history: await read($, estimates), now, short: true })
    if (!line) return next(e)
    const suffix = e.props.suffix ? `${e.props.suffix} · ${line}` : line
    return next({ ...e, props: { ...e.props, suffix } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const cfg = await read($, config)
    const s = await read($, snap)
    const u = await read($, ui)
    const now = await $.clock.now()
    if (!cfg.attention.band || e.props.hasSurvey || !s.health.needsYou || now < u.mutedUntil) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const hint = s.health.needsYou.kind === 'permission' ? ' — ↑ to review' : ''
    return (
      <Box>
        <Text color={cfg.colors.warn || 'warning'} bold>
          ⏸ {needsYouText(s, now)}
          {hint}
        </Text>
      </Box>
    )
  })
}

function outputText(ran: { text?: string; result?: unknown }): string {
  if (typeof ran.text === 'string') return ran.text
  const r = ran.result as { stdout?: unknown; stderr?: unknown } | undefined
  if (r && typeof r === 'object') return [r.stdout, r.stderr].filter(x => typeof x === 'string').join('\n')
  return typeof ran.result === 'string' ? ran.result : ''
}

function exitCodeOf(ran: { result?: unknown; text?: string }): number | undefined {
  const r = ran.result as { exitCode?: unknown; returnCode?: unknown } | undefined
  if (r && typeof r === 'object') {
    if (typeof r.exitCode === 'number') return r.exitCode
    if (typeof r.returnCode === 'number') return r.returnCode
  }
  const m = typeof ran.text === 'string' ? /exit code (\d+)/i.exec(ran.text) : null
  return m ? Number(m[1]) : undefined
}
