// Snippets and documents (docs/design/manuscript.md), two levels. Snippets: LaTeX building blocks,
// each resting on notes of the tree (its `% basis:` line and the notes its macros and citations
// name), written once and reused. Documents: what is built with them, holding copies of snippets
// (each stamped with the snippet's content it was taken from) and text of their own. A note that
// changes sends its snippets to review; a snippet that changes sends its copies to review, and a
// document is never rewritten by itself. Claude reads them with rft_manuscript, proposes snippets
// (rft_set_snippet: stubs while locked, from verified notes only) and placements the user agreed
// to (rft_set_document).

import type { Io, Loaded, RftNode } from './vault'
import { compareNames, conceptOrder, join, resolveId } from './vault'
import type { Block, DocsRegistry, Header, Kind, Registry, Snippet } from './snippets'
import {
  DOCUMENTS_DIR, DOCUMENTS_REGISTRY, KINDS, SNIPPETS_DIR, SNIPPETS_REGISTRY, THEOREMS, blockText, blocksRel, bodyAfterHeader,
  contentFingerprint, contentOf, documentRel, headerText, isDocumentLocked, isDocumentName, isKind, isSnippetLocked, listDocuments,
  listSnippets, parseBlocks, readDocsRegistry, readRegistry, snippetRel, uncommented, writeDocsRegistry, writeRegistry,
} from './snippets'
import { substanceFingerprint } from './verify'

export class ManuscriptError extends Error {}

export type Doc = { name: string; path: string; text: string; blocks: Block[]; locked: boolean }
export type Manuscript = { registry: Registry; docs: DocsRegistry; snippets: Snippet[]; documents: Doc[] }

/** Snippets and documents as they are on disk; null when the vault has neither. */
export async function readManuscript(io: Io, loaded: Loaded): Promise<Manuscript | null> {
  const vault = loaded.config.vault
  const has = loaded.hasManuscript || (await io.exists(join(vault, SNIPPETS_REGISTRY))) || (await io.exists(join(vault, DOCUMENTS_REGISTRY)))
  if (!has) return null
  const registry = await readRegistry(io, vault)
  const docs = await readDocsRegistry(io, vault)
  const snippets = await listSnippets(io, vault)
  const documents: Doc[] = []
  for (const name of await listDocuments(io, vault)) {
    const path = documentRel(name)
    let text = ''
    try { text = (await io.read(join(vault, path))).replace(/\r\n/g, '\n') } catch { continue }
    documents.push({ name, path, text, blocks: parseBlocks(text), locked: isDocumentLocked(docs, name) })
  }
  return { registry, docs, snippets, documents }
}

// ---------------------------------------------------------------- what a snippet rests on

export { uncommented }

export type Uses = { nums: [string, string][]; figs: [string, string][]; tables: [string, string][]; cites: string[] }

/** The notes a text names through the macros, and the keys it cites (comments left out). */
export function usesIn(text: string): Uses {
  const t = uncommented(text)
  const pairs = (re: RegExp) => [...t.matchAll(re)].map(m => [m[1]!.trim(), m[2]!.trim()] as [string, string])
  const cites = [...t.matchAll(/\\(?:cite|citep|citet|citealp|citeauthor|citeyear|parencite|textcite|autocite)\*?(?:\[[^\]]*\]){0,2}\{([^}]*)\}/g)]
    .flatMap(m => m[1]!.split(',').map(k => k.trim()).filter(Boolean))
  return {
    nums: pairs(/\\rftnum\{([^}]*)\}\{([^}]*)\}/g),
    figs: pairs(/\\rftfig(?:\[[^\]]*\])?\{([^}]*)\}\{([^}]*)\}/g),
    tables: pairs(/\\rfttable\{([^}]*)\}\{([^}]*)\}/g),
    cites: [...new Set(cites)],
  }
}

/**
 * The note each citation key stands for: a reference note by its id (`\cite{R07}`), and each paper
 * of a reference note by the key of its ```bibtex block (`\cite{zhang2018mixup}`, in a literature
 * note one block per paper).
 */
export function citeIndex(loaded: Loaded): Record<string, string> {
  const out: Record<string, string> = {}
  for (const n of Object.values(loaded.tree.nodes)) {
    if (n.type !== 'reference') continue
    out[n.id] = n.id
    for (const block of (loaded.texts[n.id] ?? '').matchAll(/```bibtex\n([\s\S]*?)```/g)) {
      for (const m of block[1]!.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)) out[m[1]!] ??= n.id
    }
  }
  return out
}

/** The notes a snippet rests on, declared and named by its macros and citations; and the names that are no note. */
export function basisOf(s: Pick<Snippet, 'basis' | 'text'>, loaded: Loaded, cites = citeIndex(loaded)): { ids: string[]; missing: string[] } {
  const u = usesIn(bodyAfterHeader(s.text))
  const named = [...s.basis, ...u.nums.map(p => p[0]), ...u.figs.map(p => p[0]), ...u.tables.map(p => p[0])]
  const ids: string[] = [], missing: string[] = []
  for (const ref of named) {
    const id = resolveId(loaded.tree, ref)
    if (id) { if (!ids.includes(id)) ids.push(id) } else if (!missing.includes(ref)) missing.push(ref)
  }
  for (const key of u.cites) {
    const id = cites[key]
    if (id && !ids.includes(id)) ids.push(id)
  }
  return { ids, missing }
}

/** The fingerprint of each note's substance now (verify.ts), as a snippet is stamped with them. */
export function stampOf(loaded: Loaded, ids: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const id of ids) {
    const n = loaded.tree.nodes[id]
    if (n) out[id] = substanceFingerprint(n.type, loaded.texts[id] ?? '')
  }
  return out
}

// ---------------------------------------------------------------- a snippet's state

