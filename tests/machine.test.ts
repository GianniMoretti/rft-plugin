// The machine the experiment queue runs on (hooks/lib/machine.ts): no queue until this machine is
// paired with it, so an unpaired session has no queue tool, rule or monitor; /rft-machine add
// checks the machine at no model turn, says so and stops on one already paired or with no NVIDIA
// GPU, and otherwise asks Claude to finish; rft_machine add turns the queue on in the session.
// The pairing itself (machine.json, the probe, the refusals) is server/rft_queue.py, tested in
// tests/test_queue.py.

import { describe, expect, mock, test } from 'claude-code/testing'

import type { MachineStatus, Probe } from '../hooks/lib/machine'
import { bytes, machinePrompt, probeText, statusText } from '../hooks/lib/machine'
import { QUEUE_RULE } from '../hooks/lib/ops'
import { CWD, demoFiles, world } from './fixture'

const PY = /rft_queue\.py$/
const MACHINE = { version: 1, host: 'lab-pc', added: '2026-11-18T10:00:00+01:00', runs_dir: '/data2/rft-runs', os: 'Linux 6.8', gpus: [{ index: 0, name: 'NVIDIA GeForce RTX 5080', mem_total: 16303 }, { index: 1, name: 'NVIDIA GeForce RTX 5080', mem_total: 16303 }], conda: { root: '/home/u/anaconda3', envs: ['base', 'train'] }, uv: '/home/u/.local/bin/uv' }
const TB = 1e12

/** What `machine probe` says of a machine with two GPUs and two data disks (example 2), or with none (example 1). */
const probe = (gpus = true): Probe => ({
  host: 'lab-pc', os: 'Linux 6.8', uv: '/home/u/.local/bin/uv', conda: { root: '/home/u/anaconda3', envs: ['base', 'train'] },
  gpus: gpus ? MACHINE.gpus : [], gpu_error: gpus ? null : 'nvidia-smi not found: no NVIDIA GPU here, or its driver is not installed',
  ...(gpus ? { driver: '580.1', cuda: '13.0' } : {}),
  disks: [
    { mount: '/data2', path: '/data2/rft-runs', free: 7.3 * TB, total: 15.9 * TB },
    { mount: '/data', path: '/data/rft-runs', free: 1.2 * TB, total: 15.9 * TB },
    { mount: '/', path: '/home/u/rft-runs', free: 94e9, total: 982e9 },
  ],
  runs_dir: '/data2/rft-runs', eligible: gpus, why_not: gpus ? null : 'no NVIDIA GPU here (nvidia-smi not found: no NVIDIA GPU here, or its driver is not installed)',
})

const status = (paired = true): MachineStatus => ({
  host: 'lab-pc', machine: paired ? MACHINE : null, paired,
  ...(paired ? {
    runs_free: 7.3 * TB, runs_total: 15.9 * TB,
    queue: { host: 'lab-pc', paused: false, runner: false, gpu_error: null, jobs: [], history: [], gpus: [{ index: 0, name: 'NVIDIA GeForce RTX 5080', mem_used: 3, mem_total: 16303, job: null }, { index: 1, name: 'NVIDIA GeForce RTX 5080', mem_used: 3, mem_total: 16303, job: null, allowed: false }] },
  } : {}),
})

