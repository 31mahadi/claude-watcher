import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const PANE = {
  plugin: 'watcher',
  component: 'Pane',
  requestId: 'watcher',
  props: {
    title: 'Watcher',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

// The engine beneath the plugin: each hook answers a call the mod makes on `$`.
export const toasts: string[] = []
// Host commands the mod ran, and canned answers by "argv[0] argv[1]".
export const runs: string[][] = []
export const copies: string[] = []
export const procs: Record<string, { stdout: string; exitCode?: number }> = {}
export const opens: { title?: string }[] = []

function engine(on: On, panes: { open: boolean }, store: Record<string, unknown> = {}, files: Record<string, string> = {}) {
  mock.store(on, store)
  toasts.length = 0
  runs.length = 0
  copies.length = 0
  opens.length = 0
  for (const k of Object.keys(procs)) delete procs[k]
  procs['git rev-parse'] = { stdout: 'abc123\n' }
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: unknown }).text ?? e))
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.model', () => ({ value: 'opus' }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('command.register', () => ({ value: { command: 'watch' } }))
  on('ui.open', (_, e) => {
    opens.push({ title: (e as { title?: string }).title })
    panes.open = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    panes.open = false
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: panes.open ? [{ id: 'watcher', title: 'Watcher', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('fs.read', (_, e) => {
    const text = files[e.path]
    if (text !== undefined) return { value: text }
    throw new Error('ENOENT')
  })
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const key = argv.slice(0, 2).join(' ')
    if (key in procs) return out(procs[key]!.stdout, procs[key]!.exitCode)
    if (key === 'git status') return out('## feat/auth\n M a.ts\n')
    return out('')
  })
  on('ui.copy', (_, e) => {
    copies.push(String((e as { text?: unknown }).text))
    return { value: { isCopied: true } }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.measure', () => ({ changed: [] }))
  for (const ev of ['Notification', 'TaskCreated', 'TaskCompleted', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostModelSwitch', 'StopFailure'] as const) on(`classic.${ev}`, () => ({}))
  // Stands for the engine's own drawing of sites the mod only rewrites (the spinner).
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    const props = e.props as { suffix?: string }
    return <Text>{props.suffix ?? 'engine'}</Text>
  })
  on('tool.call', (_, e) => {
    if (e.tool !== 'Bash') return { result: {} }
    // A runner that prints no counts and passes.
    if (String((e as { command?: unknown }).command).includes('make test')) return { result: { stdout: 'ok', stderr: '' } }
    return { result: { stdout: 'Tests:       1 failed, 4 passed, 5 total', stderr: '' }, isError: true }
  })
}

async function start($: Engine, on: On, files: Record<string, string> = {}) {
  const panes = { open: false }
  engine(on, panes, {}, files)
  const clock = mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  return { panes, clock }
}

test('health tab shows parsed test result, git and needs-you', async ($, on) => {
  await start($, on)
  await $.command.run({ command: 'watch', args: 'health' } as never)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.classic.Notification({ notification_type: 'permission_prompt', message: 'Allow Bash?' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /1 failed \/ 4 passed/ })).toBeDefined()
    expect(await ui.find({ text: /feat\/auth/ })).toBeDefined()
    expect(await ui.find({ text: /waiting for your permission/ })).toBeDefined()
    await ui.unmount()
  }

  const band = await $.ui.mount({
    plugin: 'watcher',
    surface: 'terminal',
    component: 'AbovePrompt',
    requestId: 'band',
    props: { hasSurvey: false, isWorking: true, maxRows: 3, bodyColumns: 80, scroll: { offset: 0, bodyRows: 3 }, view: {} },
  })
  expect(await band.find({ text: /permission/ })).toBeDefined()
  await band.unmount()
})

test('sessions tab lists heartbeats of other sessions', async ($, on) => {
  const panes = { open: false }
  engine(on, panes, {
    'session:other': {
      sessionId: 'other',
      project: 'dropin',
      cwd: '/x/dropin',
      branch: 'main',
      phase: 'waiting_permission',
      turnStartedAt: 999_000,
      tasksDone: 0,
      tasksTotal: 0,
      needsYou: 'permission',
      beatAt: 999_500,
    },
  })
  mock.clock(on, { now: 1_000_000 })
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'watch', args: 'sessions' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'scope-all' })
    expect(await ui.find({ text: /dropin/ })).toBeDefined()
    expect(await ui.find({ text: /NEEDS YOU/ })).toBeDefined()
    expect(await ui.find({ text: /app/ })).toBeDefined()
    await ui.unmount()
  }
})

test('config tab toggles a setting and /watch config set validates', async ($, on) => {
  await start($, on)
  await $.command.run({ command: 'watch', args: 'config' } as never)
  for (const surface of ['terminal', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /\[x\] visuals\.gantt/ })).toBeDefined()
    await ui.press({ key: 'cfg-visuals.gantt' })
    expect(await ui.find({ text: /\[ \] visuals\.gantt/ })).toBeDefined()
    await ui.press({ key: 'cfg-visuals.gantt' })
    await ui.unmount()
  }
  const ok = await $.command.run({ command: 'watch', args: 'config set barWidth 30' } as never)
  expect(ok.text).toBe('barWidth = 30')
  const bad = await $.command.run({ command: 'watch', args: 'config set theme loud' } as never)
  expect(bad.text).toContain('Rejected')
})

test('/watch toggles, mutes and exports; /clear resets the turn', async ($, on) => {
  const { panes } = await start($, on)
  expect((await $.command.run({ command: 'watch', args: '' } as never)).text).toBe('Watcher opened.')
  expect(panes.open).toBe(true)
  expect((await $.command.run({ command: 'watch', args: '' } as never)).text).toBe('Watcher closed.')
  expect((await $.command.run({ command: 'watch', args: 'mute 30m' } as never)).text).toContain('30m')
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: '/a.ts' })
  expect((await $.command.run({ command: 'watch', args: 'export' } as never)).text).toContain('"toolCalls": 1')
  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: {} } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /Idle ·/ })).toBeDefined()
  await ui.unmount()
})

test('spinner suffix carries the current call', async ($, on) => {
  await start($, on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.classic.TaskCreated({ task_id: '1', task_subject: 'A' })
  const ui = await $.ui.mount({
    plugin: 'watcher',
    surface: 'terminal',
    component: 'Spinner',
    requestId: 'main',
    props: { word: 'Thinking', message: null, suffix: '', mode: 'thinking' },
  })
  expect(await ui.find({ text: /0\/1 tasks/ })).toBeDefined()
  await ui.unmount()
})

test('pane redraws every second while a call runs', async ($, on) => {
  const { clock } = await start($, on)
  await $.command.run({ command: 'watch', args: '' } as never)
  await $.turn.start({ text: 'x', turnId: 't1' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /→ now · 0s/ })).toBeDefined()
  await clock.advance(3000)
  expect(await ui.find({ text: /→ now · 3s/ })).toBeDefined()
  await ui.unmount()
})

