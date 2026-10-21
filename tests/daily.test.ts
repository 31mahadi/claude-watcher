import { describe, expect, test } from 'claude-code/testing'

import { changesFromGit, changesTotal, parseNumstat } from '../hooks/changes'
import { checkKey, checkRows, recordCheck, trendGlyphs } from '../hooks/checks'
import { forecast, forecastText } from '../hooks/forecast'
import { failingLocation, openOptions } from '../hooks/openmenu'

describe('changes', () => {
  test('parseNumstat handles counts, binary and renames', async () => {
    const rows = parseNumstat('42\t7\tsrc/login.ts\n-\t-\timg.png\n3\t1\tsrc/{a => b}.ts\n')
    expect(rows).toEqual([
      { path: 'src/login.ts', added: 42, removed: 7, binary: false },
      { path: 'img.png', added: 0, removed: 0, binary: true },
      { path: 'src/b.ts', added: 3, removed: 1, binary: false },
    ])
  })

  test('changesFromGit splits Claude vs yours and sorts by turn', async () => {
    const edited = new Map([['/r/src/login.ts', 3], ['/r/new.ts', 4]])
    const rows = changesFromGit('42\t7\tsrc/login.ts\n5\t5\tREADME.md\n', 'new.ts\nscratch.txt\n', edited, '/r')
    expect(rows.map(r => [r.path, r.byClaude, r.lastTurn])).toEqual([
      ['new.ts', true, 4],
      ['src/login.ts', true, 3],
      ['README.md', false, undefined],
      ['scratch.txt', false, undefined],
    ])
    expect(rows[0]!.added).toBe(-1)
    expect(changesTotal(rows)).toEqual({ files: 2, added: 42, removed: 7, created: 1 })
  })
})

describe('checks', () => {
  test('checkKey folds shard arguments into one key', async () => {
    expect(checkKey('npm test -- --shard=1', '/r')).toBe(checkKey('npm test -- --shard=2', '/r'))
    expect(checkKey('ls', '/r')).toBe('')
  })

  test('recordCheck caps at 10 and checkRows puts failures first', async () => {
    let c = {}
    for (let i = 0; i < 12; i++) c = recordCheck(c, 'k1', 'npm test', { ok: true, at: i, turn: 1 })
    c = recordCheck(c, 'k2', 'pnpm lint', { ok: false, at: 100, turn: 2 })
    expect((c as Record<string, { runs: unknown[] }>)['k1']!.runs).toHaveLength(10)
    expect(checkRows(c).map(r => r.command)).toEqual(['pnpm lint', 'npm test'])
    expect(trendGlyphs(checkRows(c)[1]!)).toBe('✓ ✓ ✓ ✓ ✓')
  })
})

describe('forecast', () => {
  test('stable, N turns, next turn, reset after compaction', async () => {
    expect(forecast([40, 40], 0, 40, 85)).toEqual({ kind: 'stable' })
    expect(forecast([40, 44, 48], 0, 52, 85)).toEqual({ kind: 'turns', turns: 9, slope: 4 })
    expect(forecast([80], 0, 84, 85)).toEqual({ kind: 'next', slope: 4 })
    expect(forecast([70, 75, 20, 24], 2, 28, 85)).toEqual({ kind: 'turns', turns: 15, slope: 4 })
    expect(forecastText({ kind: 'turns', turns: 6, slope: 4.2 })).toBe('~6 turns to compaction · +4.2%/turn')
    expect(forecastText({ kind: 'next', slope: 4 })).toBe('compaction next turn · +4%/turn')
    expect(forecastText({ kind: 'stable' })).toBe('stable')
  })
})

describe('open menu', () => {
  test('failingLocation finds the first source path:line, skipping URLs and node_modules', async () => {
    expect(failingLocation('see https://x.test:443/a\n  at node_modules/x/i.js:10\n  at tests/unit/promise.test.ts:42:7', '/r')).toEqual({ path: '/r/tests/unit/promise.test.ts', line: 42 })
    expect(failingLocation('nothing here', '/r')).toBeUndefined()
  })

  test('openOptions order and values', async () => {
    const opts = openOptions({
      planPath: '/r/docs/p.md',
      failing: { path: '/r/t.ts', line: 3 },
      changes: [
        { path: 'a.ts', added: 1, removed: 0, binary: false, byClaude: true },
        { path: 'b.ts', added: 1, removed: 0, binary: false, byClaude: false },
      ],
      sessionId: 's1',
    })
    expect(opts.map(o => o.value)).toEqual(['plan', 'fail', 'file:a.ts', 'resume'])
    expect(opts[1]!.label).toBe('failing test: t.ts:3')
    expect(opts[3]!.action).toEqual({ kind: 'copy', text: 'claude --resume s1' })
  })
})
