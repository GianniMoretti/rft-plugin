// The scan for traces (docs/adr/0003-a-document-holds-no-trace.md). A document's files are shared
// with co-authors as they are, so they hold no trace of the tree. A trace is:
//
//   plugin     a name or a macro of the plugin: \rftnum, \usepackage{rft}, rft.sty
//   marker     a marker of the first design: % rft-begin S04 3f2a1c9d, % rft-end S04
//   id         the id of a note or a snippet that exists in this vault (E05, S04), in a text or a file's name
//   reference  an entry of a .bib that a reference note of the tree holds and the document does not cite
//
// An id that is no note's and no snippet's is not flagged ("Table S1"), and an entry the tree does
// not know is the user's own. An occurrence the user allowed is remembered in the tracking file
// and not flagged again. server/rft_scan.py reads the same way, for the page; the cases both are
// held to are tests/fixtures/local-overleaf/traces.json.

import type { Allowed } from './tracking'
import { readTracking } from './tracking'
import type { Io } from './vault'
import { DOCUMENTS_DIR, join } from './vault'

export type TraceKind = 'plugin' | 'marker' | 'id' | 'reference'
/** One trace: its file in the document, its line there (null: in the file's name), what was found, and the line's text. */
export type Trace = { file: string; line: number | null; kind: TraceKind; match: string; text: string }
type Found = Omit<Trace, 'file'>

