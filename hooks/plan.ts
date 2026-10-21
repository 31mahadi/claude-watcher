// The plan model: parse plan files and ledgers, merge todo/task events, and
// attribute what happens to the step that is running. Pure; no `$`.

import type { WatchPlan, WatchPlanStep, WatchTestResult } from '../types'

export type ParsedStep = { id: string; title: string; substeps: { title: string; done: boolean }[] }
export type ParsedPlan = { title: string; steps: ParsedStep[] }

const PLANS_DIR = '/docs/superpowers/plans/'
const TASK_HEADING = /^###\s+Task\s+(\d+):\s*(.+?)\s*$/
const CHECKBOX = /^\s*[-*]\s+\[( |x|X)\]\s+(.+?)\s*$/
const TICKET = /\b[A-Z][A-Z0-9]+-\d+\b/

// "**Step 3: Add the fields** in `x`" → "Add the fields"
function substepTitle(raw: string): string {
  let t = raw
  const bold = /^\*\*(.+?)\*\*/.exec(t)
  if (bold) t = bold[1]!
  return t.replace(/^Step\s+\d+:\s*/i, '').trim()
}

export function parsePlanFile(text: string): ParsedPlan | undefined {
  const lines = text.split('\n')
  const titleLine = lines.find(l => /^#\s+/.test(l))
  const title = (titleLine ?? '').replace(/^#\s+/, '').replace(/\s+Implementation Plan\s*$/i, '').trim()

  // superpowers format: ### Task N: <title>, checkbox substeps under each
  const steps: ParsedStep[] = []
  for (const line of lines) {
    const task = TASK_HEADING.exec(line)
    if (task) {
      steps.push({ id: `task-${task[1]}`, title: task[2]!, substeps: [] })
      continue
    }
    const box = CHECKBOX.exec(line)
    if (box && steps.length) steps[steps.length - 1]!.substeps.push({ title: substepTitle(box[2]!), done: box[1] !== ' ' })
  }
  if (steps.length) return { title, steps }

  // Fallback (plan mode and free-form plans): ##/### headings, else top-level list items.
  const headings = lines.filter(l => /^#{2,3}\s+/.test(l)).map(l => l.replace(/^#{2,3}\s+/, '').trim())
  const items = lines.filter(l => /^(\d+[.)]|[-*])\s+/.test(l)).map(l => l.replace(/^(\d+[.)]|[-*])\s+(\[[ xX]\]\s+)?/, '').trim())
  const pick = headings.length >= 2 ? headings : items.length >= 2 ? items : []
  if (pick.length < 2) return undefined
  return { title, steps: pick.map((t, i) => ({ id: `item-${i + 1}`, title: t, substeps: [] })) }
}

function repoRoot(planPath: string): string | undefined {
  const i = planPath.indexOf(PLANS_DIR)
  return i >= 0 ? planPath.slice(0, i) : undefined
}

export function isPlanPath(path: string): boolean {
  return path.includes(PLANS_DIR) && path.endsWith('.md')
}

export function ledgerPath(planPath: string): string {
  const root = repoRoot(planPath) ?? planPath.replace(/\/[^/]*$/, '')
  const base = planPath.replace(/^.*\//, '').replace(/\.md$/, '')
  return `${root}/.superpowers/sdd/${base}/progress.md`
}

// Task numbers the ledger marks complete — only when its first line names this plan.
export function parseLedger(text: string, planPath: string): Set<number> {
  const done = new Set<number>()
  const [first = '', ...rest] = text.split('\n')
  const root = repoRoot(planPath)
  const relative = root !== undefined ? planPath.slice(root.length + 1) : planPath
  const named = first.replace(/^.*plan:\s*/, '').trim()
  if (!named || !(named === relative || named === planPath || planPath.endsWith(`/${named}`))) return done
  for (const line of rest) {
    const m = /^Task\s+(\d+):\s*complete/.exec(line.trim())
    if (m) done.add(Number(m[1]))
  }
  return done
}

export function ticketKey(...candidates: (string | undefined)[]): string | undefined {
  for (const c of candidates) {
    const m = c ? TICKET.exec(c) : null
    if (m) return m[0]
  }
  return undefined
}

// ── Plan model ──

type Status = WatchPlanStep['status']
type Todo = { content?: unknown; status?: unknown }

function blank(id: string, title: string): WatchPlanStep {
  return { id, title, status: 'pending', calls: 0, editedFiles: [], agentIds: [] }
}

// Status changes stamp startedAt on entering running and endedAt on finishing.
function withStatus(step: WatchPlanStep, status: Status, now: number): WatchPlanStep {
  if (step.status === status) return step
  return {
    ...step,
    status,
    startedAt: status === 'running' || status === 'done' || status === 'failed' ? (step.startedAt ?? now) : step.startedAt,
    endedAt: status === 'done' || status === 'failed' ? (step.endedAt ?? now) : undefined,
  }
}

const finished = (s: WatchPlanStep) => s.status === 'done' || s.status === 'failed'

// With nothing running, the first unfinished step becomes the running one.
function advance(steps: WatchPlanStep[], now: number): WatchPlanStep[] {
  if (steps.some(s => s.status === 'running')) return steps
  const i = steps.findIndex(s => s.status === 'pending')
  return i < 0 ? steps : steps.map((s, j) => (j === i ? withStatus(s, 'running', now) : s))
}

// Exactly one running step: entering running sends any other running step back to pending.
function setRunning(steps: WatchPlanStep[], i: number, now: number): WatchPlanStep[] {
  return steps.map((s, j) => (j === i ? withStatus(s, 'running', now) : s.status === 'running' ? { ...s, status: 'pending' as const } : s))
}

const normal = (t: string) => t.replace(/^Task\s+\d+:\s*/i, '').trim().toLowerCase()

// A todo or task naming several steps ("Implement Tasks 1+2", "Tasks 1-3", "Task 1 and 2")
// stands for each of them; otherwise it names one step as below.
function matchSteps(steps: readonly WatchPlanStep[], text: string): number[] {
  const list = /\bTasks?\s+(\d+(?:\s*(?:[+,&\-–]|and)\s*\d+)+)\b/i.exec(text)?.[1]
  if (list) {
    const nums = list.split(/\s*(?:[+,&]|and)\s*/i).flatMap(part => {
      const [a, b] = part.split(/\s*[\-–]\s*/).map(Number)
      return b !== undefined && b >= a! && b - a! < 50 ? Array.from({ length: b - a! + 1 }, (_, i) => a! + i) : [a!]
    })
    const found = nums.map(n => steps.findIndex(s => s.id === `task-${n}`)).filter(i => i >= 0)
    if (found.length) return [...new Set(found)]
  }
  const i = matchStep(steps, text)
  return i < 0 ? [] : [i]
}

// A todo or task names a step by "Task N:", by its exact title, or by a close prefix:
// the shorter title is at least 60% of the longer and ends on a word boundary.
function matchStep(steps: readonly WatchPlanStep[], text: string): number {
  const num = /^\s*Task\s+(\d+):/i.exec(text)?.[1]
  if (num) {
    const i = steps.findIndex(s => s.id === `task-${num}`)
    if (i >= 0) return i
  }
  const t = normal(text)
  if (!t) return -1
  const exact = steps.findIndex(s => s.title.toLowerCase() === t)
  if (exact >= 0) return exact
  return steps.findIndex(s => {
    const title = s.title.toLowerCase()
    const [short, long] = title.length <= t.length ? [title, t] : [t, title]
    return short.length >= 0.6 * long.length && long.startsWith(short) && /^\W|^$/.test(long.slice(short.length))
  })
}

function todoStatus(status: unknown): Status | undefined {
  return status === 'completed' ? 'done' : status === 'in_progress' ? 'running' : status === 'pending' ? 'pending' : undefined
}

export function isPersistent(plan: WatchPlan | null): boolean {
  return plan?.source === 'file' || plan?.source === 'planmode'
}

export function planFromFile(
  parsed: ParsedPlan,
  opts: { path: string; source: 'file' | 'planmode'; done: Set<number>; now: number; prev?: WatchPlan; branch?: string; prompt?: string },
): WatchPlan {
  const { now, prev } = opts
  const known = new Map((prev?.path === opts.path ? prev.steps : []).map(s => [s.id, s]))
  let steps = parsed.steps.map(p => {
    const before = known.get(p.id)
    const extras = (before?.substeps ?? []).filter(x => !p.substeps.some(y => y.title === x.title))
    const base: WatchPlanStep = { ...(before ?? blank(p.id, p.title)), title: p.title, substeps: [...p.substeps, ...extras] }
    const num = Number(/^task-(\d+)$/.exec(p.id)?.[1])
    const allChecked = p.substeps.length > 0 && p.substeps.every(x => x.done)
    if (opts.done.has(num) || allChecked) return withStatus(base, 'done', now)
    return base
  })
  // The first unfinished step runs from the moment the plan is loaded, so early work is credited.
  steps = advance(steps, now)
  const title = parsed.title || prev?.title || 'Plan'
  return {
    source: opts.source,
    title,
    ticket: ticketKey(title, opts.branch, opts.prompt),
    path: opts.path,
    steps,
    startedAt: prev?.path === opts.path ? prev.startedAt : now,
    endedAt: undefined,
  }
}

export function mergeTodos(plan: WatchPlan | null, todos: readonly Todo[], now: number, prompt?: string): WatchPlan {
  const items = todos.filter((t): t is { content: string; status?: unknown } => typeof t.content === 'string')
  if (plan && isPersistent(plan)) {
    let steps = plan.steps
    const extras: { title: string; done: boolean }[] = []
    for (const todo of items) {
      const idx = matchSteps(steps, todo.content)
      const status = todoStatus(todo.status)
      if (!idx.length) {
        extras.push({ title: todo.content, done: status === 'done' })
        continue
      }
      if (status === 'running') steps = setRunning(steps, idx[0]!, now)
      else if (status === 'done') steps = steps.map((s, j) => (idx.includes(j) ? withStatus(s, 'done', now) : s))
    }
    if (steps.some(finished)) steps = advance(steps, now)
    const r = steps.findIndex(s => s.status === 'running')
    if (r >= 0 && extras.length) {
      steps = steps.map((s, j) => {
        if (j !== r) return s
        const subs = [...(s.substeps ?? [])]
        for (const x of extras) {
          const k = subs.findIndex(y => y.title === x.title)
          if (k >= 0) subs[k] = x
          else subs.push(x)
        }
        return { ...s, substeps: subs }
      })
    }
    return { ...plan, steps }
  }
  const known = new Map((plan?.steps ?? []).map(s => [s.title, s]))
  const steps = items.map(t => withStatus(known.get(t.content) ?? blank(`todo-${t.content}`, t.content), todoStatus(t.status) ?? 'pending', now))
  return {
    source: 'todo',
    title: plan?.title ?? (prompt ? firstLine(prompt) : 'Todo list'),
    ticket: plan?.ticket ?? ticketKey(prompt),
    steps,
    startedAt: plan?.startedAt ?? now,
  }
}

export function taskEvent(plan: WatchPlan | null, ev: { id: string; title: string; done: boolean }, now: number): WatchPlan {
  if (plan && isPersistent(plan)) {
    const idx = matchSteps(plan.steps, ev.title)
    if (!idx.length) return plan
    if (!ev.done) return { ...plan, steps: setRunning(plan.steps, idx[0]!, now) }
    return { ...plan, steps: advance(plan.steps.map((s, j) => (idx.includes(j) ? withStatus(s, 'done', now) : s)), now) }
  }
  const base: WatchPlan = plan && plan.source === 'task' ? plan : { source: 'task', title: plan?.title ?? 'Tasks', ticket: plan?.ticket, steps: [], startedAt: plan?.startedAt ?? now }
  const id = `task:${ev.id}`
  let steps = base.steps.some(s => s.id === id) ? base.steps : [...base.steps, blank(id, ev.title)]
  if (ev.done) steps = steps.map(s => (s.id === id ? withStatus(s, 'done', now) : s))
  return { ...base, steps: advance(steps, now) }
}

function firstLine(text: string): string {
  const line = text.split('\n').find(l => l.trim()) ?? ''
  const t = line.trim()
  return t.length > 80 ? `${t.slice(0, 79)}…` : t
}

export function promptPlan(prompt: string, now: number, branch?: string): WatchPlan {
  const title = firstLine(prompt)
  return { source: 'prompt', title, ticket: ticketKey(title, branch, prompt), steps: [], startedAt: now }
}

export type PlanEvent =
  | { kind: 'call' }
  | { kind: 'edit'; file: string }
  | { kind: 'test'; result: WatchTestResult }
  | { kind: 'agent'; id: string }

export function attribute(plan: WatchPlan, ev: PlanEvent): WatchPlan {
  const i = plan.steps.findIndex(s => s.status === 'running')
  if (i < 0) return plan
  const steps = plan.steps.map((s, j) => {
    if (j !== i) return s
    switch (ev.kind) {
      case 'call':
        return { ...s, calls: s.calls + 1 }
      case 'edit':
        return s.editedFiles.includes(ev.file) ? s : { ...s, editedFiles: [...s.editedFiles, ev.file] }
      case 'test':
        return { ...s, lastTest: ev.result }
      case 'agent':
        return s.agentIds.includes(ev.id) ? s : { ...s, agentIds: [...s.agentIds, ev.id] }
    }
  })
  return { ...plan, steps }
}

// A step Claude moved past with red tests is failed; a plan with nothing left is ended.
export function settle(plan: WatchPlan, now: number): WatchPlan {
  const steps = plan.steps.map(s => (s.status === 'done' && s.lastTest && !s.lastTest.ok ? { ...s, status: 'failed' as const } : s))
  const over = steps.length > 0 && steps.every(finished)
  return { ...plan, steps, endedAt: over ? (plan.endedAt ?? now) : undefined }
}

export function planProgress(plan: WatchPlan): { done: number; total: number; remainingMs?: number; current?: WatchPlanStep } {
  const total = plan.steps.length
  const done = plan.steps.filter(finished).length
  const current = plan.steps.find(s => s.status === 'running')
  // Steps marked done without being watched (ledger on load) have no real duration.
  const durations = plan.steps.filter(s => finished(s) && s.startedAt !== undefined && s.endedAt !== undefined).map(s => s.endedAt! - s.startedAt!).filter(d => d > 0)
  if (durations.length === 0 || done === total) return { done, total, current }
  const sorted = [...durations].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const typical = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
  return { done, total, remainingMs: (total - done) * typical, current }
}
