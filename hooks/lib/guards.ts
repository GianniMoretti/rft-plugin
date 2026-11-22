// The edit guards: why Claude may not make an Edit, a Write or a shell call, or null.
//
// Some of what the vault holds is not Claude's to write by hand: a concept's artifact
// (artifacts.ts), a locked note and the comments files (comments.ts), a note's priority, its
// dates and its verification, the user's alone (priority.ts, schedule.ts, verify.ts), what only a
// notebook's run writes (notebooks.ts), the snippets and documents the plugin generates or the
// user locked (snippets.ts), a new or a locked deck (decks.ts).
//
// A call is taken apart once (`refusal`): for a shell command the files it writes, as far as the
// command shows them (shell.ts); for an edit its file and, for a note, the text before and after.
// The guards then read that in a fixed order, and the first one that refuses gives the answer.

import { ARTIFACTS_DIR } from './artifacts'
import { COMMENTS_DIR, isLocked } from './comments'
import { DECKS_DIR, NEW_DECK_TEXT, P as Slides, deckLockedText } from './decks'
import { REPRODUCED_LINE, changesReproduced, changesResultsBlock, reproducedEditText, resultsBlockEditText } from './notebooks'
import { lockedText } from './ops'
import { changesPriority, priorityText } from './priority'
import { MEETING_FIELDS, changesDates, datesText } from './schedule'
import { matches, shellWrites } from './shell'
import { BLOCKS_FILE, DOCUMENTS_DIR, GENERATED, SNIPPETS_DIR, isDocumentLocked, isSnippetLocked, readDocsRegistry, readRegistry } from './snippets'
import type { Io } from './vault'
import { MEETINGS, join, resolvePath } from './vault'
import { changesVerified, verifiedText } from './verify'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** Whether the guards look at the calls of `tool` at all. */
export const isGuarded = (tool: string) => tool === 'Bash' || EDIT_TOOLS.has(tool)

/** A note as the guards need it: the snapshot's. */
export type GuardNote = { id: string; name: string; title: string; path: string; locked: boolean }

/** What the session knows when a call arrives. */
export type Scene = {
  io: Io
  /** The vault's folder and the session's, absolute. */
  vault: string
  cwd: string
  nodes: GuardNote[]
}

type Call = {
  io: Io
  vault: string
  /** The vault folder's own name: how a command that does not give the whole path names it. */
  folder: string
  nodes: GuardNote[]
  /** A file's text, read once however many guards ask; null when there is no such file. */
  text: (path: string) => Promise<string | null>
  /** A shell command: the files it writes, the notes and whether any file in the vault among them, and whether it runs a script (whose writes it does not show). */
  shell: { cmd: string; files: string[]; script: boolean; notes: GuardNote[]; inVault: boolean } | null
  /** An edit: its file, the note that file is, and for a Markdown file in the vault its text before and once the call has run (null when the call would fail). */
  edit: { path: string; note: GuardNote | null; change: () => Promise<{ before: string; after: string } | null> } | null
}

type Guard = (c: Call) => Promise<string | null> | string | null

/** A note's text once an Edit, MultiEdit or Write has run on `before`; null when the call would fail or is another one. */
function afterCall(tool: string, e: Record<string, unknown>, before: string): string | null {
  if (tool === 'Write') return typeof e.content === 'string' ? e.content : null
  const edits = tool === 'Edit' ? [e] : tool === 'MultiEdit' && Array.isArray(e.edits) ? (e.edits as Record<string, unknown>[]) : null
  if (!edits) return null
  let text = before
  for (const x of edits) {
    const from = x.old_string, to = x.new_string
    if (typeof from !== 'string' || typeof to !== 'string') return null
    if (!from) { if (text) return null; text = to; continue } // an empty old_string makes a new file
    if (!text.includes(from)) return null
    text = x.replace_all === true ? text.split(from).join(to) : text.replace(from, () => to)
  }
  return text
}