/** A snippet with nothing of the user's yet: comments, its environment, its heading and label only. */
export function isStub(text: string): boolean {
  const rest = uncommented(bodyAfterHeader(text))
    .replace(/\\(?:begin|end)\{[^}]*\}(?:\[[^\]]*\])?/g, '')
    .replace(/\\(?:paragraph|label|caption|centering)\*?(?:\{[^}]*\})?/g, '')
  return !rest.trim()
}

export type State = {
  stub: boolean
  /** Why the text may no longer hold: a basis note changed since the stamp, in review, superseded or dropped. */
  review: string[]
  /** Basis notes that are not verified (the user may link them; they are flagged). */
  unverified: string[]
  /** Names in the basis or the macros that are no note of the tree. */
  missing: string[]
  basis: string[]
}

export function stateOf(s: Snippet, loaded: Loaded, registry: Registry, cites = citeIndex(loaded)): State {
  const { ids, missing } = basisOf(s, loaded, cites)
  const stamp = registry.snippets[s.id]?.stamp ?? {}
  const review: string[] = [], unverified: string[] = []
  for (const id of ids) {
    const n = loaded.tree.nodes[id]!
    if (n.supersededBy) review.push(`${id} superseded by ${n.supersededBy}`)
    else if (n.status === 'review') review.push(`${id} in review`)
    else if (n.status === 'dropped') review.push(`${id} dropped`)
    else if (stamp[id] && stamp[id] !== substanceFingerprint(n.type, loaded.texts[id] ?? '')) review.push(`${id} changed`)
    if (n.status !== 'verified' && n.status !== 'review') unverified.push(id)
  }
  return { stub: isStub(s.text), review, unverified, missing, basis: ids }
}

/** A snippet's state in a few words: `stub`, `written`, `review (E05 superseded by E09)`, with what is unverified or missing. */
export function stateWords(st: State): string {
  const main = st.review.length ? `review (${st.review.join(', ')})` : st.stub ? 'stub' : 'written'
  return [main, st.unverified.length ? `unverified: ${st.unverified.join(', ')}` : '', st.missing.length ? `no such note: ${st.missing.join(', ')}` : ''].filter(Boolean).join('; ')
}

// ---------------------------------------------------------------- copies in documents

export type CopyState = 'review' | 'adapted' | 'sync' | 'gone'
export type Copy = { id: string; state: CopyState; snippetReview: boolean }

/**
 * A copy's state: `review` when its snippet's content no longer matches the stamp it was taken
 * with (the snippet changed since); `adapted` when its text differs from the snippet's (fitted to
 * the narrative); `gone` when there is no such snippet; else `sync`. `snippetReview`: the snippet
 * itself is in review (its notes changed), so the copy is to be looked at too.
 */
export function copyState(b: Block, snippet: Snippet | undefined, snippetReview = false): Copy {
  if (!snippet) return { id: b.id, state: 'gone', snippetReview: false }
  if (contentFingerprint(contentOf(snippet.text)) !== b.stamp) return { id: b.id, state: 'review', snippetReview }
  return { id: b.id, state: contentFingerprint(b.content) !== b.stamp ? 'adapted' : 'sync', snippetReview }
}

/** The documents holding a copy of a snippet, with the copy's state. */
export function usedIn(ms: Manuscript, id: string): { doc: string; state: CopyState }[] {
  const s = ms.snippets.find(x => x.id === id)
  return ms.documents.flatMap(d => d.blocks.filter(b => b.id === id).map(b => ({ doc: d.name, state: copyState(b, s).state })))
}

const usedWords = (u: { doc: string; state: CopyState }[]) =>
  u.length ? `used in ${u.map(x => `${x.doc}${x.state === 'sync' ? '' : ` (${x.state === 'review' ? 'copy to review' : x.state})`}`).join(', ')}` : 'in no document'

/** The snippets a document refers to (\ref{S02} and the like) and holds no copy of. */
export function refsMissing(doc: Doc): string[] {
  const held = new Set(doc.blocks.map(b => b.id))
  const refs = [...uncommented(doc.text).matchAll(/\\(?:ref|cref|Cref|autoref|eqref|nameref)\{(S\d+)\}/g)].map(m => m[1]!)
  return [...new Set(refs.filter(id => !held.has(id)))]
}

// ---------------------------------------------------------------- what a note's run saved

/** RESULTS flattened by path (`gap.1k`, `sizes[0]`), as the notebook's run checks them (server/rft_results.py leaves). */
export function flatten(x: unknown, key = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (Array.isArray(x)) x.forEach((v, i) => flatten(v, `${key}[${i}]`, out))
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) flatten(v, key ? `${key}.${k}` : k, out)
  else if (key) out[key] = x
  return out
}

export type Saved = { numbers: Record<string, unknown>; figures: string[]; tables: string[] }

/** What an experiment's (or a concept's) notebook saved for it (results/<id>.json): its numbers, and its figures' and tables' names. */
export async function savedOf(io: Io, vault: string, id: string): Promise<Saved | null> {
  let d: Record<string, unknown>
  try { d = JSON.parse(await io.read(join(vault, 'results', `${id}.json`))) as Record<string, unknown> } catch { return null }
  const name = (p: unknown, dir: string, ext: string) => typeof p === 'string' ? p.replace(`${dir}/`, '').replace(new RegExp(`^${id}_`), '').replace(ext, '') : ''
  return {
    numbers: flatten(d.results),
    figures: (Array.isArray(d.figures) ? d.figures : []).map(p => name(p, 'figures', '.svg')).filter(Boolean),
    tables: (Array.isArray(d.tables) ? d.tables : []).map(p => name(p, 'tables', '.html')).filter(Boolean),
  }
}

