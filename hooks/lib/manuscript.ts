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
import type { Located, LocatedValue } from './copies'
import { bibFor, bibKeys, copyAt, locateCopies, locateValues, mainOf, readingOrder } from './copies'
import type { Trace } from './scan'
import { citedKeys, documentFiles, scanDocument, traceWords, tracesInText } from './scan'
import type { DocsRegistry, Header, Kind, Registry, Snippet } from './snippets'
import {
  DOCUMENTS_DIR, DOCUMENTS_REGISTRY, KINDS, ManuscriptError, SNIPPETS_DIR, SNIPPETS_REGISTRY, THEOREMS, blockText, blocksRel, bodyAfterHeader,
  contentFingerprint, contentOf, documentRel, headerText, isDocument, isDocumentLocked, isDocumentName, isKind, isSnippetLocked, listDocuments,
  listSnippets, readDocsRegistry, readRegistry, snippetRel, uncommented, writeDocsRegistry, writeRegistry,
} from './snippets'
import type { Engine, TrackedCopy, TrackedValue, Tracking } from './tracking'
import { parseTracking, readTracking, writeTracking } from './tracking'
import { TEMPLATES_DIR, TEMPLATE_NAME, builtInFiles, documentTemplate, isBuiltIn, templateFiles, templateSettings, templatesWords, texText, vaultTemplates } from './templates'
import { substanceFingerprint } from './verify'
import type { Held, Written } from './writeout'
import { figureRel, markedText, savedNumbers, tableRel, writeContext, writeOut, writeText } from './writeout'

export { ManuscriptError }

/** A document's files that are read as text: where copies, values and citations are. */
const TEXT_FILE = /\.(tex|ltx|bib)$/i
export const TEX_FILE = /\.(tex|ltx)$/i
const MAX_FILE = 2_000_000

export type Doc = {
  name: string
  /** Its main file, relative to the vault, and that file's text. */
  path: string
  text: string
  /** Its main file inside its folder (the one with \begin{document}, whatever its name; '' when it has no .tex file), and its .tex and .bib files by their path there. */
  main: string
  /** The files the user is asked to pick the main file from: several have \begin{document} and none is recorded. */
  mainAsked: string[]
  /** The .tex files the main file takes in, itself among them: a copy in any other file is not in the document. */
  included: Set<string>
  /** What compiles it, and the template it was made from. */
  engine: Engine
  template: string
  files: Record<string, string>
  /** Its other files (figures, classes, styles), by their path there. */
  others: string[]
  /** What ties it to the tree (tracking.ts), and its copies as they are found in its files (copies.ts). */
  tracking: Tracking
  copies: Located[]
  locked: boolean
}
export type Manuscript = { registry: Registry; docs: DocsRegistry; snippets: Snippet[]; documents: Doc[] }

/** The template a document made before templates is read as: the built-in one of its class, as its kind was. */
export const templateOf = (mainText: string) => (/\\documentclass(?:\[[^\]]*\])?\{report\}/.test(uncommented(mainText)) ? 'report' : 'article')

/** The engines as they are said. */
export const ENGINE_NAMES: Record<Engine, string> = { pdflatex: 'pdfLaTeX', xelatex: 'XeLaTeX', lualatex: 'LuaLaTeX' }

/** One document as it is on disk: its files, its tracking file, its main file, its copies found. */
export async function readDocument(io: Io, vault: string, name: string, locked: boolean): Promise<Doc | null> {
  const files: Record<string, string> = {}
  const others: string[] = []
  for (const f of await documentFiles(io, vault, name)) {
    let text: string | null = null
    if (TEXT_FILE.test(f.rel) && f.size <= MAX_FILE) {
      try { text = (await io.read(join(vault, DOCUMENTS_DIR, name, f.rel))).replace(/\r\n/g, '\n') } catch { text = null }
    }
    if (text === null) others.push(f.rel)
    else files[f.rel] = text
  }
  const tracking = await readTracking(io, vault, name)
  const { main, asked } = mainOf(files, tracking.main)
  const text = files[main] ?? ''
  return {
    name, path: `${DOCUMENTS_DIR}/${name}/${main || 'main.tex'}`, text, main, mainAsked: asked, included: readingOrder(files, main).included,
    engine: tracking.engine ?? 'pdflatex', template: tracking.template || templateOf(text), files, others, tracking, copies: locateCopies(files, tracking), locked,
  }
}

/** A document's main file, by its path inside the vault; null when `name` is no document or has none. */
export async function documentMain(io: Io, vault: string, name: string): Promise<string | null> {
  if (!(await isDocument(io, vault, name))) return null
  const d = await readDocument(io, vault, name, true)
  return d && d.main ? `${DOCUMENTS_DIR}/${name}/${d.main}` : null
}

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
    const d = await readDocument(io, vault, name, isDocumentLocked(docs, name))
    if (d) documents.push(d)
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

export type CopyState = 'lost' | 'gone' | 'review' | 'adapted' | 'placed'
export type Copy = { id: string; state: CopyState; snippetReview: boolean }

/**
 * A copy's state: `lost` when the plugin cannot find it in the document any more (its markers and
 * its text were changed elsewhere); `gone` when there is no such snippet; `review` when its
 * snippet's content no longer matches the stamp the copy answers to (the snippet changed since);
 * `adapted` when its text differs from the snippet written out (fitted to the narrative); else
 * `placed`. `snippetReview`: the snippet itself is in review (its notes changed), so the copy is
 * to be looked at too.
 */
export function copyState(c: Located, snippet: Snippet | undefined, snippetReview = false): Copy {
  if (!c.found) return { id: c.snippet, state: 'lost', snippetReview: false }
  if (!snippet) return { id: c.snippet, state: 'gone', snippetReview: false }
  if (contentFingerprint(contentOf(snippet.text)) !== c.stamp) return { id: c.snippet, state: 'review', snippetReview }
  return { id: c.snippet, state: contentFingerprint(c.content!) !== contentFingerprint(c.placed) ? 'adapted' : 'placed', snippetReview }
}

/** A copy's name in its document: its snippet's id, and its number among that snippet's copies when there are several (`S01#2`). */
export const copyName = (d: Pick<Doc, 'copies'>, c: Located) =>
  d.copies.filter(x => x.snippet === c.snippet).length > 1 ? `${c.snippet}#${c.nth}` : c.snippet

/** Where a snippet is used: per document and file, how many copies it has there, and their states. */
export type Use = { doc: string; file: string; count: number; states: CopyState[] }

/** The documents and files holding copies of a snippet (left out: a lost copy, which is nowhere, and one in a file the main file does not take in, which is not in the document). */
export function usedIn(ms: Manuscript, id: string): Use[] {
  const s = ms.snippets.find(x => x.id === id)
  const out: Use[] = []
  for (const d of ms.documents) {
    for (const c of d.copies) {
      if (c.snippet !== id || !c.found || !d.included.has(c.file)) continue
      let u = out.find(x => x.doc === d.name && x.file === c.file)
      if (!u) out.push((u = { doc: d.name, file: c.file, count: 0, states: [] }))
      u.count++
      u.states.push(copyState(c, s).state)
    }
  }
  return out
}

const stateNote = (s: CopyState) => (s === 'placed' ? '' : s === 'review' ? 'copy to review' : s)

function usedWords(u: Use[]): string {
  if (!u.length) return 'in no document'
  const docs = [...new Set(u.map(x => x.doc))]
  return `used in ${docs.map(doc => `${doc} (${u.filter(x => x.doc === doc).map(f => {
    const notes = [...new Set(f.states.map(stateNote).filter(Boolean))]
    return `${f.file}${f.count > 1 ? ` ×${f.count}` : ''}${notes.length ? `: ${notes.join(', ')}` : ''}`
  }).join(', ')})`).join('; ')}`
}

