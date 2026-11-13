// Full-text search over the notes, so Claude finds what was tried without reading files one by
// one. A BM25 ranking built from the notes as loaded (the tools load every note anyway), so it
// is never out of date and keeps nothing on disk. Titles and one-line summaries weigh most, then
// tags and concept names, then the body; a word also matches the longer words it starts
// (augment: augmentation). The answer is meant to be read instead of the notes: each hit with its
// summary and where it sits, the concepts whose digest matches first.

import type { Digest } from './map'
import type { Loaded, RftNode } from './vault'
import { MARK, bodyOf, conceptPath, withoutChildren } from './vault'

const STOP = new Set(('a an and are as at be by for from has have in is it its of on or that the this to was were ' +
  'what when which with not no but if then than into over under via we our you your').split(' '))

/** Lowercase words of two characters or more, stop words out. */
export function words(text: string): string[] {
  return (text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(w => w.length > 1 && !STOP.has(w))
}

type Doc = { n: RftNode; tf: Map<string, number>; len: number; lines: { heading: string; text: string }[] }

export type SearchFilter = { type?: string; status?: string; concept?: string; tag?: string }
export type Hit = { id: string; score: number; heading: string; snippet: string; /** the share of the query's words found */ coverage: number }

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
    const body = withoutChildren(bodyOf(texts[n.id] ?? ''))
    const concepts = conceptPath(tree.concepts ?? {}, n.concept).map(c => tree.concepts?.[c]?.name ?? '')
    add(`${n.id} ${n.title}`, 3)
    add(n.summary ?? '', 3)
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
      .map(d => ({ id: d.n.id, score: 0, heading: d.lines[0]?.heading ?? '', snippet: cut(d.lines[0]?.text ?? ''), coverage: 0 }))
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
    // an overturned result still answers, after the one that holds now
    if (d.n.supersededBy) score *= 0.6
    const line = bestLine(d.lines, terms)
    hits.push({ id: d.n.id, score, heading: line?.heading ?? '', snippet: cut(line?.text ?? ''), coverage: found / terms.length })
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

/** A word of the query is in a text when the text has it or a longer word it starts. */
const has = (ws: Set<string>, t: string) => ws.has(t) || (t.length >= 4 && [...ws].some(w => w.startsWith(t)))

/** The concepts whose name or digest holds at least half the query's words, best first. */
export function conceptHits(loaded: Loaded, digests: Record<string, Digest>, query: string, limit = 3): { id: string; coverage: number }[] {
  const terms = [...new Set(words(query))]
  if (!terms.length) return []
  const out: { id: string; coverage: number; weight: number }[] = []
  for (const c of Object.values(loaded.tree.concepts ?? {})) {
    const d = digests[c.id]
    const name = new Set(words(`${c.name} ${c.summary ?? ''}`))
    const text = new Set(words(d ? `${d.state}\n${d.body}` : ''))
    const found = terms.filter(t => has(name, t) || has(text, t))
    if (!found.length || found.length * 2 < terms.length) continue
    out.push({ id: c.id, coverage: found.length / terms.length, weight: terms.filter(t => has(name, t)).length })
  }
  return out.sort((a, b) => b.coverage - a.coverage || b.weight - a.weight).slice(0, limit).map(({ id, coverage }) => ({ id, coverage }))
}

/** One hit, to be read instead of the note: id and title, status, parent, concept, summary. */
function hitLine(loaded: Loaded, h: Hit, terms: string[] = []): string {
  const { tree } = loaded
  const n = tree.nodes[h.id]!
  const c = tree.concepts?.[n.concept]
  const where = [n.status, n.parent ? `← ${n.parent}` : '', c && c.root ? c.name : ''].filter(Boolean).join(', ')
  const head = `${MARK[n.status] ?? '-'} ${n.name} (${where})${n.supersededBy ? ` [superseded by ${n.supersededBy}]` : ''}${n.summary ? ` — ${n.summary}` : ''}`
  // the matched line only when it holds a word of the query the title and summary do not
  if (!h.snippet) return head
  const told = new Set(words(`${n.title} ${n.summary ?? ''}`))
  const line = new Set(words(h.snippet))
  const adds = !n.summary || terms.some(t => has(line, t) && !has(told, t))
  return adds ? `${head}\n  ${h.heading ? `${h.heading}: ` : ''}${h.snippet}` : head
}

/** The hits as text for the model: matching concepts (their state), then the notes. */
export function searchReport(loaded: Loaded, query: string, filter: SearchFilter = {}, limit = 10, digests: Record<string, Digest> = {}): string {
  const hits = search(loaded, query, filter, limit)
  const shown = [query && `"${query}"`, ...Object.entries(filter).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`)].filter(Boolean).join(', ')
  const { tree } = loaded
  const concepts = filter.concept ? [] : conceptHits(loaded, digests, query)
  if (!hits.length && !concepts.length) return `No note matches ${shown || 'that'}.`
  const out: string[] = []
  if (concepts.length) {
    out.push('Concepts:')
    for (const { id } of concepts) {
      const c = tree.concepts![id]!
      const d = digests[id]
      out.push(`- ${c.name}${c.root ? ` (${c.root})` : ''}: ${d?.state ?? c.summary ?? `${c.count} note(s), no digest`}`)
    }
  }
  if (hits.length) {
    out.push(`${hits.length} note(s) for ${shown}, best first:`)
    const terms = [...new Set(words(query))]
    for (const h of hits) out.push(`- ${hitLine(loaded, h, terms)}`)
  }
  out.push(`${concepts.length ? 'rft_map <concept> for a concept\'s digest and notes; ' : ''}rft_graph <id> for a note's neighbours; a note's file only for the detail.`)
  return out.join('\n')
}

/** Notes already in the tree close to a new one (its title and summary), to ask "have we tried this?". */
export function similarNotes(loaded: Loaded, id: string, limit = 3): string {
  const n = loaded.tree.nodes[id]
  if (!n || n.type === 'reference') return ''
  const near = new Set([id, n.parent ?? ''])
  const hits = search(loaded, `${n.title} ${n.summary ?? ''}`, {}, limit + near.size)
    .filter(h => !near.has(h.id) && h.coverage >= 0.5 && loaded.tree.nodes[h.id]!.type !== 'reference')
    .slice(0, limit)
  if (!hits.length) return ''
  return [
    'Close to notes already in the tree (have we tried this?):',
    ...hits.map(h => `- ${hitLine(loaded, h)}`),
    'If one of them already answers it or ruled it out, tell the user before running it.',
  ].join('\n')
}
