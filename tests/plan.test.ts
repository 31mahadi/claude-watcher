import { describe, expect, test } from 'claude-code/testing'

import { attribute, isPersistent, isPlanPath, ledgerPath, mergeTodos, parseLedger, parsePlanFile, planFromFile, planProgress, promptPlan, settle, taskEvent, ticketKey } from '../hooks/plan'

export const SAMPLE = `# Conversion Uplift Implementation Plan

> **For agentic workers:** ...

## Global Constraints
- x

### Task 1: Company facts (data layer)
- [x] **Step 1: Write the failing tests**
- [x] **Step 2: Run to verify it fails**
- [ ] **Step 3: Add the fields**

### Task 2: Reply promise beside every CTA
- [ ] **Step 1: Write the failing e2e test**
`

describe('plan file parsing', () => {
  test('parsePlanFile reads tasks and checkbox substeps', async () => {
    const p = parsePlanFile(SAMPLE)!
    expect(p.title).toBe('Conversion Uplift')
    expect(p.steps.map(s => s.title)).toEqual(['Company facts (data layer)', 'Reply promise beside every CTA'])
    expect(p.steps[0]!.id).toBe('task-1')
    expect(p.steps[0]!.substeps.map(s => s.done)).toEqual([true, true, false])
    expect(p.steps[0]!.substeps[0]!.title).toBe('Write the failing tests')
  })

  test('parsePlanFile falls back to headings/list items; ignores < 2 items', async () => {
    expect(parsePlanFile('# Plan\n## Read code\n## Change it\n')!.steps).toHaveLength(2)
    expect(parsePlanFile('# Plan\n1. Read code\n2. Change it\n3. Test\n')!.steps).toHaveLength(3)
    expect(parsePlanFile('# Notes\njust text\n')).toBeUndefined()
  })

  test('parsePlanFile: tasks without checkboxes still parse', async () => {
    expect(parsePlanFile('# X Implementation Plan\n### Task 1: A\ntext\n### Task 2: B\n')!.steps).toHaveLength(2)
  })

  test('parseLedger honours only its own plan', async () => {
    const own = '# SDD ledger — plan: docs/superpowers/plans/a.md\nTask 1: complete\nTask 3: complete (commits x)\n'
    expect([...parseLedger(own, '/r/docs/superpowers/plans/a.md')]).toEqual([1, 3])
    expect([...parseLedger(own, '/r/docs/superpowers/plans/b.md')]).toEqual([])
  })

  test('ledgerPath and isPlanPath', async () => {
    expect(ledgerPath('/r/docs/superpowers/plans/2026-10-20-x.md')).toBe('/r/.superpowers/sdd/2026-10-20-x/progress.md')
    expect(isPlanPath('/r/docs/superpowers/plans/x.md')).toBe(true)
    expect(isPlanPath('/r/docs/notes.md')).toBe(false)
  })

  test('ticketKey takes the first match in order', async () => {
    expect(ticketKey('Migrate auth', 'feat/CAM-1234-auth', 'do PROJ-9')).toBe('CAM-1234')
    expect(ticketKey(undefined, 'main', 'hello')).toBeUndefined()
  })
})

const FILE = '/r/docs/superpowers/plans/a.md'

