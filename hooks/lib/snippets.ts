// The manuscript's files as plain data (docs/design/manuscript.md): where they are, its registry
// (manuscript.json: the lock, the next id, each snippet's stamp) and one snippet read with its
// header. What a snippet rests on, its state, the report and the writing are manuscript.ts; the
// comments on a snippet read it from here (comments.ts), so neither needs the other.
//
// A snippet is `manuscript/snippets/S<nn>.tex`, opening with two comment lines:
//   % rft-snippet S04 · result · CutMix at 1k images
//   % basis: E05, E02

import type { Io } from './vault'
import { MANUSCRIPT_DIR, MANUSCRIPT_REGISTRY, join } from './vault'

export { MANUSCRIPT_DIR, MANUSCRIPT_REGISTRY }
export const SNIPPETS_DIR = 'snippets'
export const DOCUMENTS_DIR = 'documents'
/** The files the plugin writes in the manuscript's folder: never by hand, Claude's or the user's. */
export const GENERATED = ['manuscript.json', 'rft.sty', 'rft-numbers.tex', 'refs.bib', '.build']

export const SNIPPET_RE = /^S(\d+)$/
export const isSnippetId = (id: string) => SNIPPET_RE.test(id.trim().toUpperCase())

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
  /** The manuscript is the user's to write (the default): Claude proposes stubs, comments and suggests. */
  locked: boolean
  /** The next snippet number; ids are never reused. */
  next: number
  snippets: Record<string, SnippetEntry>
  /** Snippets the user unlocked one by one while the manuscript is locked. */
  unlocked: string[]
}

export const manuscriptPath = (vault: string, ...parts: string[]) => join(vault, MANUSCRIPT_DIR, ...parts)
export const snippetRel = (id: string) => `${MANUSCRIPT_DIR}/${SNIPPETS_DIR}/${id}.tex`

export async function readRegistry(io: Io, vault: string): Promise<Registry> {
  let d: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(await io.read(join(vault, MANUSCRIPT_REGISTRY)))
    if (parsed && typeof parsed === 'object') d = parsed as Record<string, unknown>
  } catch { /* none, or not JSON: the defaults */ }
  const snippets = d.snippets && typeof d.snippets === 'object' ? (d.snippets as Record<string, SnippetEntry>) : {}
  return {
    locked: d.locked !== false,
    next: typeof d.next === 'number' && d.next > 0 ? Math.floor(d.next) : 1,
    snippets,
    unlocked: Array.isArray(d.unlocked) ? d.unlocked.filter((x): x is string => typeof x === 'string') : [],
  }
}

export const writeRegistry = (io: Io, vault: string, r: Registry) =>
  io.write(join(vault, MANUSCRIPT_REGISTRY), JSON.stringify(r, null, 2) + '\n')

/** Whether a snippet is the user's to write: the manuscript is locked and it was not unlocked alone. */
export const isSnippetLocked = (r: Registry, id: string) => r.locked && !r.unlocked.includes(id)

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

export type Snippet = Header & { path: string; text: string }

/** One snippet, its header read; a file whose header is missing or names another id still reads, as its file says. */
export async function readSnippet(io: Io, vault: string, id: string): Promise<Snippet | null> {
  const path = snippetRel(id)
  let text: string
  try { text = (await io.read(join(vault, path))).replace(/\r\n/g, '\n') } catch { return null }
  const h = parseHeader(text)
  return { id, kind: h?.kind ?? '', title: h?.title ?? '', basis: h?.basis ?? [], path, text }
}

/** Every snippet, in the order of their numbers. */
export async function listSnippets(io: Io, vault: string): Promise<Snippet[]> {
  const dir = manuscriptPath(vault, SNIPPETS_DIR)
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
