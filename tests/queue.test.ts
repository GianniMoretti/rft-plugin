// The experiment queue as Claude and the session see it (hooks/lib/queue.ts): rft_queue and
// rft_jobs answered in a few lines, a planned experiment set running when its job starts, a
// finished job flagged until its result is recorded, toasts when jobs start and end. The queue
// itself (its order, the GPUs, the runner) is server/rft_queue.py, tested in tests/test_queue.py.

import { describe, expect, mock, test } from 'claude-code/testing'

import { loadActive } from '../hooks/lib/ops'
import type { Job, QueueView } from '../hooks/lib/queue'
import { duration, jobEvents, jobsReport, queueLine, readQueue, toRecord, toStart } from '../hooks/lib/queue'
import { CWD, D01, E02, MemoryFs, demoFiles, note, world } from './fixture'

const NOW = 1_763_200_000 // seconds
const E03 = 'E03 Seed sweep'
const E04 = 'E04 Wide model'
const E05 = 'E05 Long schedule'

/** The demo tree with three more experiments under D01: E03 and E05 planned, E04 (2 GPUs) running. */
function files(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...demoFiles(),
    '.rft/config.json': JSON.stringify({ version: 2, vault: 'vault', project: 'demo', canvas: false, mermaid: false, lastId: { E: 5, D: 1 } }),
    [`vault/experiments/${E03}.md`]: note('E03', 'experiment', 'planned', D01, 'Seed sweep'),
    [`vault/experiments/${E04}.md`]: note('E04', 'experiment', 'running', D01, 'Wide model').replace('status: running\n', 'status: running\ngpus: 2\n'),
    [`vault/experiments/${E05}.md`]: note('E05', 'experiment', 'planned', D01, 'Long schedule'),
    ...extra,
  }
}

const job = (id: string, exp: string, state: Job['state'], o: Partial<Job> = {}): Job =>
  ({ id, exp, cmd: `python train.py --exp ${exp}`, cwd: '/work/code', gpus: 1, by: 'claude', state, added: NOW - 7200, ...o })

/** Example 1: two jobs running, one moved up by the user, a 2-GPU job waiting. */
const example1 = (): QueueView => ({
  host: 'lab-pc', paused: false, allowed: null, runner: true, gpu_error: null,
  gpus: [
    { index: 0, name: 'NVIDIA GeForce RTX 5080', mem_used: 9100, mem_total: 16303, util: 97, job: 'q1' },
    { index: 1, name: 'NVIDIA GeForce RTX 5080', mem_used: 8800, mem_total: 16303, util: 95, job: 'q2' },
  ],
  jobs: [
    job('q1', 'E02', 'running', { gpu_ids: [0], started: NOW - 3720 }),
    job('q2', 'E04', 'running', { gpu_ids: [1], started: NOW - 300 }),
    job('q4', 'E05', 'pending', { outlook: '1st in line: starts when a GPU is free' }),
    job('q3', 'E03', 'pending', { gpus: 2, outlook: '2nd in line, after q4' }),
  ],
  history: [],
})

/** Example 2: E04's job failed with CUDA out of memory 3 hours ago; E02's ended fine an hour ago. */
const example2 = (): QueueView => ({
  host: 'lab-pc', paused: false, allowed: null, runner: false, gpu_error: null, gpus: [],
  jobs: [],
  history: [
    job('q2', 'E02', 'done', { gpu_ids: [0], started: NOW - 3600 * 3, ended: NOW - 3600, exit: 0 }),
    job('q1', 'E04', 'failed', { gpu_ids: [1], started: NOW - 3 * 3600 - 240, ended: NOW - 3 * 3600, exit: 1, label: 'bs 512' }),
  ],
})

const loadedOf = (f = files()) => loadActive(new MemoryFs(f).io())