// ---------------------------------------------------------------- the tree's values in documents

export type ValueState = 'current' | 'review' | 'changed' | 'lost'
/**
 * A tracked value with its state: `current` when what was written still stands and the tree still
 * says it; `review` when the tree says something else now (`now`), or nothing; `changed` when
 * something else stands in the document (`inDocument`), so it is no longer the tree's; `lost`
 * when its place is not found.
 */
export type Value = LocatedValue & { state: ValueState; now: string | null; inCopyOf: string | null }

/** A saved figure's version, as both sides can tell it: its size and the second it was written; null when there is none. */
async function figureToken(io: Io, vault: string, from: string, key: string): Promise<string | null> {
  const f = (await io.list(join(vault, 'figures')).catch(() => [])).find(x => x.kind === 'file' && x.name === `${from}_${key}.pdf`)
  return f ? `${f.size}@${Math.floor(f.mtimeMs / 1000)}` : null
}

/** What the tree gives now for a value: a number's text, a table's tabular, a figure's version; null when it is no longer saved. */
export async function valueNow(io: Io, vault: string, v: Pick<TrackedValue, 'kind' | 'from' | 'key'>, numbers: Record<string, Record<string, string> | null> = {}): Promise<string | null> {
  if (v.kind === 'number') {
    const saved = v.from in numbers ? numbers[v.from]! : (numbers[v.from] = await savedNumbers(io, vault, v.from))
    return saved?.[v.key] ?? null
  }
  if (v.kind === 'figure') return figureToken(io, vault, v.from, v.key)
  try { return (await io.read(join(vault, tableRel(v.from, v.key)))).replace(/\r\n/g, '\n').trim() } catch { return null }
}

/** A document's tracked values, each found in its file and held against the tree as it is now. */
export async function valuesOf(io: Io, loaded: Loaded, d: Doc): Promise<Value[]> {
  const vault = loaded.config.vault
  const numbers: Record<string, Record<string, string> | null> = {}
  const out: Value[] = []
  for (const v of locateValues(d.files, d.tracking)) {
    const now = await valueNow(io, vault, v, numbers)
    let same = now === v.written
    // a figure is the tree's while the file the document has of it is the vault's
    if (v.kind === 'figure' && now !== null && v.found === 'written') {
      try { same = (await io.read(join(vault, DOCUMENTS_DIR, d.name, v.written))) === (await io.read(join(vault, figureRel(v.from, v.key)))) } catch { same = false }
    }
    const state: ValueState = !v.found ? 'lost' : v.found === 'changed' ? 'changed' : now !== null && (same || now === v.kept) ? 'current' : 'review'
    out.push({ ...v, state, now, inCopyOf: v.line === null ? null : copyAt(d.copies, v.file, v.line)?.snippet ?? null })
  }
  return out
}

/** A value in a few words: what it is, where it came from, where it stands. */
const valueWords = (v: Value) => `${v.kind === 'number' ? v.written : `the ${v.kind} ${v.key}`} in ${v.file}${v.line === null ? '' : `:${v.line + 1}`} (${v.from} ${v.key})`

/** What of a document's values the user is to look at: those the tree changed, those changed in the document, those not found. */
export function valueNotes(values: Value[]): string[] {
  const of = (s: ValueState) => values.filter(v => v.state === s)
  const out: string[] = []
  if (of('review').length) {
    out.push(`the tree changed since they were written: ${of('review').map(v => `${valueWords(v)}${v.kind === 'number' ? (v.now === null ? ', no longer saved' : `, now ${v.now}`) : v.now === null ? ', no longer saved' : ', saved again'}`).join('; ')}`)
  }
  if (of('changed').length) out.push(`changed in the document, no longer the tree's: ${of('changed').map(v => `${valueWords(v)}, now ${v.inDocument} there`).join('; ')}`)
  if (of('lost').length) out.push(`not found any more: ${of('lost').map(valueWords).join('; ')}`)
  return out
}

/** The entries of a document's .bib files: each key, its file, and the reference note it came from (null: the user's own). */
export function bibOf(d: Doc): { key: string; file: string; from: string | null }[] {
  return Object.keys(d.files).filter(f => /\.bib$/i.test(f)).sort()
    .flatMap(file => bibKeys(d.files[file]!).map(key => ({ key, file, from: d.tracking.bib[key]?.from ?? null })))
}

/** The citations of a document that rest on no reference note: each key cited in its .tex files whose entry, in one of its .bib files, is the user's own. Said in the page and to Claude, never written in the document. */
export function ownCited(d: Doc): { key: string; file: string; line: number }[] {
  const own = new Set(bibOf(d).filter(b => !b.from).map(b => b.key))
  const out: { key: string; file: string; line: number }[] = []
  if (!own.size) return out
  for (const file of Object.keys(d.files).filter(f => TEX_FILE.test(f)).sort()) {
    d.files[file]!.split('\n').forEach((l, i) => { for (const key of citedKeys(l)) if (own.has(key)) out.push({ key, file, line: i + 1 }) })
  }
  return out
}

/** The ids a document's files must not carry: the vault's notes and snippets. */
export const vaultIds = (loaded: Loaded, ms: Pick<Manuscript, 'snippets'>) => new Set([...Object.keys(loaded.tree.nodes), ...ms.snippets.map(s => s.id)])

/** The scan of a document for traces of the tree (scan.ts). */
export const tracesOf = (io: Io, loaded: Loaded, ms: Manuscript, d: Doc): Promise<{ traces: Trace[]; allowed: number }> =>
  scanDocument(io, loaded.config.vault, d.name, vaultIds(loaded, ms), new Set(Object.keys(citeIndex(loaded))))

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

/** A copy's state as a report says it. */
const copyWords = (c: Located, st: Copy) => [
  st.state === 'placed' ? '' : st.state === 'review' ? 'snippet changed since: to review' : st.state === 'gone' ? 'no such snippet'
    : st.state === 'lost' ? `lost: not found in ${c.file} any more` : st.state,
  c.found === 'text' ? 'its markers are gone' : '', st.snippetReview ? 'its snippet is in review' : '',
].filter(Boolean)

/** Said of a copy in a file the main file never takes in. */
const NOT_INCLUDED = 'not in the document: the main file does not take its file in'
const outside = (d: Pick<Doc, 'included'>, c: Located) => !!c.found && !d.included.has(c.file)

/** The copies of a document with their states, in a few words. */
function copiesWords(d: Doc, byId: Map<string, Snippet>, review: (id: string) => boolean): string {
  if (!d.copies.length) return 'no copies yet'
  return d.copies.map(c => {
    const notes = [c.found && c.file !== d.main ? c.file : '', outside(d, c) ? NOT_INCLUDED : '', ...copyWords(c, copyState(c, byId.get(c.snippet), review(c.snippet)))].filter(Boolean)
    return `${copyName(d, c)}${notes.length ? ` (${notes.join('; ')})` : ''}`
  }).join(', ')
}

