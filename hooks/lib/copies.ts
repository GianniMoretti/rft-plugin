// Where a document's copies and tracked values are (docs/adr/0003-a-document-holds-no-trace.md).
// A document's files say nothing of the tree, so a copy is found from two things: its marker lines
// in a file, which say only its kind and title,
//
//   %%% Definition: CutMix %%%
//   …
//   %%% end %%%
//
// and the document's tracking file (tracking.ts), which says which snippet each copy came from. A
// copy is found by its markers, else by its text as placed, else it is lost: shown, never dropped.
// A tracked value (a number, a figure, a table written out) is found by the text before and after
// it. server/rft_manuscript.py reads the same way, for the page; both are held to
// tests/fixtures/local-overleaf/expected.json.

import type { TrackedCopy, TrackedValue, Tracking } from './tracking'

const END_RE = /^\s*%%%\s*end\s*%%%\s*$/i
const MARK_RE = /^\s*%%%\s*(\S.*?)\s*%%%\s*$/

/** A pair of marker lines in a file: its words, the lines of the two markers (from 0), and the text between. */
export type Marker = { words: string; begin: number; end: number; content: string }

/** The marker pairs of a text, in order. A marker with no `%%% end %%%` before the next marker is a comment of the user's own. */
export function parseMarkers(text: string): Marker[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: Marker[] = []
  let open: { words: string; begin: number } | null = null
  lines.forEach((l, i) => {
    if (END_RE.test(l)) {
      if (open) out.push({ ...open, end: i, content: lines.slice(open.begin + 1, i).join('\n') })
      open = null
    } else {
      const m = MARK_RE.exec(l)
      if (m) open = { words: m[1]!, begin: i }
    }
  })
  return out
}

/** Words or text as compared: case and spacing do not count. */
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
const squeeze = (s: string) => s.replace(/\s+/g, ' ').trim()

const uncommentedLine = (l: string) => l.replace(/(^|[^\\])%.*$/, '$1')
/** Any command that takes a file in: \input, \include, \subfile, and a template's own (\includepaper); what its argument names must be a file of the document. */
const INCLUDE_RE = /\\(?!include(?:only|graphics|pdf|svg)\b)[A-Za-z]*(?:input|include|subfile)[A-Za-z]*\*?\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g
const TEX_RE = /\.(tex|ltx)$/i
const BEGIN_DOCUMENT = /\\begin\s*\{document\}/

/**
 * A document's main file: the one its tracking file records, while the document has it; else the
 * one file with \begin{document}, whatever its name. With several such files and none recorded
 * the user is asked: `asked` lists them, and `main` is what is read meanwhile. `files`: the
 * document's texts by path. (main_of in server/rft_manuscript.py reads the same way.)
 */
export function mainOf(files: Record<string, string>, recorded: string): { main: string; asked: string[] } {
  const tex = Object.keys(files).filter(f => TEX_RE.test(f)).sort()
  if (tex.includes(recorded)) return { main: recorded, asked: [] }
  const found = tex.filter(f => BEGIN_DOCUMENT.test(files[f]!.split('\n').map(uncommentedLine).join('\n')))
  if (found.length === 1) return { main: found[0]!, asked: [] }
  if (found.length) return { main: found.includes('main.tex') ? 'main.tex' : found[0]!, asked: found }
  return { main: tex.includes('main.tex') ? 'main.tex' : tex[0] ?? '', asked: [] }
}

/**
 * The order a document is read in: its main file, each file it takes in (\input, \include,
 * \subfile) at the line that names it, then the files nothing takes in. `at(file, line)` gives a
 * place's rank in that order; `included` the files the main file reaches.
 */
