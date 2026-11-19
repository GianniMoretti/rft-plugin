// The machine the experiment queue runs on, as the session sees it. There is no queue until a
// machine is paired with the vault's (server/rft_queue.py `machine add`, which writes
// .queue/machine.json): until then no queue tool, rule, runner or monitor. /rft-machine add checks
// the machine with no model turn (`machine probe`: its GPUs, disks, conda and uv) and, when it can
// run the queue, asks Claude to finish: the user picks where the runs' outputs go and the GPUs to
// keep for their own work, then rft_machine add pairs it. Only this machine for now.

import type { Io } from './vault'
import { join } from './vault'
import type { QueueView } from './queue'
import { QUEUE_DIR, gpuLine } from './queue'

export const MACHINE_FILE = `${QUEUE_DIR}/machine.json`

export type GpuInfo = { index: number; name: string; mem_total: number }
export type Conda = { root: string; envs: string[] }
/** A disk a run's outputs may go on: the folder suggested there, its room (bytes). */
export type Disk = { mount: string; path: string; free: number; total: number }

/** What `machine probe` read of this machine. */
export type Probe = {
  host: string
  os: string
  uv?: string | null
  conda?: Conda | null
  gpus: GpuInfo[]
  gpu_error?: string | null
  driver?: string
  cuda?: string
  /** The disks, the most room first. */
  disks: Disk[]
  /** The root of the runs' outputs to suggest: the config's runsDir, else the disk with the most room's. */
  runs_dir?: string | null
  eligible: boolean
  why_not?: string | null
}

/** The machine paired with the vault's queue (.queue/machine.json). */
export type Machine = {
  host: string
  added?: string
  /** The root of the runs' outputs: <runs_dir>/<repo>/<experiment>/<job>. */
  runs_dir?: string
  os?: string
  gpus?: GpuInfo[]
  driver?: string
  cuda?: string
  conda?: Conda
  uv?: string
}

/** What `machine status` says: the pairing, and on the paired machine its queue and the room left for outputs. */
export type MachineStatus = {
  host: string
  machine: Machine | null
  paired: boolean
  queue?: QueueView
  runs_free?: number
  runs_total?: number
}

/** The machine paired with the vault's queue, or null: no queue (whichever machine reads it; the queue's runner checks the host). */
export async function readMachine(io: Io, vault: string): Promise<Machine | null> {
  let m: unknown
  try { m = JSON.parse(await io.read(join(vault, MACHINE_FILE))) } catch { return null }
  return m && typeof m === 'object' && typeof (m as Machine).host === 'string' && (m as Machine).host ? m as Machine : null
}

// ---------------------------------------------------------------- words

/** A size as a disk tool says it: 7.3 TB, 94 GB. */
export function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let v = n
  let i = 0
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++ }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

const shortName = (name: string) => name.replace(/^NVIDIA\s+(GeForce\s+)?/i, '')

/** The GPUs in a few words: "2 GPUs: 0 RTX 5080 (16 GB), 1 RTX 5080 (16 GB)". */
export function gpusText(gpus: GpuInfo[], driver?: string, cuda?: string): string {
  if (!gpus.length) return 'no GPU'
  const list = gpus.map(g => `${g.index} ${shortName(g.name)}${g.mem_total ? ` (${Math.round(g.mem_total / 1024)} GB)` : ''}`).join(', ')
  const soft = [driver ? `driver ${driver}` : '', cuda ? `CUDA ${cuda}` : ''].filter(Boolean).join(', ')
  return `${gpus.length} GPU${gpus.length === 1 ? '' : 's'}: ${list}${soft ? `; ${soft}` : ''}`
}

/** conda and uv as a job's command can use them. */
function envText(conda?: Conda | null, uv?: string | null): string {
  const parts: string[] = []
  if (conda) {
    const envs = conda.envs.length > 8 ? [...conda.envs.slice(0, 8), '…'] : conda.envs
    parts.push(`conda at ${conda.root} (envs: ${envs.join(', ')}; a job activates one with \`source ${conda.root}/bin/activate <env>\`)`)
  }
  if (uv) parts.push(`uv at ${uv}`)
  return parts.length ? parts.join('; ') : 'neither conda nor uv found (a job gives its interpreter\'s full path)'
}

