// The manuscript (docs/design/manuscript.md): LaTeX snippets, each resting on notes of the tree,
// assembled by documents. What a snippet rests on (its `% basis:` and the notes its macros and
// citations name), its state (stub, written, review, unverified), the report Claude reads
// (rft_manuscript), and the writing (rft_set_snippet): a stub while the manuscript is locked, the
// text once the user unlocks it. Only verified notes are candidates.

import type { Io, Loaded, RftNode } from './vault'
import { compareNames, conceptOrder, join, resolveId } from './vault'
import type { Header, Kind, Registry, Snippet } from './snippets'
import {
  DOCUMENTS_DIR, KINDS, MANUSCRIPT_DIR, SNIPPETS_DIR, THEOREMS, bodyAfterHeader, headerText, isKind, isSnippetLocked,
  listSnippets, manuscriptPath, readRegistry, snippetRel, writeRegistry,
} from './snippets'
import { substanceFingerprint } from './verify'

export class ManuscriptError extends Error {}

export type Doc = { name: string; path: string; text: string; order: string[] }
export type Manuscript = { registry: Registry; snippets: Snippet[]; documents: Doc[] }

const SNIPPET_LINE = /\\rftsnippet\{(S\d+)\}/g

/** The manuscript as it is on disk; null when the vault has none. */
export async function readManuscript(io: Io, loaded: Loaded): Promise<Manuscript | null> {
  const vault = loaded.config.vault
  if (!loaded.hasManuscript && !(await io.exists(manuscriptPath(vault, 'manuscript.json')))) return null
  const registry = await readRegistry(io, vault)
  const snippets = await listSnippets(io, vault)
  const documents: Doc[] = []
  const dir = manuscriptPath(vault, DOCUMENTS_DIR)
  if (await io.exists(dir)) {
    for (const f of (await io.list(dir)).filter(f => f.kind === 'dir').sort((a, b) => compareNames(a.name, b.name))) {
      const path = `${MANUSCRIPT_DIR}/${DOCUMENTS_DIR}/${f.name}/main.tex`
      let text = ''
      try { text = await io.read(join(vault, path)) } catch { continue }
      documents.push({ name: f.name, path, text, order: [...text.matchAll(SNIPPET_LINE)].filter(m => !commentedAt(text, m.index!)).map(m => m[1]!) })
    }
  }
  return { registry, snippets, documents }
}

/** Whether the character at `at` sits after a `%` on its line (a LaTeX comment). */
function commentedAt(text: string, at: number): boolean {
  const start = text.lastIndexOf('\n', at - 1) + 1
  return /(^|[^\\])%/.test(text.slice(start, at))
}

/** The text with its LaTeX comments taken out. */
export const uncommented = (text: string) => text.split('\n').map(l => l.replace(/(^|[^\\])%.*$/, '$1')).join('\n')

// ---------------------------------------------------------------- what a snippet rests on

export type Uses = { nums: [string, string][]; figs: [string, string][]; tables: [string, string][]; cites: string[] }

/** The notes a snippet's text names through the macros, and the keys it cites (comments left out). */
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

// ---------------------------------------------------------------- state

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

const lockWords = (r: Registry) => r.locked
  ? `locked: the user writes it; you propose stubs (rft_set_snippet) and comment or suggest on their text (rft_comment, rft_suggest with the snippet's id)${r.unlocked.length ? `; unlocked for you: ${r.unlocked.join(', ')}` : ''}`
  : 'unlocked: you may write the snippets\' text with rft_set_snippet'

