import { describe, expect, test } from 'claude-code/testing'

import { DEFAULTS, mergeConfig, parseValue, patchFor } from '../hooks/config'
import { estimateMs, globMatch, median, normalizeKey, record, remember, stepKind } from '../hooks/estimate'
import { parseDuration, time, toolLabel, truncate } from '../hooks/format'
import { classifyCommand, parseGitStatus, parseTestOutput } from '../hooks/health'
import { hex } from '../hooks/render/colors'
import { shortModel } from '../hooks/render/pane'
import { base64, bar as rasterBar, cellsOf, swimlanes } from '../hooks/render/raster'
import * as svg from '../hooks/render/svg'
import * as S from '../hooks/state'

describe('format', () => {
  test('time', async () => {
    expect(time(0)).toBe('0:00')
    expect(time(134_000)).toBe('2:14')
    expect(time(3_725_000)).toBe('1:02:05')
    expect(time(134_000, 'human')).toBe('2m 14s')
    expect(time(-5000)).toBe('0:00')
  })
  test('truncate and durations', async () => {
    expect(truncate('abcdef', 4)).toBe('abc…')
    expect(truncate('a  b', 10)).toBe('a b')
    expect(parseDuration('30m')).toBe(1_800_000)
    expect(parseDuration('2h')).toBe(7_200_000)
    expect(parseDuration('x')).toBeUndefined()
  })
  test('toolLabel redacts', async () => {
    expect(toolLabel('Bash', { command: 'npm test' }, DEFAULTS)).toBe('npm test')
    expect(toolLabel('Read', { file_path: '/a/b/app.ts' }, DEFAULTS)).toBe('Read app.ts')
    expect(toolLabel('Bash', { command: 'npm test' }, { ...DEFAULTS, redactCommands: true })).toBe('Bash')
    expect(toolLabel('Bash', { command: 'SP=/x; ls', description: 'List files' }, DEFAULTS)).toBe('List files')
  })
})

describe('estimate', () => {
  test('normalizeKey groups repeat commands', async () => {
    const a = normalizeKey('Bash', { command: 'npm test -- --shard=1' }, '/p', DEFAULTS)
    const b = normalizeKey('Bash', { command: 'npm  test -- --shard=2' }, '/p', DEFAULTS)
    expect(a).toBe(b)
    expect(normalizeKey('Bash', { command: 'sleep 5' }, '/p', DEFAULTS)).toBeUndefined()
    expect(normalizeKey('Read', {}, '/p', { ...DEFAULTS, estimate: { ...DEFAULTS.estimate, perProject: false } })).toBe('Read')
  })
  test('stepKind', async () => {
    expect(stepKind('Bash', { command: 'npx vitest run src' })).toBe('bash:test')
    expect(stepKind('Bash', { command: 'pnpm install' })).toBe('bash:install')
    expect(stepKind('Bash', { command: 'git status' })).toBe('bash:git')
    expect(stepKind('Edit', {})).toBe('edit')
    expect(stepKind('Grep', {})).toBe('read')
  })
  test('glob', async () => {
    expect(globMatch('echo *', 'echo hi')).toBe(true)
    expect(globMatch('echo *', 'ls')).toBe(false)
  })
  test('estimateMs confidence and bounds', async () => {
    expect(estimateMs(undefined, 1000, 3)).toBeUndefined()
    expect(estimateMs([10_000], 4000, 3)?.confidence).toBe('?')
    const e = estimateMs([10_000, 12_000, 11_000], 4000, 3)!
    expect(e.confidence).toBe('~')
    expect(e.remainingMs).toBe(7000)
    const late = estimateMs([10_000, 10_000, 10_000], 30_000, 3)!
    expect(late.remainingMs).toBe(0)
    expect(late.fraction).toBeLessThan(1)
    expect(estimateMs([], 1000, 3, 10_000)?.confidence).toBe('max')
  })
  test('remember caps keys, most recent last', async () => {
    let h: Record<string, number[]> = {}
    for (const k of ['a', 'b', 'c']) h = remember(h, k, 1, 5, 2)
    expect(Object.keys(h)).toEqual(['b', 'c'])
    h = remember(h, 'b', 2, 5, 2)
    expect(Object.keys(h)).toEqual(['c', 'b'])
    expect(h.b).toEqual([1, 2])
  })
  test('record keeps last N', async () => {
    expect(record([1, 2, 3], 4, 3)).toEqual([2, 3, 4])
    expect(median([5, 1, 3])).toBe(3)
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })
})