/** What /rft-machine add found: the machine, its GPUs, the disks for the outputs, its environments. */
export function probeText(p: Probe): string {
  const lines = [`This machine: ${p.host}, ${p.os}.`]
  if (!p.eligible) {
    lines.push(`It cannot run the experiment queue: ${p.why_not ?? 'no NVIDIA GPU here'}. The queue stays off; the tree works as before.`)
    return lines.join('\n')
  }
  lines.push(`GPUs: ${gpusText(p.gpus, p.driver, p.cuda)}.`)
  const sug = p.disks.find(d => d.path === p.runs_dir)
  const others = p.disks.filter(d => d.path !== p.runs_dir).slice(0, 3)
  lines.push(`Runs' outputs: suggested ${p.runs_dir ?? '(no disk found)'}${sug ? ` (${bytes(sug.free)} free of ${bytes(sug.total)})` : p.runs_dir ? ' (the config\'s runsDir)' : ''}` +
    `${others.length ? `; other disks: ${others.map(d => `${d.path} (${bytes(d.free)} free)`).join(', ')}` : ''}.`)
  lines.push(`Environments: ${envText(p.conda, p.uv)}.`)
  return lines.join('\n')
}

/** The request /rft-machine add hands to Claude: the check above, two questions, one call. */
export function machinePrompt(p: Probe): string {
  const disks = p.disks.slice(0, 4).map(d => `${d.path} (${bytes(d.free)} free)`)
  return `Pair this machine with the experiment queue (rft-manual skill, "The experiment queue"). The plugin checked it already, so do not inspect the machine yourself:\n${probeText(p)}\n\n` +
    `Ask me, in one AskUserQuestion with two questions: (1) where the runs' outputs go: ${p.runs_dir ? `${p.runs_dir} first, as recommended` : 'one of the disks'}${disks.length ? `, then ${disks.filter(d => !d.startsWith(`${p.runs_dir} `)).join(', ') || 'no other disk'}` : ''}; ` +
    `(2) which GPUs to keep out of the queue for my own work: none (recommended) or ${p.gpus.map(g => `GPU ${g.index}`).join(', ')} (multiSelect). ` +
    'Then call rft_machine with action "add", runs_dir and keep_out (the GPU indices, or none), and tell me in two lines what is on.'
}

/** The pairing and the queue in a few lines: the answer of /rft-machine and of rft_machine status. `already`: /rft-machine add on a paired machine. */
export function statusText(s: MachineStatus, opts: { already?: boolean } = {}): string {
  const m = s.machine
  if (!m) return 'No machine is paired with the experiment queue, so there is none: no job, runner or monitor. /rft-machine add pairs this one.'
  if (!s.paired) {
    return `This vault's experiment queue is paired with ${m.host}, not with this machine (${s.host}): a queue runs on one machine. ` +
      `If ${m.host} is gone or was renamed, delete ${QUEUE_DIR}/machine.json in the vault, then /rft-machine add pairs this one.`
  }
  const lines = [`${opts.already ? 'Local machine already loaded' : 'This machine is paired with the experiment queue'}: ${m.host}${m.os ? `, ${m.os}` : ''}${m.added ? `, since ${m.added.slice(0, 10)}` : ''}.`]
  const v = s.queue
  const gl = v ? gpuLine(v) : null
  lines.push(gl ?? `GPUs: ${gpusText(m.gpus ?? [], m.driver, m.cuda)}`)
  if (m.runs_dir) lines.push(`Runs' outputs: ${m.runs_dir}${s.runs_free != null ? ` (${bytes(s.runs_free)} free${s.runs_total ? ` of ${bytes(s.runs_total)}` : ''})` : ''}`)
  lines.push(`Environments: ${envText(m.conda, m.uv)}`)
  if (v) {
    const running = v.jobs.filter(j => j.state === 'running').length
    const waiting = v.jobs.filter(j => j.state === 'pending').length
    lines.push(`Queue: ${running} running, ${waiting} waiting${v.paused ? ' (paused)' : ''}, ${v.history.length ? `${v.history.length} ended` : 'none ended yet'}; its runner ${v.runner ? 'is on' : 'starts with the next job'}. /rft-jobs lists them; the tree view's monitor follows them.`)
  }
  return lines.join('\n')
}