/** A session on the demo tree whose rft_queue.py answers `machine` as given; the calls it got. */
function session(on: Parameters<typeof world>[0], files: Record<string, string>, answer: { probe?: Probe; status?: MachineStatus; add?: Record<string, unknown> }) {
  const calls: string[][] = []
  const w = world(on, files, {
    process: argv => {
      if (!PY.test(argv[1] ?? '')) return undefined
      calls.push([...argv])
      const out = argv[2] === 'machine' ? { probe: answer.probe, status: answer.status, add: answer.add }[argv[5] as 'probe' | 'status' | 'add'] : {}
      return { exitCode: 0, stderr: '', stdout: JSON.stringify(out ?? {}) }
    },
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  const prompts: string[] = []
  on('prompt.submit', (_$, e) => { prompts.push(String(e.text)); return { text: e.text } as never })
  return { w, calls, prompts }
}

const paired = () => ({ ...demoFiles(), 'vault/.queue/machine.json': JSON.stringify(MACHINE) })
const compose = ($: Parameters<Parameters<typeof test>[1]>[0]) => $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
const command = ($: Parameters<Parameters<typeof test>[1]>[0], name: string, args = '') =>
  $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)

describe('machine: words', () => {
  test('sizes, the probe and the status in a few lines', () => {
    expect([bytes(7.3 * TB), bytes(94e9), bytes(512)]).toEqual(['7.3 TB', '94 GB', '512 B'])
    const text = probeText(probe())
    expect(text).toContain('This machine: lab-pc, Linux 6.8.')
    expect(text).toContain('GPUs: 2 GPUs: 0 RTX 5080 (16 GB), 1 RTX 5080 (16 GB); driver 580.1, CUDA 13.0.')
    expect(text).toContain('suggested /data2/rft-runs (7.3 TB free of 16 TB); other disks: /data/rft-runs (1.2 TB free), /home/u/rft-runs (94 GB free)')
    expect(text).toContain('`source /home/u/anaconda3/bin/activate <env>`')
    expect(probeText(probe(false))).toContain('It cannot run the experiment queue: no NVIDIA GPU here')
    const prompt = machinePrompt(probe())
    expect(prompt).toContain('do not inspect the machine yourself')
    expect(prompt).toContain('/data2/rft-runs first, as recommended, then /data/rft-runs (1.2 TB free), /home/u/rft-runs (94 GB free)')
    expect(prompt).toContain('GPU 0, GPU 1')
    expect(prompt).toContain('rft_machine with action "add"')
    const st = statusText(status(), { already: true })
    expect(st).toContain('Local machine already loaded: lab-pc, Linux 6.8, since 2026-11-18.')
    expect(st).toContain('GPU 0 RTX 5080: free · GPU 1 RTX 5080: kept out of the queue')
    expect(st).toContain('Runs\' outputs: /data2/rft-runs (7.3 TB free of 16 TB)')
    expect(st).toContain('Queue: 0 running, 0 waiting, none ended yet')
    expect(statusText(status(false))).toContain('No machine is paired with the experiment queue')
    expect(statusText({ host: 'laptop', machine: MACHINE, paired: false })).toContain('paired with lab-pc, not with this machine (laptop)')
  })
})

describe('machine: no machine paired, no queue', () => {
  test('no queue tool, rule, runner or poll of the queue; rft_machine waits behind ToolSearch', async ($, on) => {
    mock.clock(on)
    const { w, calls } = session(on, demoFiles(), {})
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    for (const t of ['rft_queue', 'rft_jobs', 'rft_job']) expect(w.tools).not.toContain(t)
    expect(w.deferred).toContain('rft_machine')
    const rules = (await compose($)).sections.find(s => s.id === 'rft:rules')!.text
    expect(rules).not.toContain('rft_queue')
    expect(rules).not.toContain('experiment queue')
    expect(rules).toContain('create its node first')
    expect(calls).toEqual([]) // nothing asked of the queue
    expect(String((await command($, 'rft-jobs')).text)).toContain('No machine is paired with the experiment queue')
  })

  test('a vault with a queue from before pairing: a toast says how to turn it on, and its jobs are not followed', async ($, on) => {
    const clock = mock.clock(on)
    const files = { ...demoFiles(), 'vault/.queue/queue.json': JSON.stringify({ version: 1, seq: 1, paused: false, jobs: [{ id: 'q1', exp: 'E02', cmd: 'x', cwd: '/w', gpus: 1, state: 'running', added: 1 }] }) }
    const { w, calls } = session(on, files, {})
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    await clock.advance(5000)
    expect(w.toasts.join()).toContain('the experiment queue is off until this machine is paired with it: /rft-machine add')
    expect(w.tools).not.toContain('rft_queue')
    expect(calls).toEqual([]) // no runner started for it
    expect(String((await $.tool.call({ tool: 'mcp__rft__rft_next' } as never)).text)).not.toContain('Experiment queue')
  })
})

describe('machine: /rft-machine add', () => {
  test('on a paired machine: nothing changes, it says the local machine is already loaded and prints its status', async ($, on) => {
    const clock = mock.clock(on)
    const { calls, prompts } = session(on, paired(), { status: status() })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const text = String((await command($, 'rft-machine', 'add')).text)
    expect(text).toContain('Local machine already loaded: lab-pc')
    expect(text).toContain('Runs\' outputs: /data2/rft-runs (7.3 TB free of 16 TB)')
    expect(calls.map(c => c[5])).not.toContain('probe')
    expect(calls.map(c => c[5])).not.toContain('add')
    await clock.advance(5000)
    expect(prompts).toEqual([]) // no model turn
  })

  test('a machine with no NVIDIA GPU: it says so and the queue stays off, at no model turn', async ($, on) => {
    const clock = mock.clock(on)
    const { calls, prompts } = session(on, demoFiles(), { status: status(false), probe: probe(false) })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const text = String((await command($, 'rft-machine', 'add')).text)
    expect(text).toContain('It cannot run the experiment queue: no NVIDIA GPU here')
    expect(text).toContain('The queue stays off')
    expect(calls.map(c => c[5])).not.toContain('add')
    await clock.advance(5000)
    expect(prompts).toEqual([])
  })

  test('a machine with GPUs: checked at no model turn, then Claude asks two questions and pairs it', async ($, on) => {
    const clock = mock.clock(on)
    const files = demoFiles()
    files['.rft/config.json'] = files['.rft/config.json']!.replace('{', '{"runsDir": "~/runs", ')
    const { calls, prompts } = session(on, files, { status: status(false), probe: probe() })
    on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }) as never)
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const text = String((await command($, 'rft-machine', 'add')).text)
    expect(text).toContain('GPUs: 2 GPUs')
    expect(text).toContain('Claude will finish in a moment')
    // the config's runsDir is the one to suggest
    const p = calls.find(c => c[5] === 'probe')!
    expect(p[p.indexOf('--runs-hint') + 1]).toBe('/home/u/runs')
    await clock.advance(5000)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('AskUserQuestion')
    expect(prompts[0]).toContain('rft_machine')
  })

  test('only this machine can be paired for now', async ($, on) => {
    mock.clock(on)
    session(on, demoFiles(), { status: status(false), probe: probe() })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    expect(String((await command($, 'rft-machine', 'add lab')).text)).toContain('Only this machine')
  })
})

