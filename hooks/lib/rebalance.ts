// Cheaper rebalancing: the plugin finds the candidates, Claude judges them. A note is a
// candidate when its words (title, summary, tags) and the references it builds on sit closer to
// another concept than to its own. The rebalance prompt then carries this short list with the
// summaries, so Claude reads the map and a few notes instead of the whole tree.

import { resolveConcept } from './map'
import { words } from './search'
import type { Loaded, RftNode, Tree } from './vault'
import { bodyOf, conceptPath, resolveId, withoutChildren } from './vault'

type Vec = Map<string, number>

export type Candidate = {
  id: string
  /** Its concept now, and how well it fits there (0 to about 1). */
  from: string
  fit: number
  /** The concept it fits better, how well, and the note there it is closest to. */
  to: string
  toFit: number
  near: string | null
  /** Past the lower bar only: worth a look when the summary leaves a doubt. */
  weak?: boolean
}

const REF_WEIGHT = 0.3
/** A candidate fits its best other concept at least this well, and by this margin over its own. */
const STRONG = { fit: 0.12, gain: 0.08, ratio: 1.4 }
/** The lower bar of the weak candidates. */
const WEAK = { fit: 0.08, gain: 0.03, ratio: 1.15 }

/** What a note is about, as words: title and summary twice, tags; the start of the body when it has no summary. */
function noteWords(loaded: Loaded, n: RftNode): string[] {
  const out = [...words(n.title), ...words(n.title), ...n.tags.flatMap(t => words(t))]
  if (n.summary) out.push(...words(n.summary), ...words(n.summary))
  else {
    const body = withoutChildren(bodyOf(loaded.texts[n.id] ?? '')).replace(/^#.*$/gm, '')
    out.push(...words(body.slice(0, 600)))
  }
  return out
}

const norm = (v: Vec): Vec => {
  let s = 0
  for (const x of v.values()) s += x * x
  const l = Math.sqrt(s) || 1
  return new Map([...v].map(([k, x]) => [k, x / l]))
}

const add = (into: Vec, v: Vec, sign = 1) => { for (const [k, x] of v) into.set(k, (into.get(k) ?? 0) + sign * x) }

function cosine(a: Vec, b: Vec): number {
  let dot = 0, na = 0, nb = 0
  for (const [k, x] of a) { dot += x * (b.get(k) ?? 0); na += x * x }
  for (const x of b.values()) nb += x * x
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

function descendants(tree: Tree, id: string): Set<string> {
  const out = new Set<string>()
  const visit = (k: string) => { out.add(k); tree.nodes[k]?.children.forEach(visit) }
  visit(id)
  return out
}

/** The notes that sit closer to another concept than to their own, the clearest first. */
export function candidates(loaded: Loaded, opts: { scope?: string; limit?: number; weakLimit?: number } = {}): Candidate[] {
  const { tree } = loaded
  const concepts = tree.concepts ?? {}
  if (Object.keys(concepts).length < 2) return []
  const nodes = Object.values(tree.nodes)
  // tf-idf over the notes
  const raw = new Map(nodes.map(n => [n.id, noteWords(loaded, n)]))
  const df = new Map<string, number>()
  for (const ws of raw.values()) for (const w of new Set(ws)) df.set(w, (df.get(w) ?? 0) + 1)
  const N = nodes.length
  const vec = new Map<string, Vec>()
  for (const [id, ws] of raw) {
    const v: Vec = new Map()
    for (const w of ws) v.set(w, (v.get(w) ?? 0) + 1)
    for (const [w, f] of v) v.set(w, (1 + Math.log(f)) * Math.log(1 + N / (df.get(w) ?? 1)))
    vec.set(id, norm(v))
  }
  // each concept: the sum of its own notes' vectors, its name, and the references its notes use
  const profile = new Map<string, Vec>()
  const refUse = new Map<string, Map<string, number>>()
  for (const c of Object.values(concepts)) {
    const p: Vec = new Map()
    for (const w of words(`${c.name} ${c.summary}`)) p.set(w, (p.get(w) ?? 0) + Math.log(1 + N / (df.get(w) ?? 1)) * 0.5)
    profile.set(c.id, p)
    refUse.set(c.id, new Map())
  }
  for (const n of nodes) {
    add(profile.get(n.concept)!, vec.get(n.id)!)
    const use = refUse.get(n.concept)!
    for (const r of n.refs ?? []) use.set(r, (use.get(r) ?? 0) + 1)
    if (n.type === 'reference') use.set(n.id, (use.get(n.id) ?? 0) + 1)
  }
  const fitOf = (n: RftNode, cid: string): number => {
    const own = n.concept === cid
    const p = new Map(profile.get(cid)!)
    if (own) add(p, vec.get(n.id)!, -1) // leave the note itself out of its own concept
    let fit = cosine(vec.get(n.id)!, p)
    const refs = n.refs ?? []
    if (refs.length) {
      const use = refUse.get(cid)!
      const shared = refs.filter(r => (use.get(r) ?? 0) - (own ? 1 : 0) > 0).length
      fit += REF_WEIGHT * shared / refs.length
    }
    return fit
  }
  const inScope = scopeOf(loaded, opts.scope)
  const starts = new Set(Object.values(concepts).map(c => c.root).filter(Boolean))
  // the distinctive words of each concept's name (a model or method name), for a note whose title names another line
  // a word names a concept when every concept whose name has it is that one or below it
  const holders = new Map<string, string[]>()
  for (const c of Object.values(concepts)) for (const w of new Set(words(c.name))) holders.set(w, [...(holders.get(w) ?? []), c.id])
  const nameWords = new Map(Object.values(concepts).map(c => [c.id,
    words(c.name).filter(w => w.length >= 4 && holders.get(w)!.every(h => conceptPath(concepts, h).includes(c.id)))]))
  const found: Candidate[] = []
  for (const n of nodes) {
    if (!n.parent || starts.has(n.id) || n.type === 'reference') continue
    const below = descendants(tree, n.id)
    const fit = fitOf(n, n.concept)
    const path = conceptPath(concepts, n.concept)
    const ownNames = new Set(path.flatMap(id => nameWords.get(id) ?? []))
    const title = new Set(words(n.title))
    let best: { id: string; fit: number } | null = null
    let named: { id: string; fit: number } | null = null
    for (const c of Object.values(concepts)) {
      // a concept on the note's own path to the top is where it already sits
      if (c.id === n.concept || c.count < 2 || (c.root && below.has(c.root)) || path.includes(c.id)) continue
      const f = fitOf(n, c.id)
      if (!best || f > best.fit) best = { id: c.id, fit: f }
      if ((nameWords.get(c.id) ?? []).some(w => title.has(w) && !ownNames.has(w)) && (!named || f > named.fit)) named = { id: c.id, fit: f }
    }
    const passes = (to: { fit: number } | null, bar: typeof STRONG) => !!to && to.fit >= bar.fit && to.fit - fit >= bar.gain && to.fit >= fit * bar.ratio
    // strong: clearly closer elsewhere; weak: a little closer, or its title names another concept it is not less close to
    const to = passes(best, WEAK) ? best! : named && named.fit >= fit ? named : null
    if (!to) continue
    const weak = to !== best || !passes(best, STRONG)
    if (inScope && !inScope.has(n.id) && !inScope.has(to.id)) continue
    // the closest note of that concept, as a parent to start from
    let near: string | null = null, close = -1
    for (const m of nodes) {
      if (m.concept !== to.id || below.has(m.id) || m.type === 'reference') continue
      const sim = cosine(vec.get(n.id)!, vec.get(m.id)!)
      if (sim > close) { close = sim; near = m.id }
    }
    found.push({ id: n.id, from: n.concept, fit, to: to.id, toFit: to.fit, near, ...(weak ? { weak } : {}) })
  }
  // a branch moves whole: drop a note whose ancestor already goes to the same concept
  const going = new Map(found.map(c => [c.id, c.to]))
  const kept = found.filter(c => {
    for (let at = tree.nodes[c.id]!.parent; at; at = tree.nodes[at]?.parent ?? null) if (going.get(at) === c.to) return false
    return true
  })
  const order = (a: Candidate, b: Candidate) => (b.toFit - b.fit) - (a.toFit - a.fit) || a.id.localeCompare(b.id)
  return [
    ...kept.filter(c => !c.weak).sort(order).slice(0, opts.limit ?? 15),
    ...kept.filter(c => c.weak).sort(order).slice(0, opts.weakLimit ?? 15),
  ]
}

/** The notes and concepts a scope (a concept or a note) covers, as ids; null for the whole tree. */
function scopeOf(loaded: Loaded, scope?: string): Set<string> | null {
  if (!scope) return null
  const { tree } = loaded
  const c = resolveConcept(tree, scope)
  const out = new Set<string>()
  if (c) {
    const under = (id: string): boolean => id === c.id || (!!tree.concepts?.[id]?.parent && under(tree.concepts[id]!.parent!))
    for (const k of Object.keys(tree.concepts ?? {})) if (under(k)) out.add(k)
    for (const n of Object.values(tree.nodes)) if (out.has(n.concept)) out.add(n.id)
    return out
  }
  const id = resolveId(tree, scope)
  if (!id) throw new Error(`${scope} is not a concept or a note of the tree`)
  for (const k of descendants(tree, id)) out.add(k)
  for (const cc of Object.values(tree.concepts ?? {})) if (cc.root && out.has(cc.root)) out.add(cc.id)
  return out
}

/** The candidates as text for the prompt: each with its summary, where it is, where it would fit. */
export function candidatesReport(loaded: Loaded, list: Candidate[]): string {
  const { tree } = loaded
  const name = (cid: string) => {
    const c = tree.concepts?.[cid]
    return c ? `${c.name}${c.root ? ` (${c.root})` : ''}` : cid
  }
  if (!list.length) return 'No note sits clearly closer to another concept than to its own.'
  const strong = list.filter(c => !c.weak), weak = list.filter(c => c.weak)
  const below = (n: RftNode) => (n.children.length ? ` (+${descendants(tree, n.id).size - 1} below)` : '')
  const out: string[] = []
  if (strong.length) {
    out.push(`${strong.length} candidate(s), the clearest first (fit: closeness of the note's title, summary, tags and references to a concept's notes):`)
    for (const c of strong) {
      const n = tree.nodes[c.id]!
      const near = c.near ? tree.nodes[c.near] : undefined
      out.push(`- ${n.name}${below(n)}${n.summary ? ` — ${n.summary}` : ''}\n` +
        `  now under ${n.parent}, concept ${name(c.from)} (fit ${c.fit.toFixed(2)}); closer to ${name(c.to)} (fit ${c.toFit.toFixed(2)})` +
        `${near ? `, nearest there: ${near.name}${near.summary ? ` — ${near.summary}` : ''}` : ''}`)
    }
  }
  if (weak.length) {
    out.push(`${weak.length} weak candidate(s), only slightly closer to another concept or naming it in the title (concept now → other, fits):`)
    for (const c of weak) {
      const n = tree.nodes[c.id]!
      out.push(`- ${n.name}${below(n)}: ${name(c.from)} → ${name(c.to)}, ${c.fit.toFixed(2)} → ${c.toFit.toFixed(2)}${c.near ? `, nearest ${c.near}` : ''}`)
    }
  }
  return out.join('\n')
}
