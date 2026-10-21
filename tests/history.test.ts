import { describe, expect, test } from 'claude-code/testing'

import { addAgent, addCall, addEvent, addFile, addWait, endTurnEntry, filterHistory, lastCompactIndex, MAX_CALLS, MAX_TURNS, noteSteps, setTest, startTurnEntry } from '../hooks/history'

const call = (label: string, ok = true, durationMs = 100) => ({ id: label, tool: 'Bash', label, key: '', startedAt: 0, durationMs, ok })

describe('history', () => {
  test('a turn collects calls, files, tests, steps, agents and waits', async () => {
    let h = startTurnEntry([], 't1', 1000, 'Fix the login bug\nmore')
    h = addCall(h, call('npm test', false, 41_000))
    h = addFile(h, '/x/login.ts')
    h = addFile(h, '/x/login.ts')
    h = setTest(h, { runner: 'jest', passed: 4, failed: 1, ok: false, at: 2, command: 'npm test', snippet: 'FAIL a' })
    h = addWait(h, 40_000)
    h = noteSteps(h, [{ title: 'Rewrite login', status: 'done' }])
    h = addAgent(h, 'Explore', true, 75_000)
    h = endTurnEntry(h, 9000, false)
    const t = h[0]!
    expect(t.kind).toBe('turn')
    if (t.kind !== 'turn') return
    expect(t).toMatchObject({ title: 'Fix the login bug', durationMs: 8000, files: ['/x/login.ts'], waitMs: 40_000, ended: true })
    expect(t.calls[0]).toMatchObject({ label: 'npm test', ok: false, durationMs: 41_000 })
    expect(t.tests).toMatchObject({ ok: false, failed: 1, snippet: 'FAIL a' })
    expect(t.steps).toEqual([{ title: 'Rewrite login', status: 'done' }])
    expect(t.agents[0]).toMatchObject({ label: 'Explore', ok: true })
  })

  test('calls beyond the cap are counted, not kept', async () => {
    let h = startTurnEntry([], 't1', 0, 'x')
    for (let i = 0; i < MAX_CALLS + 5; i++) h = addCall(h, call(`c${i}`))
    const t = h[0]!
    if (t.kind !== 'turn') throw new Error('turn')
    expect(t.calls).toHaveLength(MAX_CALLS)
    expect(t.moreCalls).toBe(5)
    expect(t.calls[t.calls.length - 1]!.label).toBe(`c${MAX_CALLS + 4}`)
  })

  test('only the last MAX_TURNS turns are kept, with events between them', async () => {
    let h = startTurnEntry([], 't0', 0, 'first')
    h = addEvent(h, 1, 'compact', 'compacted context at 78%')
    for (let i = 1; i <= MAX_TURNS; i++) h = endTurnEntry(startTurnEntry(h, `t${i}`, i * 10, `turn ${i}`), i * 10 + 5, false)
    const turns = h.filter(e => e.kind === 'turn')
    expect(turns).toHaveLength(MAX_TURNS)
    expect(turns.some(e => e.kind === 'turn' && e.title === 'first')).toBe(false)
    expect(h.some(e => e.kind === 'event' && e.at === 1)).toBe(false)
  })

  test('calls after a turn ends are ignored', async () => {
    let h = endTurnEntry(startTurnEntry([], 't1', 0, 'x'), 5, false)
    h = addCall(h, call('late'))
    const t = h[0]!
    if (t.kind !== 'turn') throw new Error('turn')
    expect(t.calls).toHaveLength(0)
  })

  test('problems filter keeps failing turns and error events', async () => {
    let h = endTurnEntry(addCall(startTurnEntry([], 'ok', 0, 'fine'), call('ls')), 1, false)
    h = endTurnEntry(addCall(startTurnEntry(h, 'bad', 2, 'broken'), call('npm test', false)), 3, false)
    h = addEvent(h, 4, 'model', 'model → opus 5.5')
    h = addEvent(h, 5, 'error', 'Claude stopped: rate_limit')
    expect(filterHistory(h, 'all')).toHaveLength(4)
    expect(filterHistory(h, 'turns').map(e => e.kind)).toEqual(['turn', 'turn'])
    expect(filterHistory(h, 'problems').map(e => e.id)).toEqual(['bad', h[3]!.id])
  })
})

describe('history fixes', () => {
  test('starting a turn closes a turn that never ended, as interrupted', async () => {
    let h = addCall(startTurnEntry([], 't1', 0, 'first'), { id: 'c', tool: 'Bash', label: 'ls', key: '', startedAt: 100, durationMs: 400, ok: true })
    h = startTurnEntry(h, 't2', 9000, 'second')
    const first = h[0]!
    if (first.kind !== 'turn') throw new Error('turn')
    expect(first).toMatchObject({ ended: true, interrupted: true })
    const second = h[1]!
    if (second.kind !== 'turn') throw new Error('turn')
    expect(second.ended).toBe(false)
  })
})

test('lastCompactIndex counts turns ended before the last compaction', async () => {
  let h = endTurnEntry(startTurnEntry([], 'a', 0, 'a'), 1, false)
  h = endTurnEntry(startTurnEntry(h, 'b', 2, 'b'), 3, false)
  h = addEvent(h, 4, 'compact', 'compacted')
  h = endTurnEntry(startTurnEntry(h, 'c', 5, 'c'), 6, false)
  expect(lastCompactIndex(h)).toBe(2)
  expect(lastCompactIndex([])).toBe(0)
})