test('needs-you band shows at once, toast waits 15s', async ($, on) => {
  const { clock } = await start($, on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.classic.Notification({ notification_type: 'permission_prompt', message: 'Allow?' })
  const band = await $.ui.mount({
    plugin: 'watcher',
    surface: 'terminal',
    component: 'AbovePrompt',
    requestId: 'band',
    props: { hasSurvey: false, isWorking: true, maxRows: 3, bodyColumns: 80, scroll: { offset: 0, bodyRows: 3 }, view: {} },
  })
  expect(await band.find({ text: /permission/ })).toBeDefined()
  expect(toasts.filter(t => /permission/.test(t))).toHaveLength(0)
  await clock.advance(16_000)
  expect(toasts.filter(t => /permission/.test(t)).length).toBeGreaterThan(0)
  await band.unmount()
})


test('agents and main share one timeline', async ($, on) => {
  const { clock } = await start($, on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
  await clock.advance(1500)
  await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'Explore', stop_hook_active: false, agent_transcript_path: '/t' })
  await $.classic.SubagentStart({ agent_id: 'a2', agent_type: 'Tester' })
  await $.command.run({ command: 'watch', args: 'agents' } as never)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^AGENTS$/ })).toBeDefined()
    expect(await ui.find({ text: /Tester/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a stalled turn says so', async ($, on) => {
  const { clock } = await start($, on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await clock.advance(95_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /no activity for 1:3/ })).toBeDefined()
  await ui.unmount()
})

test('narrow terminal pane hides the timeline', async ($, on) => {
  await start($, on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
  const narrow = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 30 } })
  expect(await narrow.find({ text: /Timeline/ })).toBeUndefined()
  await narrow.unmount()
})

// ── plan sources (Task 3): read the plan the mod keeps in $.state ──

const PLAN_PATH = '/work/app/docs/superpowers/plans/2026-10-20-auth.md'
const LEDGER = '/work/app/.superpowers/sdd/2026-10-20-auth/progress.md'
const PLAN_TEXT = `# Migrate auth Implementation Plan

### Task 1: Read existing auth code
- [ ] **Step 1: Read**

### Task 2: Rewrite login handler
- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Implement**
`

type PlanSnap = { plan: null | { source: string; title: string; steps: { title: string; status: string; calls: number; lastTest?: { ok: boolean } }[] } }

// The mod's own /watch export prints the snapshot as JSON; the test kit's $ has no state noun.
async function planOf($: Engine) {
  const out = await $.command.run({ command: 'watch', args: 'export' } as never)
  const json = /```json\n([\s\S]*?)\n```/.exec(String(out.text))?.[1] ?? '{}'
  return ((JSON.parse(json) as Partial<PlanSnap>).plan ?? null) as PlanSnap['plan']
}

test('reading a plan file makes it the plan; the ledger moves it on', async ($, on) => {
  const files: Record<string, string> = { [PLAN_PATH]: PLAN_TEXT }
  const { clock } = await start($, on, files)
  await $.turn.start({ text: 'execute the plan', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })
  let plan = await planOf($)
  expect(plan?.source).toBe('file')
  expect(plan?.title).toBe('Migrate auth')
  expect(plan?.steps.map(s => s.title)).toEqual(['Read existing auth code', 'Rewrite login handler'])
  files[LEDGER] = '# SDD ledger — plan: docs/superpowers/plans/2026-10-20-auth.md\nTask 1: complete\n'
  await clock.advance(6000)
  plan = await planOf($)
  expect(plan?.steps.map(s => s.status)).toEqual(['done', 'running'])
})

test('a ledger naming another plan is ignored', async ($, on) => {
  const files: Record<string, string> = { [PLAN_PATH]: PLAN_TEXT, [LEDGER]: '# SDD ledger — plan: docs/superpowers/plans/other.md\nTask 1: complete\n' }
  const { clock } = await start($, on, files)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })
  await clock.advance(6000)
  expect((await planOf($))?.steps.every(s => s.status !== 'done')).toBe(true)
})

test('TodoWrite alone builds steps; with a plan file it marks the matching task', async ($, on) => {
  await start($, on, { [PLAN_PATH]: PLAN_TEXT })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'A', status: 'in_progress', activeForm: 'A' }] } as never)
  expect((await planOf($))?.source).toBe('todo')
  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Task 2: Rewrite login handler', status: 'in_progress', activeForm: 'x' }] } as never)
  const plan = await planOf($)
  expect(plan?.source).toBe('file')
  expect(plan?.steps[1]!.status).toBe('running')
})

test('calls and a red test land on the running step', async ($, on) => {
  await start($, on, { [PLAN_PATH]: PLAN_TEXT })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Rewrite login handler', status: 'in_progress', activeForm: 'x' }] } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const step = (await planOf($))!.steps[1]!
  expect(step.calls).toBeGreaterThanOrEqual(2)
  expect(step.lastTest?.ok).toBe(false)
})

test('/clear keeps a file plan and drops a todo plan', async ($, on) => {
  await start($, on, { [PLAN_PATH]: PLAN_TEXT })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'A', status: 'in_progress', activeForm: 'A' }] } as never)
  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: {} } as never)
  expect(await planOf($)).toBeNull()
  await $.turn.start({ text: 'y', turnId: 't2' })
  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })
  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: {} } as never)
  expect((await planOf($))?.source).toBe('file')
})

test('a prompt with no plan becomes the title', async ($, on) => {
  await start($, on)
  await $.turn.start({ text: 'Fix CAM-12 login bug\nmore', turnId: 't1' })
  const plan = await planOf($)
  expect(plan).toMatchObject({ source: 'prompt', title: 'Fix CAM-12 login bug' })
})

// ── dashboard (Task 4) ──

const DASH = ['terminal', 'desktop', 'vscode'] as const

test('plan card: ticket, title, progress and the current step in detail', async ($, on) => {
  await start($, on, { [PLAN_PATH]: PLAN_TEXT })
  await $.turn.start({ text: 'CAM-77 run the plan', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Read existing auth code', status: 'completed', activeForm: 'x' }, { content: 'Rewrite login handler', status: 'in_progress', activeForm: 'x' }] } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/login.ts', old_string: 'a', new_string: 'b' })
  await $.command.run({ command: 'watch', args: 'plan' } as never)
  for (const surface of DASH) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /CAM-77 · Migrate auth/ })).toBeDefined()
    expect(await ui.find({ text: /1 \/ 2/ })).toBeDefined()
    expect(await ui.find({ text: /✓ Read existing auth code/ })).toBeDefined()
    expect(await ui.find({ text: /▶ Rewrite login handler/ })).toBeDefined()
    expect(await ui.find({ text: /login\.ts · 2 calls/ })).toBeDefined()
    expect(await ui.find({ text: /○ Write the failing test/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a red test shows under its step and on the attention card', async ($, on) => {
  await start($, on, { [PLAN_PATH]: PLAN_TEXT })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Rewrite login handler', status: 'in_progress', activeForm: 'x' }] } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ text: /✗ 1 test failing/ })).toBeDefined()
  await ui.unmount()
  await $.command.run({ command: 'watch', args: 'plan' } as never)
  const plan = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await plan.find({ text: /✗ 1 failed/ })).toBeDefined()
  await plan.unmount()
})