describe('plan model', () => {
  test('mergeTodos with a file plan marks the matching task running; extras become substeps', async () => {
    const p = planFromFile(parsePlanFile(SAMPLE)!, { path: FILE, source: 'file', done: new Set(), now: 0 })
    const m = mergeTodos(p, [{ content: 'Task 2: Reply promise beside every CTA', status: 'in_progress' }, { content: 'Run full suite', status: 'pending' }], 10)
    expect(m.steps.map(s => s.status)).toEqual(['pending', 'running'])
    expect(m.steps[1]!.substeps!.some(s => s.title === 'Run full suite')).toBe(true)
    expect(m.steps).toHaveLength(2)
  })

  test('mergeTodos completing a file task advances to the next', async () => {
    const p = planFromFile(parsePlanFile(SAMPLE)!, { path: FILE, source: 'file', done: new Set(), now: 0 })
    const m = mergeTodos(p, [{ content: 'Company facts (data layer)', status: 'completed' }], 4)
    expect(m.steps.map(s => s.status)).toEqual(['done', 'running'])
  })

  test('mergeTodos without a plan builds a todo plan', async () => {
    const m = mergeTodos(null, [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }], 5)
    expect(m.source).toBe('todo')
    expect(m.steps.map(s => s.status)).toEqual(['done', 'running'])
  })

  test('attribute lands on the running step only', async () => {
    let m = mergeTodos(null, [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }], 0)
    m = attribute(m, { kind: 'call' })
    m = attribute(m, { kind: 'edit', file: '/x/login.ts' })
    m = attribute(m, { kind: 'edit', file: '/x/login.ts' })
    m = attribute(m, { kind: 'agent', id: 'ag1' })
    expect(m.steps[0]).toMatchObject({ calls: 1, editedFiles: ['/x/login.ts'], agentIds: ['ag1'] })
    expect(m.steps[1]).toMatchObject({ calls: 0, editedFiles: [] })
  })

  test('settle marks a step failed only after it stops running with red tests', async () => {
    const red = { runner: 'jest', passed: 1, failed: 2, ok: false, at: 1, command: 'npm test' }
    let m = mergeTodos(null, [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }], 0)
    m = settle(attribute(m, { kind: 'test', result: red }), 2)
    expect(m.steps[0]!.status).toBe('running')
    m = settle(mergeTodos(m, [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }], 3), 3)
    expect(m.steps[0]!.status).toBe('failed')
  })

  test('settle sets endedAt when every step is done', async () => {
    const m = settle(mergeTodos(null, [{ content: 'A', status: 'completed' }], 0), 9)
    expect(m.endedAt).toBe(9)
  })

  test('planFromFile uses the ledger and keeps step stats across re-parse', async () => {
    const parsed = parsePlanFile(SAMPLE)!
    let p = planFromFile(parsed, { path: FILE, source: 'file', done: new Set(), now: 0 })
    p = attribute({ ...p, steps: p.steps.map((s, i) => (i === 0 ? { ...s, status: 'running' as const, startedAt: 0 } : s)) }, { kind: 'call' })
    const q = planFromFile(parsed, { path: FILE, source: 'file', done: new Set([1]), now: 50, prev: p })
    expect(q.steps[0]).toMatchObject({ status: 'done', calls: 1, endedAt: 50 })
    expect(q.steps[1]!.status).toBe('running')
  })

  test('planFromFile: all substeps checked counts as done', async () => {
    const text = '# P Implementation Plan\n### Task 1: A\n- [x] one\n- [x] two\n### Task 2: B\n- [ ] three\n'
    const p = planFromFile(parsePlanFile(text)!, { path: FILE, source: 'file', done: new Set(), now: 0 })
    expect(p.steps.map(s => s.status)).toEqual(['done', 'running'])
  })

  test('planFromFile takes the ticket from title, then branch, then prompt', async () => {
    const p = planFromFile(parsePlanFile(SAMPLE)!, { path: FILE, source: 'file', done: new Set(), now: 0, branch: 'feat/CAM-77-x', prompt: 'do PROJ-1' })
    expect(p.ticket).toBe('CAM-77')
  })

  test('taskEvent creates and completes steps', async () => {
    let m = taskEvent(null, { id: '1', title: 'Read code', done: false }, 0)
    m = taskEvent(m, { id: '2', title: 'Change it', done: false }, 1)
    m = taskEvent(m, { id: '1', title: 'Read code', done: true }, 5)
    expect(m.source).toBe('task')
    expect(m.steps.map(s => s.status)).toEqual(['done', 'running'])
  })

  test('promptPlan and isPersistent', async () => {
    const p = promptPlan('Fix the login bug\nmore', 0, 'feat/CAM-9')
    expect(p).toMatchObject({ source: 'prompt', title: 'Fix the login bug', ticket: 'CAM-9', steps: [] })
    expect(isPersistent(p)).toBe(false)
    expect(isPersistent(planFromFile(parsePlanFile(SAMPLE)!, { path: FILE, source: 'file', done: new Set(), now: 0 }))).toBe(true)
    expect(isPersistent(null)).toBe(false)
  })

  test('planProgress ETA from done-step median', async () => {
    const m = mergeTodos(null, [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }, { content: 'C', status: 'pending' }], 0)
    const timed = { ...m, steps: m.steps.map((s, i) => (i === 0 ? { ...s, startedAt: 0, endedAt: 60_000 } : s)) }
    expect(planProgress(timed)).toMatchObject({ done: 1, total: 3, remainingMs: 120_000 })
    expect(planProgress(timed).current!.title).toBe('B')
  })
})