/** A document's settings in a few words: its template, its main file, its engine. */
const settingsWords = (d: Doc) =>
  `template ${d.template}, main file ${d.main || 'none'}${d.mainAsked.length ? ` (the user has still to choose it among ${d.mainAsked.join(', ')})` : ''}, ${ENGINE_NAMES[d.engine]}`

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
    return documentReport(io, loaded, ms, d, states)
  }
  const byId = new Map(ms.snippets.map(s => [s.id, s]))
  const out = [`Snippets (${vault}/${SNIPPETS_DIR}/), the building blocks, ${snippetLock(ms.registry)}:`]
  for (const s of ms.snippets) {
    const st = states.get(s.id)!
    out.push(`  ${s.id} ${s.kind} · ${s.title} · ${stateWords(st)} · ${st.basis.join(', ') || 'no basis'} · ${usedWords(usedIn(ms, s.id))}`)
  }
  if (!ms.snippets.length) out.push('  none yet')
  out.push(`Documents (${vault}/${DOCUMENTS_DIR}/; each with its template, main file and engine), built from copies of snippets, ${docLock(ms.docs)}:`)
  for (const d of ms.documents) out.push(`  ${d.name} (${d.template}, ${d.main || 'no main file'}${d.mainAsked.length ? '?' : ''}, ${ENGINE_NAMES[d.engine]}): ${copiesWords(d, byId, id => !!states.get(id)?.review.length)}`)
  if (!ms.documents.length) out.push('  none yet')
  out.push(`Templates a document is made from (rft_set_document {name, template}, when the user asks for a document): ${await templatesWords(io, vault)}.`)
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

const HEADING_RE = /^\s*\\(part|chapter|section|subsection|subsubsection)\*?\{(.*)\}\s*$/

