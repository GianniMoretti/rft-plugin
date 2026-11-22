// A handoff: what a session leaves for the next one in the same folder.
//
// Every request of a session carries the whole session, and a session resumed after an hour is
// read whole again; a new session starts from the rules and the tree. The handoff makes the new
// session the cheap way to go on: at most 2,000 characters that point at notes (the tree is the
// record) and say what no note holds: what to do first, what runs and where, what is in neither a
// note nor a commit. The plugin adds what it can check itself, the repositories with uncommitted
// changes when the handoff was saved.
//
// One per session folder, in the vault's `.handoff/`, kept out of git: it is this machine's state,
// like the queue's. The first session to start in that folder after the one that wrote it gets it
// in full (after a /clear too) and marks it taken; later sessions get one line, for a week.

import type { CodeEnv } from './ops'
import { RftError, repoState, stateText, today } from './ops'
import type { Io } from './vault'
import { gitRootOf, join, repoAbs } from './vault'

export const HANDOFF_DIR = '.handoff'
/** The most characters of what Claude writes in a handoff: what a note can hold goes in the note. */
export const MAX_HANDOFF = 2000
/** How long a handoff is still pointed at once a session took it, or from another folder. */
export const POINTER_DAYS = 7
const MAX_OTHERS = 3

export type Handoff = {
  /** The folder of the session that wrote it, and that session's id ('' when the host gave none). */
  folder: string
  session: string
  /** When it was written, in seconds. */
  at: number
  done: string
  next: string
  unrecorded: string
  /** The repositories with work no commit held when it was saved, one line each. */
  uncommitted: string[]
  /** The first other session that started from it, and when. */
  takenBy?: string
  takenAt?: number
}

const FIELDS = ['done', 'next', 'unrecorded'] as const

const hash = (s: string) => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

/** A folder's file in `.handoff/`: the end of its path, and a hash of all of it so two folders never share one. */
export const handoffFile = (folder: string) =>
  `${folder.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-80) || 'root'}-${hash(folder)}.json`

const isHandoff = (v: unknown): v is Handoff => {
  const h = v as Handoff | null
  return Boolean(h) && typeof h === 'object' && typeof h!.folder === 'string' && typeof h!.at === 'number' && FIELDS.every(k => typeof h![k] === 'string') && Array.isArray(h!.uncommitted)
}

/** Every folder's handoff, the latest first. */
export async function readHandoffs(io: Io, vault: string): Promise<Handoff[]> {
  const dir = join(vault, HANDOFF_DIR)
  const out: Handoff[] = []
  for (const f of await io.list(dir).catch(() => [])) {
    if (f.kind !== 'file' || !f.name.endsWith('.json')) continue
    try {
      const v: unknown = JSON.parse(await io.read(join(dir, f.name)))
      if (isHandoff(v)) out.push(v)
    } catch { /* not a handoff */ }
  }
  return out.sort((a, b) => b.at - a.at)
}

/** Whether the vault holds a handoff: its tool and rule are in the prompt then. */
export const hasHandoffs = async (io: Io, vault: string): Promise<boolean> =>
  (await io.list(join(vault, HANDOFF_DIR)).catch(() => [])).some(f => f.kind === 'file' && f.name.endsWith('.json'))

async function write(io: Io, vault: string, h: Handoff): Promise<void> {
  const dir = join(vault, HANDOFF_DIR)
  if (!(await io.exists(join(dir, '.gitignore')))) await io.write(join(dir, '.gitignore'), '*\n')
  await io.write(join(dir, handoffFile(h.folder)), `${JSON.stringify(h, null, 2)}\n`)
}

/**
 * The repositories holding work that is in no commit (changed or untracked files), among the
 * folders given (the session's, the tree's, the concepts' code): one line each, a repository once.
 */
export async function uncommittedIn(io: Io, env: CodeEnv, folders: string[]): Promise<string[]> {
  const roots: string[] = []
  for (const f of folders) {
    let root: string | null = null
    try { root = await gitRootOf(io, repoAbs(env.root, f, env.home)) } catch { /* not a folder it can read */ }
    if (root && !roots.includes(root)) roots.push(root)
  }
  const out: string[] = []
  for (const root of roots) {
    const st = await repoState(io, env, root, { untracked: true })
    if (st.kind === 'git' && (st.dirty || st.untracked)) out.push(`${root}: ${stateText(st)}`)
  }
  return out
}

export function ago(seconds: number): string {
  const s = Math.max(0, seconds)
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`
  if (s < 48 * 3600) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} days ago`
}

