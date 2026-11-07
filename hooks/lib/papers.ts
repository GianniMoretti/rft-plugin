// Papers behind reference notes: where an open-access PDF can be had (an arXiv id, or a PDF link
// on an open-access host), the vault folder it goes to (papers/<concept>/), and the jobs the
// background downloader (server/rft_papers.py) runs. Pure functions over a loaded vault.

import type { Loaded, RftNode, Tree } from './vault'
import { ROOT_CONCEPT, front, linkTarget } from './vault'

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