export function readingOrder(files: Record<string, string>, main: string): { at: (file: string, line: number) => number; included: Set<string> } {
  const spans: { file: string; from: number; to: number; base: number }[] = []
  const seen = new Set<string>()
  let base = 0
  // what a file takes in is named from the main file's folder
  const folder = main.includes('/') ? main.slice(0, main.lastIndexOf('/') + 1) : ''
  const visit = (file: string) => {
    if (seen.has(file) || files[file] === undefined) return
    seen.add(file)
    const lines = files[file]!.split('\n')
    let from = 0
    const flush = (to: number) => {
      if (to < from) return
      spans.push({ file, from, to, base })
      base += to - from + 1
      from = to + 1
    }
    lines.forEach((l, i) => {
      for (const m of uncommentedLine(l).matchAll(INCLUDE_RE)) {
        const name = folder + m[1]!.trim().replace(/^\.\//, '')
        const target = files[name] !== undefined ? name : `${name}.tex`
        if (files[target] === undefined || seen.has(target)) continue
        flush(i)
        visit(target)
      }
    })
    flush(lines.length - 1)
  }
  visit(main)
  const included = new Set(seen)
  for (const f of Object.keys(files).sort()) if (/\.(tex|ltx)$/i.test(f)) visit(f)
  return {
    at: (file, line) => {
      const s = spans.find(x => x.file === file && line >= x.from && line <= x.to)
      return s ? s.base + (line - s.from) : Number.MAX_SAFE_INTEGER
    },
    included,
  }
}

/** A text with each run of whitespace made one space, and where each of its characters was. */
function squeezed(text: string): { text: string; at: number[] } {
  let out = ''
  const at: number[] = []
  let gap = false
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i]!)) { gap = out.length > 0; continue }
    if (gap) { out += ' '; at.push(i - 1); gap = false }
    out += text[i]
    at.push(i)
  }
  return { text: out, at }
}

const lineOf = (text: string, offset: number) => text.slice(0, offset).split('\n').length - 1

/** A copy as it is found in the document: by its markers, by its text, or not at all. */
export type Located = TrackedCopy & {
  /** Its place among the tracking file's copies. */
  index: number
  /** Its number among the copies of the same snippet, from 1: `S01#2` names the second. */
  nth: number
  found: 'markers' | 'text' | null
  /** The first and the last line it takes in its file, markers included (from 0); null when lost. */
  begin: number | null
  end: number | null
  /** Its text now; null when lost. */
  content: string | null
}

/**
 * The copies of a tracking file, each found in the document's files: by a marker pair with its
 * words (in its file first, else in another: it was moved), else by its text as placed, else lost.
 * A lost copy keeps the file it was last in.
 */
