// The tree view's radial layout (web/layout.js): the root at the centre, one ring per level,
// siblings a fixed arc apart, and a wide tree squeezed to the circle without its ends meeting.
// And the arrow keys' walk through the drawn tree: up the parent, down a child, sideways a sibling.

import { describe, expect, test } from 'claude-code/testing'

import '../web/vendor/d3.v7.9.0.min.js'
import '../web/layout.js'

type Spec = { id: string; children?: Spec[] }
type Placed = { data: Spec; depth: number; parent: Placed | null; angle: number; radius: number; descendants: () => Placed[] }
type D3 = { hierarchy: (d: Spec) => Placed }
type Dir = 'up' | 'down' | 'left' | 'right'
type Walk = { roots: string[]; kids: (id: string) => string[]; parentOf: (id: string) => string | null; last?: Map<string, string> }
type Api = {
  radial: (d3: D3, root: Placed, breadth: number, depth: number) => Placed
  normalAngle: (a: number) => number
  step: (dir: Dir, id: string, walk: Walk) => string | null
}

const g = globalThis as unknown as { d3: D3; RftLayout: Api }
const L = g.RftLayout
const BREADTH = 60
const DEPTH = 140

const leaf = (id: string): Spec => ({ id })
const chain = (ids: string[], end: Spec[]): Spec =>
  ids.reduceRight<Spec[]>((kids, id) => [{ id, children: kids }], end)[0]!

function layout(spec: Spec) {
  const root = L.radial(g.d3, g.d3.hierarchy(spec), BREADTH, DEPTH)
  return new Map(root.descendants().map(n => [n.data.id, n]))
}
const arc = (a: Placed, b: Placed) => Math.abs(a.angle - b.angle) * a.radius
const near = (got: number, want: number) => expect(Math.abs(got - want)).toBeLessThan(1e-9)

describe('radial layout', () => {
  // the demo's shape: a chain from the root, then a few small fans
  const demo = chain(['D00', 'E01', 'D01', 'E02'], [
    chain(['D02', 'E03'], [leaf('D03'), leaf('D04'), leaf('D08')]),
    leaf('D06'),
    leaf('D07'),
  ])

  test('the root sits at the centre and each level on its own ring', () => {
    const at = layout(demo)
    expect(at.get('D00')!.radius).toBe(0)
    for (const n of at.values()) expect(n.radius).toBe(n.depth * DEPTH)
  })

  test('a deep, thin tree keeps siblings a fixed arc apart instead of filling the circle', () => {
    const at = layout(demo)
    const [d02, d06, d07] = ['D02', 'D06', 'D07'].map(id => at.get(id)!)
    near(arc(d02!, d06!), BREADTH)
    near(arc(d06!, d07!), BREADTH)
    near(arc(at.get('D03')!, at.get('D04')!), BREADTH)
    const angles = [...at.values()].map(n => n.angle)
    expect(Math.max(...angles) - Math.min(...angles)).toBeLessThan(Math.PI / 2)
    // the chain runs straight out from the root, the way the tree grows
    for (const id of ['E01', 'D01', 'E02']) near(at.get(id)!.angle, 0)
  })

  test('a wide tree is squeezed to the full circle with a gap between its ends', () => {
    const at = layout({ id: 'R', children: Array.from({ length: 40 }, (_, i) => leaf(`L${i}`)) })
    const angles = Array.from({ length: 40 }, (_, i) => at.get(`L${i}`)!.angle)
    const step = angles[1]! - angles[0]!
    near(step, (2 * Math.PI) / 40)
    near(angles[39]! - angles[0]!, 2 * Math.PI - step)
  })

  test('a single note is just the centre', () => {
    const at = layout(leaf('D00'))
    expect(at.get('D00')!.radius).toBe(0)
    expect(at.get('D00')!.angle).toBe(0)
  })

  test('angles normalise into [0, 2π)', () => {
    near(L.normalAngle(-Math.PI / 2), (3 * Math.PI) / 2)
    near(L.normalAngle(2 * Math.PI), 0)
    expect(L.normalAngle(1)).toBe(1)
  })
})

describe('arrow keys', () => {
  // D00 → E01, D01, E02; D01 → D02, D03; two top-level notes when `roots` says so
  const children: Record<string, string[]> = { D00: ['E01', 'D01', 'E02'], D01: ['D02', 'D03'] }
  const parent: Record<string, string> = { E01: 'D00', D01: 'D00', E02: 'D00', D02: 'D01', D03: 'D01' }
  const walk = (extra: Partial<Walk> = {}): Walk => ({
    roots: ['D00'],
    kids: id => children[id] || [],
    parentOf: id => parent[id] || null,
    ...extra,
  })

  test('up goes to the parent, and nowhere from the top', () => {
    expect(L.step('up', 'D02', walk())).toBe('D01')
    expect(L.step('up', 'D01', walk())).toBe('D00')
    expect(L.step('up', 'D00', walk())).toBe(null)
  })

  test('down goes to the first child, and nowhere from a leaf', () => {
    expect(L.step('down', 'D00', walk())).toBe('E01')
    expect(L.step('down', 'E02', walk())).toBe(null)
  })

  test('down goes back to the child shown last, while it is still a child', () => {
    expect(L.step('down', 'D00', walk({ last: new Map([['D00', 'E02']]) }))).toBe('E02')
    // moved away, or hidden by the filters: the first child instead
    expect(L.step('down', 'D00', walk({ last: new Map([['D00', 'D03']]) }))).toBe('E01')
  })

  test('left and right move along the siblings, without wrapping', () => {
    expect(L.step('right', 'E01', walk())).toBe('D01')
    expect(L.step('right', 'D01', walk())).toBe('E02')
    expect(L.step('right', 'E02', walk())).toBe(null)
    expect(L.step('left', 'D01', walk())).toBe('E01')
    expect(L.step('left', 'E01', walk())).toBe(null)
    expect(L.step('left', 'D03', walk())).toBe('D02')
  })

  test('only the drawn children count as siblings', () => {
    // D01 hidden by the filters: E01 and E02 are next to each other
    const shown = walk({ kids: id => (children[id] || []).filter(k => k !== 'D01') })
    expect(L.step('right', 'E01', shown)).toBe('E02')
    expect(L.step('left', 'E02', shown)).toBe('E01')
  })

  test('the top-level notes are siblings of each other', () => {
    const two = walk({ roots: ['D00', 'D10'] })
    expect(L.step('right', 'D00', two)).toBe('D10')
    expect(L.step('left', 'D10', two)).toBe('D00')
    expect(L.step('right', 'D10', two)).toBe(null)
    // a note the walk does not know has no siblings
    expect(L.step('right', 'X99', two)).toBe(null)
  })
})
