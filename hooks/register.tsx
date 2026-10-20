import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { WatchCall, WatchNeedsYou, WatchPeer, WatchSnapshot, WatchTab, WatchUi } from '../types'
import { DEFAULTS, deepMergeRaw, getPath, mergeConfig, parseValue, patchFor } from './config'
import { normalizeKey, record } from './estimate'
import { parseDuration, time, toolLabel } from './format'
import { classifyCommand, parseGitStatus, parseTestOutput } from './health'
import { needsYouText, Pane, summary, TABS, type View } from './render/pane'
import type { Kit } from './render/widgets'
import { heartbeatOf } from './sessions'
import * as S from './state'

const snap = atom({ plugin: 'watcher', key: 'snap' } as const, S.EMPTY_SNAP)
const config = atom({ plugin: 'watcher', key: 'config' } as const, DEFAULTS)
const ui = atom({ plugin: 'watcher', key: 'ui' } as const, { tab: 'turn', scope: 'this', mutedUntil: 0, tick: 0 } as WatchUi)
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
let cancelAutoOpen: Timer | undefined

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
  if (open && cfg.sessions.shareState && (await read($, ui)).tab === 'sessions') {
    const now = await $.clock.now()
    const list = await readPeers($, now)
    await update($, peers, () => list)
  }
  const active = s.turnStartedAt !== null && s.turnEndedAt === null
  if (!active && !open && !cfg.idleTimer) stopTicker()
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
  await writeBeat($, heartbeatOf(s, now, summary({ s, cfg, history, now }) || undefined, endedAt))
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
  return opened
}

async function setNeedsYou($: $, needsYou: WatchNeedsYou) {
  await update($, snap, s => ({
    ...s,
    phase: needsYou.kind === 'permission' ? 'waiting_permission' : needsYou.kind === 'question' ? 'waiting_question' : s.phase,
    health: { ...s.health, needsYou },
  }))
  await alert($, needsYouText(await read($, snap), needsYou.since), true)
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

async function kitFor($: $, e: { surface: string; props: { bodyColumns: number } }, els: Kit['els']): Promise<Kit> {
  return { els, surface: e.surface, cfg: await read($, config), columns: e.props.bodyColumns }
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
      await update($, snap, () => (prev.sessionId === sessionId ? { ...prev, cwd: e.cwd, model } : { ...S.EMPTY_SNAP, sessionId, cwd: e.cwd, model }))
      const cfg = await read($, config)
      await update($, ui, u => ({ ...u, tab: prev.sessionId === sessionId ? u.tab : cfg.defaultTab }))
      await $.command.register({
        name: 'watch',
        description: 'Claude Watcher: toggle the dashboard, or /watch <tab|config|reset|export|mute|sessions>',
        argumentHint: '[turn|plan|agents|sessions|health|config|reset|export|mute <30m>]',
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
      await update($, snap, s => S.startTurn(s, now))
      const cfg = await read($, config)
      startTicker($)
      await startBeat($)
      cancelAutoOpen?.cancel()
      cancelAutoOpen = undefined
      if (cfg.autoOpen === 'always') {
        await openPane($)
      } else if (cfg.autoOpen === 'onLongTurn') {
        cancelAutoOpen = $.clock.after(cfg.longTurnSeconds * 1000, () => {
          void (async () => {
            const s = await read($, snap)
            if (s.turnEndedAt !== null || (await isPaneOpen($))) return
            const opened = await openPane($)
            if (!opened.isPlaced && !(await $.store.get('hintedNarrow'))) {
              await $.store.set('hintedNarrow', true)
              $.ui.toast('Claude Watcher: the terminal is too narrow to dock the pane. Type /watch to open it.')
            }
          })().catch(() => undefined)
        })
      }
      await refreshGit($).catch(() => undefined)
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    await guard('turn complete', $, async () => {
      cancelAutoOpen?.cancel()
      cancelAutoOpen = undefined
      const now = await $.clock.now()
      const failed = e.reason === 'error'
      await update($, snap, s => S.endTurn(s, now, failed))
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
        startedAt: now,
        agentId: e.agentId,
        note: timeout ? `timeout=${timeout}` : undefined,
      }
      const started = call
      await update($, snap, x => S.startCall(x, started))
      if (e.tool === 'AskUserQuestion') await alert($, 'Claude asked you a question', true)
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
      if (call.key && ok && cfg.estimate.enabled) {
        const key = call.key
        await update($, estimates, h => ({ ...h, [key]: record(h[key], durationMs, cfg.estimate.historySize) }))
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
      if (e.effort?.level) await update($, snap, s => ({ ...s, effort: e.effort?.level }))
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await guard('prompt submit', $, async () => {
      await update($, snap, s => (s.health.needsYou ? { ...s, health: { ...s.health, needsYou: null } } : s))
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
      await update($, snap, s => S.addTask(s, e.task_id, e.task_subject, now, e.teammate_name))
    })
    return next(e)
  })

  on('classic.TaskCompleted', async ($, e, next) => {
    await guard('task completed', $, async () => {
      const now = await $.clock.now()
      await update($, snap, s => S.completeTask(s, e.task_id, e.task_subject, now))
    })
    return next(e)
  })

  on('classic.PreCompact', async ($, e, next) => {
    await guard('pre compact', $, async () => {
      const now = await $.clock.now()
      await update($, snap, s => ({ ...s, health: { ...s.health, compactions: s.health.compactions + 1, lastCompactAt: now } }))
    })
    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    await guard('stop failure', $, async () => {
      const now = await $.clock.now()
      const kind = typeof e.error === 'string' ? e.error : 'error'
      await update($, snap, s => ({ ...s, phase: 'error' as const, health: { ...s.health, lastError: { kind, text: e.error_details, at: now } } }))
      await alert($, `Claude stopped: ${kind}`, true)
    })
    return next(e)
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    await guard('model switch', $, async () => {
      await update($, snap, s => ({ ...s, model: e.to_model }))
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
        { turnStartedAt: s.turnStartedAt, turnEndedAt: s.turnEndedAt, phase: s.phase, toolCalls: s.toolCalls, recent: s.recent, tasks: s.tasks, agents: s.agents, health: s.health },
        null,
        2,
      )
      const copied = await $.ui.copy({ text: json }).catch(() => ({ isCopied: false }))
      return { text: `${copied.isCopied ? 'Copied to clipboard.\n' : ''}\`\`\`json\n${json}\n\`\`\`` }
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
      s: await read($, snap),
      ui: await read($, ui),
      peers: await read($, peers),
      history: await read($, estimates),
      now: await $.clock.now(),
      actions: {
        tab: tab => {
          void (async () => {
            await setTab($, tab)
            if (tab === 'sessions') {
              const list = await readPeers($, await $.clock.now())
              await update($, peers, () => list)
            }
          })()
        },
        scope: scope => void update($, ui, u => ({ ...u, scope })),
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
    const line = summary({ s, cfg, history: await read($, estimates), now })
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
        <Text color={cfg.colors.attention} bold>
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