test('a prompt-only turn shows its title and what it is doing', async ($, on) => {
  await start($, on)
  await $.turn.start({ text: 'Fix the login bug', turnId: 't1' })
  for (const surface of DASH) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /Fix the login bug/ })).toBeDefined()
    expect(await ui.find({ text: /thinking/ })).toBeDefined()
    await ui.unmount()
  }
})

test('health line shows context with trend, branch and tests', async ($, on) => {
  await start($, on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.session.measure({ context: { percent: 41, window: 200_000 }, rateLimits: [], changed: ['context'] } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  for (const surface of DASH) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /context . 41%/ })).toBeDefined()
    await ui.unmount()
  }
})

test('turn ended with the plan unfinished shows a receipt line', async ($, on) => {
  await start($, on, { [PLAN_PATH]: PLAN_TEXT })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1000, isAborted: false, reason: 'answer' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /Idle · last turn .* · 1 calls/ })).toBeDefined()
  expect(await ui.find({ text: /Migrate auth/ })).toBeDefined()
  await ui.unmount()
})

test('compact terminal shows the plan header and health line only', async ($, on) => {
  await start($, on, { [PLAN_PATH]: PLAN_TEXT })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 30 } })
  expect(await ui.find({ text: /Migrate auth/ })).toBeDefined()
  expect(await ui.find({ text: /Read existing auth code/ })).toBeUndefined()
  await ui.unmount()
})

// ── review fixes ──

const PLAN_B = '/work/app/docs/superpowers/plans/2026-10-21-other.md'

test('reading a reference plan does not replace the active plan; re-reading the active one keeps it', async ($, on) => {
  await start($, on, { [PLAN_PATH]: PLAN_TEXT, [PLAN_B]: '# Other Implementation Plan\n### Task 1: X\n### Task 2: Y\n' })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })
  await $.tool.call({ tool: 'Read', file_path: PLAN_B })
  expect((await planOf($))?.title).toBe('Migrate auth')
  await $.tool.call({ tool: 'Edit', file_path: PLAN_B, old_string: 'a', new_string: 'b' })
  expect((await planOf($))?.title).toBe('Other')
  await $.tool.call({ tool: 'Edit', file_path: PLAN_PATH, old_string: 'a', new_string: 'b' })
  expect((await planOf($))?.title).toBe('Migrate auth')
})

test('after /clear the kept plan shows no turn receipt', async ($, on) => {
  await start($, on, { [PLAN_PATH]: PLAN_TEXT })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1000, isAborted: false, reason: 'answer' } as never)
  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: {} } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /Migrate auth/ })).toBeDefined()
  expect(await ui.find({ text: /turn done/ })).toBeUndefined()
  await ui.unmount()
})

// ── history ──

async function twoTurns($: Engine, on: On) {
  const ctx = await start($, on)
  await $.turn.start({ text: 'write the plan', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: '/work/app/a.ts' })
  await ctx.clock.advance(2000)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 2000, isAborted: false, reason: 'answer' } as never)
  await $.classic.PreCompact({ trigger: 'auto', custom_instructions: null } as never)
  await $.turn.start({ text: 'fix the failing test', turnId: 't2' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.turn.complete({ turnId: 't2', answer: '', durationMs: 1000, isAborted: false, reason: 'answer' } as never)
  return ctx
}

test('history lists turns newest first, collapsed, with a summary line', async ($, on) => {
  await twoTurns($, on)
  await $.command.run({ command: 'watch', args: 'history' } as never)
  for (const surface of DASH) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^HISTORY$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Turn 2 · fix the failing test · / })).toBeDefined()
    expect(await ui.find({ text: /Turn 1 · write the plan/ })).toBeDefined()
    expect(await ui.find({ text: /compacted context/ })).toBeDefined()
    await ui.unmount()
  }
})

test('history filter cycles all → turns → problems', async ($, on) => {
  await twoTurns($, on)
  await $.command.run({ command: 'watch', args: 'history' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.select({ key: 'filter', value: 'turns' })
  expect(await ui.find({ text: /compacted context/ })).toBeUndefined()
  await ui.select({ key: 'filter', value: 'problems' })
  expect(await ui.find({ text: /write the plan/ })).toBeUndefined()
  expect(await ui.find({ text: /fix the failing test/ })).toBeDefined()
  await ui.unmount()
})

test('history survives /clear; /watch history shows every turn expanded', async ($, on) => {
  await twoTurns($, on)
  await $.session.end({ reason: 'clear', sessionId: 'sess-1', resume: {} } as never)
  await $.command.run({ command: 'watch', args: 'history' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /✗ npm test/ })).toBeDefined()
  expect(await ui.find({ text: /Read a\.ts/ })).toBeDefined()
  await ui.unmount()
})

test('a test summary with no counts reads tests ✓, not tests ✓ 0', async ($, on) => {
  await start($, on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'A', status: 'in_progress', activeForm: 'A' }] } as never)
  await $.tool.call({ tool: 'Bash', command: 'make test' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /tests ✓ 0/ })).toBeUndefined()
  await ui.unmount()
})

// ── presentation round ──

test('/watch clear history empties history', async ($, on) => {
  await twoTurns($, on)
  await $.turn.start({ text: 'again', turnId: 't3' })
  expect((await $.command.run({ command: 'watch', args: 'clear history' } as never)).text).toContain('cleared')
  const after = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await after.find({ text: /again/ })).toBeDefined()
  expect(await after.find({ text: /Turn \d+ · again/ })).toBeUndefined()
  await after.unmount()
})

test('/watch clear plan dismisses it; reading the file brings it back', async ($, on) => {
  await start($, on, { [PLAN_PATH]: PLAN_TEXT })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })
  await $.command.run({ command: 'watch', args: 'clear plan' } as never)
  expect(await planOf($)).toBeNull()
  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })
  expect((await planOf($))?.title).toBe('Migrate auth')
})

test('running step shows its sub-step progress and the next sub-step', async ($, on) => {
  const text = PLAN_TEXT.replace('- [ ] **Step 1: Read**', '- [x] **Step 1: Read**\n- [x] **Step 2: Note**\n- [ ] **Step 3: Summarise**')
  await start($, on, { [PLAN_PATH]: text })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })
  await $.command.run({ command: 'watch', args: 'plan' } as never)
  for (const surface of DASH) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /○ Summarise/ })).toBeDefined()
    expect(await ui.find({ text: /✓ Note/ })).toBeDefined()
    await ui.unmount()
  }
})

