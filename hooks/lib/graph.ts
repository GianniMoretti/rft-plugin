// Graph questions over the tree, answered from the frontmatter alone: a note's neighbours
// (parent, children, what it builds on, what cites it, where it was before a move) and the path
// the reasoning took from the top of the tree to it. Each note is one line with its summary, so
// the answer is read instead of the files.

import type { Loaded, RftNode, Tree } from './vault'
import { MARK, resolveId } from './vault'

export type GraphMode = 'around' | 'path'

const line = (n: RftNode) => `${MARK[n.status] ?? '-'} ${n.name} (${n.type}, ${n.status})${n.summary ? ` — ${n.summary}` : ''}`

const lines = (tree: Tree, ids: string[], max = 12) => {
  const shown = ids.filter(id => tree.nodes[id]).slice(0, max).map(id => `  ${line(tree.nodes[id]!)}`)
  if (ids.length > max) shown.push(`  … ${ids.length - max} more`)
  return shown
}

/** The notes whose refs name `id`. */
export const citedBy = (tree: Tree, id: string) => Object.values(tree.nodes).filter(n => n.refs?.includes(id)).map(n => n.id)

/** The ancestors of a note, the top first, then the note. */
export function pathTo(tree: Tree, id: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (let at: string | null = id; at && tree.nodes[at] && !seen.has(at); at = tree.nodes[at]!.parent) {
    seen.add(at)
    out.unshift(at)
  }
  return out
}

export function graphReport(loaded: Loaded, ref: string, mode: GraphMode = 'around'): string {
  const { tree } = loaded
  const id = resolveId(tree, ref)
  if (!id) throw new Error(`${ref} is not a note of the tree`)
  const n = tree.nodes[id]!
  const c = tree.concepts?.[n.concept]
  const head = `${line(n)}${c ? ` · concept ${c.name}` : ''}`
  if (mode === 'path') {
    const path = pathTo(tree, id)
    const out = [`How ${n.id} was reached (${path.length - 1} step(s) from the top):`]
    path.forEach((p, i) => out.push(`${'  '.repeat(Math.min(i, 8))}${line(tree.nodes[p]!)}`))
    if (n.origin?.length) out.push(`Moved here; it was under ${n.origin.join(', then ')}.`)
    return out.join('\n')
  }
  const out = [head]
  const parent = n.parent ? tree.nodes[n.parent] : undefined
  if (parent) out.push('Parent:', `  ${line(parent)}`)
  if (n.children.length) out.push(`Children (${n.children.length}):`, ...lines(tree, n.children))
  if (parent) {
    const sibs = parent.children.filter(k => k !== id)
    if (sibs.length) out.push(`Beside it under ${parent.id} (${sibs.length}):`, ...lines(tree, sibs, 6))
  }
  if (n.refs?.length) out.push(`Builds on (${n.refs.length}):`, ...lines(tree, n.refs))
  const cites = citedBy(tree, id)
  if (cites.length) out.push(`Cited by (${cites.length}):`, ...lines(tree, cites))
  if (n.origin?.length) out.push(`Was under: ${n.origin.join(', then ')}.`)
  return out.join('\n')
}
