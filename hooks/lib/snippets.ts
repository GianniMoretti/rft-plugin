// Snippets and documents as plain data (docs/design/manuscript.md): two levels, each a folder of
// the vault. `snippets/`: the building blocks, `S<nn>.tex` each with its two header lines, and their
// registry (snippets.json: the lock, the next id, each snippet's stamp of its notes). `documents/`:
// what is built with them, `<name>/main.tex` each, holding copies of snippets between marker lines
// (each with the fingerprint of the snippet's content it was taken from), and their registry
// (documents.json: the lock). What a snippet rests on, the states, the report and the writing are
// manuscript.ts; the comments read a snippet or a document from here (comments.ts).
//
//   % rft-snippet S04 · result · CutMix at 1k images      (a snippet's first two lines)
//   % basis: E05, E02
//
//   % rft-begin S04 3f2a1c9d                              (a copy in a document)
//   …
//   % rft-end S04

import type { Io } from './vault'
import { DOCUMENTS_DIR, MANUSCRIPT_REGISTRY, SNIPPETS_DIR, fnv1a, join } from './vault'

export { DOCUMENTS_DIR, SNIPPETS_DIR }
export const SNIPPETS_REGISTRY = MANUSCRIPT_REGISTRY
export const DOCUMENTS_REGISTRY = `${DOCUMENTS_DIR}/documents.json`
/** The files the plugin writes, relative to the vault: never by hand, Claude's or the user's. */
export const GENERATED = [SNIPPETS_REGISTRY, DOCUMENTS_REGISTRY, ...['rft.sty', 'rft-numbers.tex', 'refs.bib', '.build', '.rft'].map(f => `${DOCUMENTS_DIR}/${f}`)]
/** Each document's record of the snippets' text its copies were taken from. */
export const BLOCKS_FILE = '.blocks.json'

export const SNIPPET_RE = /^S(\d+)$/
export const isSnippetId = (id: string) => SNIPPET_RE.test(id.trim().toUpperCase())
export const DOC_NAME = /^[a-z0-9][a-z0-9-]*$/
export const isDocumentName = (name: string) => DOC_NAME.test(name.trim())

/** What a snippet is; its kind gives its stub's environment. */
export const KINDS = [
  'definition', 'theorem', 'lemma', 'proposition', 'corollary', 'proof',
  'method', 'result', 'related-work', 'motivation', 'discussion', 'figure', 'table',
] as const
export type Kind = (typeof KINDS)[number]
export const isKind = (k: unknown): k is Kind => (KINDS as readonly unknown[]).includes(k)
/** The kinds written in an environment of their own (amsthm's, set up by rft.sty). */
export const THEOREMS: readonly string[] = ['definition', 'theorem', 'lemma', 'proposition', 'corollary']

export type SnippetEntry = {
  /** The fingerprint of each basis note's substance when the snippet was last written or reviewed (verify.ts). */
  stamp?: Record<string, string>
  /** The day Claude proposed it, wrote it, or the user marked it reviewed. */
  proposed?: string
  written?: string
  reviewed?: string
}
export type Registry = {
  /** The snippets are the user's to write (the default): Claude proposes stubs, comments and suggests. */
  locked: boolean
  /** The next snippet number; ids are never reused. */
  next: number
  snippets: Record<string, SnippetEntry>
  /** Snippets the user unlocked one by one while the snippets are locked. */
  unlocked: string[]
}
export type DocsRegistry = {
  /** The documents' text is the user's (the default): Claude places copies they agreed to, comments and suggests. */
  locked: boolean
  /** Documents the user unlocked one by one while they are locked. */
  unlocked: string[]
}

export const snippetRel = (id: string) => `${SNIPPETS_DIR}/${id}.tex`
export const documentRel = (name: string) => `${DOCUMENTS_DIR}/${name}/main.tex`
export const blocksRel = (name: string) => `${DOCUMENTS_DIR}/${name}/${BLOCKS_FILE}`

async function readJson(io: Io, path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await io.read(path))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

export async function readRegistry(io: Io, vault: string): Promise<Registry> {
  const d = await readJson(io, join(vault, SNIPPETS_REGISTRY))
  return {
    locked: d.locked !== false,
    next: typeof d.next === 'number' && d.next > 0 ? Math.floor(d.next) : 1,
    snippets: d.snippets && typeof d.snippets === 'object' ? (d.snippets as Record<string, SnippetEntry>) : {},
    unlocked: strings(d.unlocked),
  }
}

export const writeRegistry = (io: Io, vault: string, r: Registry) =>
  io.write(join(vault, SNIPPETS_REGISTRY), JSON.stringify(r, null, 2) + '\n')

export async function readDocsRegistry(io: Io, vault: string): Promise<DocsRegistry> {
  const d = await readJson(io, join(vault, DOCUMENTS_REGISTRY))
  return { locked: d.locked !== false, unlocked: strings(d.unlocked) }
}

export const writeDocsRegistry = (io: Io, vault: string, r: DocsRegistry) =>
  io.write(join(vault, DOCUMENTS_REGISTRY), JSON.stringify(r, null, 2) + '\n')