describe('review fixes', () => {
  test('a freshly loaded plan has its first step running', async () => {
    const p = planFromFile(parsePlanFile(SAMPLE)!, { path: FILE, source: 'file', done: new Set(), now: 0 })
    expect(p.steps.map(s => s.status)).toEqual(['running', 'pending'])
    expect(attribute(p, { kind: 'call' }).steps[0]!.calls).toBe(1)
  })

  test('only one step runs: marking another running demotes the first', async () => {
    const p = planFromFile(parsePlanFile(SAMPLE)!, { path: FILE, source: 'file', done: new Set(), now: 0 })
    const m = mergeTodos(p, [{ content: 'Task 2: Reply promise beside every CTA', status: 'in_progress' }], 5)
    expect(m.steps.filter(s => s.status === 'running')).toHaveLength(1)
    expect(m.steps[1]!.status).toBe('running')
  })

  test('taskEvent done on a file plan advances to the next step', async () => {
    const p = planFromFile(parsePlanFile(SAMPLE)!, { path: FILE, source: 'file', done: new Set(), now: 0 })
    const m = taskEvent(p, { id: 'x', title: 'Company facts (data layer)', done: true }, 5)
    expect(m.steps.map(s => s.status)).toEqual(['done', 'running'])
  })

  test('near-miss titles do not match a step', async () => {
    const text = '# P Implementation Plan\n### Task 1: Run full suite and commit\n### Task 2: Setup\n'
    const p = planFromFile(parsePlanFile(text)!, { path: FILE, source: 'file', done: new Set(), now: 0 })
    const m = mergeTodos(p, [{ content: 'Run tests', status: 'completed' }, { content: 'Setup the database schema and seed data', status: 'completed' }], 5)
    expect(m.steps.map(s => s.status)).toEqual(['running', 'pending'])
    expect(m.steps[0]!.substeps!.map(s => s.title)).toEqual(['Run tests', 'Setup the database schema and seed data'])
  })

  test('todos match by task number first', async () => {
    const text = '# P Implementation Plan\n### Task 1: Alpha\n### Task 2: Beta\n'
    const p = planFromFile(parsePlanFile(text)!, { path: FILE, source: 'file', done: new Set(), now: 0 })
    const m = mergeTodos(p, [{ content: 'Task 2: something reworded', status: 'in_progress' }], 5)
    expect(m.steps[1]!.status).toBe('running')
  })

  test('planProgress ignores zero-length (ledger-marked) steps for the ETA', async () => {
    const m = mergeTodos(null, [{ content: 'A', status: 'completed' }, { content: 'B', status: 'completed' }, { content: 'C', status: 'in_progress' }, { content: 'D', status: 'pending' }], 0)
    const timed = { ...m, steps: m.steps.map((s, i) => (i === 0 ? { ...s, startedAt: 0, endedAt: 60_000 } : i === 1 ? { ...s, startedAt: 5, endedAt: 5 } : s)) }
    expect(planProgress(timed).remainingMs).toBe(120_000)
  })
})