describe('health', () => {
  test('jest', async () => {
    const r = parseTestOutput('npx jest', 'FAIL src/a.test.ts\nTests:       3 failed, 39 passed, 42 total', 1)!
    expect(r).toMatchObject({ runner: 'jest', passed: 39, failed: 3, ok: false })
    expect(r.snippet).toContain('FAIL')
  })
  test('vitest', async () => {
    expect(parseTestOutput('vitest run', ' Tests  2 failed | 10 passed (12)', 1)).toMatchObject({ runner: 'vitest', passed: 10, failed: 2 })
  })
  test('pytest', async () => {
    expect(parseTestOutput('pytest -q', '==== 1 failed, 5 passed in 0.3s ====', 1)).toMatchObject({ passed: 5, failed: 1 })
  })
  test('cargo', async () => {
    expect(parseTestOutput('cargo test', 'test result: ok. 7 passed; 0 failed; 0 ignored', 0)).toMatchObject({ runner: 'cargo', passed: 7, failed: 0, ok: true })
  })
  test('bun / claude plugin test', async () => {
    expect(parseTestOutput('claude plugin test .', '(pass) a\n\n 33 pass\n 0 fail\nRan 33 tests', 0)).toMatchObject({ runner: 'bun', passed: 33, failed: 0, ok: true })
  })
  test('go', async () => {
    expect(parseTestOutput('go test ./...', '--- PASS: A\n--- FAIL: B\nFAIL\n', 1)).toMatchObject({ runner: 'go', passed: 1, failed: 1 })
  })
  test('jest summary with no failures is a pass', async () => {
    expect(parseTestOutput('npx jest', 'Tests:       11 passed, 11 total', 0)).toMatchObject({ passed: 11, failed: 0, ok: true })
  })
  test('classifyCommand reads the command, not words inside quotes or paths', async () => {
    expect(classifyCommand('cd /x; grep -n "test" hooks/a.ts | head')).toBeUndefined()
    expect(classifyCommand('cd /x && npm test')).toBe('test')
    expect(classifyCommand('npx vitest run src')).toBe('test')
    expect(classifyCommand('claude plugin test .')).toBe('test')
    expect(classifyCommand('cat tests/unit/a.test.ts')).toBeUndefined()
    expect(classifyCommand('pnpm lint')).toBe('lint')
    expect(classifyCommand('cd web && pnpm build')).toBe('build')
    expect(classifyCommand("cd /r && python3 - <<'PY'\nx = 1; npm test\nPY")).toBeUndefined()
    expect(classifyCommand("cat > a.sh <<EOF\nnpm test\nEOF\nnpm test")).toBe('test')
  })
  test('non-test command', async () => {
    expect(parseTestOutput('ls -la', 'x', 0)).toBeUndefined()
    expect(classifyCommand('npm run lint')).toBe('lint')
    expect(classifyCommand('npm run build')).toBe('build')
  })
  test('git status', async () => {
    expect(parseGitStatus('## feat/auth...origin/feat/auth\n M a.ts\n?? b.ts\n')).toEqual({ branch: 'feat/auth', dirty: 2 })
  })
})

describe('config', () => {
  test('merge keeps known keys and valid values', async () => {
    const cfg = mergeConfig({ barWidth: 30, theme: 'bogus', nope: 1, visuals: { gantt: false } }, { autoOpen: 'never' })
    expect(cfg.barWidth).toBe(30)
    expect(cfg.theme).toBe('default')
    expect(cfg.visuals.gantt).toBe(false)
    expect(cfg.visuals.cards).toBe(true)
    expect(cfg.autoOpen).toBe('never')
    expect((cfg as unknown as Record<string, unknown>).nope).toBeUndefined()
  })
  test('patch + parse', async () => {
    expect(patchFor('a.b', 1)).toEqual({ a: { b: 1 } })
    expect(parseValue('true')).toBe(true)
    expect(parseValue('42')).toBe(42)
    expect(parseValue('["a"]')).toEqual(['a'])
    expect(parseValue('red')).toBe('red')
  })
})

