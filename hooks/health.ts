import type { WatchTestResult } from '../types'

type Parsed = Omit<WatchTestResult, 'at' | 'command'>

const num = (m: RegExpMatchArray | null, i = 1) => (m ? Number(m[i]) : 0)

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

export function classifyCommand(command: string): 'test' | 'lint' | 'build' | undefined {
  const c = command.toLowerCase()
  if (/\b(test|jest|vitest|pytest|mocha|rspec|phpunit)\b/.test(c)) return 'test'
  if (/\b(lint|eslint|ruff|flake8|clippy|golangci|tsc --noemit|biome check|prettier --check)\b/.test(c)) return 'lint'
  if (/\b(build|tsc|webpack|vite build|cargo build|go build|make)\b/.test(c)) return 'build'
  return undefined
}

// `git status --porcelain -b` → branch + dirty count
export function parseGitStatus(out: string): { branch?: string; dirty: number } {
  const lines = out.split('\n').filter(Boolean)
  const head = lines[0]?.startsWith('## ') ? lines.shift()! : undefined
  const branch = head ? head.slice(3).split('...')[0]?.replace(/^No commits yet on /, '') : undefined
  return { branch, dirty: lines.length }
}