/** The macro names a text uses that no notebook saved: each a line saying what is there instead. */
export async function macroProblems(io: Io, loaded: Loaded, text: string): Promise<string[]> {
  const u = usesIn(bodyAfterHeader(text))
  const out: string[] = []
  const cache: Record<string, Saved | null> = {}
  const saved = async (id: string) => (id in cache ? cache[id]! : (cache[id] = await savedOf(io, loaded.config.vault, id)))
  const list = (xs: string[]) => (xs.length ? xs.join(', ') : 'none')
  for (const [ref, key] of u.nums) {
    const id = resolveId(loaded.tree, ref) ?? ref
    const s = await saved(id)
    if (!s) out.push(`\\rftnum{${ref}}{${key}}: ${id} has no saved RESULTS (its notebook has not run, or did not reproduce it)`)
    else if (!(key in s.numbers)) out.push(`\\rftnum{${ref}}{${key}}: no such number; ${id}'s are ${list(Object.keys(s.numbers))}`)
  }
  for (const [kind, pairs] of [['rftfig', u.figs], ['rfttable', u.tables]] as const) {
    for (const [ref, name] of pairs) {
      const id = resolveId(loaded.tree, ref) ?? ref
      const s = await saved(id)
      const names = s ? (kind === 'rftfig' ? s.figures : s.tables) : []
      if (!names.includes(name)) out.push(`\\${kind}{${ref}}{${name}}: ${id} saved no ${kind === 'rftfig' ? 'figure' : 'table'} of that name; its are ${list(names)}`)
    }
  }
  return out
}

// ---------------------------------------------------------------- the report

/** The verified notes no snippet rests on, what is still to write. */
export function stillToWrite(loaded: Loaded, ms: Manuscript, cites = citeIndex(loaded)): RftNode[] {
  const covered = new Set(ms.snippets.flatMap(s => basisOf(s, loaded, cites).ids))
  return Object.values(loaded.tree.nodes).filter(n => n.status === 'verified' && !covered.has(n.id)).sort((a, b) => compareNames(a.name, b.name))
}

const snippetLock = (r: Registry) => r.locked
  ? `locked: the user writes them; you propose stubs (rft_set_snippet) and comment or suggest on their text (rft_comment, rft_suggest with the snippet's id)${r.unlocked.length ? `; unlocked for you: ${r.unlocked.join(', ')}` : ''}`
  : 'unlocked: you may write their text with rft_set_snippet'
const docLock = (r: DocsRegistry) => r.locked
  ? `locked: their text is the user's; you place copies they agreed to (rft_set_document) and comment or suggest (rft_comment, rft_suggest with the document's name)${r.unlocked.length ? `; unlocked for you: ${r.unlocked.join(', ')}` : ''}`
  : 'unlocked: you may edit their text too'

/** The copies of a document with their states, in a few words. */
function copiesWords(d: Doc, byId: Map<string, Snippet>, review: (id: string) => boolean): string {
  if (!d.blocks.length) return 'no copies yet'
  return d.blocks.map(b => {
    const c = copyState(b, byId.get(b.id), review(b.id))
    const notes = [c.state === 'sync' ? '' : c.state === 'review' ? 'snippet changed since: to review' : c.state, c.snippetReview ? 'its snippet is in review' : ''].filter(Boolean)
    return `${b.id}${notes.length ? ` (${notes.join('; ')})` : ''}`
  }).join(', ')
}

/** rft_manuscript: the snippets (the library), the documents with their copies, what is still to write; or one snippet, or one document. */
export async function manuscriptReport(io: Io, loaded: Loaded, ref?: string): Promise<string> {
  const ms = await readManuscript(io, loaded)
  if (!ms) return 'This vault has no snippets or documents yet. The user starts them with /rft-manuscript; until then, write no snippet.'
  const cites = citeIndex(loaded)
  const vault = loaded.config.vault
  const r = ref?.trim()
  const states = new Map(ms.snippets.map(s => [s.id, stateOf(s, loaded, ms.registry, cites)]))
  if (r && /^S\d+$/i.test(r)) return snippetReport(io, loaded, ms, r.toUpperCase(), states)
  if (r) {
    const d = ms.documents.find(x => x.name === r)
    if (!d) throw new ManuscriptError(`"${r}" is no document (${ms.documents.map(x => x.name).join(', ') || 'none yet'}) nor a snippet id`)
    return documentReport(ms, d, states, vault)
  }
  const byId = new Map(ms.snippets.map(s => [s.id, s]))
  const out = [`Snippets (${vault}/${SNIPPETS_DIR}/), the building blocks, ${snippetLock(ms.registry)}:`]
  for (const s of ms.snippets) {
    const st = states.get(s.id)!
    out.push(`  ${s.id} ${s.kind} · ${s.title} · ${stateWords(st)} · ${st.basis.join(', ') || 'no basis'} · ${usedWords(usedIn(ms, s.id))}`)
  }
  if (!ms.snippets.length) out.push('  none yet')
  out.push(`Documents (${vault}/${DOCUMENTS_DIR}/), built from copies of snippets, ${docLock(ms.docs)}:`)
  for (const d of ms.documents) out.push(`  ${d.name}: ${copiesWords(d, byId, id => !!states.get(id)?.review.length)}`)
  if (!ms.documents.length) out.push('  none yet')
  const todo = stillToWrite(loaded, ms, cites)
  if (todo.length) {
    out.push('Still to write (verified notes no snippet rests on), by concept:')
    for (const c of conceptOrder(loaded.tree.concepts ?? {})) {
      const own = todo.filter(n => n.concept === c.id)
      if (own.length) out.push(`  ${c.name}: ${own.map(n => `${n.id} ${n.type} (${n.summary ?? n.title})`).join('; ')}`)
    }
  } else out.push('Still to write: nothing; every verified note has a snippet resting on it.')
  out.push(`A snippet in full: rft_manuscript S<nn> (its file: ${vault}/${SNIPPETS_DIR}/S<nn>.tex); a document's outline: rft_manuscript <name>.`)
  return out.join('\n')
}

