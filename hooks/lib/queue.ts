// The experiment queue as Claude and the session see it. The queue itself is server/rft_queue.py:
// its runner, a process of its own, starts each job on this machine's GPUs in the user's order and
// records how it ended, in the vault's .queue/ folder. Claude queues, reads and cancels through its
// command line (rft_queue, rft_jobs, rft_cancel_job); the session reads the files at each tick of its
// poll to set a planned experiment running when its job starts, toast a job that ended, and flag a
// result to record. None of that is a model turn: the answers here are a few lines each.

import type { Io, Loaded } from './vault'
import { join } from './vault'

export const QUEUE_DIR = '.queue'
export const QUEUE_FILE = `${QUEUE_DIR}/queue.json`
export const HISTORY_FILE = `${QUEUE_DIR}/history.jsonl`
/** The script the plugin runs for the queue, from the plugin's folder. */
export const QUEUE_CLI = 'server/rft_queue.py'

export type JobState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

/** A job, as server/rft_queue.py writes it (times in seconds since the epoch). */
export type Job = {
  id: string
  /** The experiment it runs (E..). */
  exp: string
  label?: string
  cmd: string
  cwd: string
  gpus: number
  by?: string
  state: JobState
  added: number
  started?: number
  ended?: number
  gpu_ids?: number[]
  exit?: number | null
  reason?: string
  retry_of?: string
  /** A waiting job: why it waits, or that it starts now (from the runner's status). */
  outlook?: string
  log?: string
}

export type Gpu = {
  index: number
  name: string
  mem_used: number
  mem_total: number
  util?: number | null
  temp?: number | null
  /** The job of the queue on it. */
  job?: string | null
  /** In use outside the queue. */
  busy?: boolean
  /** The queue may use it. */
  allowed?: boolean
}

/** The queue: from the files (no GPUs), or from the runner's `status` (with the GPUs). */
export type QueueView = {
  host?: string
  paused: boolean
  allowed?: number[] | null
  jobs: Job[]
  /** The jobs that ended, newest first. */
  history: Job[]
  gpus?: Gpu[]
  gpu_error?: string | null
  runner?: boolean
}

const ACTIVE = new Set<JobState>(['pending', 'running'])

const jobsOf = (v: unknown): Job[] => (Array.isArray(v) ? v.filter((j): j is Job => !!j && typeof j === 'object' && typeof (j as Job).id === 'string') : [])

/** The jobs that ended, newest first; a job written twice counts once, as last written. */
export function parseHistory(text: string, keep = 200): Job[] {
  const seen = new Set<string>()
  const out: Job[] = []
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0 && out.length < keep; i--) {
    const line = lines[i]!.trim()
    if (!line) continue
    try {
      const j = JSON.parse(line) as Job
      if (!j || typeof j.id !== 'string' || seen.has(j.id)) continue
      seen.add(j.id)
      out.push(j)
    } catch { /* a line cut short */ }
  }
  return out
}

/** The vault's queue from its files; null when it has none. `queueText`: queue.json, when already read. */
export async function readQueue(io: Io, vault: string, keep = 200, queueText?: string): Promise<QueueView | null> {
  let text = queueText
  if (text === undefined) {
    try { text = await io.read(join(vault, QUEUE_FILE)) } catch { return null }
  }
  let st: Record<string, unknown> = {}
  try { st = JSON.parse(text) as Record<string, unknown> } catch { /* read as empty */ }
  let history: Job[] = []
  try { history = parseHistory(await io.read(join(vault, HISTORY_FILE)), keep) } catch { /* none yet */ }
  return {
    paused: st.paused === true,
    allowed: Array.isArray(st.allowed) ? st.allowed.filter((i): i is number => typeof i === 'number') : null,
    jobs: jobsOf(st.jobs),
    history,
  }
}

// ---------------------------------------------------------------- words