test('section labels and a context bar', async ($, on) => {
  await twoTurns($, on)
  await $.session.measure({ context: { percent: 60, window: 200_000 }, rateLimits: [], changed: ['context'] } as never)
  await $.turn.start({ text: 'live', turnId: 't3' })
  const live = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await live.find({ type: 'Text', text: /^HISTORY$/ })).toBeDefined()
  expect(await live.find({ text: /60%/ })).toBeDefined()
  await live.unmount()
})

test('a history row stays one line: long titles are cut', async ($, on) => {
  await start($, on)
  await $.turn.start({ text: 'make a complete full set of test and observe the whole thing end to end please', turnId: 't1' })
  await $.command.run({ command: 'watch', args: 'history' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 50 } })
  const rows = await ui.findAll({ type: 'Text', text: /Turn 1 ·/ })
  const row = rows.sort((a, b) => a.text.length - b.text.length)[0]
  expect(row?.text.length).toBeLessThanOrEqual(50)
  expect(row?.text).toContain('…')
  await ui.unmount()
})

test('Bash calls are labelled by their description when given', async ($, on) => {
  await start($, on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'SP=/tmp/x; screencapture -x $SP/a.png', description: 'Capture the screen' })
  await $.command.run({ command: 'watch', args: 'calls' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /Capture the screen/ })).toBeDefined()
  await ui.unmount()
})

// ── daily tool: engine wiring (Task 5) ──

async function snapOf($: Engine) {
  const out = await $.command.run({ command: 'watch', args: 'export' } as never)
  const json = /```json\n([\s\S]*?)\n```/.exec(String(out.text))?.[1] ?? '{}'
  return JSON.parse(json) as { health: { changes: { path: string; added: number; removed: number; byClaude: boolean; lastTurn?: number }[]; checks: Record<string, { runs: unknown[] }> } }
}

test('changes refresh after a turn with an edit', async ($, on) => {
  await start($, on)
  procs['git diff'] = { stdout: '42\t7\tsrc/login.ts\n' }
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/login.ts', old_string: 'a', new_string: 'b' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1000, isAborted: false, reason: 'answer' } as never)
  const snap = await snapOf($)
  expect(snap.health.changes[0]).toMatchObject({ path: 'src/login.ts', added: 42, removed: 7, byClaude: true, lastTurn: 1 })
})

test('no git base → no changes refresh', async ($, on) => {
  await start($, on)
  procs['git rev-parse'] = { stdout: '', exitCode: 128 }
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  runs.length = 0
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/login.ts', old_string: 'a', new_string: 'b' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1000, isAborted: false, reason: 'answer' } as never)
  expect((await snapOf($)).health.changes).toEqual([])
  expect(runs.some(r => r[0] === 'git' && r[1] === 'diff')).toBe(false)
})

test('two runs of npm test record one check', async ($, on) => {
  await start($, on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const checks = (await snapOf($)).health.checks
  expect(Object.keys(checks)).toHaveLength(1)
  expect(Object.values(checks)[0]!.runs).toHaveLength(2)
})

test('pane title badge follows needs-you', async ($, on) => {
  await start($, on)
  await $.command.run({ command: 'watch', args: '' } as never)
  await $.turn.start({ text: 'x', turnId: 't1' })
  opens.length = 0
  await $.classic.Notification({ notification_type: 'permission_prompt', message: 'Allow?' })
  expect(opens.some(o => o.title === 'Watcher · 1')).toBe(true)
  await $.prompt.submit({ text: 'ok' } as never).catch(() => undefined)
  expect(opens[opens.length - 1]!.title).toBe('Watcher')
})

// ── daily tool: dashboard (Task 6) ──

test('idle line after a finished turn; live sections absent', async ($, on) => {
  const { clock } = await start($, on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: '/a.ts' })
  await clock.advance(2000)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 2000, isAborted: false, reason: 'answer' } as never)
  for (const surface of DASH) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /Idle · last turn 0:02 · 1 calls/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^PLAN$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^CHECKS$/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('changes section lists Claude edits with line counts and a total', async ($, on) => {
  await start($, on)
  procs['git diff'] = { stdout: '42\t7\tsrc/login.ts\n' }
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/login.ts', old_string: 'a', new_string: 'b' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1000, isAborted: false, reason: 'answer' } as never)
  await $.turn.start({ text: 'y', turnId: 't2' })
  await $.command.run({ command: 'watch', args: 'changes' } as never)
  for (const surface of DASH) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^CHANGES$/ })).toBeDefined()
    expect(await ui.find({ text: /src\/login\.ts/ })).toBeDefined()
    expect(await ui.find({ text: /\+42 −7/ })).toBeDefined()
    expect(await ui.find({ text: /1 files · \+42 −7/ })).toBeDefined()
    await ui.unmount()
  }
})

test('checks section shows the trend of a repeated command', async ($, on) => {
  await start($, on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.command.run({ command: 'watch', args: 'checks' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ type: 'Text', text: /^CHECKS$/ })).toBeDefined()
  expect(await ui.find({ text: /npm test/ })).toBeDefined()
  expect(await ui.find({ text: /✗ ✗/ })).toBeDefined()
  await ui.unmount()
})

test('context section forecasts compaction from the per-turn burn', async ($, on) => {
  await start($, on)
  for (const [i, pctNow] of [40, 44].entries()) {
    await $.turn.start({ text: `t${i}`, turnId: `t${i}` })
    await $.session.measure({ context: { percent: pctNow, window: 200_000 }, rateLimits: [], changed: ['context'] } as never)
    await $.turn.complete({ turnId: `t${i}`, answer: '', durationMs: 1000, isAborted: false, reason: 'answer' } as never)
  }
  await $.turn.start({ text: 'now', turnId: 'tn' })
  await $.session.measure({ context: { percent: 48, window: 200_000 }, rateLimits: [], changed: ['context'] } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /context . 48% · ~10 turns left/ })).toBeDefined()
  await ui.unmount()
})

test('dashboard buttons are only the history arrow and clear; footer has the menus', async ($, on) => {
  await twoTurns($, on)
  await $.turn.start({ text: 'live', turnId: 't3' })
  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // Only the history header's two controls are buttons.
    expect((await ui.findAll({ type: 'Button' })).map(b => b.key).sort()).toEqual(['history-clear', 'history-toggle'])
    expect((await ui.find({ key: 'view' }))?.type).toBe('Select')
    expect((await ui.find({ key: 'filter' }))?.type).toBe('Select')
    expect((await ui.find({ key: 'open' }))?.type).toBe('Select')
    await ui.unmount()
  }
})

test('open… runs code -g for a changed file; copies the path when code fails', async ($, on) => {
  await start($, on)
  procs['git diff'] = { stdout: '42\t7\tsrc/login.ts\n' }
  procs['code -g'] = { stdout: '', exitCode: 1 }
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/login.ts', old_string: 'a', new_string: 'b' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1000, isAborted: false, reason: 'answer' } as never)
  await $.turn.start({ text: 'y', turnId: 't2' })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.select({ key: 'open', value: 'file:src/login.ts' })
  expect(runs.some(r => r.join(' ') === 'code -g /work/app/src/login.ts')).toBe(true)
  expect(toasts.some(t => t.startsWith('Copied path:'))).toBe(true)
  await ui.unmount()
})

