// The tree view's experiment queue monitor (web/queue.js): the moves its ↑ ↓, Top and drag send,
// what each GPU is said to do, how a job ended, and the button's count.

import { describe, expect, test } from 'claude-code/testing'

import '../web/queue.js'

type Job = { id: string; exp: string; state: string; exit?: number | null; reason?: string; started?: number; ended?: number }
type Log = { lines: string[]; partial: string; cut: boolean; next: number }
type Api = {
  notebookWord: (j: Job & { kind?: string; outcome?: Record<string, unknown>; error?: string }) => string
  progressParts: (p: unknown) => { stage: string; bars: { label: string; pct: number | null; nums: string; title: string }[]; line: string } | null
  cleanLine: (line: string) => string
  newLog: () => Log
  feedLog: (log: Log, piece: { text: string; start: number; end: number; reset?: boolean }) => Log
  logText: (log: Log) => string
  duration: (s: number) => string
  moveOp: (order: string[], id: string, to: number) => { id: string; before: string | null }
  gpuState: (g: Record<string, unknown>, jobs: Job[]) => { kind: string; text: string; exp: string | null }
  endWord: (j: Job) => string
  badge: (v: { jobs: Job[]; paused?: boolean }) => { count: number; running: number; waiting: number; label: string }
}

const Q = (globalThis as unknown as { RftQueue: Api }).RftQueue