async function snippetReport(io: Io, loaded: Loaded, ms: Manuscript, id: string, states: Map<string, State>): Promise<string> {
  const s = ms.snippets.find(x => x.id === id)
  if (!s) throw new ManuscriptError(`${id} is no snippet`)
  const st = states.get(id)!
  const out = [
    `${s.id} ${s.kind} · ${s.title} (${loaded.config.vault}/${s.path}): ${stateWords(st)}; ${usedWords(usedIn(ms, id))}; ${isSnippetLocked(ms.registry, id) ? 'locked: the user writes it' : 'unlocked: you may write it'}.`,
    'Basis:',
  ]
  for (const b of st.basis) {
    const n = loaded.tree.nodes[b]!
    const saved = await savedOf(io, loaded.config.vault, b)
    out.push(`  ${n.id} ${n.status}${n.supersededBy ? ` (superseded by ${n.supersededBy})` : ''} · ${n.title}${n.summary ? `: ${n.summary}` : ''}`)
    if (saved) {
      const nums = Object.entries(saved.numbers).slice(0, 12).map(([k, v]) => `\\rftnum{${b}}{${k}} = ${String(v)}`)
      if (nums.length) out.push(`    numbers: ${nums.join(', ')}${Object.keys(saved.numbers).length > 12 ? ', …' : ''}`)
      if (saved.figures.length) out.push(`    figures: ${saved.figures.map(f => `\\rftfig{${b}}{${f}}`).join(', ')}`)
      if (saved.tables.length) out.push(`    tables: ${saved.tables.map(t => `\\rfttable{${b}}{${t}}`).join(', ')}`)
    }
  }
  const problems = await macroProblems(io, loaded, s.text)
  if (problems.length) out.push('Macros that name nothing saved:', ...problems.map(p => `  ${p}`))
  return out.join('\n')
}

function documentReport(ms: Manuscript, d: Doc, states: Map<string, State>, vault: string): string {
  const byId = new Map(ms.snippets.map(s => [s.id, s]))
  const lines = d.text.split('\n')
  const out = [`${d.name} (${vault}/${d.path}): ${d.locked ? 'locked: its text is the user\'s' : 'unlocked: you may edit its text'}. Its outline:`]
  const starts = new Map(d.blocks.map(b => [b.begin, b]))
  for (let i = 0; i < lines.length; i++) {
    const b = starts.get(i)
    if (b) {
      const s = byId.get(b.id)
      const c = copyState(b, s, !!states.get(b.id)?.review.length)
      out.push(`  ${b.id}${s ? ` ${s.kind} · ${s.title}` : ''}: ${c.state === 'sync' ? 'as the snippet' : c.state === 'review' ? 'the snippet changed since: to review' : c.state === 'gone' ? 'no such snippet' : 'adapted'}${c.snippetReview ? '; its snippet is in review' : ''}`)
      i = b.end
      continue
    }
    const h = /^\s*\\(part|chapter|section|subsection)\*?\{(.*)\}\s*$/.exec(lines[i]!)
    if (h) out.push(`${h[1] === 'subsection' ? '  ' : ''}§ ${h[2]}`)
  }
  const missing = refsMissing(d)
  if (missing.length) out.push(`It refers to snippets it holds no copy of: ${missing.join(', ')}.`)
  return out.join('\n')
}

// ---------------------------------------------------------------- writing snippets

/** A new snippet's text: its header, the outline as comments, the kind's environment, the body left to the user (or `text`). */
export function stubText(h: Header, outline: string[], date: string, text?: string, byUser = false): string {
  const lines = [headerText(h).trimEnd()]
  if (text == null && !byUser) {
    lines.push('%', `% Proposed by Claude on ${date}, for you to write: Claude comments and suggests, and writes it only once you unlock it.`)
    if (outline.length) lines.push('% What to say:', ...outline.map(l => `%   - ${l}`))
  }
  const body = text?.trim() ? text.trim() : '% your text'
  const kind = h.kind as Kind
  if (THEOREMS.includes(kind)) lines.push(`\\begin{${kind}}[${h.title}]\\label{${h.id}}`, body, `\\end{${kind}}`)
  else if (kind === 'proof') lines.push('\\begin{proof}', body, '\\end{proof}')
  else if (kind === 'figure') lines.push('\\begin{figure}[t]', '  \\centering', body, `  \\caption{${h.title}}\\label{${h.id}}`, '\\end{figure}')
  else if (kind === 'table') lines.push('\\begin{table}[t]', '  \\centering', `  \\caption{${h.title}}\\label{${h.id}}`, body, '\\end{table}')
  else lines.push(`\\paragraph{${h.title}}`, body)
  return lines.join('\n') + '\n'
}

export type SnippetInput = { id?: string; kind?: unknown; title?: unknown; basis?: string[]; outline?: unknown; text?: unknown; edits?: unknown }

/** A title as a header line and a LaTeX argument hold it: one line, no · { } \ % (they break the header or the argument). */
const cleanTitle = (t: unknown) => String(t ?? '').replace(/[·\n\r{}\\%]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)

/** The registries, made when missing: the two levels start together. */
async function ensureRegistries(io: Io, loaded: Loaded): Promise<void> {
  const vault = loaded.config.vault
  if (!(await io.exists(join(vault, SNIPPETS_REGISTRY)))) await writeRegistry(io, vault, await readRegistry(io, vault))
  if (!(await io.exists(join(vault, DOCUMENTS_REGISTRY)))) await writeDocsRegistry(io, vault, await readDocsRegistry(io, vault))
  loaded.hasManuscript = true
}

/**
 * rft_set_snippet. Without `id`, a new snippet: a stub (header, outline, the kind's environment)
 * while the snippets are locked, else with `text`. With `id`, its text (or edits, its basis, its
 * title), only when it is unlocked. The basis must be verified notes (the user's may be any), and
 * every macro must name what a notebook saved. Stamped with the basis notes' substance. A snippet
 * enters a document only through rft_set_document.
 */