test('compact terminal keeps attention, plan header, context and footer only', async ($, on) => {
  await start($, on, { [PLAN_PATH]: PLAN_TEXT })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })
  await $.session.measure({ context: { percent: 30, window: 200_000 }, rateLimits: [], changed: ['context'] } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 30 } })
  expect(await ui.find({ text: /Migrate auth/ })).toBeDefined()
  expect(await ui.find({ text: /30%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^HISTORY$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^CHANGES$/ })).toBeUndefined()
  await ui.unmount()
})

test('vscode does not cut text by its reported column count', async ($, on) => {
  await start($, on)
  const long = 'Refactor the session authentication middleware to use OAuth2 tokens'
  await $.turn.start({ text: long, turnId: 't1' })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode', props: { ...PANE.props, bodyColumns: 30 } })
  expect(await ui.find({ text: long })).toBeDefined()
  await ui.unmount()
})

// ── review + live fixes ──

test('changes in a repo subdirectory are attributed and opened at the repo root', async ($, on) => {
  await start($, on)
  procs['git rev-parse'] = { stdout: '/work\nabc123\n' }
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  procs['git diff'] = { stdout: '42\t7\tapp/src/login.ts\n' }
  procs['code -g'] = { stdout: '' }
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/login.ts', old_string: 'a', new_string: 'b' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1000, isAborted: false, reason: 'answer' } as never)
  expect((await snapOf($)).health.changes[0]).toMatchObject({ path: 'app/src/login.ts', byClaude: true, lastTurn: 1 })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.select({ key: 'open', value: 'file:app/src/login.ts' })
  expect(runs.some(r => r.join(' ') === 'code -g /work/app/src/login.ts')).toBe(true)
  await ui.unmount()
})

test('reopening the pane keeps the badge', async ($, on) => {
  await start($, on)
  await $.command.run({ command: 'watch', args: '' } as never)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.classic.Notification({ notification_type: 'permission_prompt', message: 'Allow?' })
  await $.command.run({ command: 'watch', args: '' } as never)
  opens.length = 0
  await $.command.run({ command: 'watch', args: '' } as never)
  expect(opens[opens.length - 1]!.title).toBe('Watcher · 1')
})

test('after a turn ends, idle still shows what changed and the checks', async ($, on) => {
  await start($, on)
  procs['git diff'] = { stdout: '42\t7\tsrc/login.ts\n' }
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/login.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'make test' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1000, isAborted: false, reason: 'answer' } as never)
  await $.prompt.submit({ text: 'ok' } as never).catch(() => undefined)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ text: /Idle ·/ })).toBeDefined()
  expect(await ui.find({ text: /files changed \+42 −7/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ tests / })).toBeDefined()
  await ui.unmount()
})

test('a check row is labelled by the call description', async ($, on) => {
  await start($, on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'cd /work/app && npm test -- --runInBand --silent', description: 'Run unit tests' })
  await $.command.run({ command: 'watch', args: 'checks' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ type: 'Text', text: /^Run unit tests$/ })).toBeDefined()
  await ui.unmount()
})

// ── block layout ──

test('usage, status and now blocks on top, history block pinned below, footer last inside history', async ($, on) => {
  await twoTurns($, on)
  await $.turn.start({ text: 'live', turnId: 't3' })
  for (const surface of DASH) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const root = (await ui.drawn()) as unknown as { props?: Record<string, unknown>; children?: unknown[] }
    const kids = (root.children ?? []) as { key?: string; props?: Record<string, unknown>; children?: unknown[] }[]
    expect(root.props?.height).toBe(40)
    const keyOf = (c: { key?: string; props?: Record<string, unknown> }) => c.key ?? (c.props?.key as string | undefined)
    expect(kids.map(keyOf)).toEqual(['usage-block', 'status', 'now', 'spacer', 'history-block'])
    expect(kids[3]!.props?.flexGrow).toBe(1)
    const hist = kids[4]!
    const last = (hist.children ?? [])[(hist.children ?? []).length - 1] as { key?: string; props?: Record<string, unknown> }
    expect(keyOf(last)).toBe('footer')
    await ui.unmount()
  }
})

test('every bar is drawn the same 4px height', async ($, on) => {
  await start($, on, { [PLAN_PATH]: PLAN_TEXT })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })
  await $.session.measure({ context: { percent: 50, window: 200_000 }, rateLimits: [], changed: ['context'] } as never)
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  const svgs = await ui.findAll({ type: 'Svg' })
  expect(svgs.length).toBeGreaterThanOrEqual(2)
  for (const s of svgs) {
    const src = String(s.props.source)
    const heights = [...src.matchAll(/<rect[^>]*?height="([\d.]+)"/g)].map(m => Number(m[1])).filter(hh => hh > 1)
    for (const hh of heights) expect(hh).toBe(4)
  }
  await ui.unmount()
})

test('open… starts on a blank choice so every option can be picked', async ($, on) => {
  await start($, on, { [PLAN_PATH]: PLAN_TEXT })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  const open = await ui.find({ key: 'open' })
  const options = open?.props.options as { value: string; label: string }[]
  expect(options[0]).toEqual({ value: '', label: 'choose…' })
  expect(open?.props.value).toBe('')
  await ui.select({ key: 'open', value: '' })
  expect(runs.some(r => r[0] === 'code')).toBe(false)
  await ui.unmount()
})

test('/watch clear checks empties the checks', async ($, on) => {
  await start($, on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect((await $.command.run({ command: 'watch', args: 'clear checks' } as never)).text).toContain('checks cleared')
  expect(Object.keys((await snapOf($)).health.checks)).toHaveLength(0)
})

// ── visual dashboard ──

async function busyPlan($: Engine, on: On) {
  const { clock } = await start($, on, { [PLAN_PATH]: PLAN_TEXT })
  procs['git diff'] = { stdout: '42\t7\tsrc/login.ts\n' }
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })
  await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/login.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1000, isAborted: false, reason: 'answer' } as never)
  await clock.advance(1000)
  await $.turn.start({ text: 'continue', turnId: 't2' })
  await $.session.measure({ context: { percent: 57, window: 200_000 }, rateLimits: [], changed: ['context'] } as never)
}

test('visual dashboard: segmented plan bar, step list, signal chips; no file or check lists', async ($, on) => {
  await busyPlan($, on)
  for (const surface of DASH) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'plan-segments' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^Read existing auth code$/ }))?.props.color).toBe('#79c0ff')
    expect(await ui.find({ text: /files changed \+42 −7/ })).toBeDefined()
    expect(await ui.find({ text: /context .*57%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ tests / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^CHANGES$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^CHECKS$/ })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /^Rewrite login handler$/ }))?.props.color).toBe('#6e7681')
    await ui.unmount()
  }
})