describe('labels', () => {
  test('shortModel', async () => {
    expect(shortModel('claude-opus-5-5')).toBe('opus 5.5')
    expect(shortModel('claude-haiku-5-5-20260101')).toBe('haiku 5.5')
    expect(shortModel('gpt-x')).toBe('gpt-x')
  })
})

describe('visuals', () => {
  test('base64 + cellsOf packing', async () => {
    expect(base64(new Uint8Array([1, 2, 3, 4]))).toBe('AQIDBA==')
    // one orange block cell from the RasterProps doc example
    expect(cellsOf([{ ch: '█', fg: 0xff8800 }])).toBe('iCUAAACI/wAAAAAB')
    const g = rasterBar(0.5, 10, 0x00ff00, 0x333333)
    expect(g.columns).toBe(10)
    expect(swimlanes([{ start: 0, end: 5, fg: 1 }, { start: 5, end: 10, fg: 2 }], 0, 10, 8, 3).rows).toBe(2)
  })
  test('svg widgets are well formed', async () => {
    for (const s of [svg.bar(0.4, '#0f0'), svg.donut(0.7, '#f00'), svg.sparkline([1, 4, 2], '#00f'), svg.heatStrip(['#0f0', '#f00']), svg.gantt([{ label: 'a<b', start: 0, end: 5, color: '#fff' }], 0, 10)]) {
      expect(s).toStartWith('<svg xmlns="http://www.w3.org/2000/svg"')
      expect(s).toEndWith('</svg>')
      expect(s).not.toContain('a<b')
    }
  })
  test('colors', async () => {
    expect(hex('ok', DEFAULTS)).toBe(0x3fb950)
    expect(hex('ok', { ...DEFAULTS, colors: { ...DEFAULTS.colors, ok: '#112233' } })).toBe(0x112233)
  })
})

describe('reducers', () => {
  test('turn and tool lifecycle', async () => {
    let s = S.startTurn(S.EMPTY_SNAP, 1000)
    expect(s.phase).toBe('thinking')
    const call = { id: 't1', tool: 'Bash', label: 'npm test', key: 'k', startedAt: 1100 }
    s = S.startCall(s, call)
    expect(s.phase).toBe('tool')
    s = S.endCall(s, { ...call, durationMs: 50, ok: true }, 8)
    expect(s.current).toBeNull()
    expect(s.recent).toHaveLength(1)
    s = S.endTurn(s, 2000, false)
    expect(s.phase).toBe('done')
  })
  test('syncAgents follows the engine list', async () => {
    let s = S.syncAgents(S.EMPTY_SNAP, [{ id: 'a', label: 'Explore', status: 'running' }, { id: 'old', label: 'Old', status: 'completed' }], 10)
    expect(s.agents.map(a => a.id)).toEqual(['a'])
    s = S.syncAgents(s, [{ id: 'a', label: 'Explore', status: 'completed' }], 40)
    expect(s.agents[0]).toMatchObject({ phase: 'done', startedAt: 10, endedAt: 40 })
  })
  test('syncAgents ends a running agent the engine no longer lists', async () => {
    let s = S.agentStart(S.EMPTY_SNAP, 'gone', 'Review', 0)
    s = S.agentStart(s, 'new', 'Fresh', 50_000)
    s = S.syncAgents(s, [], 60_000)
    expect(s.agents.find(a => a.id === 'gone')).toMatchObject({ phase: 'done', endedAt: 60_000 })
    // Just started: the engine may not list it yet.
    expect(s.agents.find(a => a.id === 'new')?.phase).toBe('running')
  })
})

describe('state upgrade', () => {
  test('normalizeSnap fills fields an older version did not store', async () => {
    const old = { ...S.EMPTY_SNAP, health: { compactions: 0, editedFiles: [], needsYou: null } } as unknown as Record<string, unknown>
    delete old.plan
    delete old.history
    const s = S.normalizeSnap(old)
    expect(s.plan).toBeNull()
    expect(s.history).toEqual([])
    expect(s.health.contextHistory).toEqual([])
  })
})
