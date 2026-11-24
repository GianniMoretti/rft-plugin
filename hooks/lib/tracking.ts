// A document's tracking file (docs/adr/0003-a-document-holds-no-trace.md): what ties the document
// to the tree, kept outside the document's folder so that the folder can be shared as it is.
// `documents/.rft/<name>/tracking.json`, written by the plugin only (the session for all that
// concerns copies and values; the server, server/rft_documents.py, only to carry a renamed file's
// paths and the main file and engine the user chose in the page):
//
//   main     the document's main file, once it is recorded (the user's choice, or what a template said);
//            until then it is the one file with \begin{document} (mainOf in copies.ts)
//   engine   what compiles it: pdflatex (the default), xelatex or lualatex
//   template the template it was made from
//   bibOf    the .bib the user chose for a file's entries, where the document itself does not say
//   copies   each copy of a snippet, in the order of the document: its snippet, its marker's words,
//            its file, the fingerprint of the snippet's content it answers to, that snippet written out
//   values   each number, figure and table of the tree written out in the document: where it came
//            from, what was written, its file and the text before and after it
//   bib      each entry of the document's .bib files that came from a reference note: the note, the
//            .bib it was added to, and any other .bib of the document it was added to since (`also`)
//   allowed  occurrences the scan flagged and the user allowed

import type { Io } from './vault'
import { DOCUMENTS_DIR, join } from './vault'

/** The plugin's own files of the documents, outside every document's folder. */
export const TRACKING_DIR = `${DOCUMENTS_DIR}/.rft`
export const trackingRel = (name: string) => `${TRACKING_DIR}/${name}/tracking.json`

export type TrackedCopy = {
  snippet: string
  /** The marker's words when it was placed (`Definition: CutMix`): how the copy is found when its snippet is gone or retitled. */
  marker: string
  file: string
  /** The fingerprint of the snippet's content the copy answers to. */
  stamp: string
  /** The snippet written out, as the copy answers to it: what it is compared with to tell whether it was adapted. */
  placed: string
  /** The copy's own text when the plugin last saw it, when that is not `placed`: what finds it again once its markers are gone. */
  seen?: string
}
export type ValueKind = 'number' | 'figure' | 'table'
export type TrackedValue = {
  kind: ValueKind
  /** The note it came from, and its name there (`acc.1k`, a figure's or a table's name). */
  from: string
  key: string
  /** What was written in the document: the number's text, the figure's path, the table's tabular. */
  written: string
  file: string
  /** The text just before and just after it, which finds it again. */
  before: string
  after: string
  /** What the tree said when the user chose to keep theirs: not flagged again until the tree says something else. */
  kept?: string
}
export type Allowed = { file: string; match: string; text: string }
export const ENGINES = ['pdflatex', 'xelatex', 'lualatex'] as const
export type Engine = (typeof ENGINES)[number]
export type Tracking = {
  version: 1
  /** The main file as recorded; '' while it is not. */
  main: string
  engine?: Engine
  template?: string
  bibOf?: Record<string, string>
  copies: TrackedCopy[]
  values: TrackedValue[]
  bib: Record<string, { from: string; file: string; also?: string[] }>
  allowed: Allowed[]
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [])

/** A tracking file as read: what is missing or malformed is left out, never guessed. */
export function parseTracking(raw: unknown): Tracking {
  const d = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const bib: Tracking['bib'] = {}
  if (d.bib && typeof d.bib === 'object') {
    for (const [key, v] of Object.entries(d.bib as Record<string, unknown>)) {
      const e = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
      const also = Array.isArray(e.also) ? e.also.filter((x): x is string => typeof x === 'string' && !!x) : []
      if (str(e.from)) bib[key] = { from: str(e.from), file: str(e.file), ...(also.length ? { also } : {}) }
    }
  }
  const bibOf: Record<string, string> = {}
  if (d.bibOf && typeof d.bibOf === 'object') for (const [k, v] of Object.entries(d.bibOf as Record<string, unknown>)) if (str(v)) bibOf[k] = str(v)
  return {
    version: 1,
    main: str(d.main),
    ...((ENGINES as readonly string[]).includes(str(d.engine)) ? { engine: str(d.engine) as Engine } : {}),
    ...(str(d.template) ? { template: str(d.template) } : {}),
    ...(Object.keys(bibOf).length ? { bibOf } : {}),
    copies: list(d.copies).filter(c => str(c.snippet) && str(c.file))
      .map(c => ({ snippet: str(c.snippet), marker: str(c.marker), file: str(c.file), stamp: str(c.stamp), placed: str(c.placed), ...(str(c.seen) ? { seen: str(c.seen) } : {}) })),
    values: list(d.values).filter(v => ['number', 'figure', 'table'].includes(str(v.kind)) && str(v.from) && str(v.file))
      .map(v => ({ kind: str(v.kind) as ValueKind, from: str(v.from), key: str(v.key), written: str(v.written), file: str(v.file), before: str(v.before), after: str(v.after), ...(str(v.kept) ? { kept: str(v.kept) } : {}) })),
    bib,
    allowed: list(d.allowed).filter(a => str(a.file) && str(a.match)).map(a => ({ file: str(a.file), match: str(a.match), text: str(a.text) })),
  }
}

/** A document's tracking file; one that is missing reads as a document tied to nothing yet. */
export async function readTracking(io: Io, vault: string, name: string): Promise<Tracking> {
  try { return parseTracking(JSON.parse(await io.read(join(vault, trackingRel(name))))) } catch { return parseTracking(null) }
}

export const writeTracking = (io: Io, vault: string, name: string, t: Tracking) =>
  io.write(join(vault, trackingRel(name)), JSON.stringify(t, null, 2) + '\n')
