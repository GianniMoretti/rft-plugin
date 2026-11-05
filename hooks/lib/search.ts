// Full-text search over the notes, so Claude finds what was tried without reading files one by
// one. A BM25 ranking built from the notes as loaded (the tools load every note anyway), so it
// is never out of date and keeps nothing on disk. Titles weigh most, then tags and concept
// names, then the body; a word also matches the longer words it starts (augment: augmentation).

import type { Loaded, RftNode } from './vault'
import { bodyOf, conceptPath } from './vault'

const STOP = new Set(('a an and are as at be by for from has have in is it its of on or that the this to was were ' +
  'what when which with not no but if then than into over under via we our you your').split(' '))

/** Lowercase words of two characters or more, stop words out. */
export function words(text: string): string[] {
  return (text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(w => w.length > 1 && !STOP.has(w))
}

type Doc = { n: RftNode; tf: Map<string, number>; len: number; lines: { heading: string; text: string }[] }

export type SearchFilter = { type?: string; status?: string; concept?: string; tag?: string }
export type Hit = { id: string; score: number; heading: string; snippet: string }

/** The body's lines, each with the section it is in, frontmatter and markup left out. */
function linesOf(body: string): { heading: string; text: string }[] {
  const out: { heading: string; text: string }[] = []
  let heading = ''
  for (const raw of body.split('\n')) {
    const h = /^#{1,6}\s+(.*)$/.exec(raw)
    if (h) { heading = h[1]!.trim(); continue }
    const text = raw.replace(/^\s*[-*]\s+/, '').replace(/\*\*|`/g, '').replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2').trim()
    if (text) out.push({ heading, text })
  }
  return out
}

function docs(loaded: Loaded): Doc[] {
  const { tree, texts } = loaded
  return Object.values(tree.nodes).map(n => {
    const tf = new Map<string, number>()
    const add = (text: string, weight: number) => { for (const w of words(text)) tf.set(w, (tf.get(w) ?? 0) + weight) }
    // the children list is the children's titles, not this note's content
    const body = bodyOf(texts[n.id] ?? '').replace(/\n## Children in the tree\n[\s\S]*?(?=\n## |$)/, '\n')
    const concepts = conceptPath(tree.concepts ?? {}, n.concept).map(c => tree.concepts?.[c]?.name ?? '')
    add(`${n.id} ${n.title}`, 3)
    add([...n.tags, ...concepts].join(' '), 2)
    add(body, 1)
    let len = 0
    for (const v of tf.values()) len += v
    return { n, tf, len, lines: linesOf(body) }
  })
}

function matches(loaded: Loaded, n: RftNode, f: SearchFilter): boolean {
  if (f.type && n.type !== f.type) return false
  if (f.status && n.status !== f.status) return false
  if (f.tag && !n.tags.includes(f.tag.toLowerCase())) return false
  if (f.concept) {
    const want = f.concept.toLowerCase()
    const path = conceptPath(loaded.tree.concepts ?? {}, n.concept)
    if (!path.some(id => id.toLowerCase() === want || loaded.tree.concepts?.[id]?.name.toLowerCase() === want)) return false
  }
  return true
}

/** The notes that best match `query`, best first; with filters only, the newest that pass. */
export function search(loaded: Loaded, query: string, filter: SearchFilter = {}, limit = 10): Hit[] {
  const all = docs(loaded).filter(d => matches(loaded, d.n, filter))
  const terms = [...new Set(words(query))]
  if (!terms.length) {
    return all.sort((a, b) => b.n.date.localeCompare(a.n.date)).slice(0, limit)
      .map(d => ({ id: d.n.id, score: 0, heading: d.lines[0]?.heading ?? '', snippet: cut(d.lines[0]?.text ?? '') }))
  }
  const N = all.length || 1
  const avg = all.reduce((a, d) => a + d.len, 0) / N || 1
  const vocab = new Set<string>()
  for (const d of all) for (const w of d.tf.keys()) vocab.add(w)
  // each query word: itself, and at half weight the longer words it starts
  const expand = (t: string) => [[t, 1] as const, ...(t.length >= 4 ? [...vocab].filter(w => w !== t && w.startsWith(t)).map(w => [w, 0.5] as const) : [])]
  const df = (w: string) => all.reduce((a, d) => a + (d.tf.has(w) ? 1 : 0), 0)
  const expanded = terms.map(expand)
  const idf = new Map<string, number>()
  const k1 = 1.2, b = 0.75
  const hits: Hit[] = []
  for (const d of all) {
    let score = 0
    let found = 0
    for (const forms of expanded) {
      let best = 0
      for (const [w, weight] of forms) {
        const f = d.tf.get(w)
        if (!f) continue
        if (!idf.has(w)) { const x = df(w); idf.set(w, Math.log(1 + (N - x + 0.5) / (x + 0.5))) }
        best = Math.max(best, weight * idf.get(w)! * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / avg)))
      }
      if (best > 0) found++
      score += best
    }
    if (!score) continue
    // notes with every word of the query come first
    score *= 1 + found / terms.length
    const line = bestLine(d.lines, terms)
    hits.push({ id: d.n.id, score, heading: line?.heading ?? '', snippet: cut(line?.text ?? '') })
  }
  return hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit)
}

function bestLine(lines: { heading: string; text: string }[], terms: string[]) {
  let best: { heading: string; text: string } | undefined
  let most = 0
  for (const l of lines) {
    const ws = new Set(words(l.text))
    const n = terms.filter(t => ws.has(t) || [...ws].some(w => t.length >= 4 && w.startsWith(t))).length
    if (n > most) { most = n; best = l }
  }
  return best ?? lines[0]
}

const cut = (text: string, max = 220) => (text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text)

/** The hits as text for the model. */
export function searchReport(loaded: Loaded, query: string, filter: SearchFilter = {}, limit = 10): string {
  const hits = search(loaded, query, filter, limit)
  const shown = [query && `"${query}"`, ...Object.entries(filter).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`)].filter(Boolean).join(', ')
  if (!hits.length) return `No note matches ${shown || 'that'}.`
  const { tree } = loaded
  const lines = hits.map(h => {
    const n = tree.nodes[h.id]!
    const c = tree.concepts?.[n.concept]
    const where = [n.type, n.status, c && c.root ? `concept ${c.name}` : '', n.tags.length ? `#${n.tags.join(' #')}` : ''].filter(Boolean).join(', ')
    return `- ${n.name} (${where})${h.snippet ? `\n  ${h.heading ? `${h.heading}: ` : ''}${h.snippet}` : ''}`
  })
  return `${hits.length} note(s) for ${shown}, best first:\n${lines.join('\n')}\nRead a note's file for the whole of it.`
}