test('history block: a turn strip and the latest three turns', async ($, on) => {
  await start($, on)
  for (let i = 1; i <= 5; i++) {
    await $.turn.start({ text: `turn number ${i}`, turnId: `t${i}` })
    await $.turn.complete({ turnId: `t${i}`, answer: '', durationMs: 1000, isAborted: false, reason: 'answer' } as never)
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ key: 'turn-strip' })).toBeDefined()
  expect(await ui.find({ text: /turn number 5/ })).toBeDefined()
  expect(await ui.find({ text: /turn number 3/ })).toBeDefined()
  expect(await ui.find({ text: /turn number 1/ })).toBeUndefined()
  await ui.unmount()
})

test('segments are 4px blocks, one per step, coloured by status', async ($, on) => {
  await busyPlan($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  // Svg takes no key; the segments markup carries data-kind="segments".
  const svgs = await ui.findAll({ type: 'Svg' })
  const src = svgs.map(x => String(x.props.source)).find(x => x.includes('data-kind="segments"')) ?? ''
  const rects = [...src.matchAll(/<rect[^>]*>/g)]
  expect(rects).toHaveLength(2)
  expect(src).not.toBe('')
  for (const r of rects) expect(r[0]).toContain('height="4"')
  await ui.unmount()
})

// ── colour ──

test('now block border follows state; chips are tinted badges', async ($, on) => {
  await busyPlan($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  const root = (await ui.drawn()) as unknown as { children?: { props?: Record<string, unknown> }[] }
  const nowBlock = root.children?.[2]
  expect(nowBlock?.props?.borderColor).toBe('#58a6ff')
  for (const text of [/^ tests /, /^ files changed /, /^ context /]) {
    const chip = await ui.find({ type: 'Text', text })
    expect(typeof chip?.props.backgroundColor).toBe('string')
  }
  await ui.unmount()
})

// ── self-explaining labels ──

test('every number on the dashboard carries a word', async ($, on) => {
  await busyPlan($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ text: /step 1 of 2 · \d\d:\d\d → now · / })).toBeDefined()
  expect(await ui.find({ text: /0 done/ })).toBeDefined()
  expect(await ui.find({ text: /^ files changed \+42 −7 $/ })).toBeDefined()
  expect(await ui.find({ text: /^ context . 57%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^PLAN$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^NOW$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^HISTORY$/ })).toBeDefined()
  expect(await ui.find({ text: /bar height = turn length/ })).toBeUndefined()
  await ui.unmount()
})

// ── plan lifecycle ──

test('actions menu clears the plan and the history', async ($, on) => {
  await start($, on, { [PLAN_PATH]: PLAN_TEXT })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  const menu = await ui.find({ key: 'open' })
  expect(menu?.props.label).toBe('actions…')
  const values = (menu?.props.options as { value: string }[]).map(o => o.value)
  expect(values).toContain('clear-plan')
  expect(values).toContain('clear-history')
  await ui.select({ key: 'open', value: 'clear-plan' })
  await ui.unmount()
  expect(await planOf($)).toBeNull()
})

test('a finished plan logs an event and clears itself when the next turn starts', async ($, on) => {
  const files: Record<string, string> = { [PLAN_PATH]: PLAN_TEXT }
  const { clock } = await start($, on, files)
  await $.turn.start({ text: 'run plan', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })
  files[LEDGER] = '# SDD ledger — plan: docs/superpowers/plans/2026-10-20-auth.md\nTask 1: complete\nTask 2: complete\n'
  await clock.advance(6000)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 6000, isAborted: false, reason: 'answer' } as never)
  const done = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await done.find({ text: /all 2 steps done/ })).toBeDefined()
  await done.unmount()
  await $.command.run({ command: 'watch', args: 'history' } as never)
  const hist = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await hist.find({ text: /plan finished · Migrate auth · 2 steps/ })).toBeDefined()
  await hist.unmount()
  await $.command.run({ command: 'watch', args: 'turn' } as never)
  await $.turn.start({ text: 'next thing', turnId: 't2' })
  expect((await planOf($))?.source).toBe('prompt')
})

// ── step list on the dashboard ──

test('dashboard lists steps in order: green done, blue running, grey waiting', async ($, on) => {
  await start($, on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  const todos = [
    { content: 'Alpha', status: 'completed', activeForm: 'x' },
    { content: 'Beta', status: 'in_progress', activeForm: 'x' },
    { content: 'Gamma', status: 'pending', activeForm: 'x' },
  ]
  await $.tool.call({ tool: 'TodoWrite', todos } as never)
  for (const surface of DASH) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const texts = await ui.findAll({ type: 'Text', text: /^(Alpha|Beta|Gamma)$/ })
    expect(texts.map(t => t.text)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(texts[0]!.props.color).toBe('#7ee2a0')
    expect(texts[1]!.props.color).toBe('#79c0ff')
    expect(texts[1]!.props.bold).toBe(true)
    expect(texts[2]!.props.color).toBe('#6e7681')
    await ui.unmount()
  }
})

test('long plans fold done steps into one line', async ($, on) => {
  await start($, on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  const todos = [
    ...Array.from({ length: 22 }, (_, i) => ({ content: `done ${i + 1}`, status: 'completed', activeForm: 'x' })),
    { content: 'now', status: 'in_progress', activeForm: 'x' },
    ...Array.from({ length: 4 }, (_, i) => ({ content: `later ${i + 1}`, status: 'pending', activeForm: 'x' })),
  ]
  await $.tool.call({ tool: 'TodoWrite', todos } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /✓ 21 done/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^done 22$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^done 3$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^later 4$/ })).toBeDefined()
  await ui.unmount()
})

test('steps finished without a measured time show no 0s', async ($, on) => {
  const files: Record<string, string> = { [PLAN_PATH]: PLAN_TEXT, [LEDGER]: '# SDD ledger — plan: docs/superpowers/plans/2026-10-20-auth.md\nTask 1: complete\n' }
  await start($, on, files)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ type: 'Text', text: /^0s$/ })).toBeUndefined()
  await ui.unmount()
})

// ── turns: times, paging, filter, replay ──

async function manyTurns($: Engine, on: On, n: number) {
  const ctx = await start($, on)
  for (let i = 1; i <= n; i++) {
    await $.turn.start({ text: `turn number ${i}`, turnId: `t${i}` })
    if (i === 3) await $.tool.call({ tool: 'Bash', command: 'npm test' })
    await ctx.clock.advance(60_000)
    await $.turn.complete({ turnId: `t${i}`, answer: '', durationMs: 60_000, isAborted: false, reason: 'answer' } as never)
  }
  return ctx
}

test('turn rows show start → end and the length', async ($, on) => {
  await manyTurns($, on, 1)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ text: /\d\d:\d\d → \d\d:\d\d/ })).toBeDefined()
  expect(await ui.find({ text: /→ \d\d:\d\d · 1m/ })).toBeDefined()
  await ui.unmount()
})

