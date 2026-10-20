import type { WatchTestResult } from '../types'

type Parsed = Omit<WatchTestResult, 'at' | 'command'>

// An absent group ("Tests: 11 passed" has no failed count) is 0, not NaN.
const num = (m: RegExpMatchArray | null, i = 1) => (m && m[i] !== undefined ? Number(m[i]) : 0)

// Best-effort parse of common test runners' summaries. Returns undefined when the
// command does not look like a test run.
export function parseTestOutput(command: string, output: string, exitCode: number | undefined): Parsed | undefined {
  const cmd = command.toLowerCase()
  const looksLikeTest = /\b(test|jest|vitest|pytest|cargo test|go test|mocha|rspec|phpunit)\b/.test(cmd)
  if (!looksLikeTest) return undefined
  const text = output.slice(-20_000)
  const failedByExit = exitCode !== undefined && exitCode !== 0

  // jest: "Tests:       3 failed, 39 passed, 42 total"
  let m = text.match(/Tests:\s+(?:(\d+) failed,\s*)?(?:\d+ skipped,\s*)?(?:(\d+) passed)?/)
  if (m && (m[1] || m[2])) return done('jest', num(m, 2), num(m, 1), text)

  // vitest: "Tests  3 failed | 39 passed (42)"
  m = text.match(/Tests\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed/)
  if (m) return done('vitest', num(m, 2), num(m, 1), text)

  // pytest: "=== 3 failed, 39 passed in 1.2s ==="
  if (/pytest|py\.test/.test(cmd) || /=+ .*(passed|failed).* in [\d.]+s/.test(text)) {
    const passed = num(text.match(/(\d+) passed/))
    const failed = num(text.match(/(\d+) failed/)) + num(text.match(/(\d+) error/))
    if (passed || failed) return done('pytest', passed, failed, text)
  }

  // bun / claude plugin test: " 29 pass" / " 0 fail" on their own lines
  m = text.match(/^\s*(\d+) pass\s*$/m)
  if (m) return done('bun', num(m), num(text.match(/^\s*(\d+) fail\s*$/m)), text)

  // cargo: "test result: FAILED. 39 passed; 3 failed;"
  m = text.match(/test result: \w+\. (\d+) passed; (\d+) failed/)
  if (m) return done('cargo', num(m, 1), num(m, 2), text)

  // go test: count "--- PASS" / "--- FAIL" lines, or "ok"/"FAIL" package lines
  if (/go test/.test(cmd)) {
    const passed = (text.match(/^--- PASS/gm) ?? []).length || (text.match(/^ok\s/gm) ?? []).length
    const failed = (text.match(/^--- FAIL/gm) ?? []).length || (text.match(/^FAIL\s/gm) ?? []).length
    return done('go', passed, failed, text)
  }

  // Unknown runner: exit code only.
  return { runner: 'test', passed: 0, failed: failedByExit ? 1 : 0, ok: !failedByExit }

  function done(runner: string, passed: number, failed: number, all: string): Parsed {
    const ok = failed === 0 && !failedByExit
    return { runner, passed, failed, ok, snippet: ok ? undefined : failureSnippet(all) }
  }
}

export function failureSnippet(text: string, maxLines = 12): string {
  const lines = text.split('\n')
  const idx = lines.findIndex(l => /(FAIL|✕|×|● |FAILED|Error:|AssertionError|panicked)/.test(l))
  const from = idx >= 0 ? idx : Math.max(0, lines.length - maxLines)
  return lines.slice(from, from + maxLines).join('\n').trim()
}

const PM = '(?:npm|pnpm|yarn|bun)(?: run)?'
const TEST = new RegExp(`^(?:(?:npx|bunx|pnpm|yarn|bun)\\s+)?(?:jest|vitest|mocha|pytest|py\\.test|rspec|phpunit)\\b|^${PM} test\\b|^(?:go|cargo|deno|make|bun|claude plugin) test\\b`)
const LINT = new RegExp(`^${PM} lint\\b|^(?:(?:npx|pnpm|bunx)\\s+)?(?:eslint|ruff|flake8|golangci-lint|biome check|prettier --check)\\b|^cargo clippy\\b|^(?:npx\\s+)?tsc\\b.*--noemit`)
const BUILD = new RegExp(`^${PM} build\\b|^(?:cargo|go) build\\b|^(?:npx\\s+)?(?:tsc|webpack|vite build|next build)\\b|^make\\b`)

// What kind of check a shell line runs, judged by each command's own words:
// quoted text, comments, `cd` and env assignments do not count.
export function classifyCommand(command: string): 'test' | 'lint' | 'build' | undefined {
  const bare = command
    .toLowerCase()
    .replace(/(["'])(?:\\.|(?!\1).)*\1/g, ' ')
    .replace(/(^|\s)#.*$/gm, ' ')
  const segments = bare.split(/&&|\|\||;|\|/).map(x => x.trim().replace(/^(?:\w+=\S*\s+)+/, ''))
  const runs = segments.filter(x => x && !/^cd\b/.test(x))
  if (runs.some(x => TEST.test(x))) return 'test'
  if (runs.some(x => LINT.test(x))) return 'lint'
  if (runs.some(x => BUILD.test(x))) return 'build'
  return undefined
}

// `git status --porcelain -b` → branch + dirty count
export function parseGitStatus(out: string): { branch?: string; dirty: number } {
  const lines = out.split('\n').filter(Boolean)
  const head = lines[0]?.startsWith('## ') ? lines.shift()! : undefined
  const branch = head ? head.slice(3).split('...')[0]?.replace(/^No commits yet on /, '') : undefined
  return { branch, dirty: lines.length }
}