/** A duration in its two largest units: 45s, 4m, 1h 2m, 1d 2h. */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`
  const d = Math.floor(h / 24)
  return `${d}d${h % 24 ? ` ${h % 24}h` : ''}`
}

const ago = (t: number | undefined, now: number) => (t ? `${duration(now - t)} ago` : 'some time ago')
const gpuWord = (n: number) => `${n} GPU${n === 1 ? '' : 's'}`
const gpuList = (ids: number[] | undefined) => (ids?.length ? `GPU${ids.length === 1 ? '' : 's'} ${ids.join(', ')}` : 'no GPU')
const shortName = (name: string) => name.replace(/^NVIDIA\s+(GeForce\s+)?/i, '')
const titleOf = (loaded: Loaded, exp: string) => loaded.tree.nodes[exp]?.title
const named = (loaded: Loaded, j: Job) => `${j.id} ${j.exp}${titleOf(loaded, j.exp) ? ` ${titleOf(loaded, j.exp)}` : ''}${j.label ? ` [${j.label}]` : ''}`

/** How a job ended: "done", "failed (exit 1)", "failed (lost)", "cancelled". */
export function endWord(j: Job): string {
  if (j.state === 'failed') return `failed (${j.exit != null ? `exit ${j.exit}` : j.reason?.startsWith('lost') ? 'lost' : j.reason || 'no exit code'})`
  return j.state
}

const ranFor = (j: Job) => (j.started && j.ended ? ` after ${duration(j.ended - j.started)}` : j.state === 'cancelled' && !j.started ? ' before it started' : '')

// ---------------------------------------------------------------- what the session does with it

/** The planned experiments whose job runs: the session sets them running. */
export function toStart(v: QueueView, loaded: Loaded): string[] {
  const out = new Set<string>()
  for (const j of v.jobs) {
    const n = loaded.tree.nodes[j.exp]
    if (j.state === 'running' && n?.type === 'experiment' && n.status === 'planned') out.add(j.exp)
  }
  return [...out]
}

/**
 * The experiments with a result to record: their last job ended, nothing more of theirs waits or
 * runs, and the note still says running. Newest first.
 */
export function toRecord(v: QueueView, loaded: Loaded): { exp: string; job: Job }[] {
  const active = new Set(v.jobs.filter(j => ACTIVE.has(j.state)).map(j => j.exp))
  const seen = new Set<string>()
  const out: { exp: string; job: Job }[] = []
  for (const j of v.history) {
    if (seen.has(j.exp)) continue
    seen.add(j.exp)
    if (!active.has(j.exp) && loaded.tree.nodes[j.exp]?.status === 'running') out.push({ exp: j.exp, job: j })
  }
  return out
}

const recordText = (r: { exp: string; job: Job }, now: number) => {
  const j = r.job
  const how = j.state === 'failed' ? `failed, ${j.exit != null ? `exit ${j.exit}` : 'lost'}` : j.state
  return `${r.exp} (${j.id} ${how}, ${ago(j.ended, now)})`
}

/** The session's start: what the queue holds, and the results to record; null when there is nothing. */
export function queueLine(v: QueueView, loaded: Loaded, now: number): string | null {
  const running = v.jobs.filter(j => j.state === 'running').length
  const waiting = v.jobs.filter(j => j.state === 'pending').length
  const rec = toRecord(v, loaded)
  if (!running && !waiting && !rec.length) return null
  const parts = [`Experiment queue: ${running} running, ${waiting} waiting${v.paused ? ' (paused)' : ''}.`]
  if (rec.length) {
    parts.push(`Jobs that ended, their result not recorded yet: ${rec.slice(0, 6).map(r => recordText(r, now)).join(', ')}${rec.length > 6 ? `, and ${rec.length - 6} more` : ''}. ` +
      'rft_jobs <id> (log: 40 for the end of its output) says how it ended; then record the result or the failure in the note.')
  }
  return parts.join(' ')
}

/** rft_next's part: the queue in two lines, and the results to record. Empty when there is nothing. */
export function jobsNext(v: QueueView | null, loaded: Loaded, now: number): string {
  if (!v) return ''
  const running = v.jobs.filter(j => j.state === 'running')
  const waiting = v.jobs.filter(j => j.state === 'pending')
  const rec = toRecord(v, loaded)
  if (!running.length && !waiting.length && !rec.length) return ''
  const out = [`## Experiment queue${v.paused ? ' (paused)' : ''}`]
  if (running.length) out.push(`Running: ${running.map(j => `${j.id} ${j.exp} (${duration(now - (j.started ?? now))})`).join(', ')}`)
  if (waiting.length) out.push(`Waiting (${waiting.length}): ${waiting.slice(0, 8).map(j => `${j.id} ${j.exp}`).join(', ')}${waiting.length > 8 ? ', …' : ''}`)
  if (rec.length) out.push(`Results to record: ${rec.map(r => recordText(r, now)).join(', ')}`)
  return out.join('\n')
}