/** The call as the guards read it; null when it writes no file the guards could tell. */
function callOf(tool: string, e: Record<string, unknown>, at: Scene): Call | null {
  const vault = resolvePath(at.vault, '.')
  const texts = new Map<string, Promise<string | null>>()
  const text = (path: string) => {
    let t = texts.get(path)
    if (!t) texts.set(path, (t = at.io.read(path).then(s => s, () => null)))
    return t
  }
  const base = { io: at.io, vault, folder: vault.split('/').pop() ?? '', nodes: at.nodes, text }
  if (tool === 'Bash') {
    const cmd = String(e.command ?? '')
    const w = shellWrites(cmd, at.cwd)
    return {
      ...base, edit: null,
      shell: {
        cmd, files: w.files, script: w.script,
        notes: at.nodes.filter(n => w.files.some(f => matches(f, join(vault, n.path)))),
        inVault: w.files.some(f => f.startsWith(`${vault}/`)),
      },
    }
  }
  const raw = e.file_path ?? e.notebook_path
  if (typeof raw !== 'string') return null
  const path = resolvePath(at.cwd, raw)
  const isNoteFile = typeof e.file_path === 'string' && e.file_path.endsWith('.md') && path.startsWith(`${vault}/`)
  let change: Promise<{ before: string; after: string } | null> | null = null
  return {
    ...base, shell: null,
    edit: {
      path,
      note: at.nodes.find(n => join(vault, n.path) === path) ?? null,
      change: () => (change ??= !isNoteFile ? Promise.resolve(null) : text(path).then(t => {
        const before = t ?? '' // a new file
        const after = afterCall(tool, e, before)
        return after === null ? null : { before, after }
      })),
    },
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const ARTIFACT_BY_HAND = `Only rft_set_artifact writes a concept's artifact (${ARTIFACTS_DIR}/), stamped with the results it was written from: call rft_artifact <concept>, then rft_set_artifact with edits (old_str → new_str, as with Edit) or html for the whole page. Reading the file is fine.`

/**
 * A concept's artifact written by hand: an Edit or Write in the vault's artifacts/, a shell
 * command that writes there, or a script whose command names that folder.
 */
const artifact: Guard = c => {
  const dir = `${c.vault}/${ARTIFACTS_DIR}/`
  if (c.shell) {
    const { cmd, files, script } = c.shell
    const named = cmd.includes(`${c.folder}/${ARTIFACTS_DIR}/`) || cmd.includes(dir)
    return files.some(f => f.startsWith(dir)) || (script && named) ? ARTIFACT_BY_HAND : null
  }
  return c.edit!.path.startsWith(dir) ? ARTIFACT_BY_HAND : null
}

const COMMENTS_BY_HAND = `The tree view and the rft tools write the comments files (${COMMENTS_DIR}/): use rft_comment and rft_suggest.`

/**
 * A locked note edited (Edit, Write; a shell command that writes and names the note's file, as far
 * as the command shows it), or a comments file written by hand.
 */
const locked: Guard = async c => {
  if (c.shell) {
    const { cmd, files, script, notes } = c.shell
    if (files.some(f => f.startsWith(`${c.vault}/${COMMENTS_DIR}/`)) || (script && cmd.includes(`${COMMENTS_DIR}/`))) return COMMENTS_BY_HAND
    const written = notes.find(n => n.locked)
    if (written) return lockedText(written)
    if (!script) return null
    // a script: the locked note it names by its file name (the id, then the title's first word, or a glob)
    for (const n of c.nodes) {
      if (!n.locked) continue
      const word = escapeRe(n.title.split(' ')[0] ?? '')
      if (cmd.includes(n.name) || new RegExp(`\\b${n.id}(?:[*?]|(?:\\\\ | )${word})`).test(cmd)) return lockedText(n)
    }
    return null
  }
  const { path, note } = c.edit!
  if (path.startsWith(`${c.vault}/${COMMENTS_DIR}/`)) return COMMENTS_BY_HAND
  if (!note) return null
  const text = await c.text(path)
  return text !== null && isLocked(text) ? lockedText(note) : null
}

/** A refusal's text, for the note it is about when that is known. */
type Why = (n: GuardNote | null) => string

/**
 * A guard of fields only the user, or a notebook's run, writes. An Edit or Write of a note (or a
 * milestone, or a meeting) in the vault is refused when it adds, changes or removes one
 * (`inEdit`); a shell command when it holds such a line (`inCommand`) and writes a note or in the
 * vault, or runs a script and names the vault or a note. `first`: a check of the command made before.
 */
const fields = (
  inCommand: (cmd: string) => Why | null,
  inEdit: (before: string, after: string, isMeeting: boolean) => Why | null,
  first?: (shell: NonNullable<Call['shell']>, c: Call) => string | null,
): Guard => async c => {
  if (c.shell) {
    const { cmd, script, notes, inVault } = c.shell
    const early = first?.(c.shell, c) ?? null
    if (early !== null) return early
    const why = inCommand(cmd)
    if (!why) return null
    if (notes.length || inVault) return why(notes[0] ?? null)
    if (!script) return null
    // a script: the vault or a note it names, by name or id
    const named = c.nodes.find(n => cmd.includes(n.name) || new RegExp(`\\b${n.id}\\b`).test(cmd)) ?? null
    return named || cmd.includes(c.vault) || (c.folder && cmd.includes(`${c.folder}/`)) ? why(named) : null
  }
  const { path, note, change } = c.edit!
  const ch = await change()
  if (!ch) return null
  const why = inEdit(ch.before, ch.after, path.startsWith(`${c.vault}/${MEETINGS}/`))
  return why ? why(note) : null
}

/** A `priority:` line, not `suggested_priority:`. */
const PRIORITY_LINE = /(^|[^\w])priority\s*:/m
/** A `due:`, `start:` or `est:` line, not `suggested_start:` or `suggested_est:`. */
const DATE_LINE = /(^|[^\w])(due|start|est)\s*:/m
/** A line of a meeting's times. */
const MEETING_LINE = new RegExp(`(^|[^\\w])(${MEETING_FIELDS.join('|')})\\s*:`, 'm')
/** A `status: verified` or `verified:` line. */
const VERIFIED_LINE = /(^|[^\w])(status\s*:\s*["']?verified|verified\s*:)/m

/** A note's `priority:`, the user's alone. */
const priority = fields(
  cmd => (PRIORITY_LINE.test(cmd) ? priorityText : null),
  (before, after) => (changesPriority(before, after) ? priorityText : null),
)

/**
 * A date, the user's alone: `due:`, `start:` or `est:` of a note or a milestone, and a meeting's
 * times (a command that holds such a line and writes in meetings/, or a script that names it).
 */
const dates = fields(
  cmd => (DATE_LINE.test(cmd) ? datesText : null),
  (before, after, isMeeting) => (changesDates(before, after, isMeeting) ? datesText : null),
  ({ cmd, files, script }, c) =>
    MEETING_LINE.test(cmd) && cmd.includes(`${MEETINGS}/`) && (files.some(f => f.startsWith(`${c.vault}/${MEETINGS}/`)) || script) ? datesText(null) : null,
)

/** A note's `reproduced:`, or the table of RESULTS in its Result: only a notebook's run writes them. */
const reproduced = fields(
  cmd => (REPRODUCED_LINE.test(cmd) ? reproducedEditText : cmd.includes('rft-results') ? resultsBlockEditText : null),
  (before, after) => (changesReproduced(before, after) ? reproducedEditText : changesResultsBlock(before, after) ? resultsBlockEditText : null),
)

/** A note verified (`status: verified`) or its stamp changed (`verified:`), the user's alone. */
const verified = fields(
  cmd => (VERIFIED_LINE.test(cmd) ? verifiedText : null),
  (before, after) => (changesVerified(before, after) ? verifiedText : null),
)

const MANUSCRIPT_GENERATED = `The plugin writes ${GENERATED.join(', ')} and each document's ${BLOCKS_FILE}: snippets go through rft_set_snippet, placements through rft_set_document, the rest is generated when a document compiles.`
const snippetLockedText = (id?: string) =>
  `The snippets are locked: ${id ? `${id} is` : 'they are'} the user's to write. Propose a snippet as a stub with rft_set_snippet, and comment or suggest on the user's text with rft_comment / rft_suggest {id: "${id ?? 'S..'}", quote, …}; they accept or reject it.`
const documentLockedText = (name: string) =>
  `The document ${name} is locked: its text is the user's. Place, move or remove a copy of a snippet with rft_set_document once the user agrees; comment or suggest on its text with rft_comment / rft_suggest {id: "${name}", quote, …}.`

/**
 * Snippets or documents written by hand where they are not Claude's to (an Edit or Write in
 * vault/snippets/ or vault/documents/, a shell command that writes there): the registries, the
 * generated files and the copies' records always, a new snippet's file (rft_set_snippet numbers
 * and stamps it), a locked snippet, and a locked document's text.
 */
const manuscript: Guard = async c => {
  const names = [SNIPPETS_DIR, DOCUMENTS_DIR]
  const dirs = names.map(d => `${c.vault}/${d}/`)
  let files: string[]
  if (c.shell) {
    const { cmd, script } = c.shell
    files = c.shell.files.filter(f => dirs.some(d => f.startsWith(d)))
    if (!files.length && script) files = dirs.filter((d, k) => cmd.includes(d) || cmd.includes(`${c.folder}/${names[k]}/`))
  } else {
    files = dirs.some(d => c.edit!.path.startsWith(d)) ? [c.edit!.path] : []
  }
  if (!files.length) return null
  const reg = await readRegistry(c.io, c.vault)
  const docs = await readDocsRegistry(c.io, c.vault)
  for (const f of files) {
    const rel = f.slice(c.vault.length + 1)
    if (GENERATED.some(g => rel === g || rel.startsWith(`${g}/`)) || rel.endsWith(`/${BLOCKS_FILE}`)) return MANUSCRIPT_GENERATED
    const m = new RegExp(`^${SNIPPETS_DIR}/(S\\d+)\\.tex$`).exec(rel)
    if (m) {
      if ((await c.text(f)) === null) return 'A new snippet is made with rft_set_snippet, which numbers it, writes its header and stamps it with its basis: not by hand.'
      if (isSnippetLocked(reg, m[1]!)) return snippetLockedText(m[1])
      continue
    }
    const d = new RegExp(`^${DOCUMENTS_DIR}/([a-z0-9][a-z0-9-]*)/`).exec(rel)
    if (d) {
      if (isDocumentLocked(docs, d[1]!)) return documentLockedText(d[1]!)
      continue
    }
    if (rel.startsWith(`${SNIPPETS_DIR}/`) ? reg.locked : docs.locked) return rel.startsWith(`${SNIPPETS_DIR}/`) ? snippetLockedText() : MANUSCRIPT_GENERATED
  }
  return null
}

/**
 * A slide deck written by hand where it is not Claude's to (an Edit or Write in vault/decks/, a
 * shell command that writes there): a new deck (the Slides tab numbers and locks it) or a locked
 * deck. Other files there (images) are not refused.
 */
const deck: Guard = async c => {
  const dir = `${c.vault}/${DECKS_DIR}/`
  const isLockedDeck = (text: string) => Slides.isLocked(Slides.frontOf(text.replace(/\r\n/g, '\n')).fields)
  let files: string[]
  if (c.shell) {
    const { cmd, script } = c.shell
    files = c.shell.files.filter(f => f.startsWith(dir))
    // a script that names the folder but whose files cannot be told: refused while a deck there is locked
    if (!files.length && script && (cmd.includes(dir) || cmd.includes(`${c.folder}/${DECKS_DIR}/`))) {
      for (const f of await c.io.list(dir).catch(() => [])) {
        if (f.kind === 'file' && f.name.endsWith('.md') && isLockedDeck((await c.text(`${dir}${f.name}`)) ?? '')) return deckLockedText(f.name.split(' ')[0]!)
      }
      return null
    }
  } else {
    files = c.edit!.path.startsWith(dir) ? [c.edit!.path] : []
  }
  for (const f of files) {
    const rel = f.slice(dir.length)
    if (rel.includes('/') || !rel.endsWith('.md')) continue
    const text = await c.text(f)
    if (text === null) return NEW_DECK_TEXT
    if (isLockedDeck(text)) return deckLockedText(rel.split(' ')[0]!)
  }
  return null
}

/** In this order: a call that breaks several rules is told of the first. */
const GUARDS: Guard[] = [artifact, locked, priority, dates, reproduced, verified, manuscript, deck]

/** Why Claude may not make this call of `tool` (an Edit, a Write or a shell command, with its input `e`), or null. */
export async function refusal(tool: string, e: Record<string, unknown>, at: Scene): Promise<string | null> {
  if (!isGuarded(tool)) return null
  const call = callOf(tool, e, at)
  if (!call) return null
  for (const guard of GUARDS) {
    const why = await guard(call)
    if (why !== null) return why
  }
  return null
}