/** Whether a snippet is the user's to write: the snippets are locked and it was not unlocked alone. */
export const isSnippetLocked = (r: Registry, id: string) => r.locked && !r.unlocked.includes(id)
/** Whether a document's text is the user's: the documents are locked and it was not unlocked alone. */
export const isDocumentLocked = (r: DocsRegistry, name: string) => r.locked && !r.unlocked.includes(name)

export type Header = { id: string; kind: string; title: string; basis: string[] }

const HEAD_RE = /^%\s*rft-snippet\s+(S\d+)\s*·\s*([\w-]+)\s*·\s*(.*?)\s*$/
const BASIS_RE = /^%\s*basis:\s*(.*?)\s*$/

/** A snippet's two header lines read back; null when the file does not start with them. */
export function parseHeader(text: string): Header | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const m = HEAD_RE.exec(lines[0] ?? '')
  if (!m) return null
  const b = BASIS_RE.exec(lines[1] ?? '')
  const basis = b ? b[1]!.split(/[,\s]+/).map(x => x.trim()).filter(Boolean) : []
  return { id: m[1]!, kind: m[2]!, title: m[3]!, basis: [...new Set(basis)] }
}

export const headerText = (h: Header) => `% rft-snippet ${h.id} · ${h.kind} · ${h.title}\n% basis: ${h.basis.join(', ')}\n`

/** A snippet's text after its two header lines. */
export function bodyAfterHeader(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const skip = HEAD_RE.test(lines[0] ?? '') ? (BASIS_RE.test(lines[1] ?? '') ? 2 : 1) : 0
  return lines.slice(skip).join('\n')
}

/** The text with its LaTeX comments taken out. */
export const uncommented = (text: string) => text.split('\n').map(l => l.replace(/(^|[^\\])%.*$/, '$1')).join('\n')

/** What a snippet gives a document: its text below the header, its blank lines at either end left out. */
export const contentOf = (snippetText: string) => bodyAfterHeader(snippetText).replace(/^(\s*\n)+/, '').replace(/\s+$/, '')

/** A content's fingerprint: its text without comments, whitespace collapsed (an outline comment changes nothing). */
export const contentFingerprint = (content: string) => fnv1a(uncommented(content).replace(/\s+/g, ' ').trim())

export type Snippet = Header & { path: string; text: string }

/** One snippet, its header read; a file whose header is missing still reads, as its file says. */
export async function readSnippet(io: Io, vault: string, id: string): Promise<Snippet | null> {
  const path = snippetRel(id)
  let text: string
  try { text = (await io.read(join(vault, path))).replace(/\r\n/g, '\n') } catch { return null }
  const h = parseHeader(text)
  return { id, kind: h?.kind ?? '', title: h?.title ?? '', basis: h?.basis ?? [], path, text }
}

/** Every snippet, in the order of their numbers. */
export async function listSnippets(io: Io, vault: string): Promise<Snippet[]> {
  const dir = join(vault, SNIPPETS_DIR)
  if (!(await io.exists(dir))) return []
  const ids = (await io.list(dir))
    .filter(f => f.kind === 'file' && /^S\d+\.tex$/.test(f.name))
    .map(f => f.name.slice(0, -4))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
  const out: Snippet[] = []
  for (const id of ids) {
    const s = await readSnippet(io, vault, id)
    if (s) out.push(s)
  }
  return out
}

const BEGIN_RE = /^%\s*rft-begin\s+(S\d+)\s+([0-9a-f]{8})\s*$/
const END_RE = /^%\s*rft-end\s+(S\d+)\s*$/

/** A copy of a snippet in a document: its id, the stamp it was taken with, its lines (the markers' indexes) and its text. */
export type Block = { id: string; stamp: string; begin: number; end: number; content: string }

/** The copies a document's text holds, in order; a begin marker with no end is no copy. */
export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: Block[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = BEGIN_RE.exec(lines[i]!)
    if (!m) continue
    const end = lines.findIndex((l, j) => j > i && END_RE.exec(l)?.[1] === m[1])
    if (end < 0) continue
    out.push({ id: m[1]!, stamp: m[2]!, begin: i, end, content: lines.slice(i + 1, end).join('\n') })
    i = end
  }
  return out
}

/** A copy as a document holds it: `stamp`, the fingerprint of the snippet's content it answers to. */
export const blockText = (id: string, stamp: string, content: string) => `% rft-begin ${id} ${stamp}\n${content}\n% rft-end ${id}`

/** The documents, by name. */
export async function listDocuments(io: Io, vault: string): Promise<string[]> {
  const dir = join(vault, DOCUMENTS_DIR)
  if (!(await io.exists(dir))) return []
  const out: string[] = []
  for (const f of await io.list(dir)) {
    if (f.kind === 'dir' && DOC_NAME.test(f.name) && (await io.exists(join(vault, documentRel(f.name))))) out.push(f.name)
  }
  return out.sort()
}