describe('queue: what Claude reads', () => {
  test('durations are short', () => {
    expect(duration(45)).toBe('45s')
    expect(duration(240)).toBe('4m')
    expect(duration(3720)).toBe('1h 2m')
    expect(duration(3600 * 26 + 60)).toBe('1d 2h')
  })

  test('rft_jobs: the GPUs, what runs, the queue in its order, in a few lines', async () => {
    const out = jobsReport(example1(), await loadedOf(), NOW)
    expect(out).toContain('lab-pc')
    expect(out).toContain('GPU 0 RTX 5080: q1 E02, 97%')
    expect(out).toContain('q1 E02 Variant run · GPU 0 · 1h 2m')
    expect(out).toContain('q2 E04 Wide model · GPU 1 · 5m')
    expect(out.indexOf('1. q4 E05')).toBeGreaterThan(0)
    expect(out.indexOf('1. q4 E05')).toBeLessThan(out.indexOf('2. q3 E03'))
    expect(out).toContain('2. q3 E03 Seed sweep · 2 GPUs · 2nd in line, after q4')
    expect(out.split('\n').length).toBeLessThan(14)
  })

  test('rft_jobs: one experiment, or one job with the end of its log', async () => {
    const loaded = await loadedOf()
    const one = jobsReport(example2(), loaded, NOW, { ref: 'E04' })
    expect(one).toContain('q1 E04')
    expect(one).not.toContain('q2 E02')
    const withLog = jobsReport(example2(), loaded, NOW, { ref: 'q1', log: 'epoch 3\nRuntimeError: CUDA out of memory' })
    expect(withLog).toContain('failed (exit 1) after 4m, 3h ago')
    expect(withLog).toContain('python train.py --exp E04')
    expect(withLog).toContain('RuntimeError: CUDA out of memory')
    expect(jobsReport({ ...example2(), history: [] }, loaded, NOW)).toContain('No jobs')
  })

  test('a finished job whose experiment still says running is a result to record', async () => {
    const loaded = await loadedOf()
    // E02 and E04 are both running in the tree; their jobs ended
    expect(toRecord(example2(), loaded).map(r => `${r.exp} ${r.job.id}`)).toEqual(['E02 q2', 'E04 q1'])
    const line = queueLine(example2(), loaded, NOW)!
    expect(line).toContain('E04 (q1 failed, exit 1, 3h ago)')
    expect(line).toContain('E02 (q2 done, 1h ago)')
    expect(line).toContain('rft_jobs')
    // once recorded (the note is done), or while another job of it waits, it is not flagged
    const recorded = await loadedOf(files({ [`vault/experiments/${E02}.md`]: note('E02', 'experiment', 'done', D01, 'Variant run') }))
    expect(toRecord(example2(), recorded).map(r => r.exp)).toEqual(['E04'])
    const again = { ...example2(), jobs: [job('q3', 'E04', 'pending', { retry_of: 'q1' })] }
    expect(toRecord(again, recorded)).toEqual([])
    expect(queueLine({ ...example2(), history: [] }, loaded, NOW)).toBeNull()
  })

  test('a planned experiment whose job runs is set running; others are left as they are', async () => {
    const loaded = await loadedOf()
    const v = example1()
    expect(toStart(v, loaded)).toEqual([])
    v.jobs[2] = { ...v.jobs[2]!, state: 'running', gpu_ids: [0], started: NOW }
    expect(toStart(v, loaded)).toEqual(['E05'])
  })

  test('the toasts: a job that started, finished or failed', () => {
    const before = example1()
    const after = example1()
    after.jobs = [after.jobs[1]!, { ...after.jobs[2]!, state: 'running', gpu_ids: [0], started: NOW }, after.jobs[3]!]
    after.history = [{ ...before.jobs[0]!, state: 'failed', exit: 1, ended: NOW }]
    const events = jobEvents(before, after)
    expect(events).toContain('q1 (E02) failed (exit 1) after 1h 2m')
    expect(events).toContain('q4 (E05) started on GPU 0')
    expect(jobEvents(null, after)).toEqual([])
    expect(jobEvents(after, after)).toEqual([])
  })

  test('the queue is read from the vault: active jobs and the history, newest first', async () => {
    const fs = new MemoryFs({
      'vault/.queue/queue.json': JSON.stringify({ version: 1, seq: 3, paused: true, allowed: [1], jobs: [job('q3', 'E03', 'pending')] }),
      'vault/.queue/history.jsonl': [job('q1', 'E04', 'failed'), job('q2', 'E02', 'done')].map(j => JSON.stringify(j)).join('\n') + '\n',
    })
    const v = (await readQueue(fs.io(), 'vault'))!
    expect(v.paused).toBe(true)
    expect(v.jobs.map(j => j.id)).toEqual(['q3'])
    expect(v.history.map(j => j.id)).toEqual(['q2', 'q1'])
    expect(await readQueue(new MemoryFs({}).io(), 'vault')).toBeNull()
  })
})