describe('queue monitor', () => {
  test('durations as the plugin says them', () => {
    expect(Q.duration(45)).toBe('45s')
    expect(Q.duration(3720)).toBe('1h 2m')
    expect(Q.duration(3600 * 26)).toBe('1d 2h')
  })

  test('example 1: moving E17 (q4) above E16 (q3), by button or by drag', () => {
    const order = ['q3', 'q4', 'q5']
    // ↑ on q4 (index 1): before q3
    expect(Q.moveOp(order, 'q4', 0)).toEqual({ id: 'q4', before: 'q3' })
    // ↓ on q3 (index 0): before q5
    expect(Q.moveOp(order, 'q3', 1)).toEqual({ id: 'q3', before: 'q5' })
    // ↓ on the one before last: to the end
    expect(Q.moveOp(order, 'q4', 2)).toEqual({ id: 'q4', before: null })
    // past either end stays at that end
    expect(Q.moveOp(order, 'q5', -3)).toEqual({ id: 'q5', before: 'q3' })
    expect(Q.moveOp(order, 'q3', 9)).toEqual({ id: 'q3', before: null })
  })

  test('what each GPU does: a job, kept out, used elsewhere, or free', () => {
    const jobs = [{ id: 'q1', exp: 'E14', state: 'running' }]
    expect(Q.gpuState({ index: 0, job: 'q1' }, jobs)).toEqual({ kind: 'job', text: 'q1 E14', exp: 'E14' })
    expect(Q.gpuState({ index: 1, job: null, allowed: false, busy: false }, jobs).kind).toBe('kept')
    const used = Q.gpuState({ index: 1, job: null, busy: true, procs: [{ pid: 4242, name: '/usr/bin/python3' }, { pid: 4243, name: 'python3' }] }, jobs)
    expect(used).toEqual({ kind: 'elsewhere', text: 'in use outside the queue (python3)', exp: null })
    expect(Q.gpuState({ index: 1, job: null, busy: false }, jobs).kind).toBe('free')
  })

  test('example 2: how a job ended', () => {
    expect(Q.endWord({ id: 'q2', exp: 'E15', state: 'failed', exit: 1 })).toBe('failed (exit 1)')
    expect(Q.endWord({ id: 'q2', exp: 'E15', state: 'failed', exit: null, reason: 'lost: the process ended without an exit code' })).toBe('failed (lost)')
    expect(Q.endWord({ id: 'q1', exp: 'E14', state: 'done', exit: 0 })).toBe('done')
    expect(Q.endWord({ id: 'q5', exp: 'E14', state: 'cancelled' })).toBe('cancelled')
  })

  test('the button counts what runs and waits', () => {
    const b = Q.badge({ jobs: [{ id: 'q1', exp: 'E14', state: 'running' }, { id: 'q3', exp: 'E16', state: 'pending' }, { id: 'q4', exp: 'E17', state: 'pending' }], paused: true })
    expect([b.count, b.running, b.waiting]).toEqual([3, 1, 2])
    expect(b.label).toBe('Experiment queue: 1 running, 2 waiting (paused)')
  })

  test('a log followed piece by piece: a bar redrawn across two reads ends on its last state, colour codes dropped', () => {
    let log = Q.feedLog(Q.newLog(), { text: 'epoch 1\ntrain  10%|#   \rtrain  5', start: 0, end: 30, reset: true })
    expect(Q.logText(log)).toBe('epoch 1\ntrain  5')
    expect(log.next).toBe(30)
    log = Q.feedLog(log, { text: '0%|#####\rtrain 100%|##########\n\x1b[32mval acc 0.91\x1b[0m\r\n', start: 30, end: 90 })
    expect(Q.logText(log)).toBe('epoch 1\ntrain 100%|##########\nval acc 0.91')
    expect(log.next).toBe(90)
    // the first piece of a long log starts within it; a reset (the log started anew) starts again
    expect(Q.logText(Q.feedLog(Q.newLog(), { text: 'last line\n', start: 5000, end: 5010, reset: true }))).toBe('… earlier output: Whole log\nlast line')
    expect(Q.logText(Q.feedLog(log, { text: 'new run\n', start: 0, end: 8, reset: true }))).toBe('new run')
    expect(Q.cleanLine('a\rb\rc\r')).toBe('c')
  })

  test('a log keeps its last lines in the page; the earlier ones are in the whole log', () => {
    const text = Array.from({ length: 3500 }, (_, i) => `step ${i}`).join('\n') + '\n'
    const log = Q.feedLog(Q.newLog(), { text, start: 0, end: text.length, reset: true })
    expect(log.lines).toHaveLength(3000)
    expect(log.lines[0]).toBe('step 500')
    expect(log.cut).toBe(true)
  })

  test("how an experiment's notebook run went, in the history", () => {
    const nb = { id: 'q4', exp: 'E08', state: 'done', kind: 'notebook' }
    expect(Q.notebookWord({ ...nb, outcome: { state: 'ok', recorded: true } })).toBe('wrote the numbers in its Result')
    expect(Q.notebookWord({ ...nb, outcome: { state: 'ok' } })).toBe('reproduced its Result')
    expect(Q.notebookWord({ ...nb, outcome: { state: 'differs' } })).toBe('differs from its Result')
    expect(Q.notebookWord({ ...nb, outcome: { state: 'failed' }, error: "Traceback (most recent call last):\nKeyError: 'acc'" })).toBe("failed: KeyError: 'acc'")
  })

  test("a running job's row: its stage, a meter per bar with its numbers and time left, its last line", () => {
    const got = Q.progressParts({ stage: { stage: 'probe patchpos', i: 2, n: 5 }, bars: [{ desc: 'train shard 3/12', n: '450', total: '1000', pct: 45, left: '01:40', elapsed: '01:23', rate: '5.40it/s' }, { desc: '', n: '1200', rate: '40.0it/s' }], line: 'loss 0.31' })!
    expect(got.stage).toBe('Stage 2/5: probe patchpos')
    expect(got.bars).toEqual([
      { label: 'train shard 3/12', pct: 45, nums: '450/1000 · 45% · 01:40 left', title: '01:23 so far, 5.40it/s' },
      { label: 'progress', pct: null, nums: '1200 · 40.0it/s', title: '40.0it/s' },
    ])
    expect(got.line).toBe('loss 0.31')
    expect(Q.progressParts({ stage: { stage: 'cache' } })!.stage).toBe('Stage: cache')
    expect(Q.progressParts({})).toBeNull()
    expect(Q.progressParts(undefined)).toBeNull()
  })
})