/** rft_manuscript: the documents and their snippets, those in none, and what is still to write; or one snippet in full. */
export async function manuscriptReport(io: Io, loaded: Loaded, ref?: string): Promise<string> {
  const ms = await readManuscript(io, loaded)
  if (!ms) return 'This vault has no manuscript yet. The user starts one with /rft-manuscript; until then, write no snippet.'
  const cites = citeIndex(loaded)
  const vault = loaded.config.vault
  const line = (s: Snippet) => {
    const st = stateOf(s, loaded, ms.registry, cites)
    return `  ${s.id} ${s.kind} · ${s.title} · ${stateWords(st)} · ${st.basis.join(', ') || 'no basis'}`
  }
  const r = ref?.trim()
  if (r && /^S\d+$/i.test(r)) return snippetReport(io, loaded, ms, r.toUpperCase(), cites)
  const docs = r ? ms.documents.filter(d => d.name === r) : ms.documents
  if (r && !docs.length) throw new ManuscriptError(`"${r}" is no document of the manuscript (${ms.documents.map(d => d.name).join(', ') || 'none yet'}) nor a snippet id`)
  const byId = new Map(ms.snippets.map(s => [s.id, s]))
  const out = [`Manuscript (${vault}/${MANUSCRIPT_DIR}/), ${lockWords(ms.registry)}.`]
  for (const d of docs) {
    out.push(`${d.name} (${vault}/${d.path}): ${d.order.length} snippet(s)`)
    for (const id of d.order) out.push(byId.has(id) ? line(byId.get(id)!) : `  ${id}: no such snippet (its \\rftsnippet line names none)`)
  }
  if (!r) {
    const placed = new Set(ms.documents.flatMap(d => d.order))
    const loose = ms.snippets.filter(s => !placed.has(s.id))
    if (loose.length) out.push('In no document:', ...loose.map(line))
    const todo = stillToWrite(loaded, ms, cites)
    if (todo.length) {
      out.push('Still to write (verified notes no snippet rests on), by concept:')
      const concepts = loaded.tree.concepts ?? {}
      for (const c of conceptOrder(concepts)) {
        const own = todo.filter(n => n.concept === c.id)
        if (own.length) out.push(`  ${c.name}: ${own.map(n => `${n.id} ${n.type} (${n.summary ?? n.title})`).join('; ')}`)
      }
    } else out.push('Still to write: nothing; every verified note has a snippet resting on it.')
  }
  out.push(`A snippet in full: rft_manuscript S<nn>. Its file: ${vault}/${MANUSCRIPT_DIR}/${SNIPPETS_DIR}/S<nn>.tex.`)
  return out.join('\n')
}