export async function setSnippet(io: Io, loaded: Loaded, i: SnippetInput, date: string, opts: { byUser?: boolean } = {}): Promise<string> {
  const ms = await readManuscript(io, loaded)
  if (!ms) throw new ManuscriptError('This vault has no snippets or documents yet: the user starts them with /rft-manuscript')
  const vault = loaded.config.vault
  const reg = ms.registry
  const basisIds = (refs: string[]) => {
    const ids: string[] = []
    for (const ref of refs) {
      const id = resolveId(loaded.tree, ref.trim())
      if (!id) throw new ManuscriptError(`"${ref}" is not a note of the tree`)
      if (!ids.includes(id)) ids.push(id)
    }
    const unverified = ids.filter(id => loaded.tree.nodes[id]!.status !== 'verified')
    // the user may rest a snippet on any note (it is flagged until the note is verified); Claude only on verified ones
    if (unverified.length && !opts.byUser) {
      throw new ManuscriptError(`only verified notes are candidates for a snippet: ${unverified.map(id => `${id} is ${loaded.tree.nodes[id]!.status}`).join(', ')}. ` +
        'When one is ready, suggest verifying it (rft_set_status verified, with what was checked); the user verifies it in the tree view.')
    }
    return ids
  }
  const text = typeof i.text === 'string' && i.text.trim() ? i.text.replace(/\r\n/g, '\n') : undefined
  const outline = (Array.isArray(i.outline) ? i.outline : typeof i.outline === 'string' ? i.outline.split('\n') : [])
    .map(l => String(l).replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean)

  if (!i.id?.trim()) {
    if (!isKind(i.kind)) throw new ManuscriptError(`kind must be one of ${KINDS.join(', ')}`)
    const title = cleanTitle(i.title)
    if (!title) throw new ManuscriptError('give the snippet a title')
    if (!i.basis?.length) throw new ManuscriptError('give its basis: the verified notes it rests on')
    if (text && reg.locked && !opts.byUser) throw new ManuscriptError('the snippets are locked: the user writes the text. Propose the snippet as a stub (outline: what it should say), with no text')
    const ids = basisIds(i.basis)
    const id = `S${String(reg.next).padStart(2, '0')}`
    const body = stubText({ id, kind: i.kind, title, basis: ids }, outline, date, text, opts.byUser)
    const problems = await macroProblems(io, loaded, body)
    if (problems.length) throw new ManuscriptError(`its macros name what no notebook saved:\n${problems.join('\n')}`)
    await io.write(join(vault, snippetRel(id)), body)
    reg.next++
    reg.snippets[id] = { stamp: stampOf(loaded, [...new Set([...ids, ...basisOf({ basis: ids, text: body }, loaded).ids])]), ...(text ? { written: date } : { proposed: date }) }
    await writeRegistry(io, vault, reg)
    return `${id} ${text ? 'written' : 'proposed as a stub for the user to write'}: ${vault}/${snippetRel(id)} (${i.kind}, basis ${ids.join(', ')}), in no document yet.` +
      (text || opts.byUser ? '' : ' Tell the user it is there and what it asks for; then comment and suggest on their text when they ask, never write it.') +
      (opts.byUser ? '' : ' To place it in a document, propose where (rft_manuscript <document> shows its outline); place it with rft_set_document once the user agrees.')
  }

  const id = i.id.trim().toUpperCase()
  const s = ms.snippets.find(x => x.id === id)
  if (!s) throw new ManuscriptError(`${id} is no snippet`)
  if (isSnippetLocked(reg, id) && !opts.byUser) {
    throw new ManuscriptError(`${id} is the user's to write (the snippets are locked): comment on it with rft_comment {id: "${id}", quote, text}, or propose new text with rft_suggest {id: "${id}", quote, replacement}; the user accepts or rejects it`)
  }
  const h: Header = { id, kind: isKind(i.kind) ? i.kind : s.kind, title: i.title != null ? cleanTitle(i.title) || s.title : s.title, basis: i.basis ? basisIds(i.basis) : s.basis }
  let body = bodyAfterHeader(s.text)
  if (text) body = THEOREMS.includes(h.kind) || ['proof', 'figure', 'table'].includes(h.kind) || /^\\paragraph/.test(text) ? text : `\\paragraph{${h.title}}\n${text}`
  if (Array.isArray(i.edits)) {
    for (const e of i.edits as { old_str?: unknown; new_str?: unknown }[]) {
      const from = typeof e.old_str === 'string' ? e.old_str : ''
      const to = typeof e.new_str === 'string' ? e.new_str : ''
      const count = from ? body.split(from).length - 1 : 0
      if (count !== 1) throw new ManuscriptError(`an edit's old_str must be in ${id} exactly once (it is ${count} times): ${from.slice(0, 60)}`)
      body = body.replace(from, () => to)
    }
  }
  const next = headerText(h) + body.replace(/^\n+/, '').replace(/\n*$/, '\n')
  const problems = await macroProblems(io, loaded, next)
  if (problems.length) throw new ManuscriptError(`its macros name what no notebook saved:\n${problems.join('\n')}`)
  await io.write(join(vault, s.path), next)
  reg.snippets[id] = { ...reg.snippets[id], stamp: stampOf(loaded, basisOf({ basis: h.basis, text: next }, loaded).ids), written: date }
  await writeRegistry(io, vault, reg)
  const used = usedIn(ms, id).map(u => u.doc)
  const changed = contentFingerprint(contentOf(next)) !== contentFingerprint(contentOf(s.text))
  return `${id} written (${vault}/${s.path}), stamped with its basis as it is now.` +
    (used.length && changed ? ` Its copies in ${used.join(', ')} go to review: the user takes the new text there, or keeps theirs.` : '')
}