describe('queue: in a session', () => {
  const PY = /rft_queue\.py$/

  test('rft_queue queues through the runner and answers in a line; the tools are in the prompt once there is a queue', async ($, on) => {
    mock.clock(on)
    const calls: string[][] = []
    const w = world(on, files({ 'vault/.queue/queue.json': JSON.stringify({ version: 1, seq: 0, paused: false, jobs: [] }) }), {
      process: argv => {
        if (!PY.test(argv[1] ?? '')) return undefined
        calls.push([...argv])
        if (argv[2] === 'add') {
          const spec = JSON.parse(argv[argv.indexOf('--job') + 1]!)
          return { exitCode: 0, stderr: '', stdout: JSON.stringify({ job: { ...job('q7', spec.exp, 'pending', spec), place: 2 }, outlook: '2nd in line, after q6: needs 2 GPUs, 1 is free' }) }
        }
        return { exitCode: 0, stderr: '', stdout: '{}' }
      },
    })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    for (const t of ['rft_queue', 'rft_jobs', 'rft_cancel_job']) {
      expect(w.tools).toContain(t)
      expect(w.deferred).not.toContain(t)
    }
    const r = await $.tool.call({ tool: 'mcp__rft__rft_queue', exp: 'E04', cmd: 'python train.py --wide', cwd: '/work/code' } as never)
    expect(r.isError).toBeFalsy()
    const add = calls.find(c => c[2] === 'add')!
    expect(add).toContain('--vault')
    expect(add[add.indexOf('--vault') + 1]).toBe(`${CWD}/vault`)
    // the note's gpus: is the default
    expect(JSON.parse(add[add.indexOf('--job') + 1]!)).toMatchObject({ exp: 'E04', cmd: 'python train.py --wide', cwd: '/work/code', gpus: 2 })
    expect(String(r.text)).toContain('Queued q7 for E04')
    expect(String(r.text)).toContain('2nd in line')
    expect(String(r.text).split('\n').length).toBeLessThan(4)
    // only experiments are queued
    const bad = await $.tool.call({ tool: 'mcp__rft__rft_queue', exp: 'D01', cmd: 'true' } as never)
    expect(bad.isError).toBe(true)
    expect(String(bad.text)).toContain('experiment')
  })

  test('rft_move_job moves one job and answers the new order in one line', async ($, on) => {
    mock.clock(on)
    const calls: string[][] = []
    const waiting = [{ id: 'q4', exp: 'E05', gpus: 1 }, { id: 'q3', exp: 'E03', gpus: 2 }, { id: 'q5', exp: 'E04', gpus: 1 }]
    const w = world(on, files({ 'vault/.queue/queue.json': JSON.stringify({ version: 1, seq: 5, paused: false, jobs: [] }) }), {
      process: argv => {
        if (!PY.test(argv[1] ?? '')) return undefined
        calls.push([...argv])
        if (argv[2] !== 'move') return { exitCode: 0, stderr: '', stdout: '{}' }
        if (argv[argv.indexOf('--id') + 1] === 'q9') return { exitCode: 2, stderr: '', stdout: JSON.stringify({ error: 'no job q9' }) }
        return { exitCode: 0, stderr: '', stdout: JSON.stringify({ job: job('q4', 'E05', 'pending'), waiting }) }
      },
    })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    expect(w.tools).toContain('rft_move_job')
    expect(w.deferred).not.toContain('rft_move_job')
    // example 1: E17's job (here q4) before E16's (q3)
    const r = await $.tool.call({ tool: 'mcp__rft__rft_move_job', id: 'Q4', before: 'q3' } as never)
    expect(r.isError).toBeFalsy()
    const move = calls.find(c => c[2] === 'move')!
    expect(move.slice(move.indexOf('--id'))).toEqual(['--id', 'q4', '--before', 'q3'])
    expect(String(r.text)).toBe('Moved q4 (E05). Waiting: 1. q4 E05 · 2. q3 E03 (2 GPUs) · 3. q5 E04')
    // the top and the end are words; no before means the end
    await $.tool.call({ tool: 'mcp__rft__rft_move_job', id: 'q5', before: 'top' } as never)
    expect(calls.at(-1)!.slice(-4)).toEqual(['--id', 'q5', '--before', 'top'])
    await $.tool.call({ tool: 'mcp__rft__rft_move_job', id: 'q5' } as never)
    expect(calls.at(-1)!.slice(-4)).toEqual(['--id', 'q5', '--before', 'end'])
    const bad = await $.tool.call({ tool: 'mcp__rft__rft_move_job', id: 'q9', before: 'top' } as never)
    expect(bad.isError).toBe(true)
    expect(String(bad.text)).toBe('no job q9')
  })

  test('without a queue the tools wait behind ToolSearch', async ($, on) => {
    mock.clock(on)
    const w = world(on, files())
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    expect(w.deferred).toContain('rft_queue')
    expect(w.deferred).toContain('rft_jobs')
  })

  test('a job that starts sets its planned experiment running; one that ends is toasted and flagged', async ($, on) => {
    const clock = mock.clock(on)
    const running = job('q1', 'E03', 'running', { gpu_ids: [0], started: NOW })
    const w = world(on, files({ 'vault/.queue/queue.json': JSON.stringify({ version: 1, seq: 1, paused: false, jobs: [running] }) }))
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    await clock.advance(5000)
    expect(w.fs.read(`vault/experiments/${E03}.md`)).toContain('status: running')
    expect(w.toasts.join()).toContain('E03')
    // the job ends: the toast says so, and the next rft_next flags its result
    w.fs.write('vault/.queue/queue.json', JSON.stringify({ version: 1, seq: 1, paused: false, jobs: [] }))
    w.fs.write('vault/.queue/history.jsonl', JSON.stringify({ ...running, state: 'failed', exit: 1, ended: NOW + 240 }) + '\n')
    await clock.advance(5000)
    expect(w.toasts.join()).toContain('q1 (E03) failed (exit 1)')
    const next = await $.tool.call({ tool: 'mcp__rft__rft_next' } as never)
    expect(String(next.text)).toContain('E03 (q1 failed, exit 1')
    // a note already past planned is left as it is
    expect(w.fs.read(`vault/experiments/${E02}.md`)).toContain('status: running')
  })
})