test('three turns show; load more adds three, show less goes back', async ($, on) => {
  await manyTurns($, on, 8)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ type: 'Text', text: /^turn number 6$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^turn number 5$/ })).toBeUndefined()
  expect((await ui.find({ key: 'history-more' }))?.text).toBe('↓ load 3 more · 5 older')
  await ui.press({ key: 'history-more' })
  expect(await ui.find({ type: 'Text', text: /^turn number 3$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^turn number 2$/ })).toBeUndefined()
  await ui.select({ key: 'turn-pick', value: 'more' })
  expect(await ui.find({ type: 'Text', text: /^turn number 1$/ })).toBeDefined()
  expect(await ui.find({ key: 'history-more' })).toBeUndefined()
  await ui.press({ key: 'history-less' })
  expect(await ui.find({ type: 'Text', text: /^turn number 5$/ })).toBeUndefined()
  await ui.unmount()
})

test('the history filter applies to the dashboard rows', async ($, on) => {
  await manyTurns($, on, 4)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.select({ key: 'filter', value: 'problems' })
  expect(await ui.find({ type: 'Text', text: /^turn number 3$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^turn number 4$/ })).toBeUndefined()
  await ui.unmount()
})

test('picking a turn replays it in the dashboard layout', async ($, on) => {
  const files: Record<string, string> = { [PLAN_PATH]: PLAN_TEXT }
  const { clock } = await start($, on, files)
  await $.turn.start({ text: 'run plan', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })
  await clock.advance(30_000)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 30_000, isAborted: false, reason: 'answer' } as never)
  await $.turn.start({ text: 'later', turnId: 't2' })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.select({ key: 'turn-pick', value: 't1' })
  expect(await ui.find({ text: /Turn 1 · run plan/ })).toBeDefined()
  expect(await ui.find({ text: /→/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^Read existing auth code$/ }))?.props.color).toBe('#79c0ff')
  expect(await ui.find({ type: 'Text', text: /^PLAN$/ })).toBeDefined()
  await ui.unmount()
})

test('a finished turn card lists its tests, files and calls', async ($, on) => {
  const { clock } = await start($, on, { [PLAN_PATH]: PLAN_TEXT })
  await $.turn.start({ text: 'run plan', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })
  await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/login.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await clock.advance(30_000)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 30_000, isAborted: false, reason: 'answer' } as never)
  await $.turn.start({ text: 'next', turnId: 't2' })
  for (const surface of DASH) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /tests ✗ 1 · 1 file · 3 calls/ })).toBeDefined()
    await ui.unmount()
  }
})

test('from a replay, the view menu goes back to the dashboard', async ($, on) => {
  await manyTurns($, on, 2)
  await $.turn.start({ text: 'live', turnId: 'tl' })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.select({ key: 'turn-pick', value: 't1' })
  const view = await ui.find({ key: 'view' })
  expect(view?.props.value).toBe('replay')
  expect((view?.props.options as { value: string }[]).some(o => o.value === 'replay')).toBe(true)
  await ui.select({ key: 'view', value: 'turn' })
  expect(await ui.find({ type: 'Text', text: /^HISTORY$/ })).toBeDefined()
  await ui.unmount()
})

test('a multi-line test command shows as one short line in the tree', async ($, on) => {
  const { clock } = await start($, on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  const long = "npm test -- --runInBand\necho 'second line that must not show'\n" + 'x'.repeat(200)
  await $.tool.call({ tool: 'Bash', command: long })
  await clock.advance(1000)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1000, isAborted: false, reason: 'answer' } as never)
  await $.turn.start({ text: 'next', turnId: 't2' })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  const branch = await ui.find({ type: 'Text', text: /tests/ })
  expect(await ui.find({ text: /second line that must not show/ })).toBeUndefined()
  expect(branch).toBeDefined()
  const tests = await ui.findAll({ type: 'Text', text: /├─|└─/ })
  for (const t of tests) expect(t.text.length).toBeLessThan(120)
  await ui.unmount()
})

test('the live tree lists only steps this turn moved', async ($, on) => {
  const { clock } = await start($, on, { [PLAN_PATH]: PLAN_TEXT })
  await $.turn.start({ text: 'first', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })
  await clock.advance(1000)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1000, isAborted: false, reason: 'answer' } as never)
  await clock.advance(1000)
  await $.turn.start({ text: 'second', turnId: 't2' })
  await $.tool.call({ tool: 'Read', file_path: '/work/app/x.ts' })
  await clock.advance(1000)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.findAll({ type: 'Text', text: /step\s+Read existing auth code/ })).toHaveLength(0)
  await ui.unmount()
})

test('svgs are drawn at their own pixel size so text never stretches', async ($, on) => {
  await busyPlan($, on)
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  for (const svg of await ui.findAll({ type: 'Svg' })) {
    const w = /width="([\d.]+)"/.exec(String(svg.props.source))?.[1]
    expect(svg.props.width).toBe(Number(w))
  }
  await ui.unmount()
})

test('svgs never overflow a narrow pane on any surface', async ($, on) => {
  await busyPlan($, on)
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
  await $.classic.SubagentStart({ agent_id: 'a2', agent_type: 'Plan' })
  for (const surface of ['vscode', 'desktop'] as const) {
    for (const cols of [30, 50, 100]) {
      const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: cols } })
      for (const svg of await ui.findAll({ type: 'Svg' })) expect(Number(svg.props.width)).toBeLessThanOrEqual(cols * 7)
      await ui.unmount()
    }
  }
})

test('svg bars grow with a wide pane', async ($, on) => {
  await busyPlan($, on)
  const widest = async (cols: number) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'vscode', props: { ...PANE.props, bodyColumns: cols } })
    const ws = (await ui.findAll({ type: 'Svg' })).map(s => Number(s.props.width))
    await ui.unmount()
    return Math.max(0, ...ws)
  }
  expect(await widest(120)).toBeGreaterThan(await widest(50))
})

test('narrow vscode pane goes compact like the terminal', async ($, on) => {
  await start($, on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
  const narrow = await $.ui.mount({ ...PANE, surface: 'vscode', props: { ...PANE.props, bodyColumns: 30 } })
  expect(await narrow.find({ text: /Timeline/ })).toBeUndefined()
  await narrow.unmount()
})

test('a plan of up to 20 steps lists every step while it runs', async ($, on) => {
  await start($, on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  const todos = [
    ...Array.from({ length: 5 }, (_, i) => ({ content: `done ${i + 1}`, status: 'completed', activeForm: 'x' })),
    { content: 'now', status: 'in_progress', activeForm: 'x' },
    ...Array.from({ length: 6 }, (_, i) => ({ content: `later ${i + 1}`, status: 'pending', activeForm: 'x' })),
  ]
  await $.tool.call({ tool: 'TodoWrite', todos } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  for (const t of ['done 1', 'done 5', 'now', 'later 1', 'later 6']) expect(await ui.find({ type: 'Text', text: new RegExp(`^${t}$`) })).toBeDefined()
  expect(await ui.find({ key: 'steps-folded' })).toBeUndefined()
  await ui.unmount()
})

test('timeline freezes once the turn and its agents end', async ($, on) => {
  const { clock } = await start($, on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
  await clock.advance(5000)
  await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'Explore' } as never)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5000, isAborted: false, reason: 'answer' } as never)
  const shot = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
    const src = (await ui.findAll({ type: 'Svg' })).map(x => String(x.props.source)).join('|')
    await ui.unmount()
    return src
  }
  const before = await shot()
  await clock.advance(30_000)
  expect(await shot()).toBe(before)
})

