// State of knowledge: a result that overturns another marks it (superseded_by:), so an older
// number is not built on; and what is still open, by concept (rft_next, /rft-next): directions
// never explored, experiments planned and never run, the open questions of the digests.

import type { Digest } from './map'
import { readDigests, resolveConcept } from './map'
import type { Io, Loaded, RftNode } from './vault'
import { MARK, conceptOrder, conceptPath, join, load, removeField, resolveId, setField, withHistory } from './vault'

export class KnowledgeError extends Error {}

/** Marks `ref` as overturned by `by` (or, with no `by`, clears the mark), with a dated History line. */
export async function supersede(io: Io, loaded: Loaded, ref: string, by: string | null, why: string | undefined, date: string): Promise<string> {
  const { tree, config } = loaded
  const id = resolveId(tree, ref)
  if (!id) throw new KnowledgeError(`"${ref}" is not a note of the tree`)
  const n = tree.nodes[id]!
  const text = loaded.texts[id]!
  const reason = why?.trim() ? ` (${why.trim().replace(/\s+/g, ' ')})` : ''
  if (!by?.trim()) {
    if (!n.supersededBy) return `${n.name} is not marked as superseded.`
    await io.write(join(config.vault, n.path), withHistory(removeField(text, 'superseded_by'), `- ${date}: no longer superseded by [[${tree.nodes[n.supersededBy]?.name ?? n.supersededBy}]]${reason}`))
    Object.assign(loaded, await load(io, config))
    return `${n.name} is no longer marked as superseded.`
  }
  const newer = resolveId(tree, by)
  if (!newer) throw new KnowledgeError(`"${by}" is not a note of the tree`)
  if (newer === id) throw new KnowledgeError('a note cannot supersede itself')
  // no loop: the newer note must not itself be overturned, directly or further on, by this one
  for (let at: string | undefined = newer, i = 0; at && i < 100; at = tree.nodes[at]?.supersededBy, i++) {
    if (at === id) throw new KnowledgeError(`${newer} is already superseded, through the chain, by ${id}`)
  }
  const m = tree.nodes[newer]!
  const out = withHistory(setField(text, 'superseded_by', `"[[${m.name}]]"`, 'summary'), `- ${date}: superseded by [[${m.name}]]${reason}`)
  await io.write(join(config.vault, n.path), out)
  Object.assign(loaded, await load(io, config))
  return `${n.name} is marked as superseded by ${m.name}: its result is no longer to be built on. ` +
    `Update the digest of its concept (rft_set_digest) so the current result is the one it states${n.summary ? '' : ', and give it a summary'}.`
}

/** The note that holds now, following a chain of superseded results. */
export function current(loaded: Loaded, id: string): string {
  let at = id
  for (let i = 0; i < 100 && loaded.tree.nodes[at]?.supersededBy; i++) at = loaded.tree.nodes[at]!.supersededBy!
  return at
}

/** The lines under `## Open questions` in a digest. */
export function openQuestions(d: Digest | undefined): string[] {
  if (!d) return []
  const m = /(^|\n)##\s*Open questions\s*\n([\s\S]*?)(?=\n##\s|$)/i.exec(d.body)
  return (m?.[2] ?? '').split('\n').map(l => l.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean)
}

const ageDays = (date: string, today: string) => {
  const a = Date.parse(date), b = Date.parse(today)
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.round((b - a) / 86400000)
}

const line = (n: RftNode, today: string) => {
  const age = ageDays(n.date, today)
  return `  ${MARK[n.status] ?? '-'} ${n.name}${age !== null && age > 0 ? ` (${age}d)` : ''}${n.summary ? ` — ${n.summary}` : ''}`
}

const capped = (items: string[], max: number) => (items.length > max ? [...items.slice(0, max), `  … ${items.length - max} more`] : items)

/** What is still open, concept by concept: unexplored directions, planned experiments, open questions. */
export async function nextReport(io: Io, loaded: Loaded, today: string, ref?: string, max = 8): Promise<string> {
  const { tree } = loaded
  const concepts = tree.concepts ?? {}
  const scope = ref?.trim() ? resolveConcept(tree, ref) : null
  if (ref?.trim() && !scope) throw new KnowledgeError(`"${ref}" is not a concept (rft_concepts lists them)`)
  const digests = await readDigests(io, loaded)
  const out: string[] = []
  let total = 0
  for (const c of conceptOrder(concepts)) {
    if (scope && !conceptPath(concepts, c.id).includes(scope.id)) continue
    const own = Object.values(tree.nodes).filter(n => n.concept === c.id && !n.supersededBy)
    const byDate = (a: RftNode, b: RftNode) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)
    // a direction is unexplored while nothing has been tried under it
    const ideas = own.filter(n => n.type === 'direction' && n.status === 'idea' && !n.children.some(k => tree.nodes[k]?.type === 'experiment')).sort(byDate)
    const planned = own.filter(n => n.type === 'experiment' && n.status === 'planned').sort(byDate)
    const running = own.filter(n => n.status === 'running').sort(byDate)
    const questions = openQuestions(digests[c.id])
    if (!ideas.length && !planned.length && !running.length && !questions.length) continue
    total += ideas.length + planned.length + questions.length
    out.push(`## ${c.name}${c.root ? ` (${c.root})` : ''}`)
    if (running.length) out.push(`Running (${running.length}):`, ...capped(running.map(n => line(n, today)), max))
    if (planned.length) out.push(`Planned, never run (${planned.length}, oldest first):`, ...capped(planned.map(n => line(n, today)), max))
    if (ideas.length) out.push(`Directions not explored yet (${ideas.length}, oldest first):`, ...capped(ideas.map(n => line(n, today)), max))
    if (questions.length) out.push(`Open questions (from the digest${digests[c.id] && digests[c.id]!.updated ? ` of ${digests[c.id]!.updated}` : ''}):`, ...capped(questions.map(q => `  - ${q}`), max))
  }
  if (!out.length) return `Nothing open${scope ? ` in ${scope.name}` : ''}: no unexplored direction, no planned experiment, no open question in the digests.`
  return `${total} open item(s)${scope ? ` in ${scope.name}` : ''}, by concept (age in days since the note was made):\n\n${out.join('\n')}`
}