/** The toasts for what changed between two reads of the queue: jobs that started, and that ended. */
export function jobEvents(prev: QueueView | null, next: QueueView): string[] {
  if (!prev) return []
  const out: string[] = []
  const was = new Map(prev.jobs.map(j => [j.id, j]))
  const known = new Set(prev.history.map(j => j.id))
  for (const j of next.jobs) {
    if (j.state === 'running' && was.get(j.id)?.state !== 'running') out.push(`${j.id} (${j.exp}) started on ${gpuList(j.gpu_ids)}`)
  }
  for (const j of next.history) {
    if (known.has(j.id)) continue
    out.push(`${j.id} (${j.exp}) ${j.state === 'done' ? 'finished' : endWord(j)}${ranFor(j)}`)
  }
  return out
}

// ---------------------------------------------------------------- what Claude reads

/** rft_queue's answer: the job, its place in line and why it waits, in a line or two. */
export function addedText(r: { job: Job & { place?: number }; outlook?: string }, loaded: Loaded, vault: string): string {
  const j = r.job
  return `Queued ${j.id} for ${j.exp}${titleOf(loaded, j.exp) ? ` ${titleOf(loaded, j.exp)}` : ''}: ${gpuWord(j.gpus)}, ${r.outlook || `${j.place ?? '?'} in line`}. ` +
    `Its output goes to ${vault}/${QUEUE_DIR}/logs/${j.id}.log. The plugin sets ${j.exp} running when it starts and tells the user when it ends: do not poll rft_jobs to wait for it.`
}

const gpuLine = (v: QueueView) => {
  if (v.gpu_error) return `GPUs: ${v.gpu_error}`
  if (!v.gpus?.length) return null
  return `GPUs: ${v.gpus.map(g => {
    const state = g.job ? `${g.job} ${v.jobs.find(j => j.id === g.job)?.exp ?? ''}`.trim()
      : g.allowed === false ? 'kept out of the queue' : g.busy ? 'in use outside the queue' : 'free'
    return `GPU ${g.index} ${shortName(g.name)}: ${state}${g.util != null && (g.job || g.busy) ? `, ${g.util}%` : ''}`
  }).join(' · ')}`
}

/**
 * rft_jobs: the GPUs, the jobs running and waiting (in their order), the last ones that ended and
 * the results to record. `ref`: one job (with the end of its output, `log`) or one experiment's.
 */