/** One document: its files, its outline in the order it is read (headings and copies with their state), its lost copies, its values to look at, its traces. */
async function documentReport(io: Io, loaded: Loaded, ms: Manuscript, d: Doc, states: Map<string, State>): Promise<string> {
  const byId = new Map(ms.snippets.map(s => [s.id, s]))
  const vault = loaded.config.vault
  const tex = Object.keys(d.files).filter(f => TEX_FILE.test(f))
  const order = readingOrder(d.files, d.main)
  const rest = [...Object.keys(d.files).filter(f => f !== d.main), ...d.others].sort()
  const out = [
    `${d.name} (${vault}/${DOCUMENTS_DIR}/${d.name}/, ${settingsWords(d)}): ${d.locked ? 'locked: its text is the user\'s' : 'unlocked: you may edit its .tex and .bib files'}.`,
    `Its files: ${[d.main, ...rest].filter(Boolean).join(', ') || 'none'}.`,
    'Its outline:',
  ]
  const items: { file: string; line: number; text: string }[] = []
  for (const file of tex) {
    const inCopy = (line: number) => !!copyAt(d.copies, file, line)
    d.files[file]!.split('\n').forEach((l, line) => {
      const h = HEADING_RE.exec(l)
      if (h && !inCopy(line)) items.push({ file, line, text: `${h[1] === 'subsection' || h[1] === 'subsubsection' ? '  ' : ''}§ ${h[2]}` })
    })
  }
  for (const c of d.copies) {
    if (!c.found) continue
    const s = byId.get(c.snippet)
    const st = copyState(c, s, !!states.get(c.snippet)?.review.length)
    items.push({ file: c.file, line: c.begin!, text: `  ${copyName(d, c)} ${s ? `${s.kind} · ${s.title}` : c.marker}: ${[st.state === 'placed' ? 'as the snippet' : '', outside(d, c) ? 'not in the document' : '', ...copyWords(c, st)].filter(Boolean).join('; ')}` })
  }
  let file = d.main
  for (const x of items.sort((a, b) => order.at(a.file, a.line) - order.at(b.file, b.line))) {
    if (x.file !== file) out.push(`${(file = x.file)}${order.included.has(file) ? '' : ' (the main file does not take it in)'}:`)
    out.push(x.text)
  }
  const lost = d.copies.filter(c => !c.found)
  if (lost.length) out.push(`Lost (the plugin cannot find them in the document any more; the user points to them again in the page, or drops them): ${lost.map(c => `${copyName(d, c)} ${c.marker} (was in ${c.file})`).join(', ')}.`)
  const notes = valueNotes(await valuesOf(io, loaded, d))
  if (notes.length) out.push(`Values of the tree written in it: ${notes.join('. ')}.`)
  const { traces } = await tracesOf(io, loaded, ms, d)
  if (traces.length) out.push(`Traces of the tree in its files, which are shared as they are (${traces.length}): ${traces.slice(0, 6).map(traceWords).join('; ')}${traces.length > 6 ? '; …' : ''}.`)
  const own = ownCited(d)
  if (own.length) out.push(`Cited from the user's own .bib entries, which rest on no reference note of the tree: ${[...new Set(own.map(o => o.key))].map(key => `${key} (${own.filter(o => o.key === key).map(o => `${o.file}:${o.line}`).join(', ')})`).join('; ')}.`)
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
  const used = [...new Set(usedIn(ms, id).map(u => u.doc))]
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

export { documentTemplate, texText }

/**
 * A new document, made from a template (templates.ts): a built-in one (`article`, `report`: a
 * main.tex with the title set in, and an empty refs.bib) or a folder of vault/templates/, every
 * file of which is copied as it is. The document records the template it was made from, its
 * engine when the template names one, and its main file when there is no doubt which it is. The
 * first document starts the two levels. The answer says what was made.
 */
export async function newDocument(io: Io, loaded: Loaded, name: string, template = 'article', title?: string): Promise<string> {
  const vault = loaded.config.vault
  const doc = name.trim().toLowerCase()
  if (!isDocumentName(doc)) throw new ManuscriptError('a document\'s name is lowercase letters, digits and dashes, e.g. paper or thesis-ch3')
  const folder = `${DOCUMENTS_DIR}/${doc}`
  if (await io.exists(join(vault, folder))) throw new ManuscriptError(`there is already a document ${doc} (${vault}/${folder}/)`)
  const t = template.trim() || 'article'
  const tracking = parseTracking(null)
  tracking.template = t
  let made: string[]
  if (isBuiltIn(t)) {
    const files = builtInFiles(t, title?.trim().replace(/\s+/g, ' ') || loaded.config.project)
    made = Object.keys(files)
    for (const f of made) await io.write(join(vault, folder, f), files[f]!)
    tracking.main = 'main.tex'
  } else {
    if (!TEMPLATE_NAME.test(t) || !(await vaultTemplates(io, vault)).includes(t)) throw new ManuscriptError(`"${t}" is no template: a document is made from ${await templatesWords(io, vault)}`)
    made = await templateFiles(io, vault, t)
    if (!made.length) throw new ManuscriptError(`the template ${t} (${vault}/${TEMPLATES_DIR}/${t}/) has no file`)
    const texts: Record<string, string> = {}
    for (const f of made) {
      await copyIn(io, join(vault, TEMPLATES_DIR, t, f), join(vault, folder, f))
      if (TEX_FILE.test(f)) { try { texts[f] = await io.read(join(vault, TEMPLATES_DIR, t, f)) } catch { /* not text: not a main file */ } }
    }
    const settings = await templateSettings(io, vault, t)
    if (settings.engine) tracking.engine = settings.engine
    const { main, asked } = mainOf(texts, settings.main ?? '')
    if (main && !asked.length) tracking.main = main
  }
  const started = !(await io.exists(join(vault, SNIPPETS_REGISTRY)))
  await ensureRegistries(io, loaded)
  await writeTracking(io, vault, doc, tracking)
  const what = `the document ${doc} (${vault}/${folder}/, from the template ${t}: ${made.length} file${made.length === 1 ? '' : 's'}${tracking.main ? `, main file ${tracking.main}` : ', its main file still to choose in the page'})`
  return started
    ? `Started snippets (${vault}/${SNIPPETS_DIR}/) and documents (${vault}/${DOCUMENTS_DIR}/), both locked (you write them; Claude proposes snippets from verified notes and where to place them, comments and suggests), with ${what}.`
    : `Added ${what}.`
}

const COPY_REF = /^(S\d+)(?:#(\d+))?$/
const END_OF_DOC = /\\bibliographystyle|\\bibliography\{|\\printbibliography|\\end\{document\}/
/** How much of the text before and after a value its tracking keeps, to find it again. */
const CONTEXT = 28

type Holding = Pick<Doc, 'name' | 'main' | 'files' | 'copies'>

/** A document that has no .tex file takes no copy. */
const NO_MAIN = (name: string) => `${name} has no .tex file yet: the user makes its main file (the one with \\begin{document}) in the page first`

/** The copy a reference names in a document: `S04`, or `S04#2` when the document holds several of S04. */
export function findCopy(d: Holding, ref: string): Located {
  const m = COPY_REF.exec(ref.trim().toUpperCase())
  if (!m) throw new ManuscriptError(`"${ref}" names no copy: give a snippet's id (S04), or S04#2 for its second copy in the document`)
  const all = d.copies.filter(c => c.snippet === m[1])
  if (!all.length) throw new ManuscriptError(`${d.name} holds no copy of ${m[1]}`)
  const c = m[2] ? all.find(x => x.nth === Number(m[2])) : all.length === 1 ? all[0] : undefined
  if (c) return c
  throw new ManuscriptError(`${d.name} holds ${all.length} ${all.length === 1 ? 'copy' : 'copies'} of ${m[1]}: name one, ${all.map(x => `${m[1]}#${x.nth} (${x.found ? x.file : 'lost'})`).join(', ')}`)
}

function found(d: Holding, c: Located): Located & { found: 'markers' | 'text'; begin: number; end: number; content: string } {
  if (!c.found) throw new ManuscriptError(`the copy of ${c.snippet} in ${d.name} is lost: the plugin cannot find it in ${c.file} any more. The user points to it again in the page, or drops it`)
  return c as never
}

/** Where a copy goes: after a copy, after a heading whose title is `after`, else before the bibliography or at the end of `file` (the main file by default). */
function insertion(d: Holding, i: { file?: string; after?: string }, copyOf: (ref: string) => Located = ref => findCopy(d, ref)): { file: string; line: number } {
  const tex = Object.keys(d.files).filter(f => TEX_FILE.test(f))
  const file = i.file?.trim().replace(/^\.\//, '') || undefined
  if (file && !tex.includes(file)) throw new ManuscriptError(`${d.name} has no file ${file} to place a copy in (its .tex files: ${tex.join(', ')})`)
  const after = i.after?.trim()
  if (after && COPY_REF.test(after.toUpperCase())) {
    const c = found(d, copyOf(after))
    if (file && file !== c.file) throw new ManuscriptError(`the copy ${after} is in ${c.file}, not in ${file}`)
    return { file: c.file, line: c.end + 1 }
  }
  if (after) {
    const order = readingOrder(d.files, d.main)
    for (const f of file ? [file] : tex.sort((a, b) => order.at(a, 0) - order.at(b, 0))) {
      const h = d.files[f]!.split('\n').findIndex(l => HEADING_RE.exec(l)?.[2]!.trim().toLowerCase() === after.toLowerCase())
      if (h >= 0) return { file: f, line: h + 1 }
    }
    throw new ManuscriptError(`"${after}" is neither a copy in ${d.name} nor one of its headings${file ? ` in ${file}` : ''} (rft_manuscript ${d.name} shows its outline)`)
  }
  if (d.files[file ?? d.main] === undefined) throw new ManuscriptError(NO_MAIN(d.name))
  const lines = d.files[file ?? d.main]!.split('\n')
  let at = lines.findIndex(l => END_OF_DOC.test(l) && !l.trimStart().startsWith('%'))
  if (at < 0) at = lines.length
  while (at > 0 && !lines[at - 1]!.trim()) at--
  return { file: file ?? d.main, line: at }
}

/** `lines` with `block` (its lines) set in at `at`, a blank line on each side. */
function withBlockAt(lines: string[], at: number, block: string[]): string[] {
  const before = lines.slice(0, at), after = lines.slice(at)
  while (before.length && !before[before.length - 1]!.trim()) before.pop()
  while (after.length && !after[0]!.trim()) after.shift()
  return [...before, ...(before.length ? [''] : []), ...block, '', ...after]
}

/** `lines` with those from `begin` to `end` taken out, and the blank line they leave. */
function withoutLines(lines: string[], begin: number, end: number): string[] {
  const out = [...lines.slice(0, begin), ...lines.slice(end + 1)]
  if (begin > 0 && begin < out.length && !out[begin - 1]!.trim() && !out[begin]!.trim()) out.splice(begin, 1)
  return out
}

/** A change to a document being made: its files and its tracking as they will be, the files to write and to delete. */
type Work = { files: Record<string, string>; tracking: Tracking; touched: Set<string>; removed: string[] }
const workOn = (d: Doc): Work => {
  const tracking = JSON.parse(JSON.stringify(d.tracking)) as Tracking
  // the main file is recorded with the first thing written, once there is no doubt which it is
  if ((!tracking.main || d.files[tracking.main] === undefined) && !d.mainAsked.length) tracking.main = d.main
  return { files: { ...d.files }, tracking, touched: new Set(), removed: [] }
}

async function save(io: Io, vault: string, d: Doc, w: Work): Promise<void> {
  for (const f of w.touched) await io.write(join(vault, DOCUMENTS_DIR, d.name, f), w.files[f]!)
  for (const f of w.removed) await io.remove(join(vault, DOCUMENTS_DIR, d.name, f)).catch(() => undefined)
  await writeTracking(io, vault, d.name, w.tracking)
}

/** The labels a document's files define, those of one copy left out. */
function labelsIn(d: Doc, except?: Located): string[] {
  const out: string[] = []
  for (const [file, text] of Object.entries(d.files)) {
    if (!TEX_FILE.test(file)) continue
    uncommented(text).split('\n').forEach((l, k) => {
      if (except?.found && except.file === file && k >= except.begin! && k <= except.end!) return
      for (const m of l.matchAll(/\\label\{([^}]*)\}/g)) out.push(m[1]!.trim())
    })
  }
  return out
}

/** The tracked values that stand inside a copy, by their place in the tracking file. */
const valuesInside = (d: Doc, c: Located): number[] =>
  !c.found ? [] : locateValues(d.files, d.tracking).filter(v => v.file === c.file && v.line !== null && v.line >= c.begin! && v.line <= c.end!).map(v => v.index)

/** What the document already has, for a snippet written out into it; `except`: the copy being written again, whose own labels and figures do not count. */
function heldOf(d: Doc, except?: Located): Held {
  const files: Record<string, string> = Object.fromEntries(d.others.map(f => [f, '']))
  const own = new Set(except ? valuesInside(d, except) : [])
  d.tracking.values.forEach((v, k) => { if (v.kind === 'figure' && !own.has(k)) files[v.written] = `${v.from} ${v.key}` })
  // a figure only this copy uses is written again in its place
  d.tracking.values.forEach((v, k) => { if (v.kind === 'figure' && own.has(k) && files[v.written] === '') delete files[v.written] })
  return { labels: labelsIn(d, except), files }
}

/** The values a snippet written out brings, as a document's tracking keeps them: each with the text before and after it. */
const trackedValues = (w: Written, file: string): TrackedValue[] => w.values.map(v => ({
  kind: v.kind, from: v.from, key: v.key, written: v.written, file,
  before: w.text.slice(Math.max(0, v.at - CONTEXT), v.at), after: w.text.slice(v.at + v.written.length, v.at + v.written.length + CONTEXT),
}))

/**
 * The .bib the entries brought into a file go in (bibFor in copies.ts): the one that file uses.
 * When the document has several and nothing says which, the one the user picked in the page
 * (`chosen`), remembered for that file; refused, with the choices, when there is no such pick.
 */
function bibOfFile(w: Work, d: Pick<Doc, 'name' | 'main'>, file: string, chosen?: string): string {
  const r = bibFor(w.files, d.main, file, w.tracking.bibOf ?? {})
  if ('bib' in r) return r.bib
  const pick = chosen?.trim()
  if (pick && r.ask.includes(pick)) {
    w.tracking.bibOf = { ...(w.tracking.bibOf ?? {}), [file]: pick }
    return pick
  }
  throw new ManuscriptError(`${d.name} has several .bib files (${r.ask.join(', ')}) and nothing in ${file}, nor in the files that take it in, says which one it uses: ` +
    (pick ? `"${pick}" is not one of them` : 'the user places it from the page once, which asks which and remembers it (or gives the chapter its own \\bibliography line)'))
}

/** The entries a written-out snippet cites, added to the .bib its file uses when that .bib does not have their key yet, and tracked. */
function addEntries(w: Work, d: Pick<Doc, 'name' | 'main'>, entries: Written['bib'], file: string, chosen?: string): void {
  if (!entries.length) return
  const bib = bibOfFile(w, d, file, chosen)
  let text = w.files[bib] ?? ''
  const have = new Set(bibKeys(text))
  for (const e of entries) {
    if (have.has(e.key)) continue // there already: the user's own entry of that key stays theirs, and none is added twice
    text = `${text.replace(/\s+$/, '')}${text.trim() ? '\n\n' : ''}${e.entry}\n`
    have.add(e.key)
    // a bibliography per chapter: the same entry may stand in several .bib files of the document
    const tracked = w.tracking.bib[e.key]
    if (!tracked) w.tracking.bib[e.key] = { from: e.from, file: bib }
    else if (tracked.file !== bib && !(tracked.also ?? []).includes(bib)) tracked.also = [...(tracked.also ?? []), bib]
  }
  if (text !== (w.files[bib] ?? '')) { w.files[bib] = text; w.touched.add(bib) }
}

/** A .bib text without the entry of `key`. */
function withoutEntry(bib: string, key: string): string {
  const m = new RegExp(`^[ \\t]*@\\w+\\s*\\{\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*,`, 'm').exec(bib)
  if (!m) return bib
  let depth = 0, k = bib.indexOf('{', m.index)
  for (; k < bib.length; k++) {
    if (bib[k] === '{') depth++
    else if (bib[k] === '}' && --depth === 0) break
  }
  return (bib.slice(0, m.index).replace(/\s+$/, '') + '\n\n' + bib.slice(k + 1).replace(/^\s+/, '')).replace(/^\s+/, '').replace(/\s+$/, '') + '\n'
}

/** What nothing of the document uses any more is taken out: an entry the plugin added and no file cites, a figure it copied in and no file includes. */
function dropUnused(w: Work, d: Doc): void {
  const tex = Object.entries(w.files).filter(([f]) => TEX_FILE.test(f)).map(([, text]) => text)
  const cited = new Set(tex.flatMap(citedKeys))
  for (const [key, e] of Object.entries(w.tracking.bib)) {
    if (cited.has(key) || cited.has('*')) continue
    for (const file of [e.file, ...(e.also ?? [])]) {
      const next = w.files[file] === undefined ? undefined : withoutEntry(w.files[file]!, key)
      if (next !== undefined && next !== w.files[file]) { w.files[file] = next; w.touched.add(file) }
    }
    delete w.tracking.bib[key]
  }
  const still = new Set(w.tracking.values.filter(v => v.kind === 'figure').map(v => v.written))
  for (const v of d.tracking.values) {
    if (v.kind !== 'figure' || still.has(v.written) || w.removed.includes(v.written) || !d.others.includes(v.written)) continue
    if (!tex.some(text => uncommented(text).includes(v.written))) w.removed.push(v.written)
  }
}

/** A file copied as it is; through the text when the io has no copy of its own. */
const copyIn = async (io: Io, from: string, to: string) => (io.copy ? io.copy(from, to) : io.write(to, await io.read(from)))

/** A copy's lines set in a file at a line, and its entry in the tracking file where the document's order puts it. */
function putCopy(w: Work, main: string, entry: TrackedCopy, block: string[], at: { file: string; line: number }): void {
  const order = readingOrder(w.files, main)
  const rank = order.at(at.file, at.line)
  const next = locateCopies(w.files, w.tracking).find(c => c.found && order.at(c.file, c.begin!) >= rank)
  w.files[at.file] = withBlockAt(w.files[at.file]!.split('\n'), at.line, block).join('\n')
  w.touched.add(at.file)
  w.tracking.copies.splice(next ? next.index : w.tracking.copies.length, 0, { ...entry, file: at.file })
}

/** A snippet written out into a document: its files copied in, its entries added, its values tracked in `file`. */
async function bring(io: Io, vault: string, d: Doc, w: Work, out: Written, file: string, bib?: string): Promise<void> {
  w.tracking.values.push(...trackedValues(out, file))
  addEntries(w, d, out.bib, file, bib) // first: it refuses when the user is still to say which .bib, before anything is copied in
  for (const f of out.files) await copyIn(io, join(vault, f.from), join(vault, DOCUMENTS_DIR, d.name, f.to))
}

const broughtWords = (out: Written) => [
  out.files.length ? `${out.files.map(f => f.to).join(', ')} copied in` : '',
  out.bib.length ? `${out.bib.map(b => b.key).join(', ')} in its .bib` : '',
].filter(Boolean).join('; ')

export type DocumentInput = { name?: string; place?: string; file?: string; after?: string; move?: string; remove?: string; template?: string; bib?: string }

/**
 * rft_set_document: a change to a document's structure the user agreed to. `place`: the snippet
 * written out as plain LaTeX between two marker lines, in `file` (the main file by default), after
 * `after` (a copy or a heading) or before the bibliography; its figures copied into the document,
 * its entries added to the document's .bib, the copy and its values recorded in the tracking file.
 * `move`: a copy moved there, its text as it is. `remove`: a copy taken out, with what only it used.
 * `template`, with a name no document has: the document made from that template (newDocument).
 */
export async function setDocument(io: Io, loaded: Loaded, i: DocumentInput): Promise<string> {
  const ms = await readManuscript(io, loaded)
  if (!ms) throw new ManuscriptError('This vault has no snippets or documents yet: the user starts them with /rft-manuscript')
  const vault = loaded.config.vault
  const d = ms.documents.find(x => x.name === (i.name ?? '').trim())
  // a template makes the document, when the user asked for one
  if (i.template?.trim()) {
    if (d) throw new ManuscriptError(`there is already a document ${d.name}: a template makes a new one (to add a template's files to it, the user uses the page)`)
    if (i.place || i.move || i.remove) throw new ManuscriptError('make the document first (name, template), then place copies in it')
    return newDocument(io, loaded, i.name ?? '', i.template)
  }
  if (!d) throw new ManuscriptError(`"${i.name ?? ''}" is no document (${ms.documents.map(x => x.name).join(', ') || 'none yet'}); with a template (${await templatesWords(io, vault)}) rft_set_document makes it, when the user asked for one`)
  const w = workOn(d)
  const where = (at: { file: string }) => `${at.file !== d.main ? ` (${at.file})` : ''}${i.after ? ` after ${i.after}` : ''}`
  if (i.place) {
    const id = i.place.trim().toUpperCase()
    const s = ms.snippets.find(x => x.id === id)
    if (!s) throw new ManuscriptError(`${id} is no snippet`)
    const at = insertion(d, i)
    const out = await writeOut(io, loaded, s, ms.snippets, vaultIds(loaded, ms), heldOf(d))
    putCopy(w, d.main, { snippet: id, marker: out.marker, file: at.file, stamp: contentFingerprint(contentOf(s.text)), placed: out.text }, markedText(out.marker, out.text).split('\n'), at)
    await bring(io, vault, d, w, out, at.file, i.bib)
    await save(io, vault, d, w)
    const n = d.copies.filter(c => c.snippet === id).length + 1
    return `Placed a copy of ${id} in ${d.name}${where(at)}, written out as plain LaTeX${broughtWords(out) ? ` (${broughtWords(out)})` : ''}. It is the document's now: the user may adapt it; when ${id} changes, the copy goes to review.` +
      (n > 1 ? ` ${d.name} now holds ${n} copies of ${id}: ${id}#1 to ${id}#${n}.` : '')
  }
  const ref = (i.move || i.remove || '').trim()
  if (!ref) throw new ManuscriptError('say what to do: place, move or remove (a snippet id)')
  const lost = findCopy(d, ref)
  const name = copyName(d, lost)
  if (i.remove && !lost.found) {
    w.tracking.copies.splice(lost.index, 1)
    await save(io, vault, d, w)
    return `Dropped the lost copy of ${name} from ${d.name}: it is no longer tracked (the snippet itself stays).`
  }
  const c = found(d, lost)
  const lines = w.files[c.file]!.split('\n')
  const block = c.found === 'markers' ? lines.slice(c.begin, c.end + 1) : markedText(c.marker, c.content).split('\n')
  const inside = valuesInside(d, c)
  w.files[c.file] = withoutLines(lines, c.begin, c.end).join('\n')
  w.touched.add(c.file)
  const [entry] = w.tracking.copies.splice(c.index, 1)
  if (i.remove) {
    w.tracking.values = w.tracking.values.filter((_, k) => !inside.includes(k))
    dropUnused(w, d)
    await save(io, vault, d, w)
    return `Removed the copy of ${name} from ${d.name} (the snippet itself stays).`
  }
  // the document without the copy: `after` names a copy as the user saw it, before this one was taken out
  const rest: Holding = { name: d.name, main: d.main, files: w.files, copies: locateCopies(w.files, w.tracking) }
  const at = insertion(rest, i, r => {
    const a = findCopy(d, r)
    if (a.index === c.index) throw new ManuscriptError('a copy cannot go after itself')
    return rest.copies[a.index > c.index ? a.index - 1 : a.index]!
  })
  putCopy(w, d.main, entry!, block, at)
  for (const k of inside) w.tracking.values[k]!.file = at.file
  await save(io, vault, d, w)
  return `Moved the copy of ${name} in ${d.name}${where(at) || ' to the end'}.`
}

/**
 * The user answers a copy in review (the tree view): `take` the snippet's text now (the copy
 * written out again in its place), or `keep` theirs (it answers to the snippet as it is now).
 * Either way it is no longer in review.
 */
export async function reviewCopy(io: Io, loaded: Loaded, name: string, ref: string, action: 'take' | 'keep', bib?: string): Promise<string> {
  const ms = await readManuscript(io, loaded)
  const d = ms?.documents.find(x => x.name === name)
  if (!ms || !d) throw new ManuscriptError(`"${name}" is no document`)
  const c = found(d, findCopy(d, ref))
  const s = ms.snippets.find(x => x.id === c.snippet)
  if (!s) throw new ManuscriptError(`${c.snippet} is no snippet any more: remove its copy, or keep its text as the document's own`)
  const vault = loaded.config.vault
  const w = workOn(d)
  const stamp = contentFingerprint(contentOf(s.text))
  const out = await writeOut(io, loaded, s, ms.snippets, vaultIds(loaded, ms), heldOf(d, c))
  const words = copyName(d, c)
  if (action === 'keep') {
    const same = contentFingerprint(c.content) === contentFingerprint(out.text)
    w.tracking.copies[c.index] = { snippet: c.snippet, marker: c.marker, file: c.file, stamp, placed: out.text, ...(same ? {} : { seen: c.content }) }
    await save(io, vault, d, w)
    return `The copy of ${words} in ${name} is kept as it is, now answering to the snippet as it is.`
  }
  const inside = valuesInside(d, c)
  const lines = w.files[c.file]!.split('\n')
  w.files[c.file] = [...lines.slice(0, c.begin), ...markedText(out.marker, out.text).split('\n'), ...lines.slice(c.end + 1)].join('\n')
  w.touched.add(c.file)
  w.tracking.copies[c.index] = { snippet: c.snippet, marker: out.marker, file: c.file, stamp, placed: out.text }
  w.tracking.values = w.tracking.values.filter((_, k) => !inside.includes(k))
  await bring(io, vault, d, w, out, c.file, bib)
  dropUnused(w, d)
  await save(io, vault, d, w)
  return `The copy of ${words} in ${name} now holds the snippet's text, written out as plain LaTeX.`
}

/**
 * The user answers a tracked value (the tree view): `take` the tree's (the number or the tabular
 * written in its place, the figure's file copied again), or `keep` theirs (what stands in the
 * document is theirs: it is not flagged again until the tree says something else). A value whose
 * place is lost, or that the tree no longer saves, is no longer tracked once kept.
 */
export async function reviewValue(io: Io, loaded: Loaded, name: string, index: number, action: 'take' | 'keep'): Promise<string> {
  const ms = await readManuscript(io, loaded)
  const d = ms?.documents.find(x => x.name === name)
  if (!ms || !d) throw new ManuscriptError(`"${name}" is no document`)
  const v = (await valuesOf(io, loaded, d)).find(x => x.index === index)
  if (!v) throw new ManuscriptError(`${name} tracks no such value`)
  const vault = loaded.config.vault
  const w = workOn(d)
  const what = `${v.kind === 'number' ? `the number ${v.from} ${v.key}` : `the ${v.kind} ${v.key} of ${v.from}`} in ${name} (${v.file})`
  if (action === 'keep') {
    if (!v.found || v.now === null) {
      w.tracking.values.splice(index, 1)
      await save(io, vault, d, w)
      return `${what} is no longer tracked: what stands there is the document's own.`
    }
    w.tracking.values[index] = { ...w.tracking.values[index]!, ...(v.kind === 'figure' ? {} : { written: v.inDocument! }), kept: v.now }
    await save(io, vault, d, w)
    return `${what} is kept as it is; it is flagged again when the tree says something else.`
  }
  if (!v.found) throw new ManuscriptError(`${what} is not found in the document any more: keep it (it is then no longer tracked), or write it again`)
  if (v.now === null) throw new ManuscriptError(`${v.from} no longer saves ${v.key}: keep what the document has (it is then no longer tracked)`)
  const entry = { ...w.tracking.values[index]! }
  delete entry.kept
  if (v.kind === 'figure') {
    await copyIn(io, join(vault, figureRel(v.from, v.key)), join(vault, DOCUMENTS_DIR, d.name, v.written))
  } else {
    const text = w.files[v.file]!
    w.files[v.file] = text.slice(0, v.offset!) + v.now + text.slice(v.offset! + v.inDocument!.length)
    w.touched.add(v.file)
    // the copy it stands in answers to the snippet written out with the tree's value: taking it does not make the copy adapted
    const c = v.line === null ? null : copyAt(d.copies, v.file, v.line)
    if (c) {
      const tracked = w.tracking.copies[c.index]!
      for (const field of ['placed', 'seen'] as const) {
        const own = tracked[field]
        const at = own === undefined ? null : locateValues({ x: own }, { values: [{ ...entry, file: 'x' }] })[0]!
        if (own !== undefined && at?.found === 'written') tracked[field] = own.slice(0, at.offset!) + v.now + own.slice(at.offset! + entry.written.length)
      }
    }
    entry.written = v.now
  }
  w.tracking.values[index] = entry
  await save(io, vault, d, w)
  return v.kind === 'figure' ? `${what} is the tree's again: its file was copied in anew.` : `${what} now reads ${v.kind === 'number' ? v.now : 'as the tree has it'}.`
}

/**
 * The user inserts something of the tree at the cursor of a document's file (the tree view),
 * outside any copy: a note's saved number, figure or table, or a citation of a reference note,
 * written out as plain LaTeX and tracked as a copy's values are, so a number in the abstract is
 * watched too. `line` from 1, `ch` from 0.
 */
export async function insertFromTree(
  io: Io, loaded: Loaded, name: string, at: { file: string; line: number; ch: number },
  what: { kind: 'number' | 'figure' | 'table' | 'citation'; from: string; key?: string }, bib?: string,
): Promise<string> {
  const ms = await readManuscript(io, loaded)
  const d = ms?.documents.find(x => x.name === name)
  if (!ms || !d) throw new ManuscriptError(`"${name}" is no document`)
  const text = d.files[at.file]
  if (text === undefined || !TEX_FILE.test(at.file)) throw new ManuscriptError(`${name} has no .tex file ${at.file}`)
  const id = resolveId(loaded.tree, what.from) ?? what.from.trim()
  if (!loaded.tree.nodes[id]) throw new ManuscriptError(`"${what.from}" is not a note of the tree`)
  const key = (what.key ?? '').trim()
  if (what.kind !== 'citation' && (!key || /[{}]/.test(key))) throw new ManuscriptError(`say which ${what.kind} of ${id}`)
  const source = what.kind === 'number' ? `\\rftnum{${id}}{${key}}` : what.kind === 'figure' ? `\\rftfig[width=\\linewidth]{${id}}{${key}}`
    : what.kind === 'table' ? `\\rfttable{${id}}{${key}}` : `\\cite{${id}}`
  if (what.kind === 'citation' && loaded.tree.nodes[id]!.type !== 'reference') throw new ManuscriptError(`${id} is not a reference note: only a reference is cited`)
  const lines = text.split('\n')
  const line = Math.floor(at.line) - 1
  if (!(line >= 0 && line < lines.length)) throw new ManuscriptError(`line ${at.line} is not in ${at.file}`)
  const ch = Math.max(0, Math.min(Math.floor(at.ch) || 0, lines[line]!.length))
  const offset = lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0) + ch
  const out = await writeText(io, loaded, source, ms.snippets, writeContext(loaded, heldOf(d)))
  const traces = tracesInText(out.text, vaultIds(loaded, ms))
  if (traces.length) throw new ManuscriptError(`written out, it would carry a trace of the tree (${traces.map(x => x.match).join(', ')}): a document's files must not`)
  const vault = loaded.config.vault
  const w = workOn(d)
  const next = text.slice(0, offset) + out.text + text.slice(offset)
  w.files[at.file] = next
  w.touched.add(at.file)
  // each value with the text now around it in the file, which finds it again
  for (const v of out.values) {
    const from = offset + v.at, to = from + v.written.length
    w.tracking.values.push({ kind: v.kind, from: v.from, key: v.key, written: v.written, file: at.file, before: next.slice(Math.max(0, from - CONTEXT), from), after: next.slice(to, to + CONTEXT) })
  }
  addEntries(w, d, out.bib, at.file, bib)
  for (const f of out.files) await copyIn(io, join(vault, f.from), join(vault, DOCUMENTS_DIR, d.name, f.to))
  await save(io, vault, d, w)
  return what.kind === 'citation' ? `Cited ${id} in ${name} (${at.file}:${at.line}) as ${out.text}${broughtWords({ ...out, marker: '' }) ? ` (${broughtWords({ ...out, marker: '' })})` : ''}.`
    : `Wrote the ${what.kind} ${key} of ${id} in ${name} (${at.file}:${at.line})${what.kind === 'number' ? `: ${out.text}` : ''}${out.files.length ? ` (${out.files.map(f => f.to).join(', ')} copied in)` : ''}; it is watched: when the tree changes it, it goes to review.`
}

/** The user allows one occurrence the scan flagged (a false alarm: "Table S01" of a supplement): remembered in the tracking file, not flagged again. */
export async function allowTrace(io: Io, loaded: Loaded, name: string, t: { file: string; match: string; text: string }): Promise<string> {
  const ms = await readManuscript(io, loaded)
  const d = ms?.documents.find(x => x.name === name)
  if (!ms || !d) throw new ManuscriptError(`"${name}" is no document`)
  const { traces } = await tracesOf(io, loaded, ms, d)
  if (!traces.some(x => x.file === t.file && x.match === t.match && x.text === t.text)) throw new ManuscriptError(`${name} has no such trace to allow (it may have changed since: look again)`)
  const w = workOn(d)
  w.tracking.allowed.push({ file: t.file, match: t.match, text: t.text })
  await save(io, loaded.config.vault, d, w)
  return `Allowed ${t.match} in ${name} (${t.file}): that occurrence is not flagged again.`
}

/** The heading each theorem-like environment prints. */
const THEOREM_NAMES: Record<string, string> = { theorem: 'Theorem', lemma: 'Lemma', proposition: 'Proposition', corollary: 'Corollary', definition: 'Definition' }

/** The user adds the declaration of an environment a copy needs and the document lacks: one \newtheorem line at the end of the main file's preamble. */
export async function declareEnvironment(io: Io, loaded: Loaded, name: string, environment: string): Promise<string> {
  const ms = await readManuscript(io, loaded)
  const d = ms?.documents.find(x => x.name === name)
  if (!ms || !d) throw new ManuscriptError(`"${name}" is no document`)
  const heading = THEOREM_NAMES[environment]
  if (!heading || !THEOREMS.includes(environment)) throw new ManuscriptError(`"${environment}" is not an environment of a snippet's kind (${THEOREMS.join(', ')})`)
  const lines = d.text.split('\n')
  const at = lines.findIndex(l => /\\begin\{document\}/.test(uncommented(l)))
  if (at < 0) throw new ManuscriptError(`${d.main} has no \\begin{document} to declare it before`)
  if (Object.entries(d.files).some(([f, text]) => TEX_FILE.test(f) && new RegExp(`\\\\newtheorem\\*?\\{${environment}\\}`).test(uncommented(text)))) return `${name} already declares the ${environment} environment.`
  const line = `\\newtheorem{${environment}}{${heading}}`
  const before = lines.slice(0, at)
  while (before.length && !before[before.length - 1]!.trim()) before.pop()
  const w = workOn(d)
  w.files[d.main] = [...before, line, '', ...lines.slice(at)].join('\n')
  w.touched.add(d.main)
  await save(io, loaded.config.vault, d, w)
  return `Added ${line} to the preamble of ${name} (${d.main}).`
}

/**
 * The user points to a passage of a document as a copy of a snippet (the tree view, a selection):
 * the lines from `from` to `to` of `file` (from 1) get marker lines around them. `ref` names a
 * lost copy (it is found again, there) or a snippet (a new copy: text a co-author wrote is tied to
 * the snippet without being replaced). Its text is the passage's, so it reads as adapted.
 */
export async function pointCopy(io: Io, loaded: Loaded, name: string, ref: string, at: { file: string; from: number; to: number }): Promise<string> {
  const ms = await readManuscript(io, loaded)
  const d = ms?.documents.find(x => x.name === name)
  if (!ms || !d) throw new ManuscriptError(`"${name}" is no document`)
  const vault = loaded.config.vault
  const m = COPY_REF.exec(ref.trim().toUpperCase())
  if (!m) throw new ManuscriptError(`"${ref}" names no snippet or copy`)
  const lost = d.copies.filter(c => c.snippet === m[1] && !c.found)
  const again = m[2] ? lost.find(c => c.nth === Number(m[2])) : lost[0]
  if (m[2] && !again) throw new ManuscriptError(`${name} has no lost copy ${ref}`)
  const s = ms.snippets.find(x => x.id === m[1])
  if (!again && !s) throw new ManuscriptError(`${m[1]} is no snippet`)
  const text = d.files[at.file]
  if (text === undefined || !TEX_FILE.test(at.file)) throw new ManuscriptError(`${name} has no .tex file ${at.file}`)
  const lines = text.split('\n')
  const from = Math.floor(at.from) - 1, to = Math.floor(at.to) - 1
  if (!(from >= 0 && to >= from && to < lines.length)) throw new ManuscriptError(`lines ${at.from} to ${at.to} are not in ${at.file}`)
  const over = d.copies.find(c => c.found && c.file === at.file && c.begin! <= to && c.end! >= from)
  if (over) throw new ManuscriptError(`those lines are already in the copy of ${copyName(d, over)}`)
  const passage = lines.slice(from, to + 1).join('\n')
  if (!passage.trim()) throw new ManuscriptError('select the passage first: those lines are empty')
  const w = workOn(d)
  let entry: TrackedCopy
  if (again) {
    entry = { ...w.tracking.copies.splice(again.index, 1)[0]!, file: at.file, seen: passage }
  } else {
    const out = await writeOut(io, loaded, s!, ms.snippets, vaultIds(loaded, ms), heldOf(d))
    entry = { snippet: s!.id, marker: out.marker, file: at.file, stamp: contentFingerprint(contentOf(s!.text)), placed: out.text, seen: passage }
  }
  if (contentFingerprint(entry.placed) === contentFingerprint(passage)) delete entry.seen
  const order = readingOrder(w.files, d.main)
  const next = locateCopies(w.files, w.tracking).find(c => c.found && order.at(c.file, c.begin!) >= order.at(at.file, from))
  w.files[at.file] = [...lines.slice(0, from), ...markedText(entry.marker, passage).split('\n'), ...lines.slice(to + 1)].join('\n')
  w.touched.add(at.file)
  w.tracking.copies.splice(next ? next.index : w.tracking.copies.length, 0, entry)
  await save(io, vault, d, w)
  return again ? `The copy of ${m[1]} in ${name} is found again: lines ${at.from} to ${at.to} of ${at.file}, between its marker lines.`
    : `Lines ${at.from} to ${at.to} of ${at.file} in ${name} are now a copy of ${m[1]}, between two marker lines: its text is kept as it is, and it goes to review when ${m[1]} changes.`
}

/** A copy found by its text gets its two marker lines back, around its text as it is. */
export async function restoreMarkers(io: Io, loaded: Loaded, name: string, ref: string): Promise<string> {
  const ms = await readManuscript(io, loaded)
  const d = ms?.documents.find(x => x.name === name)
  if (!ms || !d) throw new ManuscriptError(`"${name}" is no document`)
  const c = found(d, findCopy(d, ref))
  if (c.found === 'markers') return `The copy of ${copyName(d, c)} in ${name} has its marker lines.`
  const w = workOn(d)
  const lines = w.files[c.file]!.split('\n')
  w.files[c.file] = [...lines.slice(0, c.begin), ...markedText(c.marker, c.content).split('\n'), ...lines.slice(c.end + 1)].join('\n')
  w.touched.add(c.file)
  await save(io, loaded.config.vault, d, w)
  return `The copy of ${copyName(d, c)} in ${name} (${c.file}) has its two marker lines again.`
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

/** What rft_next adds: the snippets in review, the copies in review or lost, the values the tree changed, the stubs waiting for the user, the verified notes still to write. */
export async function manuscriptNext(io: Io, loaded: Loaded): Promise<string[]> {
  const ms = await readManuscript(io, loaded)
  if (!ms) return []
  const cites = citeIndex(loaded)
  const states = ms.snippets.map(s => [s, stateOf(s, loaded, ms.registry, cites)] as const)
  const review = states.filter(([, st]) => st.review.length).map(([s, st]) => `${s.id} (${st.review.join(', ')})`)
  const stubs = states.filter(([, st]) => st.stub && !st.review.length).map(([s]) => s.id)
  const byId = new Map(ms.snippets.map(s => [s.id, s]))
  const per = (pick: (d: Doc) => string[]) => ms.documents.map(d => [d.name, pick(d)] as const).filter(([, xs]) => xs.length).map(([name, xs]) => `${name}: ${xs.join(', ')}`).join('; ')
  const copies = per(d => d.copies.filter(c => copyState(c, byId.get(c.snippet)).state === 'review').map(c => `${copyName(d, c)} (${c.file})`))
  const lost = per(d => d.copies.filter(c => !c.found).map(c => `${copyName(d, c)} (was in ${c.file})`))
  const values: string[] = []
  for (const d of ms.documents) {
    const notes = valueNotes(await valuesOf(io, loaded, d))
    if (notes.length) values.push(`${d.name}: ${notes.join('. ')}`)
  }
  const todo = stillToWrite(loaded, ms, cites).map(n => n.id)
  return [
    review.length ? `Snippets in review (check their text against their notes): ${review.join('; ')}.` : '',
    copies ? `Copies in documents whose snippet changed since (the user takes the new text or keeps theirs): ${copies}.` : '',
    lost ? `Copies the plugin can no longer find in their document (the user points to them again in the page, or drops them): ${lost}.` : '',
    values.length ? `Values of the tree written in documents, for the user to look at (they take the tree's or keep theirs). ${values.join('. ')}.` : '',
    stubs.length ? `Stubs waiting for the user to write: ${stubs.join(', ')}.` : '',
    todo.length ? `Verified notes no snippet rests on yet (rft_manuscript): ${todo.join(', ')}.` : '',
  ].filter(Boolean)
}

/** What rft_validate adds: basis names that are no note, macros that name nothing saved, unknown citations, references with no BibTeX; per document its copies of no snippet, its lost copies, its values to look at and the traces of the tree in its files. */
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
    const at = `${vault}/${DOCUMENTS_DIR}/${d.name}`
    const gone = d.copies.filter(c => c.found && !byId.has(c.snippet)).map(c => `${copyName(d, c)} (${c.file})`)
    if (gone.length) out.push(`${at}: holds copies of snippets that do not exist: ${gone.join(', ')}`)
    const lost = d.copies.filter(c => !c.found).map(c => `${copyName(d, c)} (was in ${c.file})`)
    if (lost.length) out.push(`${at}: copies the plugin can no longer find (the user points to them again in the page, or drops them): ${lost.join(', ')}`)
    for (const n of valueNotes(await valuesOf(io, loaded, d))) out.push(`${at}: values of the tree, ${n}`)
    const { traces } = await tracesOf(io, loaded, ms, d)
    if (traces.length) out.push(`${at}: its files are shared as they are and hold ${traces.length} trace${traces.length === 1 ? '' : 's'} of the tree: ${traces.slice(0, 5).map(traceWords).join('; ')}${traces.length > 5 ? '; …' : ''}`)
  }
  const cited = new Set(ms.snippets.flatMap(s => usesIn(s.text).cites).map(k => cites[k]).filter(Boolean))
  for (const id of cited) if (!/```bibtex\n/.test(loaded.texts[id!] ?? '')) out.push(`${id}: cited in a snippet but has no \`\`\`bibtex block in its Source (a document gets a bare @misc for it)`)
  return out
}
