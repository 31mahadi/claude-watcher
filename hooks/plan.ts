// The plan model: parse plan files and ledgers, merge todo/task events, and
// attribute what happens to the step that is running. Pure; no `$`.

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