describe('machine: rft_machine add', () => {
  test('pairs the machine with the outputs folder and the GPUs kept out, and turns the queue on in the session', async ($, on) => {
    mock.clock(on)
    const { w, calls } = session(on, demoFiles(), { add: { added: true, machine: MACHINE, allowed: [0], status: status() } })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    expect(w.tools).not.toContain('rft_queue')
    w.fs.write('vault/.queue/machine.json', JSON.stringify(MACHINE)) // what `machine add` writes
    const r = await $.tool.call({ tool: 'mcp__rft__rft_machine', action: 'add', runs_dir: '/data2/rft-runs', keep_out: [1] } as never)
    const add = calls.find(c => c[5] === 'add')!
    expect(add.slice(6)).toEqual(['--runs', '/data2/rft-runs', '--keep', '1'])
    const text = String(r.text)
    expect(text).toContain('This machine is paired with the experiment queue: lab-pc')
    expect(text).toContain('The experiment queue is on')
    expect(text).toContain(QUEUE_RULE)
    // its tools join the prompt from the next turn
    for (const t of ['rft_queue', 'rft_jobs', 'rft_job']) {
      expect(w.tools).toContain(t)
      expect(w.deferred).not.toContain(t)
    }
  })

  test('on a paired machine it changes nothing and says so', async ($, on) => {
    mock.clock(on)
    const { w } = session(on, paired(), { add: { already: true, machine: MACHINE, status: status() } })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const before = w.tools.length
    const r = await $.tool.call({ tool: 'mcp__rft__rft_machine', action: 'add' } as never)
    expect(String(r.text)).toContain('Local machine already loaded')
    expect(w.tools).toHaveLength(before)
  })

  test('a session on a paired machine: every run goes through the queue', async ($, on) => {
    mock.clock(on)
    const { w } = session(on, paired(), {})
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    expect(w.tools).toContain('rft_queue')
    const rules = (await compose($)).sections.find(s => s.id === 'rft:rules')!.text
    expect(rules).toContain('every run of an experiment\'s code goes through rft_queue')
    expect(rules).toContain('Its runs then go through rft_queue (above).')
  })
})