async function snippetReport(io: Io, loaded: Loaded, ms: Manuscript, id: string, cites: Record<string, string>): Promise<string> {
  const s = ms.snippets.find(x => x.id === id)
  if (!s) throw new ManuscriptError(`${id} is no snippet of the manuscript`)
  const st = stateOf(s, loaded, ms.registry, cites)
  const where = ms.documents.filter(d => d.order.includes(id)).map(d => d.name)
  const out = [
    `${s.id} ${s.kind} · ${s.title} (${loaded.config.vault}/${s.path}): ${stateWords(st)}; in ${where.join(', ') || 'no document'}; ${isSnippetLocked(ms.registry, id) ? 'locked: the user writes it' : 'unlocked: you may write it'}.`,
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

// ---------------------------------------------------------------- writing

/** A new snippet's text: its header, the outline as comments, the kind's environment, the body left to the user (or `text`). */
export function stubText(h: Header, outline: string[], date: string, text?: string): string {
  const lines = [headerText(h).trimEnd()]
  if (text == null) {
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

/** A document's text with `\rftsnippet{id}` placed: after `after`'s line, else before the bibliography or the end. */
export function placed(doc: string, id: string, after?: string): string {
  const line = `\\rftsnippet{${id}}`
  if (doc.includes(line)) return doc
  const lines = doc.split('\n')
  let at = after ? lines.findIndex(l => l.includes(`\\rftsnippet{${after}}`) && !l.trimStart().startsWith('%')) + 1 : 0
  if (after && at === 0) throw new ManuscriptError(`${after} is not placed in this document: place it after one that is, or leave after out`)
  if (!after) {
    at = lines.findIndex(l => /\\bibliographystyle|\\bibliography\{|\\printbibliography|\\end\{document\}/.test(l) && !l.trimStart().startsWith('%'))
    if (at < 0) at = lines.length
    // after the last snippet line before it, so new ones come in order
    while (at > 0 && !lines[at - 1]!.trim()) at--
  }
  lines.splice(at, 0, line)
  return lines.join('\n')
}

export type SnippetInput = {
  id?: string
  kind?: unknown
  title?: unknown
  basis?: string[]
  outline?: unknown
  text?: unknown
  edits?: unknown
  document?: string
  after?: string
}

/** A title as a header line and a LaTeX argument hold it: one line, no · { } \\ % (they break the header or the argument). */
const cleanTitle = (t: unknown) => String(t ?? '').replace(/[·\n\r{}\\%]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)

/**
 * rft_set_snippet. Without `id`, a new snippet: a stub (header, outline, the kind's environment)
 * while the manuscript is locked, else with `text`; placed in `document`. With `id`, its text (or
 * edits, its basis, its title), only when it is unlocked. The basis must be verified notes, and
 * every macro must name what a notebook saved. Stamped with the basis notes' substance.
 */
export async function setSnippet(io: Io, loaded: Loaded, i: SnippetInput, date: string): Promise<string> {
  const ms = await readManuscript(io, loaded)
  if (!ms) throw new ManuscriptError('This vault has no manuscript: the user starts one with /rft-manuscript')
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
    if (unverified.length) {
      throw new ManuscriptError(`only verified notes are candidates for the manuscript: ${unverified.map(id => `${id} is ${loaded.tree.nodes[id]!.status}`).join(', ')}. ` +
        'When one is ready, suggest verifying it (rft_set_status verified, with what was checked); the user verifies it in the tree view.')
    }
    return ids
  }
  const text = typeof i.text === 'string' && i.text.trim() ? i.text.replace(/\r\n/g, '\n') : undefined
  const outline = (Array.isArray(i.outline) ? i.outline : typeof i.outline === 'string' ? i.outline.split('\n') : [])
    .map(l => String(l).replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean)
  const doc = i.document?.trim() ? ms.documents.find(d => d.name === i.document!.trim()) : undefined
  if (i.document?.trim() && !doc) throw new ManuscriptError(`"${i.document}" is no document of the manuscript (${ms.documents.map(d => d.name).join(', ') || 'none yet'})`)

  if (!i.id?.trim()) {
    if (!isKind(i.kind)) throw new ManuscriptError(`kind must be one of ${KINDS.join(', ')}`)
    const title = cleanTitle(i.title)
    if (!title) throw new ManuscriptError('give the snippet a title')
    if (!i.basis?.length) throw new ManuscriptError('give its basis: the verified notes it rests on')
    if (text && reg.locked) throw new ManuscriptError('the manuscript is locked: the user writes the text. Propose the snippet as a stub (outline: what it should say), with no text')
    const ids = basisIds(i.basis)
    const id = `S${String(reg.next).padStart(2, '0')}`
    const body = stubText({ id, kind: i.kind, title, basis: ids }, outline, date, text)
    const problems = await macroProblems(io, loaded, body)
    if (problems.length) throw new ManuscriptError(`its macros name what no notebook saved:\n${problems.join('\n')}`)
    await io.write(join(vault, snippetRel(id)), body)
    reg.next++
    reg.snippets[id] = { stamp: stampOf(loaded, [...new Set([...ids, ...basisOf({ basis: ids, text: body }, loaded).ids])]), ...(text ? { written: date } : { proposed: date }) }
    await writeRegistry(io, vault, reg)
    let where = 'in no document yet (place it with document)'
    if (doc) {
      await io.write(join(vault, doc.path), placed(doc.text, id, i.after?.trim()))
      where = `placed in ${doc.name}${i.after ? ` after ${i.after}` : ''}`
    }
    return `${id} ${text ? 'written' : 'proposed as a stub for the user to write'}: ${vault}/${snippetRel(id)} (${i.kind}, basis ${ids.join(', ')}), ${where}.` +
      (text ? '' : ' Tell the user it is there and what it asks for; then comment and suggest on their text when they ask, never write it.')
  }

  const id = i.id.trim().toUpperCase()
  const s = ms.snippets.find(x => x.id === id)
  if (!s) throw new ManuscriptError(`${id} is no snippet of the manuscript`)
  if (isSnippetLocked(reg, id)) {
    throw new ManuscriptError(`${id} is the user's to write (the manuscript is locked): comment on it with rft_comment {id: "${id}", quote, text}, or propose new text with rft_suggest {id: "${id}", quote, replacement}; the user accepts or rejects it`)
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
  if (doc) await io.write(join(vault, doc.path), placed(doc.text, id, i.after?.trim()))
  return `${id} written (${vault}/${s.path}), stamped with its basis as it is now.${doc ? ` Placed in ${doc.name}.` : ''}`
}

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
% Each \\rftsnippet line puts a snippet here (manuscript/snippets/S<nn>.tex); the tree view's
% Manuscript tab lists them, and rft_set_snippet places Claude's proposals.

\\bibliographystyle{plainnat}
\\bibliography{refs}
\\end{document}
`
}

const DOC_NAME = /^[a-z0-9][a-z0-9-]*$/

/**
 * Starts the manuscript (its registry, locked) with a first document, or adds a document to it.
 * The answer says what was made.
 */
export async function newDocument(io: Io, loaded: Loaded, name: string, kind: 'article' | 'report' = 'article', title?: string): Promise<string> {
  const vault = loaded.config.vault
  const doc = name.trim().toLowerCase()
  if (!DOC_NAME.test(doc)) throw new ManuscriptError('a document\'s name is lowercase letters, digits and dashes, e.g. paper or thesis-ch3')
  const path = `${MANUSCRIPT_DIR}/${DOCUMENTS_DIR}/${doc}/main.tex`
  if (await io.exists(join(vault, path))) throw new ManuscriptError(`the manuscript already has a document ${doc} (${vault}/${path})`)
  const started = !(await io.exists(manuscriptPath(vault, 'manuscript.json')))
  if (started) await writeRegistry(io, vault, await readRegistry(io, vault))
  await io.write(join(vault, path), documentTemplate(title?.trim() || loaded.config.project, kind))
  loaded.hasManuscript = true
  return started
    ? `Started the manuscript in ${vault}/${MANUSCRIPT_DIR}/, locked (you write it; Claude proposes snippets from verified notes, comments and suggests), with the document ${doc} (${vault}/${path}).`
    : `Added the document ${doc} (${vault}/${path}).`
}

// ---------------------------------------------------------------- for rft_next and rft_validate

/** What rft_next adds: the snippets in review, the stubs waiting for the user, the verified notes still to write. */
export async function manuscriptNext(io: Io, loaded: Loaded): Promise<string[]> {
  const ms = await readManuscript(io, loaded)
  if (!ms) return []
  const cites = citeIndex(loaded)
  const states = ms.snippets.map(s => [s, stateOf(s, loaded, ms.registry, cites)] as const)
  const review = states.filter(([, st]) => st.review.length).map(([s, st]) => `${s.id} (${st.review.join(', ')})`)
  const stubs = states.filter(([, st]) => st.stub && !st.review.length).map(([s]) => s.id)
  const todo = stillToWrite(loaded, ms, cites).map(n => n.id)
  return [
    review.length ? `Manuscript snippets in review (check their text against the notes): ${review.join('; ')}.` : '',
    stubs.length ? `Stubs waiting for the user to write: ${stubs.join(', ')}.` : '',
    todo.length ? `Verified notes no snippet rests on yet (rft_manuscript): ${todo.join(', ')}.` : '',
  ].filter(Boolean)
}

/** What rft_validate adds: basis names that are no note, macros that name nothing saved, unknown citations, references with no BibTeX. */
export async function manuscriptWarnings(io: Io, loaded: Loaded): Promise<string[]> {
  const ms = await readManuscript(io, loaded)
  if (!ms) return []
  const cites = citeIndex(loaded)
  const out: string[] = []
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
  for (const d of ms.documents) {
    const missing = d.order.filter(id => !ms.snippets.some(s => s.id === id))
    if (missing.length) out.push(`${loaded.config.vault}/${d.path}: places snippets that do not exist: ${missing.join(', ')}`)
  }
  const cited = new Set(ms.snippets.flatMap(s => usesIn(bodyAfterHeader(s.text)).cites).map(k => cites[k]).filter(Boolean))
  for (const id of cited) if (!/```bibtex\n/.test(loaded.texts[id!] ?? '')) out.push(`${id}: cited in the manuscript but has no \`\`\`bibtex block in its Source (refs.bib gets a bare @misc for it)`)
  return out
}
