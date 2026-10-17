// A tidy tree layout and its SVG drawing, shared by the pane and the static HTML export.
// Leaves are placed side by side along the breadth axis and every parent is centred over
// its visible children; collapsed branches take the room of one node.

import type { Tree } from './vault'
import { MARK } from './vault'

export type Orientation = 'TD' | 'LR'

export type Box = { id: string; x: number; y: number; hidden: number }

export type Layout = {
  boxes: Box[]
  edges: [string, string][]
  width: number
  height: number
  nodeW: number
  nodeH: number
}

const PAD = 16

const SIZE: Record<Orientation, { w: number; h: number; gapBreadth: number; gapDepth: number }> = {
  TD: { w: 150, h: 44, gapBreadth: 12, gapDepth: 34 },
  LR: { w: 210, h: 36, gapBreadth: 8, gapDepth: 36 },
}

export const TYPE_FILL: Record<string, { fill: string; ink: string }> = {
  direction: { fill: '#ece3fa', ink: '#2b1a40' },
  experiment: { fill: '#d7f1ec', ink: '#0f3a33' },
}

export const STATUS_STROKE: Record<string, string> = {
  done: '#2f9e44', running: '#f76b15', planned: '#c9a300', idea: '#c9a300',
  dropped: '#c92a2a', discussed: '#868e96', moved: '#1c7ed6',
}

const FADED = new Set(['dropped', 'discussed', 'moved'])

const count = (tree: Tree, id: string): number =>
  tree.nodes[id]!.children.reduce((s, k) => s + 1 + count(tree, k), 0)

export function layout(tree: Tree, collapsed: ReadonlySet<string>, orientation: Orientation): Layout {
  const s = SIZE[orientation]
  const boxes: Box[] = []
  const edges: [string, string][] = []
  const breadthStep = (orientation === 'TD' ? s.w : s.h) + s.gapBreadth
  const depthStep = (orientation === 'TD' ? s.h : s.w) + s.gapDepth
  let next = 0
  let maxDepth = 0
  const at = new Map<string, number>()
  const place = (id: string, depth: number) => {
    maxDepth = Math.max(maxDepth, depth)
    const n = tree.nodes[id]!
    const open = !collapsed.has(id)
    const kids = open ? n.children : []
    for (const k of kids) {
      place(k, depth + 1)
      edges.push([id, k])
    }
    let b: number
    if (kids.length) b = (at.get(kids[0]!)! + at.get(kids[kids.length - 1]!)!) / 2
    else { b = next; next += breadthStep }
    at.set(id, b)
    const d = depth * depthStep
    boxes.push({
      id,
      x: PAD + (orientation === 'TD' ? b : d),
      y: PAD + (orientation === 'TD' ? d : b),
      hidden: open ? 0 : count(tree, id),
    })
  }
  for (const r of tree.roots) place(r, 0)
  const breadth = Math.max(0, next - s.gapBreadth)
  const depth = (maxDepth + 1) * depthStep - s.gapDepth
  return {
    boxes, edges,
    width: Math.ceil(2 * PAD + (orientation === 'TD' ? breadth : depth)),
    height: Math.ceil(2 * PAD + (orientation === 'TD' ? depth : breadth)),
    nodeW: s.w, nodeH: s.h,
  }
}

export const esc = (t: string) =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const cut = (t: string, n: number) => (t.length > n ? t.slice(0, Math.max(1, n - 1)) + '…' : t)

export type SvgOptions = {
  collapsed?: ReadonlySet<string>
  orientation?: Orientation
  selected?: string | null
  /** Adds `data-id` and a pointer cursor on every node (the HTML export's script reads it). */
  isScripted?: boolean
}

export function treeSvg(tree: Tree, opts: SvgOptions = {}): { svg: string; layout: Layout } {
  const orientation = opts.orientation ?? 'TD'
  const L = layout(tree, opts.collapsed ?? new Set(), orientation)
  const { nodeW: w, nodeH: h } = L
  const pos = new Map(L.boxes.map(b => [b.id, b]))
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.width} ${L.height}" width="${L.width}" height="${L.height}" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif">`,
    '<g fill="none" stroke="#9aa0a6" stroke-width="1.4">',
  ]
  for (const [p, c] of L.edges) {
    const a = pos.get(p)!, b = pos.get(c)!
    if (orientation === 'TD') {
      const x1 = a.x + w / 2, y1 = a.y + h, x2 = b.x + w / 2, y2 = b.y, my = (y1 + y2) / 2
      parts.push(`<path data-edge="${esc(c)}" d="M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}"/>`)
    } else {
      const x1 = a.x + w, y1 = a.y + h / 2, x2 = b.x, y2 = b.y + h / 2, mx = (x1 + x2) / 2
      parts.push(`<path data-edge="${esc(c)}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>`)
    }
  }
  parts.push('</g>')
  const chars = Math.floor((w - 14) / 6.1)
  for (const b of L.boxes) {
    const n = tree.nodes[b.id]!
    const tone = TYPE_FILL[n.type] ?? TYPE_FILL.experiment!
    const stroke = STATUS_STROKE[n.status] ?? '#868e96'
    const isSel = opts.selected === b.id
    const attrs = opts.isScripted ? ` data-id="${esc(b.id)}" style="cursor:pointer"` : ''
    parts.push(`<g${attrs}${FADED.has(n.status) ? ' opacity="0.6"' : ''}>`)
    parts.push(`<title>${esc(`${n.name} (${n.type}, ${n.status}${n.date ? ', ' + n.date : ''})`)}</title>`)
    parts.push(`<rect x="${b.x}" y="${b.y}" width="${w}" height="${h}" rx="7" fill="${tone.fill}" stroke="${isSel ? '#1f2937' : stroke}" stroke-width="${isSel ? 3 : 1.8}"/>`)
    parts.push(`<rect x="${b.x}" y="${b.y + 4}" width="4" height="${h - 8}" rx="2" fill="${stroke}"/>`)
    const head = `${MARK[n.status] ?? ''} ${n.id}`
    if (orientation === 'TD') {
      parts.push(`<text x="${b.x + 10}" y="${b.y + 17}" font-size="11.5" font-weight="700" fill="${tone.ink}">${esc(head)}<tspan font-weight="400" fill="${stroke}"> ${esc(n.status)}</tspan></text>`)
      parts.push(`<text x="${b.x + 10}" y="${b.y + 34}" font-size="11" fill="${tone.ink}">${esc(cut(n.title, chars))}</text>`)
    } else {
      parts.push(`<text x="${b.x + 10}" y="${b.y + h / 2 + 4}" font-size="11.5" fill="${tone.ink}"><tspan font-weight="700">${esc(head)}</tspan> ${esc(cut(n.title, chars - head.length - 1))}</text>`)
    }
    if (b.hidden) {
      const bx = b.x + w - 30, by = b.y + h - 15
      parts.push(`<rect x="${bx}" y="${by}" width="26" height="12" rx="6" fill="#1f2937"/>`)
      parts.push(`<text x="${bx + 13}" y="${by + 9.5}" font-size="9" text-anchor="middle" fill="#ffffff">+${b.hidden}</text>`)
    }
    parts.push('</g>')
  }
  parts.push('</svg>')
  return { svg: parts.join(''), layout: L }
}