export function locateCopies(files: Record<string, string>, tracking: Pick<Tracking, 'copies'>): Located[] {
  const names = Object.keys(files).filter(f => /\.(tex|ltx)$/i.test(f)).sort()
  const markers = names.flatMap(file => parseMarkers(files[file]!).map(m => ({ file, ...m, taken: false })))
  const counts: Record<string, number> = {}
  const out: Located[] = tracking.copies.map((c, index) => ({ ...c, index, nth: (counts[c.snippet] = (counts[c.snippet] ?? 0) + 1), found: null, begin: null, end: null, content: null }))
  for (const c of out) {
    const same = markers.filter(m => !m.taken && norm(m.words) === norm(c.marker))
    const m = same.find(x => x.file === c.file) ?? same[0]
    if (!m) continue
    m.taken = true
    Object.assign(c, { found: 'markers', file: m.file, begin: m.begin, end: m.end, content: m.content })
  }
  // by its text: where the placed text still stands, outside every copy found so far
  const claimed = (file: string, from: number, to: number) => out.some(c => c.found && c.file === file && c.begin! <= to && c.end! >= from)
  for (const c of out) {
    const want = squeeze(c.seen ?? c.placed)
    if (c.found || !want) continue
    for (const file of [c.file, ...names.filter(f => f !== c.file)]) {
      if (files[file] === undefined) continue
      const sq = squeezed(files[file]!)
      let hit = -1
      for (let k = sq.text.indexOf(want); k >= 0; k = sq.text.indexOf(want, k + 1)) {
        const from = lineOf(files[file]!, sq.at[k]!), to = lineOf(files[file]!, sq.at[k + want.length - 1]!)
        if (!claimed(file, from, to)) { hit = k; break }
      }
      if (hit < 0) continue
      const from = lineOf(files[file]!, sq.at[hit]!), to = lineOf(files[file]!, sq.at[hit + want.length - 1]!)
      // its markers are still around it, their words changed: they are its markers
      const m = markers.find(x => !x.taken && x.file === file && x.begin < from && x.end > to && squeeze(x.content) === want)
      if (m) { m.taken = true; Object.assign(c, { found: 'markers', file, begin: m.begin, end: m.end, content: m.content }) }
      else Object.assign(c, { found: 'text', file, begin: from, end: to, content: files[file]!.split('\n').slice(from, to + 1).join('\n') })
      break
    }
  }
  return out
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A text as a pattern that takes any spacing where the text has some. */
const flexible = (s: string) => s.split(/\s+/).map(escapeRe).join('\\s+')

/** How much of the text on each side of a value is asked to match: all that was kept, then less. */
const NEAR = [1000, 12, 6]

/** A tracked value as it is found in its file. */
export type LocatedValue = TrackedValue & {
  index: number
  /** `written`: it stands as it was written; `changed`: something else stands between its before and after; null: its place is not found. */
  found: 'written' | 'changed' | null
  /** Where what stands there starts in its file, and what it is. */
  offset: number | null
  line: number | null
  inDocument: string | null
}

/** Each tracked value found in its file by the text before and after it. */
export function locateValues(files: Record<string, string>, tracking: Pick<Tracking, 'values'>): LocatedValue[] {
  const taken: Record<string, [number, number][]> = {}
  const free = (file: string, from: number, to: number) => !(taken[file] ?? []).some(([a, b]) => from < b && to > a)
  return tracking.values.map((v, index) => {
    const text = files[v.file]
    const lost: LocatedValue = { ...v, index, found: null, offset: null, line: null, inDocument: null }
    if (text === undefined) return lost
    const take = (found: 'written' | 'changed', re: RegExp): LocatedValue | null => {
      for (const m of text.matchAll(re)) {
        const offset = m.index! + m[1]!.length, inDocument = m[2]!
        if (!free(v.file, offset, offset + inDocument.length)) continue
        ;(taken[v.file] ??= []).push([offset, offset + Math.max(1, inDocument.length)])
        return { ...v, index, found, offset, line: lineOf(text, offset), inDocument }
      }
      return null
    }
    // by all the text kept on each side; then by less of it, so that a word changed nearby does not lose the value
    const around = (n: number) => [flexible(v.before.slice(-n)), flexible(v.after.slice(0, n))] as const
    for (const n of NEAR) {
      const [before, after] = around(n)
      const exact = take('written', new RegExp(`(${before})(${flexible(v.written)})(?=${after})`, 'g'))
      if (exact) return exact
    }
    // what stands between the same before and after now: the user's or a co-author's own value
    if (v.kind === 'table') return lost
    for (const n of NEAR.slice(0, 2)) {
      if (squeeze(v.before.slice(-n)).length + squeeze(v.after.slice(0, n)).length < 6) continue
      const [before, after] = around(n)
      const changed = take('changed', new RegExp(`(${before})([^\\n]{0,80}?)(?=${after})`, 'g'))
      if (changed) return changed
    }
    return lost
  })
}

/** The copy a place of a file lies in, if any. */
export const copyAt = (copies: readonly Located[], file: string, line: number) =>
  copies.find(c => c.found && c.file === file && line >= c.begin! && line <= c.end!) ?? null

/** The keys of the entries of a .bib text, in order. */
export const bibKeys = (bib: string) => [...bib.matchAll(/^\s*@\w+\s*\{\s*([^,\s]+)\s*,/gm)].map(m => m[1]!).filter(k => !/^(string|comment|preamble)$/i.test(k))