const stamp = (at: number) => {
  const d = new Date(at * 1000)
  return `${today(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const body = (h: Handoff) => [
  `Done: ${h.done}`,
  `Next: ${h.next}`,
  `In no note or commit: ${h.unrecorded}`,
  ...(h.uncommitted.length ? [`Uncommitted when it was saved (the plugin's check): ${h.uncommitted.join('; ')}`] : []),
].join('\n')

/**
 * Saves this folder's handoff, replacing the one before; the answer says what the plugin found
 * uncommitted (`by.uncommitted`, looked up once the handoff itself is accepted).
 */
export async function leaveHandoff(
  io: Io, vault: string, input: { done?: string; next?: string; unrecorded?: string },
  by: { folder: string; session: string; now: number; uncommitted: () => Promise<string[]> },
): Promise<string> {
  const parts = { done: (input.done ?? '').trim(), next: (input.next ?? '').trim(), unrecorded: (input.unrecorded ?? '').trim() }
  const missing = FIELDS.filter(k => !parts[k])
  if (missing.length) throw new RftError(`A handoff has done, next and unrecorded: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} missing (unrecorded: "nothing" when the notes and the commits hold it all).`)
  const size = FIELDS.reduce((sum, k) => sum + parts[k].length, 0)
  if (size > MAX_HANDOFF) {
    throw new RftError(`The handoff is ${size} characters, over its ${MAX_HANDOFF}. It points at notes and does not repeat them: put what a note can hold in the note (a result in its experiment, an idea as a direction, a concept's state in its digest), then name the notes by id here.`)
  }
  const uncommitted = await by.uncommitted()
  await write(io, vault, { folder: by.folder, session: by.session, at: by.now, ...parts, uncommitted })
  return [
    `Handoff saved for ${by.folder} (${size} characters). The next session in this folder starts from it: a new session, or this one after /clear. Tell the user so.`,
    uncommitted.length
      ? `In no commit (the plugin's check, kept with the handoff):\n${uncommitted.map(l => `- ${l}`).join('\n')}`
      : "The plugin's check found no repository with uncommitted changes.",
  ].join('\n')
}

/** A folder's handoff as the tool and the command show it, with the other folders that have one. */
export async function showHandoff(io: Io, vault: string, folder: string, now: number): Promise<string> {
  const all = await readHandoffs(io, vault)
  const mine = all.find(h => h.folder === folder)
  const others = all.filter(h => h.folder !== folder)
  const out = [mine
    ? `Handoff left for ${folder} on ${stamp(mine.at)} (${ago(now - mine.at)}):\n${body(mine)}${mine.takenAt ? `\nA later session started from it on ${stamp(mine.takenAt)}.` : ''}`
    : `No handoff for ${folder}.`]
  if (others.length) out.push(`Other folders with a handoff: ${others.map(h => `${h.folder} (${ago(now - h.at)})`).join(', ')}.`)
  return out.join('\n\n')
}

export async function clearHandoff(io: Io, vault: string, folder: string): Promise<string> {
  const path = join(vault, HANDOFF_DIR, handoffFile(folder))
  if (!(await io.exists(path))) return `No handoff for ${folder}.`
  await io.remove(path)
  return `The handoff of ${folder} is removed.`
}

/**
 * What a session's rules say of the handoffs. This folder's is given in full to the first session
 * that starts after the one that wrote it, which marks it taken; that session and the writer's own
 * keep it in full. Later sessions get one line while it is recent. The handoffs other folders
 * left, that no session took yet, get one line too. Dates, not ages: a session resumed gets the
 * same text, so the rules it was cached with still hold.
 */
export async function handoffRules(io: Io, vault: string, at: { folder: string; session: string; now: number }): Promise<string | null> {
  const all = await readHandoffs(io, vault)
  const recent = (h: Handoff) => at.now - h.at <= POINTER_DAYS * 86400
  const out: string[] = []
  const mine = all.find(h => h.folder === at.folder)
  if (mine) {
    if (at.session && mine.session !== at.session && !mine.takenBy) {
      mine.takenBy = at.session
      mine.takenAt = at.now
      try { await write(io, vault, mine) } catch { /* shown in full again next time */ }
    }
    if (!mine.takenBy || mine.takenBy === at.session || mine.session === at.session) {
      out.push(`Handoff left for this folder on ${stamp(mine.at)}: the work goes on from it. The notes are the record: where a note and the handoff differ, the note holds.\n${body(mine)}`)
    } else if (recent(mine)) {
      out.push(`A handoff was left for this folder on ${stamp(mine.at)}, and a session since started from it: rft_handoff shows it.`)
    }
  }
  const others = all.filter(h => h.folder !== at.folder && !h.takenBy && recent(h)).slice(0, MAX_OTHERS)
  if (others.length) out.push(`Handoffs left in other folders, which no session took up yet: ${others.map(h => `${h.folder} (${stamp(h.at)})`).join(', ')}. rft_handoff {folder} shows one.`)
  return out.length ? out.join('\n\n') : null
}

/** What /rft-handoff asks of Claude; `note`: what the user added after the command. */
export const handoffPrompt = (note: string) =>
  `The user asked for a handoff: this session stops here, and the next one in this folder (a new session, or this one after /clear) starts from the handoff and the tree. First bring the tree up to date, since the handoff points at notes and does not repeat them: the result or the state of each experiment this session touched in its note (rft_set_status), each new idea as a direction, the digest of each concept that changed. Then call rft_handoff once, ${MAX_HANDOFF.toLocaleString('en-US')} characters at most in all: done (what this session did and decided, by note id), next (what to do first, in order; what is running, where its output goes and what to check in it), unrecorded (what neither a note nor a commit holds: uncommitted code, a log half read, a decision not written down; "nothing" when there is none). Its answer lists the repositories with uncommitted changes. End by telling the user, in a few lines, what the handoff says and that /clear, or a new session in this folder, goes on from it.${note ? ` The user adds: ${note}` : ''}`

/** The session sizes, in tokens, at which the user is told once that a handoff and a new session cost less. */
export const TELL_AT = [200_000, 400_000] as const

/** The size a session of `tokens` passed and was not told of (`told`: the largest it was told of), or null. */
export const toTell = (tokens: number, told: number): number | null =>
  [...TELL_AT].reverse().find(t => tokens >= t && t > told) ?? null

export const sizeToast = (tokens: number) =>
  `rft: this session is at ${Math.round(tokens / 1000)}k tokens, sent again with every request. /rft-handoff leaves what the next session needs; /clear then goes on from it and the tree.`
