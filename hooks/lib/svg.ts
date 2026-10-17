// Tree layouts and their SVG drawing, shared by the pane and the static HTML export.
// `TD` and `LR` are tidy trees: leaves side by side along the breadth axis, every parent
// centred over its visible children. `V` is a vertical, indented tree: one node per row,
// indented by depth with elbow connectors, as wide as it is given; it suits a tall, narrow
// pane, growing downward at a readable size. Collapsed branches take the room of one node.

import type { Tree } from './vault'
import { MARK } from './vault'

export type Orientation = 'V' | 'TD' | 'LR'

export type Box = { id: string; x: number; y: number; w: number; h: number; hidden: number }

export type Layout = {
  boxes: Box[]
  edges: [string, string][]
  width: number
  height: number
  nodeW: number
  nodeH: number
  /** Multiplies the font sizes: the `V` layout's scale, 1 for the tidy ones. */
  font: number
}

export type LayoutOptions = {
  /** `V` only: the width to fill, in pixels (default 640). */
  width?: number
  /** `V` only: the drawing scale; 1 is 12.5 px text (default 1). */
  scale?: number
}

const PAD = 16

const SIZE: Record<'TD' | 'LR', { w: number; h: number; gapBreadth: number; gapDepth: number }> = {
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

function vertical(tree: Tree, collapsed: ReadonlySet<string>, opts: LayoutOptions): Layout {
  const sc = Math.min(4, Math.max(0.25, opts.scale ?? 1))
  const width = Math.max(160, opts.width ?? 640)
  const h = 26 * sc, gap = 6 * sc, pad = 8 * sc, minW = Math.min(width - 2 * pad, 220 * sc)
  // indent in steps: a full step at a branching, a third of one for an only child, so long
  // chains drift right slowly and stay readable
  const CHAIN = 1 / 3
  const level = new Map<string, number>()
  let deepest = 0
  const measure = (id: string, lv: number) => {
    level.set(id, lv)
    deepest = Math.max(deepest, lv)
    const kids = collapsed.has(id) ? [] : tree.nodes[id]!.children
    for (const k of kids) measure(k, lv + (kids.length > 1 ? 1 : CHAIN))
  }
  for (const r of tree.roots) measure(r, 0)
  // the step shrinks until the deepest node still leaves a readable box
  const indent = deepest ? Math.max(4 * sc, Math.min(18 * sc, (width - 2 * pad - minW) / deepest)) : 18 * sc
  const boxes: Box[] = []
  const edges: [string, string][] = []
  let row = 0
  const place = (id: string) => {
    const open = !collapsed.has(id)
    const x = pad + level.get(id)! * indent
    boxes.push({ id, x, y: pad + row * (h + gap), w: Math.max(minW, width - pad - x), h, hidden: open ? 0 : count(tree, id) })
    row += 1
    if (open) for (const k of tree.nodes[id]!.children) { edges.push([id, k]); place(k) }
  }
  for (const r of tree.roots) place(r)
  const right = Math.max(width, ...boxes.map(b => b.x + b.w + pad))
  return {
    boxes, edges, width: Math.ceil(right), height: Math.ceil(2 * pad + row * (h + gap) - gap),
    nodeW: width, nodeH: h, font: sc,
  }
}

export function layout(tree: Tree, collapsed: ReadonlySet<string>, orientation: Orientation, opts: LayoutOptions = {}): Layout {
  if (orientation === 'V') return vertical(tree, collapsed, opts)
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
      w: s.w,
      h: s.h,
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
    nodeW: s.w, nodeH: s.h, font: 1,
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
  /**
   * The size to draw at, in pixels; the drawing is scaled into it (viewBox, proportions kept).
   * Absent: the layout's own size. The markup carries the size itself, so a surface that
   * draws the SVG at the markup's size (a sandboxed frame) shows all of it.
   */
  size?: { width: number; height: number }
  /** The `V` layout's width and scale. */
  layout?: LayoutOptions
}

export function treeSvg(tree: Tree, opts: SvgOptions = {}): { svg: string; layout: Layout } {
  const orientation = opts.orientation ?? 'TD'
  const L = layout(tree, opts.collapsed ?? new Set(), orientation, opts.layout)
  const f = L.font
  const pos = new Map(L.boxes.map(b => [b.id, b]))
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.width} ${L.height}" width="${opts.size?.width ?? L.width}" height="${opts.size?.height ?? L.height}" preserveAspectRatio="xMidYMid meet" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif">`,
    '<g fill="none" stroke="#9aa0a6" stroke-width="1.4">',
  ]
  for (const [p, c] of L.edges) {
    const a = pos.get(p)!, b = pos.get(c)!
    if (orientation === 'V') {
      const x1 = a.x + 9 * f, y1 = a.y + a.h
      // under its parent: a line into the top; indented: an elbow into the left side
      const d = b.x - a.x < 9 * f ? `M${x1},${y1} V${b.y}` : `M${x1},${y1} V${b.y + b.h / 2} H${b.x}`
      parts.push(`<path data-edge="${esc(c)}" d="${d}"/>`)
    } else if (orientation === 'TD') {
      const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y, my = (y1 + y2) / 2
      parts.push(`<path data-edge="${esc(c)}" d="M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}"/>`)
    } else {
      const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2, mx = (x1 + x2) / 2
      parts.push(`<path data-edge="${esc(c)}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>`)
    }
  }
  parts.push('</g>')
  for (const b of L.boxes) {
    const { w, h } = b
    const chars = Math.floor((w - 14 * f - (b.hidden ? 32 * f : 0)) / (6.4 * f))
    const n = tree.nodes[b.id]!
    const tone = TYPE_FILL[n.type] ?? TYPE_FILL.experiment!
    const stroke = STATUS_STROKE[n.status] ?? '#868e96'
    const isSel = opts.selected === b.id
    const attrs = opts.isScripted ? ` data-id="${esc(b.id)}" style="cursor:pointer"` : ''
    parts.push(`<g${attrs}${FADED.has(n.status) ? ' opacity="0.6"' : ''}>`)
    parts.push(`<title>${esc(`${n.name} (${n.type}, ${n.status}${n.date ? ', ' + n.date : ''})`)}</title>`)
    parts.push(`<rect x="${b.x}" y="${b.y}" width="${w}" height="${h}" rx="${7 * f}" fill="${tone.fill}" stroke="${isSel ? '#1f2937' : stroke}" stroke-width="${isSel ? 3 : 1.8}"/>`)
    parts.push(`<rect x="${b.x}" y="${b.y + 4 * f}" width="${4 * f}" height="${h - 8 * f}" rx="${2 * f}" fill="${stroke}"/>`)
    const head = `${MARK[n.status] ?? ''} ${n.id}`
    if (orientation === 'TD') {
      parts.push(`<text x="${b.x + 10}" y="${b.y + 17}" font-size="11.5" font-weight="700" fill="${tone.ink}">${esc(head)}<tspan font-weight="400" fill="${stroke}"> ${esc(n.status)}</tspan></text>`)
      parts.push(`<text x="${b.x + 10}" y="${b.y + 34}" font-size="11" fill="${tone.ink}">${esc(cut(n.title, chars))}</text>`)
    } else {
      const size = orientation === 'V' ? 12.5 * f : 11.5
      parts.push(`<text x="${b.x + 10 * f}" y="${b.y + h / 2 + size * 0.35}" font-size="${size}" fill="${tone.ink}"><tspan font-weight="700">${esc(head)}</tspan> ${esc(cut(n.title, chars - head.length - 1))}</text>`)
    }
    if (b.hidden) {
      const bw = 26 * f, bh = 12 * f, bx = b.x + w - bw - 4 * f, by = b.y + (orientation === 'V' ? (h - bh) / 2 : h - bh - 3 * f)
      parts.push(`<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${bh / 2}" fill="#1f2937"/>`)
      parts.push(`<text x="${bx + bw / 2}" y="${by + bh * 0.78}" font-size="${9 * f}" text-anchor="middle" fill="#ffffff">+${b.hidden}</text>`)
    }
    parts.push('</g>')
  }
  parts.push('</svg>')
  return { svg: parts.join(''), layout: L }
}

/** The size that fits the whole layout in a box, keeping its proportions (at most twice its own). */
export function fitSize(L: Layout, boxW: number, boxH?: number, maxScale = 2): { width: number; height: number } {
  const scale = Math.min(boxW / L.width, boxH && boxH > 0 ? boxH / L.height : Infinity, maxScale)
  return { width: Math.max(1, Math.round(L.width * scale)), height: Math.max(1, Math.round(L.height * scale)) }
}