export function jobsReport(v: QueueView, loaded: Loaded, now: number, opts: { ref?: string; log?: string; history?: number } = {}): string {
  const ref = opts.ref?.trim()
  if (ref && /^q\d+$/i.test(ref)) {
    const j = [...v.jobs, ...v.history].find(x => x.id === ref.toLowerCase())
    if (!j) return `There is no job ${ref}: rft_jobs lists them.`
    const how = j.state === 'running' ? `running on ${gpuList(j.gpu_ids)} for ${duration(now - (j.started ?? now))}`
      : j.state === 'pending' ? `waiting: ${j.outlook || 'in line'}`
        : `${endWord(j)}${ranFor(j)}, ${ago(j.ended, now)}${j.reason && j.state !== 'failed' ? ` (${j.reason})` : j.reason?.startsWith('lost') ? ` (${j.reason})` : ''}`
    const lines = [`${named(loaded, j)} · ${gpuWord(j.gpus)} · ${how}`, `$ ${j.cmd}`, `in ${j.cwd}${j.retry_of ? ` · retry of ${j.retry_of}` : ''}`]
    if (opts.log !== undefined) lines.push(opts.log.trim() ? `Output (last lines):\n${opts.log.replace(/\s+$/, '')}` : 'No output yet.')
    return lines.join('\n')
  }
  const exp = ref ? ref.toUpperCase() : null
  const mine = (j: Job) => !exp || j.exp === exp
  const running = v.jobs.filter(j => j.state === 'running' && mine(j))
  const waiting = v.jobs.filter(j => j.state === 'pending')
  const ended = v.history.filter(mine)
  if (!running.length && !waiting.some(mine) && !ended.length) {
    return exp ? `No job for ${exp}: rft_queue queues one.` : 'No jobs: the queue is empty. rft_queue queues one.'
  }
  const out: string[] = []
  const head = [v.host, v.paused ? 'the queue is paused' : '', v.runner === false && (running.length || waiting.length) ? 'its runner is starting' : ''].filter(Boolean)
  if (head.length && !exp) out.push(head.join(' · '))
  const gl = exp ? null : gpuLine(v)
  if (gl) out.push(gl)
  if (running.length) out.push(`Running (${running.length}):`, ...running.map(j => `- ${named(loaded, j)} · ${gpuList(j.gpu_ids)} · ${duration(now - (j.started ?? now))}`))
  const shown = waiting.map((j, i) => [i + 1, j] as const).filter(([, j]) => mine(j))
  if (shown.length) {
    out.push(`Waiting (${waiting.length}, in order):`, ...shown.slice(0, 12).map(([i, j]) => `${i}. ${named(loaded, j)} · ${gpuWord(j.gpus)}${j.outlook ? ` · ${j.outlook}` : ''}`))
    if (shown.length > 12) out.push(`… ${shown.length - 12} more`)
  }
  const keep = opts.history ?? 5
  if (ended.length && keep > 0) {
    out.push(`Ended (last ${Math.min(keep, ended.length)}${ended.length > keep ? ` of ${ended.length}` : ''}):`,
      ...ended.slice(0, keep).map(j => `- ${named(loaded, j)} · ${endWord(j)}${ranFor(j)}, ${ago(j.ended, now)}`))
  }
  const rec = toRecord(v, loaded).filter(r => !exp || r.exp === exp)
  if (rec.length) out.push(`Results to record: ${rec.map(r => recordText(r, now)).join(', ')} (rft_jobs <id> log: 40 for a job's output).`)
  return out.join('\n')
}

/** rft_move_job's answer: the job moved and the waiting order it leaves, in one line. */
export function movedText(r: { job: Job; waiting?: { id: string; exp: string; gpus: number }[] }): string {
  const w = r.waiting ?? []
  const order = w.slice(0, 10).map((j, i) => `${i + 1}. ${j.id} ${j.exp}${j.gpus !== 1 ? ` (${gpuWord(j.gpus)})` : ''}`)
  return `Moved ${r.job.id} (${r.job.exp}). Waiting: ${order.join(' · ')}${w.length > 10 ? ` · … ${w.length - 10} more` : ''}`
}

/** rft_cancel_job's answer. */
export function cancelledText(j: Job, loaded: Loaded, now: number): string {
  const what = j.started ? `it ran on ${gpuList(j.gpu_ids)} for ${duration((j.ended ?? now) - j.started)}; its output stays in ${QUEUE_DIR}/logs/${j.id}.log` : 'it had not started'
  return `Cancelled ${named(loaded, j)}: ${what}.${loaded.tree.nodes[j.exp]?.status === 'running' ? ` ${j.exp} still says running: set its status once you know what to keep.` : ''}`
}