/** The user marks a snippet reviewed (the tree view's Reviewed): its stamp taken anew from its basis as it is now. */
export async function markReviewed(io: Io, loaded: Loaded, ref: string, date: string): Promise<string> {
  const ms = await readManuscript(io, loaded)
  const id = ref.trim().toUpperCase()
  const s = ms?.snippets.find(x => x.id === id)
  if (!ms || !s) throw new ManuscriptError(`${id} is no snippet`)
  ms.registry.snippets[id] = { ...ms.registry.snippets[id], stamp: stampOf(loaded, basisOf(s, loaded).ids), reviewed: date }
  await writeRegistry(io, loaded.config.vault, ms.registry)
  return `${id} reviewed: stamped with its basis as it is now.`
}

// ---------------------------------------------------------------- documents

/** Plain text as LaTeX prints it: its special characters escaped (a title typed in the tree view). */
export const texText = (s: string) =>
  s.replace(/[\\&%$#_{}~^]/g, c => ({ '\\': '\\textbackslash{}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' } as Record<string, string>)[c] ?? `\\${c}`)

/** A new document's main.tex: `article` (a paper) or `report` (a thesis chapter). */
export function documentTemplate(title: string, kind: 'article' | 'report'): string {
  return `\\documentclass[11pt]{${kind}}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb,amsthm}
\\usepackage{graphicx,booktabs}
\\usepackage[numbers]{natbib}
\\usepackage{rft}
\\usepackage{hyperref}

\\title{${title}}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle
${kind === 'report' ? `\n\\chapter{${title}}\n` : ''}
% Your text, and copies of snippets between % rft-begin and % rft-end lines: adapt a copy to the
% narrative as you like; when its snippet changes, the copy is flagged for review.

\\bibliographystyle{plainnat}
\\bibliography{refs}
\\end{document}
`
}

/** Starts the two levels with a first document, or adds a document. The answer says what was made. */
export async function newDocument(io: Io, loaded: Loaded, name: string, kind: 'article' | 'report' = 'article', title?: string): Promise<string> {
  const vault = loaded.config.vault
  const doc = name.trim().toLowerCase()
  if (!isDocumentName(doc)) throw new ManuscriptError('a document\'s name is lowercase letters, digits and dashes, e.g. paper or thesis-ch3')
  const path = documentRel(doc)
  if (await io.exists(join(vault, path))) throw new ManuscriptError(`there is already a document ${doc} (${vault}/${path})`)
  const started = !(await io.exists(join(vault, SNIPPETS_REGISTRY)))
  await ensureRegistries(io, loaded)
  await io.write(join(vault, path), documentTemplate(texText(title?.trim().replace(/\s+/g, ' ') || loaded.config.project), kind))
  return started
    ? `Started snippets (${vault}/${SNIPPETS_DIR}/) and documents (${vault}/${DOCUMENTS_DIR}/), both locked (you write them; Claude proposes snippets from verified notes and where to place them, comments and suggests), with the document ${doc} (${vault}/${path}).`
    : `Added the document ${doc} (${vault}/${path}).`
}

async function readBlocksFile(io: Io, vault: string, doc: string): Promise<Record<string, string>> {
  try {
    const d = JSON.parse(await io.read(join(vault, blocksRel(doc))))
    return d && typeof d === 'object' ? (d as Record<string, string>) : {}
  } catch { return {} }
}

/** Where a copy goes among a document's lines: after a copy (`S04`), after a heading whose title is `after`, else before the bibliography or the end. */
function insertionLine(lines: string[], blocks: Block[], after?: string): number {
  if (after?.trim()) {
    const a = after.trim()
    const b = blocks.find(x => x.id === a.toUpperCase())
    if (b) return b.end + 1
    const h = lines.findIndex(l => {
      const m = /^\s*\\(?:part|chapter|section|subsection|subsubsection)\*?\{(.*)\}\s*$/.exec(l)
      return m && m[1]!.trim().toLowerCase() === a.toLowerCase()
    })
    if (h >= 0) return h + 1
    throw new ManuscriptError(`"${a}" is neither a copy in this document nor one of its headings (rft_manuscript <document> shows its outline)`)
  }
  let at = lines.findIndex(l => /\\bibliographystyle|\\bibliography\{|\\printbibliography|\\end\{document\}/.test(l) && !l.trimStart().startsWith('%'))
  if (at < 0) at = lines.length
  while (at > 0 && !lines[at - 1]!.trim()) at--
  return at
}

/** `lines` with `block` (its lines) set in at `at`, a blank line on each side. */
function withBlockAt(lines: string[], at: number, block: string[]): string[] {
  const before = lines.slice(0, at), after = lines.slice(at)
  while (before.length && !before[before.length - 1]!.trim()) before.pop()
  while (after.length && !after[0]!.trim()) after.shift()
  return [...before, '', ...block, '', ...after]
}

/** `lines` with a copy's lines taken out, and the blank line it leaves. */
function withoutBlock(lines: string[], b: Block): string[] {
  const out = [...lines.slice(0, b.begin), ...lines.slice(b.end + 1)]
  if (b.begin > 0 && b.begin < out.length && !out[b.begin - 1]!.trim() && !out[b.begin]!.trim()) out.splice(b.begin, 1)
  return out
}

export type DocumentInput = { name?: string; place?: string; after?: string; move?: string; remove?: string }

/**
 * rft_set_document: a change to a document's structure the user agreed to. `place`: a copy of the
 * snippet's current text, stamped, after `after` (a copy or a heading) or before the bibliography;
 * `move`: a copy moved there, its text as it is; `remove`: a copy taken out.
 */
export async function setDocument(io: Io, loaded: Loaded, i: DocumentInput): Promise<string> {
  const ms = await readManuscript(io, loaded)
  if (!ms) throw new ManuscriptError('This vault has no snippets or documents yet: the user starts them with /rft-manuscript')
  const vault = loaded.config.vault
  const d = ms.documents.find(x => x.name === (i.name ?? '').trim())
  if (!d) throw new ManuscriptError(`"${i.name ?? ''}" is no document (${ms.documents.map(x => x.name).join(', ') || 'none yet'})`)
  const lines = d.text.split('\n')
  const snapshots = await readBlocksFile(io, vault, d.name)
  const one = (v: string | undefined) => (v ?? '').trim().toUpperCase()
  if (i.place) {
    const id = one(i.place)
    const s = ms.snippets.find(x => x.id === id)
    if (!s) throw new ManuscriptError(`${id} is no snippet`)
    if (d.blocks.some(b => b.id === id)) throw new ManuscriptError(`${d.name} already holds a copy of ${id}: move it instead`)
    const content = contentOf(s.text)
    const next = withBlockAt(lines, insertionLine(lines, d.blocks, i.after), blockText(id, contentFingerprint(content), content).split('\n'))
    await io.write(join(vault, d.path), next.join('\n'))
    await io.write(join(vault, blocksRel(d.name)), JSON.stringify({ ...snapshots, [id]: content }, null, 2) + '\n')
    return `Placed a copy of ${id} in ${d.name}${i.after ? ` after ${i.after}` : ''}. It is the document's now: the user may adapt it; when ${id} changes, the copy goes to review.`
  }
  const id = one(i.move || i.remove)
  if (!id) throw new ManuscriptError('say what to do: place, move or remove (a snippet id)')
  const b = d.blocks.find(x => x.id === id)
  if (!b) throw new ManuscriptError(`${d.name} holds no copy of ${id}`)
  const without = withoutBlock(lines, b)
  if (i.remove) {
    const rest = { ...snapshots }
    delete rest[id]
    await io.write(join(vault, d.path), without.join('\n'))
    await io.write(join(vault, blocksRel(d.name)), JSON.stringify(rest, null, 2) + '\n')
    return `Removed the copy of ${id} from ${d.name} (the snippet itself stays).`
  }
  if (i.after && one(i.after) === id) throw new ManuscriptError('a copy cannot go after itself')
  const next = withBlockAt(without, insertionLine(without, parseBlocks(without.join('\n')), i.after), lines.slice(b.begin, b.end + 1))
  await io.write(join(vault, d.path), next.join('\n'))
  return `Moved the copy of ${id} in ${d.name}${i.after ? ` after ${i.after}` : ' to the end'}.`
}

/**
 * The user answers a copy in review (the tree view): `take` the snippet's text now (the copy
 * replaced), or `keep` theirs (restamped to the snippet as it is now). Either way it is no longer
 * in review.
 */
export async function reviewCopy(io: Io, loaded: Loaded, name: string, ref: string, action: 'take' | 'keep'): Promise<string> {
  const ms = await readManuscript(io, loaded)
  const d = ms?.documents.find(x => x.name === name)
  const id = ref.trim().toUpperCase()
  const b = d?.blocks.find(x => x.id === id)
  const s = ms?.snippets.find(x => x.id === id)
  if (!ms || !d || !b) throw new ManuscriptError(`${name} holds no copy of ${id}`)
  if (!s) throw new ManuscriptError(`${id} is no snippet any more: remove its copy, or keep its text as the document's own`)
  const content = contentOf(s.text)
  const lines = d.text.split('\n')
  const block = blockText(id, contentFingerprint(content), action === 'take' ? content : b.content).split('\n')
  const vault = loaded.config.vault
  await io.write(join(vault, d.path), [...lines.slice(0, b.begin), ...block, ...lines.slice(b.end + 1)].join('\n'))
  await io.write(join(vault, blocksRel(d.name)), JSON.stringify({ ...(await readBlocksFile(io, vault, d.name)), [id]: content }, null, 2) + '\n')
  return action === 'take' ? `The copy of ${id} in ${name} now holds the snippet's text.` : `The copy of ${id} in ${name} is kept as it is, now answering to the snippet as it is.`
}

// ---------------------------------------------------------------- the first layout

/**
 * A vault started before the two levels (vault/manuscript/: snippets/, documents/, manuscript.json,
 * each document placing snippets by \rftsnippet lines) brought to them: the snippets and their
 * registry to snippets/, the documents to documents/, each \rftsnippet line made a copy of the
 * snippet. The old files are removed; null when there is nothing to bring.
 */
export async function migrateManuscript(io: Io, loaded: Loaded): Promise<string | null> {
  const vault = loaded.config.vault
  const old = join(vault, 'manuscript')
  if (!(await io.exists(join(old, 'manuscript.json'))) || (await io.exists(join(vault, SNIPPETS_REGISTRY)))) return null
  let reg: Record<string, unknown> = {}
  try { reg = JSON.parse(await io.read(join(old, 'manuscript.json'))) as Record<string, unknown> } catch { /* the defaults */ }
  const moved: string[] = []
  const contents: Record<string, string> = {}
  if (await io.exists(join(old, 'snippets'))) {
    for (const f of await io.list(join(old, 'snippets'))) {
      if (f.kind !== 'file' || !/^S\d+\.tex$/.test(f.name)) continue
      const text = await io.read(join(old, 'snippets', f.name))
      await io.write(join(vault, SNIPPETS_DIR, f.name), text)
      await io.remove(join(old, 'snippets', f.name))
      contents[f.name.slice(0, -4)] = contentOf(text)
      moved.push(f.name.slice(0, -4))
    }
  }
  await io.write(join(vault, SNIPPETS_REGISTRY), JSON.stringify({ locked: reg.locked !== false, next: reg.next ?? 1, snippets: reg.snippets ?? {}, unlocked: reg.unlocked ?? [] }, null, 2) + '\n')
  await writeDocsRegistry(io, vault, { locked: reg.locked !== false, unlocked: [] })
  const docs: string[] = []
  if (await io.exists(join(old, 'documents'))) {
    for (const f of await io.list(join(old, 'documents'))) {
      if (f.kind !== 'dir' || !isDocumentName(f.name) || !(await io.exists(join(old, 'documents', f.name, 'main.tex')))) continue
      const text = await io.read(join(old, 'documents', f.name, 'main.tex'))
      const snapshots: Record<string, string> = {}
      const next = text.split('\n').flatMap(l => {
        const m = /^\s*\\rftsnippet\{(S\d+)\}\s*$/.exec(l)
        const c = m ? contents[m[1]!] : undefined
        if (!m || c == null) return [l]
        snapshots[m[1]!] = c
        return blockText(m[1]!, contentFingerprint(c), c).split('\n')
      }).join('\n')
      await io.write(join(vault, documentRel(f.name)), next)
      await io.write(join(vault, blocksRel(f.name)), JSON.stringify(snapshots, null, 2) + '\n')
      await io.remove(join(old, 'documents', f.name, 'main.tex'))
      docs.push(f.name)
    }
  }
  await io.remove(join(old, 'manuscript.json'))
  for (const g of ['rft.sty', 'rft-numbers.tex', 'refs.bib']) if (await io.exists(join(old, g))) await io.remove(join(old, g))
  loaded.hasManuscript = true
  return `Brought the manuscript to two levels: snippets ${moved.join(', ') || '(none)'} in ${vault}/${SNIPPETS_DIR}/, documents ${docs.join(', ') || '(none)'} in ${vault}/${DOCUMENTS_DIR}/, each \\rftsnippet line now a copy of its snippet.`
}

// ---------------------------------------------------------------- for rft_next and rft_validate

/** What rft_next adds: the snippets in review, the copies in review, the stubs waiting for the user, the verified notes still to write. */
export async function manuscriptNext(io: Io, loaded: Loaded): Promise<string[]> {
  const ms = await readManuscript(io, loaded)
  if (!ms) return []
  const cites = citeIndex(loaded)
  const states = ms.snippets.map(s => [s, stateOf(s, loaded, ms.registry, cites)] as const)
  const review = states.filter(([, st]) => st.review.length).map(([s, st]) => `${s.id} (${st.review.join(', ')})`)
  const stubs = states.filter(([, st]) => st.stub && !st.review.length).map(([s]) => s.id)
  const byId = new Map(ms.snippets.map(s => [s.id, s]))
  const copies = ms.documents.map(d => [d.name, d.blocks.filter(b => copyState(b, byId.get(b.id)).state === 'review').map(b => b.id)] as const).filter(([, ids]) => ids.length)
  const todo = stillToWrite(loaded, ms, cites).map(n => n.id)
  return [
    review.length ? `Snippets in review (check their text against their notes): ${review.join('; ')}.` : '',
    copies.length ? `Copies in documents whose snippet changed since (the user takes the new text or keeps theirs): ${copies.map(([d, ids]) => `${d}: ${ids.join(', ')}`).join('; ')}.` : '',
    stubs.length ? `Stubs waiting for the user to write: ${stubs.join(', ')}.` : '',
    todo.length ? `Verified notes no snippet rests on yet (rft_manuscript): ${todo.join(', ')}.` : '',
  ].filter(Boolean)
}

/** What rft_validate adds: basis names that are no note, macros that name nothing saved, unknown citations, references with no BibTeX, copies of no snippet, references to snippets a document does not hold. */
export async function manuscriptWarnings(io: Io, loaded: Loaded): Promise<string[]> {
  const ms = await readManuscript(io, loaded)
  if (!ms) return []
  const cites = citeIndex(loaded)
  const out: string[] = []
  const vault = loaded.config.vault
  for (const s of ms.snippets) {
    if (!s.kind) out.push(`${s.path}: no header (% rft-snippet ${s.id} · <kind> · <title>, then % basis: <ids>)`)
    else if (!isKind(s.kind)) out.push(`${s.id}: kind "${s.kind}" is not one of ${KINDS.join(', ')}`)
    const st = stateOf(s, loaded, ms.registry, cites)
    if (st.missing.length) out.push(`${s.id}: its basis names no note of the tree: ${st.missing.join(', ')}`)
    if (!st.basis.length) out.push(`${s.id}: rests on no note (give it a % basis: line)`)
    for (const p of await macroProblems(io, loaded, s.text)) out.push(`${s.id}: ${p}`)
    const unknown = usesIn(bodyAfterHeader(s.text)).cites.filter(k => !cites[k])
    if (unknown.length) out.push(`${s.id}: cites what no reference note holds: ${unknown.join(', ')}`)
  }
  const byId = new Map(ms.snippets.map(s => [s.id, s]))
  for (const d of ms.documents) {
    const gone = d.blocks.filter(b => !byId.has(b.id)).map(b => b.id)
    if (gone.length) out.push(`${vault}/${d.path}: holds copies of snippets that do not exist: ${gone.join(', ')}`)
    const twice = d.blocks.map(b => b.id).filter((id, k, all) => all.indexOf(id) !== k)
    if (twice.length) out.push(`${vault}/${d.path}: holds more than one copy of ${[...new Set(twice)].join(', ')}`)
    const missing = refsMissing(d)
    if (missing.length) out.push(`${vault}/${d.path}: refers to snippets it holds no copy of: ${missing.join(', ')}`)
    for (const p of await macroProblems(io, loaded, d.text)) out.push(`${d.name}: ${p}`)
  }
  const cited = new Set([...ms.snippets.map(s => s.text), ...ms.documents.map(d => d.text)].flatMap(t => usesIn(t).cites).map(k => cites[k]).filter(Boolean))
  for (const id of cited) if (!/```bibtex\n/.test(loaded.texts[id!] ?? '')) out.push(`${id}: cited in a snippet or document but has no \`\`\`bibtex block in its Source (refs.bib gets a bare @misc for it)`)
  return out
}