test('a turn replay has a one-click way back to the dashboard', async ($, on) => {
  await manyTurns($, on, 2)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  const first = ((await ui.find({ key: 'turn-pick' }))!.props.options as { label: string; value: string }[]).find(o => o.label.startsWith('Turn 1'))!.value
  await ui.select({ key: 'turn-pick', value: first })
  expect((await ui.find({ key: 'replay-back' }))?.text).toBe('← dashboard')
  await ui.press({ key: 'replay-back' })
  expect(await ui.find({ key: 'replay-back' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^NOW$/ })).toBeDefined()
  await ui.unmount()
})

test('usage windows show on top of every view, like /usage', async ($, on) => {
  await start($, on)
  const soon = new Date(1_000_000 + 2 * 3_600_000 + 5 * 60_000).toISOString()
  const rateLimits = [
    { kind: 'seven_day', percentUsed: 41, resetsAt: new Date(1_000_000 + 4 * 86_400_000).toISOString() },
    { kind: 'five_hour', percentUsed: 23.5, resetsAt: soon },
    { kind: 'seven_day_fable', percentUsed: 92 },
  ]
  await $.session.measure({ context: { percent: 10, window: 200_000 }, rateLimits, changed: ['rateLimits'] } as never)
  for (const surface of DASH) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const labels = (await ui.findAll({ type: 'Text', text: /^(session|weekly|fable)$/ })).map(t => t.text)
    expect(labels).toEqual(['session', 'weekly', 'fable'])
    expect(await ui.find({ text: /^24%$/ })).toBeDefined()
    expect(await ui.find({ text: /resets in 2h 5m/ })).toBeDefined()
    expect((await ui.find({ text: /^92%$/ }))?.props.color).toBe('error')
    await ui.unmount()
  }
  await $.command.run({ command: 'watch', args: 'health' } as never)
  const detail = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await detail.find({ type: 'Text', text: /^USAGE$/ })).toBeDefined()
  await detail.unmount()
})

test('usage block shows before any update; status block says what is happening', async ($, on) => {
  await start($, on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })
  for (const surface of DASH) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /waiting for the first usage update/ })).toBeDefined()
    expect(await ui.find({ key: 'status-line' })).toBeDefined()
    expect(await ui.find({ key: 'status-agent-a1' })).toBeDefined()
    const order = (await ui.findAll({ type: 'Text', text: /^(USAGE|NOW)$/ })).map(t => t.text)
    expect(order).toEqual(['USAGE', 'NOW'])
    await ui.unmount()
  }
})

test('new files count in the files-changed chip', async ($, on) => {
  await start($, on)
  procs['git ls-files'] = { stdout: 'demo/new.ts\n' }
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Write', file_path: '/work/app/demo/new.ts', content: 'a' } as never)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1000, isAborted: false, reason: 'answer' } as never)
  await $.turn.start({ text: 'y', turnId: 't2' })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ text: /^ files changed 1 new $/ })).toBeDefined()
  await ui.unmount()
})

// ── blocks for history, tree for now ──

test('history turns are cards, not tree lines', async ($, on) => {
  const { clock } = await start($, on)
  await $.turn.start({ text: 'first turn', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/app/a.ts', old_string: 'a', new_string: 'b' })
  await clock.advance(30_000)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 30_000, isAborted: false, reason: 'answer' } as never)
  await $.turn.start({ text: 'second', turnId: 't2' })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  const root = (await ui.drawn()) as unknown as { children?: { children?: unknown[] }[] }
  const hist = JSON.stringify(root.children?.[4])
  expect(hist).toContain('"key":"card-t1"')
  expect(hist).not.toContain('├─')
  expect(await ui.find({ text: /\d\d:\d\d → \d\d:\d\d · 30s/ })).toBeDefined()
  await ui.unmount()
})

test('the current turn shows its work as a tree under NOW', async ($, on) => {
  await start($, on)
  await $.turn.start({ text: 'live', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/login.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ text: /├─ ✗ tests\s+1 failed/ })).toBeDefined()
  expect(await ui.find({ text: /└─ ✎ files\s+login\.ts/ })).toBeDefined()
  await ui.unmount()
})

test('the current card shows start → now, not only elapsed', async ($, on) => {
  await start($, on, { [PLAN_PATH]: PLAN_TEXT })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: PLAN_PATH })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ text: /\d\d:\d\d → now · / })).toBeDefined()
  await ui.unmount()
})

test('agent lane labels are pane text, not drawn inside the chart', async ($, on) => {
  await start($, on)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Demo Reviewer' })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  for (const svg of await ui.findAll({ type: 'Svg' })) expect(String(svg.props.source)).not.toContain('<text')
  expect(await ui.find({ type: 'Text', text: /^Demo Reviewer$/ })).toBeDefined()
  await ui.unmount()
})

test('history collapses to one line and expands again', async ($, on) => {
  await manyTurns($, on, 3)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.select({ key: 'turn-pick', value: 'collapse' })
  expect(await ui.find({ type: 'Text', text: /^turn number 3$/ })).toBeUndefined()
  expect(await ui.find({ text: /show 3 turns/ })).toBeDefined()
  await ui.select({ key: 'turn-pick', value: 'expand' })
  expect(await ui.find({ type: 'Text', text: /^turn number 3$/ })).toBeDefined()
  await ui.unmount()
})

test('history header has an arrow to collapse and a clear button', async ($, on) => {
  await manyTurns($, on, 2)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect((await ui.find({ key: 'history-toggle' }))?.text).toBe('▾ hide')
  expect((await ui.find({ key: 'history-clear' }))?.text).toBe('✕ clear')
  await ui.press({ key: 'history-toggle' })
  expect((await ui.find({ key: 'history-toggle' }))?.text).toBe('▸ show 2 turns')
  expect(await ui.find({ type: 'Text', text: /^turn number 2$/ })).toBeUndefined()
  await ui.press({ key: 'history-toggle' })
  expect(await ui.find({ type: 'Text', text: /^turn number 2$/ })).toBeDefined()
  await ui.press({ key: 'history-clear' })
  expect(await ui.find({ type: 'Text', text: /^turn number 2$/ })).toBeUndefined()
  await ui.unmount()
})