/** `rft` where a word starts, in lower case as the plugin writes it (an acronym RFT is the user's own). */
const PLUGIN_RE = /(?<![A-Za-z])\\?rft[\w@-]*/g
const OLD_MARKER_RE = /^\s*%\s*rft-(?:begin|end)\b.*$/
const ID_RE = /(?<![A-Za-z0-9])[A-Z]\d+(?![A-Za-z0-9])/g
/** Any command that cites: \cite, \citep, \parencite, \nocite, \footcite and the like. */
const CITES_RE = /\\[A-Za-z]*cite[A-Za-z]*\*?(?:\[[^\]]*\]){0,2}\{([^}]*)\}/g
const BIB_ENTRY_RE = /^\s*@(\w+)\s*\{\s*([^,\s]+)\s*,/
/** Files read as bytes only: their names are scanned, their content is not. */
const BINARY_RE = /\.(pdf|png|jpe?g|gif|eps|ps|tiff?|bmp|ico|zip|gz|tgz|otf|ttf|woff2?|pfb|xlsx?|docx?)$/i
/** A text larger than this is not read. */
const MAX_TEXT = 2_000_000

const uncommented = (text: string) => text.split('\n').map(l => l.replace(/(^|[^\\])%.*$/, '$1')).join('\n')

/** The traces in a text, line by line: the plugin's names, the first design's markers, and the ids of `ids`. */
export function tracesInText(text: string, ids: ReadonlySet<string>): Found[] {
  const out: Found[] = []
  text.replace(/\r\n/g, '\n').split('\n').forEach((raw, i) => {
    const shown = raw.trim()
    if (OLD_MARKER_RE.test(raw)) out.push({ line: i + 1, kind: 'marker', match: shown.replace(/^%\s*/, '').split(/\s+/)[0]!, text: shown })
    else for (const m of raw.matchAll(PLUGIN_RE)) out.push({ line: i + 1, kind: 'plugin', match: m[0], text: shown })
    for (const m of raw.matchAll(ID_RE)) if (ids.has(m[0])) out.push({ line: i + 1, kind: 'id', match: m[0], text: shown })
  })
  return out
}

/** The traces in a file's path inside the document. */
export function tracesInName(rel: string, ids: ReadonlySet<string>): Found[] {
  const out: Found[] = []
  for (const m of rel.matchAll(PLUGIN_RE)) out.push({ line: null, kind: 'plugin', match: m[0], text: '' })
  for (const m of rel.matchAll(ID_RE)) if (ids.has(m[0])) out.push({ line: null, kind: 'id', match: m[0], text: '' })
  return out
}

/** The keys a text cites, comments left out; `*` among them when it cites everything (\nocite{*}). */
export function citedKeys(text: string): string[] {
  return [...new Set([...uncommented(text).matchAll(CITES_RE)].flatMap(m => m[1]!.split(',').map(k => k.trim()).filter(Boolean)))]
}

/** The entries of a .bib that the tree holds (`treeKeys`) and the document does not cite. */
export function uncitedEntries(bib: string, cited: ReadonlySet<string>, treeKeys: ReadonlySet<string>): Found[] {
  if (cited.has('*')) return []
  const out: Found[] = []
  bib.replace(/\r\n/g, '\n').split('\n').forEach((raw, i) => {
    const m = BIB_ENTRY_RE.exec(raw)
    if (m && treeKeys.has(m[2]!) && !cited.has(m[2]!)) out.push({ line: i + 1, kind: 'reference', match: m[2]!, text: raw.trim() })
  })
  return out
}

const isAllowed = (allowed: readonly Allowed[], t: Trace) => allowed.some(a => a.file === t.file && a.match === t.match && a.text === t.text)

/** Every file of a document, by its path inside the document's folder, in order. */
export async function documentFiles(io: Io, vault: string, name: string): Promise<{ rel: string; size: number }[]> {
  const root = join(vault, DOCUMENTS_DIR, name)
  const out: { rel: string; size: number }[] = []
  const visit = async (dir: string) => {
    let entries: Awaited<ReturnType<Io['list']>>
    try { entries = await io.list(join(root, dir)) } catch { return }
    for (const f of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const rel = dir ? `${dir}/${f.name}` : f.name
      if (f.kind === 'dir') await visit(rel)
      else out.push({ rel, size: f.size })
    }
  }
  await visit('')
  return out
}

export type ScanInput = {
  /** Each file of the document: its path inside it, and its text (null: not read, a figure or a large file). */
  files: { rel: string; text: string | null }[]
  /** The ids of the notes and the snippets of the vault. */
  ids: ReadonlySet<string>
  /** The keys of the BibTeX entries the reference notes hold. */
  treeKeys: ReadonlySet<string>
  allowed?: readonly Allowed[]
}

/** The traces of a document given as its files: those still flagged, and how many the user allowed. */
export function scanFiles(i: ScanInput): { traces: Trace[]; allowed: number } {
  const all: Trace[] = []
  const cited = new Set(i.files.filter(f => f.text !== null && /\.(tex|ltx)$/i.test(f.rel)).flatMap(f => citedKeys(f.text!)))
  for (const f of i.files) {
    for (const t of tracesInName(f.rel, i.ids)) all.push({ file: f.rel, ...t })
    if (f.text === null) continue
    for (const t of tracesInText(f.text, i.ids)) all.push({ file: f.rel, ...t })
    if (/\.bib$/i.test(f.rel)) for (const t of uncitedEntries(f.text, cited, i.treeKeys)) all.push({ file: f.rel, ...t })
  }
  const traces = all.filter(t => !isAllowed(i.allowed ?? [], t))
  return { traces, allowed: all.length - traces.length }
}

/** The scan of a document's folder (documents/<name>/), with what its tracking file allows. */
export async function scanDocument(io: Io, vault: string, name: string, ids: ReadonlySet<string>, treeKeys: ReadonlySet<string>): Promise<{ traces: Trace[]; allowed: number }> {
  const files: ScanInput['files'] = []
  for (const f of await documentFiles(io, vault, name)) {
    let text: string | null = null
    if (!BINARY_RE.test(f.rel) && f.size <= MAX_TEXT) {
      try { text = await io.read(join(vault, DOCUMENTS_DIR, name, f.rel)) } catch { text = null }
      if (text !== null && text.includes('\u0000')) text = null
    }
    files.push({ rel: f.rel, text })
  }
  return scanFiles({ files, ids, treeKeys, allowed: (await readTracking(io, vault, name)).allowed })
}

/** A trace in a few words, as a refusal or a report shows it. */
export function traceWords(t: Trace): string {
  const what = t.kind === 'plugin' ? `the plugin's ${t.match}` : t.kind === 'marker' ? `a marker of the first design (${t.match})`
    : t.kind === 'id' ? `the id ${t.match}` : `the entry ${t.match}, which the document does not cite`
  return `${t.file}${t.line === null ? ' (its name)' : `:${t.line}`}: ${what}`
}
