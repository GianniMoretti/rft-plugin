// Papers behind reference notes: where an open-access PDF can be had (an arXiv id, or a PDF link
// on an open-access host), the vault folder it goes to (papers/<concept>/), and the jobs the
// background downloader (server/rft_papers.py) runs. Pure functions over a loaded vault.

import type { Loaded, RftNode, Tree } from './vault'
import { ROOT_CONCEPT, front, isLiterature, linkTarget } from './vault'

/** Hosts whose papers are open access; arXiv's are always used. */
export const OPEN_HOSTS = [
  'arxiv.org', 'export.arxiv.org', 'openreview.net', 'aclanthology.org', 'proceedings.mlr.press',
  'jmlr.org', 'www.jmlr.org', 'papers.nips.cc', 'proceedings.neurips.cc', 'openaccess.thecvf.com',
  'www.biorxiv.org', 'www.medrxiv.org', 'ojs.aaai.org', 'www.ijcai.org',
]

/** The papers folder, inside the vault. */
export const PAPERS = 'papers'

const ARXIV_NEW = String.raw`\d{4}\.\d{4,5}(?:v\d+)?`
const ARXIV_OLD = String.raw`[a-z-]+(?:\.[A-Z]{2})?/\d{7}(?:v\d+)?`

/** The text of a note's `## Source` section, else the whole note. */
function sourceText(text: string): string {
  const m = /## Source\n([\s\S]*?)(?=\n## |$)/.exec(text)
  return m ? m[1]! : text
}

/** Where a reference's paper can be downloaded: an arXiv id, or a PDF on an open-access host. */
export function paperSource(text: string, hosts = OPEN_HOSTS): { arxiv: string } | { url: string } | null {
  const src = sourceText(text)
  const arxiv = new RegExp(String.raw`arxiv\.org/(?:abs|pdf)/(${ARXIV_NEW}|${ARXIV_OLD})|arXiv:\s*(${ARXIV_NEW}|${ARXIV_OLD})`, 'i').exec(src)
  if (arxiv) return { arxiv: (arxiv[1] ?? arxiv[2])!.replace(/\.pdf$/, '') }
  for (const m of src.matchAll(/https?:\/\/[^\s)>\]"']+/g)) {
    const url = m[0].replace(/[.,;]+$/, '')
    let host = ''
    try { host = new URL(url).hostname } catch { continue }
    if (hosts.includes(host) && (/\.pdf($|\?)/i.test(url) || /\/pdf\b/.test(url))) return { url }
  }
  return null
}

/** A folder name from a concept name: no characters that break paths or links. */
export const folderName = (name: string) =>
  name.replace(/[\^#|[\]\\/:*"<>?]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'General'

/** The folder of a note's papers: its concept's (the project root concept: General). */
export function paperDir(tree: Tree, n: RftNode): string {
  const c = tree.concepts?.[n.concept]
  return `${PAPERS}/${!c || c.id === ROOT_CONCEPT ? 'General' : folderName(c.name)}`
}

/** The PDF a reference links (`pdf:`), relative to the vault. */
export const pdfOf = (text: string) => linkTarget(front(text).pdf)

/** A literature note's papers: the `### ` entries of its Papers section, each with its heading and text. */
export function literaturePapers(text: string): { heading: string; text: string; start: number; end: number }[] {
  const sec = /^## Papers\n/m.exec(text)
  if (!sec) return []
  const from = sec.index + sec[0].length
  const stop = /^## /m.exec(text.slice(from))
  const end = stop ? from + stop.index : text.length
  const out: { heading: string; text: string; start: number; end: number }[] = []
  const re = /^### (.*)$/gm
  re.lastIndex = 0
  const body = text.slice(from, end)
  const heads = [...body.matchAll(re)]
  heads.forEach((m, i) => {
    const start = from + m.index!
    const stopAt = i + 1 < heads.length ? from + heads[i + 1]!.index! : end
    out.push({ heading: m[1]!.trim(), text: text.slice(start, stopAt), start, end: stopAt })
  })
  return out
}

/** The line that links a literature entry's saved PDF. */
const PDF_LINE = /^PDF: \[\[([^\]]+)\]\]$/m

/**
 * A literature note with the PDF `file` linked under its paper `n` (1-based), as a `PDF:` line at
 * the end of the entry; the text unchanged when the entry is gone or already links one.
 */
export function withEntryPdf(text: string, n: number, file: string): string {
  const e = literaturePapers(text)[n - 1]
  if (!e || PDF_LINE.test(e.text)) return text
  const body = e.text.replace(/\s+$/, '')
  return text.slice(0, e.start) + `${body}\nPDF: [[${file}]]\n\n` + text.slice(e.end).replace(/^\n+/, '')
}

/** A paper job's note and, for a literature note, its entry: `R05#2` is R05's second paper. */
export const jobNote = (id: string): { id: string; entry: number | null } => {
  const m = /^(.*)#(\d+)$/.exec(id)
  return m ? { id: m[1]!, entry: Number(m[2]) } : { id, entry: null }
}

export type PaperJob =
  | { op: 'fetch'; id: string; arxiv?: string; url?: string; dir: string; title: string; year: string }
  | { op: 'move'; id: string; from: string; dir: string }

export type PaperPlan = { jobs: PaperJob[]; saved: string[]; skipped: { id: string; why: string }[] }

/**
 * What to do for the reference notes `ids` (all of them when empty): fetch the ones with an
 * open-access source and no PDF yet, move a saved PDF to its concept's folder when the concept
 * changed, and say why the others are left.
 */
export function planPapers(loaded: Loaded, ids: string[] = [], hosts = OPEN_HOSTS): PaperPlan {
  const { tree, texts } = loaded
  const plan: PaperPlan = { jobs: [], saved: [], skipped: [] }
  const refs = ids.length ? ids : Object.values(tree.nodes).filter(n => n.type === 'reference').map(n => n.id)
  for (const id of refs) {
    const n = tree.nodes[id]
    if (!n) { plan.skipped.push({ id, why: 'not a note of the tree' }); continue }
    if (n.type !== 'reference') { plan.skipped.push({ id, why: 'not a reference note' }); continue }
    if (n.status === 'dropped' && !ids.length) continue
    const text = texts[id]!
    const dir = paperDir(tree, n)
    if (isLiterature(n)) {
      // one job per paper of its Papers section; a saved one stays where it is
      const entries = literaturePapers(text)
      if (!entries.length) { plan.skipped.push({ id, why: 'no ### entries under Papers' }); continue }
      entries.forEach((e, i) => {
        const at = `${id}#${i + 1}`
        if (PDF_LINE.test(e.text)) return void plan.saved.push(at)
        const src = paperSource(e.text, hosts)
        if (!src) return void plan.skipped.push({ id: at, why: `${e.heading}: no arXiv id or open-access PDF link` })
        plan.jobs.push({ op: 'fetch', id: at, ...src, dir, title: e.heading, year: '' })
      })
      continue
    }
    const pdf = pdfOf(text)
    if (pdf) {
      if (pdf.slice(0, pdf.lastIndexOf('/')) !== dir) plan.jobs.push({ op: 'move', id, from: pdf, dir })
      else plan.saved.push(id)
      continue
    }
    const src = paperSource(text, hosts)
    if (!src) { plan.skipped.push({ id, why: 'no arXiv id or open-access PDF link under Source' }); continue }
    // the year and first author come from arXiv; for a plain link the title alone names the file
    plan.jobs.push({ op: 'fetch', id, ...src, dir, title: n.title, year: '' })
  }
  return plan
}
